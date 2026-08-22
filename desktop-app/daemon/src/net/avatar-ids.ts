/**
 * Avatar identity, recovered from an avatar's image URL.
 *
 * ## Why this exists
 *
 * VRChat does not tell you which avatar somebody is wearing. A public user record carries
 * `currentAvatarImageUrl` and `currentAvatarThumbnailImageUrl` — pictures — and no `avtr_…` id at
 * all; the id is only ever visible to the avatar's own author. So a "friend changed avatar" row has
 * a picture and nothing to open. The one durable handle in that picture is the **file id** in its
 * path (`.../image/file_d9ec5b06-6ea5-4ae0-ab67-78dfa3eea6df/2/256`), and turning a file id into an
 * avatar id is what a third party is for: somebody has to have seen both halves at once.
 *
 * ## The third-party call, stated plainly
 *
 * `GET https://avtr.zip/v3/avatars/by-file/file_…` is **the only request vrc.zip makes to anything
 * other than VRChat.** It is a deliberate exception to "local-only" (PLAN.md §Guardrails), so:
 *
 *  - **What leaves the machine is one image file id.** No account id, no user id, no cookie, no
 *    display name, and not the vrc.zip contact string either — the User-Agent below is the app's
 *    own, mandatory for VRChat and sent here for the same honesty reason, and carries whatever
 *    contact the user configured. Nothing identifies *whose* feed the id came from.
 *  - **It is switchable.** `Settings.resolveAvatarIds` gates every call; with it off `resolve()`
 *    answers `null`, which the route reports as "not resolved" rather than as a failure.
 *  - **It is rate limited separately.** avtr.zip publishes 10 req/s, which is a different budget
 *    from VRChat's three ceilings, so it gets its own bucket (see {@link TokenBucket}) rather than
 *    borrowing `RateLimiter` — that class is per-account and shares one 429 breaker across every
 *    VRChat call, and charging a third party's traffic to it would let an avtr.zip hiccup stall
 *    presence polling.
 *
 * ## Caching
 *
 * Positive answers are permanent: a file belongs to exactly one avatar and always will. Negative
 * answers are a **cooldown, not a verdict** — avtr.zip learns about new avatars over time, so "not
 * known yet" must be re-askable, just not on every render. A transient failure (5xx, a dead
 * network) is cached as neither; it is simply not an answer.
 */

const AVTR_ZIP_BASE_URL = "https://avtr.zip";

/**
 * avtr.zip's published ceiling. Not shaded to 80% the way the VRChat buckets are: there is no
 * shared breaker here to be tripped by being slightly optimistic, the traffic is one request per
 * newly-seen avatar rather than a sustained stream, and the whole bucket refills in a second.
 */
export const AVTR_ZIP_RATE_LIMIT_PER_SECOND = 10;

/**
 * How long an "avtr.zip does not know this file" answer is believed. Six hours.
 *
 * Long enough that scrolling a feed full of unknown avatars costs one request each per session,
 * short enough that an avatar indexed this morning is openable this evening. The permanent
 * alternative would be wrong in the one direction that cannot be undone: a file id asked about
 * before it was indexed would stay unopenable forever.
 */
export const AVATAR_ID_NEGATIVE_TTL_MS = 6 * 60 * 60_000;

/*
 * The URL grammar moved to `@vrcz/shared` when the UI needed it too: it decides which pictures are
 * worth offering a lookup for, and a second copy here would be a second opinion about what a file
 * id is. Re-exported rather than re-imported at every call site, because this module is still where
 * a reader looks for it.
 */
import { AVATAR_ID_PATTERN, FILE_ID_PATTERN, fileIdFromImageUrl } from "@vrcz/shared";

// Re-exported as well as imported: a bare `export … from` creates no local binding, and the two
// patterns below are used in this file. Callers still find them here, which is where they look.
export { AVATAR_ID_PATTERN, FILE_ID_PATTERN, fileIdFromImageUrl };

/** What one persisted mapping looks like. `avatar_id` null means "avtr.zip knows of none". */
export interface AvatarFileIdRecord {
  readonly avatar_id: string | null;
  readonly resolved_at: number;
}

/**
 * The slice of `Store` this needs, named structurally so a test can hand in two functions and the
 * resolver never imports the store.
 */
export interface AvatarIdPersistence {
  getAvatarFileId(fileId: string): AvatarFileIdRecord | null;
  putAvatarFileId(fileId: string, avatarId: string | null, resolvedAt: number): void;
}

export interface AvatarIdResolverOptions {
  /** The mandatory vrc.zip User-Agent, built by `buildUserAgent`. */
  readonly userAgent: string;
  /**
   * Where the mapping survives a restart. Optional: without it the resolver still works and still
   * de-duplicates, it just re-learns everything on the next boot.
   */
  readonly store?: AvatarIdPersistence | undefined;
  /**
   * Whether the third-party lookup is permitted right now. Read per call rather than captured, so
   * flipping the setting takes effect without rebuilding anything.
   */
  readonly enabled?: (() => boolean) | undefined;
  readonly baseUrl?: string | undefined;
  /** Injected for tests. Narrower than `typeof fetch` for the reason `RequestContext.fetch` is. */
  readonly fetch?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly ratePerSecond?: number | undefined;
  readonly negativeTtlMs?: number | undefined;
}

/**
 * A plain token bucket for one non-VRChat host.
 *
 * Deliberately not `RateLimiter`: that class models three VRChat ceilings keyed by account behind
 * one shared 429 breaker, and every part of that is wrong here. There is no account — the request
 * carries no identity — and coupling a third party's throttling to the breaker that governs
 * presence polling would let avtr.zip stall VRChat traffic. Twenty lines of bucket is a smaller
 * thing to own than a fourth mode on a load-bearing component.
 */
class TokenBucket {
  #tokens: number;
  #lastRefillAt: number;
  readonly #rate: number;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(rate: number, now: () => number, sleep: (ms: number) => Promise<void>) {
    this.#rate = rate;
    this.#capacity = rate;
    this.#tokens = rate;
    this.#now = now;
    this.#sleep = sleep;
    this.#lastRefillAt = now();
  }

  /** Blocks until a token is free. Loops rather than sleeping once: callers race for refills. */
  async take(): Promise<void> {
    for (;;) {
      const now = this.#now();
      const elapsedMs = Math.max(0, now - this.#lastRefillAt);
      this.#tokens = Math.min(this.#capacity, this.#tokens + (elapsedMs / 1000) * this.#rate);
      this.#lastRefillAt = now;

      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      await this.#sleep(Math.max(1, Math.ceil(((1 - this.#tokens) / this.#rate) * 1000)));
    }
  }
}

/** One in-memory answer. `avatarId` null with a timestamp is the cooldown, not a verdict. */
interface MemoEntry {
  readonly avatarId: string | null;
  readonly at: number;
}

export class AvatarIdResolver {
  readonly #memory = new Map<string, MemoEntry>();
  readonly #inFlight = new Map<string, Promise<string | null>>();
  readonly #bucket: TokenBucket;
  readonly #userAgent: string;
  readonly #store: AvatarIdPersistence | null;
  readonly #enabled: () => boolean;
  readonly #baseUrl: string;
  readonly #fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly #now: () => number;
  readonly #negativeTtlMs: number;

  constructor(options: AvatarIdResolverOptions) {
    this.#userAgent = options.userAgent;
    this.#store = options.store ?? null;
    this.#enabled = options.enabled ?? ((): boolean => true);
    this.#baseUrl = options.baseUrl ?? AVTR_ZIP_BASE_URL;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#negativeTtlMs = options.negativeTtlMs ?? AVATAR_ID_NEGATIVE_TTL_MS;
    this.#bucket = new TokenBucket(
      options.ratePerSecond ?? AVTR_ZIP_RATE_LIMIT_PER_SECOND,
      this.#now,
      options.sleep ?? ((ms) => Bun.sleep(ms)),
    );
  }

  /**
   * The `avtr_…` id for one image file id, or null.
   *
   * **Never throws.** Null covers every way this can fail to produce an id — the setting is off, the
   * input is not a file id, avtr.zip has never seen it, avtr.zip is down — because none of them is
   * an error from the caller's point of view: the row simply is not openable.
   */
  async resolve(fileId: string, signal?: AbortSignal): Promise<string | null> {
    if (!FILE_ID_PATTERN.test(fileId)) return null;

    const now = this.#now();

    // Checked before the setting, so an answer already in hand is still served with the lookup
    // switched off. Turning the setting off means "make no more third-party requests", not "forget
    // what this machine already knows".
    const memo = this.#memory.get(fileId);
    if (memo !== undefined && this.#stillValid(memo.avatarId, memo.at, now)) return memo.avatarId;

    const row = this.#store?.getAvatarFileId(fileId) ?? null;
    if (row !== null && this.#stillValid(row.avatar_id, row.resolved_at, now)) {
      this.#memory.set(fileId, { avatarId: row.avatar_id, at: row.resolved_at });
      return row.avatar_id;
    }

    if (!this.#enabled()) return null;

    // One request per file id no matter how many rows name it. The promise never rejects, so a
    // caller inheriting it cannot inherit a throw either.
    const pending = this.#inFlight.get(fileId);
    if (pending !== undefined) return await pending;

    const work = this.#fetchOne(fileId, signal).finally(() => {
      this.#inFlight.delete(fileId);
    });
    this.#inFlight.set(fileId, work);
    return await work;
  }

  /** A positive answer never expires; a negative one is on a cooldown. See the module comment. */
  #stillValid(avatarId: string | null, at: number, now: number): boolean {
    return avatarId !== null || now - at < this.#negativeTtlMs;
  }

  async #fetchOne(fileId: string, signal?: AbortSignal): Promise<string | null> {
    try {
      await this.#bucket.take();
      if (signal?.aborted === true) return null;

      const response = await this.#fetch(`${this.#baseUrl}/v3/avatars/by-file/${fileId}`, {
        headers: { "User-Agent": this.#userAgent, Accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });

      // A 404 is avtr.zip saying it has no avatar for this file, which is an *answer* and worth
      // remembering for a while. Any other non-2xx is avtr.zip having a bad day, which is not an
      // answer at all and must not be cached — caching it would turn a five-minute outage into six
      // hours of unopenable rows.
      if (!response.ok) {
        await response.text().catch(() => "");
        return response.status === 404 ? this.#record(fileId, null) : null;
      }

      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null) return null;

      const payload = body as { success?: unknown; avatarId?: unknown };
      const avatarId = payload.avatarId;
      if (payload.success !== true || typeof avatarId !== "string")
        return this.#record(fileId, null);
      // Pattern-checked rather than trusted: this value is interpolated into a VRChat path by
      // `getAvatar`, and it came from a third party.
      if (!AVATAR_ID_PATTERN.test(avatarId)) return this.#record(fileId, null);

      return this.#record(fileId, avatarId);
    } catch {
      // A network failure, an abort, or a non-JSON body. Not an answer; nothing is written.
      return null;
    }
  }

  /** Writes both caches and returns what was written, so call sites read as one expression. */
  #record(fileId: string, avatarId: string | null): string | null {
    const at = this.#now();
    this.#memory.set(fileId, { avatarId, at });
    this.#store?.putAvatarFileId(fileId, avatarId, at);
    return avatarId;
  }
}
