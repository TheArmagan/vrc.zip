import type { LimitedUserFriend } from "@vrcz/api/types";
import type { EventBus, Subscription } from "../bus/event-bus.ts";
import { JitteredInterval } from "../net/jitter.ts";
import { vrcFetch } from "../net/request.ts";
import { pickUserImageUrl, type UserImageFields } from "../net/user-image.ts";
import type { Store } from "../store/index.ts";
import type { AccountManager } from "./manager.ts";

/**
 * The fields of a VRChat user body this cares about.
 *
 * Structural rather than `User`, because both `GET /users/{id}` and the pipeline's partial frames
 * feed it and neither is the other's type. Everything is optional: the body is genuinely shorter
 * for a non-friend, and treating a missing field as an answer is how presence would get worse from
 * being told more.
 */
export interface ObservedUser extends UserImageFields {
  readonly id?: string;
  readonly displayName?: string;
  readonly status?: string;
  readonly statusDescription?: string;
  /** VRChat's own `online` / `active` / `offline`. The only reliable online-ness in this body. */
  readonly state?: string;
  readonly location?: string;
  readonly worldId?: string;
  readonly platform?: string;
  readonly last_platform?: string;
  readonly tags?: readonly string[];
}

/** Everything that counts as news. `lastSeenAt` deliberately does not — see `observe`. */
function sameRecord(a: FriendPresenceRecord, b: FriendPresenceRecord): boolean {
  return (
    a.displayName === b.displayName &&
    a.status === b.status &&
    a.statusDescription === b.statusDescription &&
    a.location === b.location &&
    a.worldId === b.worldId &&
    a.platform === b.platform &&
    a.trustLevel === b.trustLevel &&
    a.isOnline === b.isOnline &&
    a.iconUrl === b.iconUrl
  );
}

/**
 * A string VRChat actually filled in, or null.
 *
 * VRChat writes `""` rather than omitting a field, which makes `??` the wrong operator against
 * every one of its optional strings — the empty string is truthy to `??` and meaningless to
 * everything downstream. This is the same rule the UI applies to image URLs; it applies here for
 * exactly the same reason.
 */
function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Friend presence: who is online, where, and on what.
 *
 * Presence is **in-memory, not a table**. It is a projection of live state that is wrong the moment
 * the daemon stops, and persisting it would mean serving stale "online" rows after a restart until
 * the first poll landed. What *is* persisted is the friendship itself (`friend_log`) and the user
 * record (`user_cache`), both of which are history rather than state.
 *
 * Two sources, and the split matters:
 *  - The **pipeline** carries the deltas, and is the reason presence is live at all.
 *  - A **slow jittered poll** reconciles. Sockets drop, frames are missed, and a friend who went
 *    offline during a reconnect would otherwise show as online forever.
 */

/** VRChat's trust ranks, derived from tags. Ordered low to high; the highest tag present wins. */
const TRUST_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["system_trust_basic", "basic"],
  ["system_trust_known", "known"],
  ["system_trust_trusted", "trusted"],
  ["system_trust_veteran", "veteran"],
];

export function trustLevelOf(tags: readonly string[] | undefined): string {
  if (!tags) return "visitor";
  if (tags.includes("system_troll")) return "troll";

  let level = "visitor";
  for (const [tag, name] of TRUST_TAGS) {
    if (tags.includes(tag)) level = name;
  }
  return level;
}

export interface FriendPresenceRecord {
  readonly id: string;
  readonly displayName: string;
  /** VRChat's own status string: `active`, `join me`, `ask me`, `busy`, `offline`. */
  readonly status: string;
  readonly statusDescription: string | null;
  /**
   * Raw VRChat location. May be `""`, `"offline"`, `"traveling"`, `"traveling:traveling"`,
   * `"private"`, or a real instance string — carried through untouched so the UI decides how to
   * render each. See PLAN.md §1.5.
   */
  readonly location: string | null;
  readonly worldId: string | null;
  readonly platform: string | null;
  readonly trustLevel: string;
  readonly isOnline: boolean;
  /**
   * An absolute VRChat image URL, or null when the friend has no image at all. It is *not* loadable
   * by a browser: those URLs need the account's auth cookie and the mandatory User-Agent, so the UI
   * goes through the daemon's `GET /api/image` proxy.
   */
  readonly iconUrl: string | null;
  /** Unix ms this record was last updated from any source. */
  readonly lastSeenAt: number;
}

export interface PresenceServiceOptions {
  readonly accounts: AccountManager;
  readonly store: Store;
  readonly bus: EventBus;
  /** Base poll interval. Jittered, and never clock-aligned. PLAN.md §1.4 suggests 2–5 minutes. */
  readonly refreshIntervalMs?: number;
  /** VRChat caps `n` at 100. */
  readonly pageSize?: number;
}

const DEFAULT_REFRESH_MS = 3 * 60_000;
const DEFAULT_PAGE_SIZE = 100;

/**
 * Which of two readings of the same person to keep. See {@link PresenceService.listAll}.
 *
 * Online beats offline before timestamps are consulted, because a stale-but-online record and a
 * fresh-but-offline one usually mean one account's poll has not run yet rather than that the person
 * left — and showing somebody as offline when they are not is the more annoying of the two errors.
 */
function fresher(candidate: FriendPresenceRecord, held: FriendPresenceRecord): boolean {
  if (candidate.isOnline !== held.isOnline) return candidate.isOnline;
  return (candidate.lastSeenAt ?? 0) > (held.lastSeenAt ?? 0);
}

export class PresenceService {
  /** accountId -> userId -> record. Per account, because friend lists differ per account. */
  readonly #byAccount = new Map<string, Map<string, FriendPresenceRecord>>();
  readonly #timers = new Map<string, JitteredInterval>();
  #subscription: Subscription | null = null;
  /**
   * Set by `stop()`. A refresh already awaiting the network resumes *after* shutdown has closed the
   * store, so cancelling the timer is not enough — the resumed continuation would write to a closed
   * database. Anything that outlives `stop()` has to re-check this after every await.
   */
  #disposed = false;

  constructor(private readonly options: PresenceServiceOptions) {}

  start(): void {
    this.#subscription = this.options.bus.subscribe(
      (event) => this.#onBusEvent(event.kind, event),
      {
        // `user.updated*` and not `user.updated`: the bridge refines a profile update into
        // `user.updated.avatar` and friends once it can name the field, and an exact-kind
        // subscription would have silently stopped seeing every one of them. `friend.*` already
        // matches at any depth.
        kinds: ["friend.*", "user.updated", "user.updated.*", "account.ready"],
      },
    );

    for (const snapshot of this.options.accounts.list()) {
      if (snapshot.state === "online") this.#startPolling(snapshot.id);
    }
  }

  stop(): void {
    this.#disposed = true;
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    for (const timer of this.#timers.values()) timer.stop();
    this.#timers.clear();
  }

  list(accountId: string): FriendPresenceRecord[] {
    const records = [...(this.#byAccount.get(accountId)?.values() ?? [])];
    // Online first, then by name. The friends screen is scanned, not read top-to-bottom.
    return records.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  /**
   * Every friend across every account, **one row per person**.
   *
   * The dedupe is not tidiness. Two accounts commonly share friends — an alt is usually friends with
   * the same people as the main — and this list is keyed by user id by everything that renders it.
   * Before this, one shared friend produced two rows with the same id, which in Svelte 5 is not a
   * warning but a hard `each_key_duplicate` throw: the entire Friends screen rendered as empty grey
   * bars, on exactly the multi-account setup this app is built for. Found by the screenshot
   * pipeline, whose two demo accounts share a friend list.
   *
   * **The freshest reading wins.** "Ada is online" and "Ada is offline" can both be true of two
   * accounts' caches, and only one of them is current — so the record with the newer `lastSeenAt`
   * is kept, and an online reading beats an offline one when neither has a timestamp. Picking the
   * first account's answer would make the merged list depend on sign-in order.
   */
  listAll(): FriendPresenceRecord[] {
    const best = new Map<string, FriendPresenceRecord>();
    for (const accountId of this.#byAccount.keys()) {
      for (const record of this.list(accountId)) {
        const held = best.get(record.id);
        if (held === undefined || fresher(record, held)) best.set(record.id, record);
      }
    }
    return [...best.values()].sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  /**
   * Records what a live `GET /users/{id}` just told us about one of this account's friends.
   *
   * A profile fetch is the freshest reading of a person there is — fresher than the friends poll,
   * which runs on an interval, and fresher than the last socket frame, which only fires when
   * something changed *and* the socket was up to hear it. Throwing that away meant the friends
   * list could sit on a stale status while a card opened over it showed the true one, from the
   * same daemon, seconds apart.
   *
   * Two rules keep this from being a way to invent friends:
   *
   *  - **It only ever updates a record that already exists.** Presence *is* the friends list, so
   *    inserting here would put a stranger in it — and `GET /users/{id}` answers for anybody.
   *  - **It writes only what VRChat actually filled in.** The body is shorter for a non-friend and
   *    partial in general, and `""` is how VRChat spells "nothing", so an absent field leaves what
   *    is already known alone rather than blanking it.
   *
   * Returns true when something actually changed, which is what the caller announces. Hovering the
   * same unchanged name ten times is ten fetches and no events.
   */
  observe(accountId: string, user: ObservedUser, now = Date.now()): boolean {
    const map = this.#byAccount.get(accountId);
    if (map === undefined) return false;

    const id = nonEmpty(user.id);
    if (id === null) return false;

    const existing = map.get(id);
    // Not a friend of this account — or the first friends poll has not landed yet, in which case
    // it is about to overwrite everything here anyway.
    if (existing === undefined) return false;

    /*
     * `state` is VRChat's own online/offline verdict and the only trustworthy one in this body:
     * `status` is the user's *chosen* status and stays `active` while they are offline, which is
     * exactly the trap that makes an offline friend look online.
     */
    const state = nonEmpty(user.state);
    const isOnline = state === null ? existing.isOnline : state !== "offline";

    const next: FriendPresenceRecord = {
      ...existing,
      displayName: nonEmpty(user.displayName) ?? existing.displayName,
      status: nonEmpty(user.status) ?? existing.status,
      statusDescription: nonEmpty(user.statusDescription) ?? existing.statusDescription,
      location: nonEmpty(user.location) ?? existing.location,
      worldId: nonEmpty(user.worldId) ?? existing.worldId,
      platform: nonEmpty(user.platform) ?? nonEmpty(user.last_platform) ?? existing.platform,
      trustLevel: user.tags === undefined ? existing.trustLevel : trustLevelOf(user.tags),
      isOnline,
      iconUrl: pickUserImageUrl(user) ?? existing.iconUrl,
      lastSeenAt: now,
    };

    // `lastSeenAt` moves on every call and is not news, so it is excluded from the comparison —
    // otherwise every hover would emit an event and every event would refetch the friends list.
    if (sameRecord(existing, next)) return false;

    map.set(id, next);
    return true;
  }

  /**
   * Fetches the full friends list for one account and replaces its presence map.
   *
   * Online and offline are **separate paginated queries** — VRChat's `offline` flag is a filter, not
   * a field, so one pass returns only half the list. Fetching only the online half would make every
   * offline friend vanish from the UI rather than appear as offline.
   */
  async refresh(accountId: string): Promise<void> {
    if (this.#disposed) return;

    const account = this.options.accounts.get(accountId);
    if (account?.state !== "online") return;

    const pageSize = this.options.pageSize ?? DEFAULT_PAGE_SIZE;
    const next = new Map<string, FriendPresenceRecord>();
    const now = Date.now();

    for (const offline of [false, true]) {
      for (let offset = 0; ; offset += pageSize) {
        const query = `?n=${String(pageSize)}&offset=${String(offset)}&offline=${String(offline)}`;
        const response = await vrcFetch(account.context(), `/auth/user/friends${query}`);
        if (this.#disposed) return;
        if (!response.ok) {
          await response.arrayBuffer().catch(() => undefined);
          return;
        }

        const page = (await response.json()) as LimitedUserFriend[];
        if (this.#disposed) return;
        for (const friend of page) {
          next.set(friend.id, this.#toRecord(friend, !offline, now));
        }

        // A short page is the last page. Asking for one more would be a wasted request per refresh,
        // per account, forever.
        if (page.length < pageSize) break;
      }
    }

    if (this.#disposed) return;

    this.#byAccount.set(accountId, next);
    this.#persistFriendships(accountId, next, now);
    this.options.bus.emit({
      kind: "friend.list_refreshed",
      accountId,
      ts: now,
      payload: { count: next.size },
    });
  }

  #toRecord(friend: LimitedUserFriend, isOnline: boolean, now: number): FriendPresenceRecord {
    return {
      id: friend.id,
      displayName: friend.displayName,
      // `nonEmpty`, not `??`: VRChat sends `""` for a field it has nothing for, so `??` lets the
      // empty string through as if it were an answer. `""` is not a status any vocabulary maps, so
      // the UI drew a grey dot and the word "Unknown" for a friend who was plainly online.
      status: nonEmpty(friend.status) ?? (isOnline ? "active" : "offline"),
      statusDescription: nonEmpty(friend.statusDescription),
      location: friend.location ?? null,
      // `friend.location` is literally "private" when hidden; there is no world id to recover.
      worldId:
        typeof friend.location === "string" && friend.location.startsWith("wrld_")
          ? (friend.location.split(":")[0] ?? null)
          : null,
      platform: friend.platform ?? null,
      trustLevel: trustLevelOf(friend.tags),
      isOnline,
      iconUrl: pickUserImageUrl(friend),
      lastSeenAt: now,
    };
  }

  /**
   * Records the friendship in `friend_log`, which is **never auto-deleted** — "when did we become
   * friends" is the kind of thing people keep for years. Presence itself is not written.
   */
  #persistFriendships(
    accountId: string,
    records: Map<string, FriendPresenceRecord>,
    now: number,
  ): void {
    for (const record of records.values()) {
      const existing = this.options.store.getFriend(accountId, record.id);
      this.options.store.upsertFriend({
        account_id: accountId,
        user_id: record.id,
        display_name: record.displayName,
        trust_level: record.trustLevel,
        // Keep the original date. Overwriting it on every poll would reset every friendship to
        // "friends since today" and quietly destroy the only copy of that history.
        friended_at: existing?.friended_at ?? now,
        unfriended_at: null,
      });
    }
  }

  #onBusEvent(kind: string, event: { accountId: string | null; payload?: unknown }): void {
    if (!event.accountId) return;

    if (kind === "account.ready") {
      // `account.ready`, not `account.state`: the latter fires while the manager still has the
      // account under its pending id, so `accounts.get(realId)` would return undefined and the
      // first refresh would silently do nothing.
      this.#startPolling(event.accountId);
      return;
    }

    const payload = event.payload as
      | { userId?: string; userid?: string; user?: Partial<LimitedUserFriend>; location?: string }
      | undefined;
    if (!payload) return;

    // `friend-active` spells it `userid`. Upstream typo — see PLAN.md §1.5.
    const userId = payload.userId ?? payload.userid ?? payload.user?.id;
    if (!userId) return;

    const map = this.#byAccount.get(event.accountId);
    if (!map) return;

    const existing = map.get(userId);
    const now = Date.now();

    if (kind === "friend.removed") {
      map.delete(userId);
      return;
    }

    const isOnline = kind !== "friend.offline";
    const user = payload.user;

    map.set(userId, {
      id: userId,
      displayName: user?.displayName ?? existing?.displayName ?? userId,
      status: nonEmpty(user?.status) ?? (isOnline ? (existing?.status ?? "active") : "offline"),
      statusDescription: nonEmpty(user?.statusDescription) ?? existing?.statusDescription ?? null,
      location:
        payload.location ?? user?.location ?? (isOnline ? (existing?.location ?? null) : null),
      worldId: existing?.worldId ?? null,
      platform: user?.platform ?? existing?.platform ?? null,
      trustLevel: user?.tags ? trustLevelOf(user.tags) : (existing?.trustLevel ?? "visitor"),
      isOnline,
      // A pipeline frame carries a *partial* user, and several frame types carry none of the image
      // fields at all. Falling back to what we already have is the difference between an icon that
      // stays put and one that blinks out the moment a friend changes status.
      iconUrl: pickUserImageUrl(user) ?? existing?.iconUrl ?? null,
      lastSeenAt: now,
    });
  }

  #startPolling(accountId: string): void {
    if (this.#timers.has(accountId)) return;

    const interval = new JitteredInterval(
      this.options.refreshIntervalMs ?? DEFAULT_REFRESH_MS,
      () => this.refresh(accountId),
    );
    interval.start();
    this.#timers.set(accountId, interval);

    // The first refresh is what fills the list at all; `JitteredInterval` deliberately spreads its
    // first tick across the whole interval, which would leave the UI empty for minutes.
    void this.refresh(accountId);
  }
}
