import { APP_VERSION } from "@vrcz/shared";
import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { hostGuard, originGuard, sessionAuth, type TokenSource } from "../security/guards.ts";

/**
 * The control API — the private surface the vrc.zip UI and CLI talk to. See PLAN.md §1.8.
 *
 * Its own `Hono` instance on its own port, never a path prefix on the mirror: the byte-faithful
 * proxy must be structurally incapable of serving a control route, and separate instances make
 * that a property of the wiring rather than of careful middleware ordering.
 *
 * Everything the routes need arrives through `ControlDeps`. Nothing in this file imports the store,
 * the account manager, or the event bus — the handlers stay a thin translation between HTTP and a
 * set of async methods, which is also what makes them testable with a fake in a few lines.
 */

/** JSON as it crosses the wire. Local to this module so the control API owns no foreign types. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The 2FA challenges VRChat issues. `otp` is a one-time recovery code. */
export type TwoFactorMethod = "totp" | "emailOtp" | "otp";

export interface ControlAccount {
  id: string;
  displayName: string;
  /** Unix milliseconds, integer. */
  addedAt: number;
  enabled: boolean;
  /** Unix milliseconds, integer, or null when never seen. */
  lastSeenAt: number | null;
  /** Pipeline/login state, as the UI's status dot renders it. */
  connection: "connected" | "connecting" | "disconnected" | "needs-2fa";
  /**
   * An absolute VRChat image URL, or null. **The UI must load it through `GET /api/image`, never
   * directly** — `api.vrchat.cloud` image URLs require the account's auth cookie and the mandatory
   * User-Agent, neither of which a browser can supply, so a bare `<img src>` gets a 403.
   */
  iconUrl: string | null;
}

export interface RateLimitSnapshot {
  /** Requests permitted per second across all accounts. */
  limit: number;
  /** Tokens currently available. */
  remaining: number;
  /** Requests waiting on the limiter right now. */
  queued: number;
  /** Unix milliseconds when a 429 backoff lifts, or null when not backing off. */
  retryAfter: number | null;
}

/** Everything `GET /api/status` reports that this module cannot work out for itself. */
export interface StatusSnapshot {
  /** True when the master key sits in a plain file rather than the OS keychain. */
  degradedKeychain: boolean;
  /** Which keychain backend is in use, for the settings screen. */
  backend: string;
  /** Number of configured accounts. */
  accounts: number;
  rateLimit: RateLimitSnapshot;
}

export interface LoginInput {
  username: string;
  password: string;
}

export type LoginResult =
  | { status: "ok"; account: ControlAccount }
  | { status: "requires-2fa"; accountId: string; methods: TwoFactorMethod[] };

export interface VerifyTwoFactorInput {
  method: TwoFactorMethod;
  code: string;
}

/** A live VRChat game-client session, as reconstructed from the log watcher. */
export interface GameSession {
  id: number;
  accountId: string | null;
  displayName: string | null;
  /** Unix milliseconds, integer. */
  startedAt: number;
  vrMode: string | null;
  currentLocation: string | null;
  currentWorldId: string | null;
}

/**
 * An instance a self-invite can be aimed at, split the way VRChat's path template wants it:
 * `POST /invite/myself/to/{worldId}:{instanceId}`.
 *
 * Split rather than passed as one location string on purpose — the route validates and the
 * dependency interpolates, so a caller cannot smuggle a second path segment past the validator by
 * handing the implementation a raw string it would have to re-check.
 */
export interface InviteTarget {
  readonly worldId: string;
  readonly instanceId: string;
}

/** One row of the unified feed. */
export interface FeedEvent {
  id: number;
  /**
   * Null for events from a VRChat client signed into an account vrc.zip does not manage. That is a
   * normal state, not an error — see PLAN.md §1.7 on unlinked sessions.
   */
  accountId: string | null;
  /** Unix milliseconds, integer. */
  ts: number;
  sessionId: number | null;
  kind: string;
  subjectId: string | null;
  location: string | null;
  payload: JsonValue;
}

export interface EventQuery {
  accountId?: string;
  kind?: string;
  /** Already clamped by the route. */
  limit?: number;
  /** Unix milliseconds; return events strictly older than this. Feeds the infinite scroll. */
  before?: number;
}

/** A pending or recent VRChat notification: an invite, a friend request, a group announcement. */
export interface NotificationItem {
  id: string;
  accountId: string;
  /** Unix milliseconds, integer. */
  ts: number;
  type: string;
  senderUserId: string | null;
  senderDisplayName: string | null;
  message: string | null;
  seen: boolean;
  data: JsonValue;
}

export interface FriendPresence {
  id: string;
  displayName: string;
  /** VRChat's own status string: `active`, `join me`, `ask me`, `busy`, `offline`. */
  status: string;
  statusDescription: string | null;
  location: string | null;
  worldId: string | null;
  platform: string | null;
  /**
   * An absolute VRChat image URL, or null. **The UI must load it through `GET /api/image`, never
   * directly** — `api.vrchat.cloud` image URLs require the account's auth cookie and the mandatory
   * User-Agent, neither of which a browser can supply, so a bare `<img src>` gets a 403.
   */
  iconUrl: string | null;
  /** Unix milliseconds, integer, or null when unknown. */
  lastSeenAt: number | null;
}

/**
 * Settings are deliberately opaque here. The control API's job is to hand them to the UI and hand
 * a patch back; the schema belongs to whoever owns `settings.json`.
 */
export type Settings = { readonly [key: string]: JsonValue };
export type SettingsPatch = { readonly [key: string]: JsonValue };

/** A message pushed down `GET /api/stream`. */
export interface StreamEvent {
  type: string;
  /** Unix milliseconds, integer. */
  ts: number;
  payload: JsonValue;
}

/**
 * The daemon capabilities the control API needs, and nothing else.
 *
 * Narrow on purpose: every method here is one route's worth of work, which keeps the seam between
 * "HTTP" and "the daemon" small enough to hold in your head and lets the two be built in parallel.
 */
export interface ControlDeps {
  /** Backing data for `GET /api/status`. `version` is added by the route from `@vrcz/shared`. */
  status(): Promise<StatusSnapshot>;

  listAccounts(): Promise<ControlAccount[]>;
  /** Resolves to `requires-2fa` rather than throwing — a challenge is a success, not an error. */
  login(input: LoginInput): Promise<LoginResult>;
  verifyTwoFactor(accountId: string, input: VerifyTwoFactorInput): Promise<ControlAccount>;
  /** Removes the account, its secrets, and its rows. Throws `ControlError(404)` if unknown. */
  removeAccount(accountId: string): Promise<void>;

  /**
   * Sends this account an invite to `target`, so a game client already signed into it can travel
   * there by accepting a notification.
   *
   * This exists because `vrchat://launch?id=…` is the wrong tool once a client is running: the URI
   * starts a *second* client, and two clients on one account fight over it. A self-invite is what
   * the running client can act on, and it is what VRCX's "Invite Me" does. The deep link stays
   * correct for the case where nothing is running — that decision is the UI's, not the daemon's.
   *
   * `target` has already been validated by `parseInviteLocation`; the implementation interpolates
   * it into a path and must not accept an unvalidated one.
   */
  inviteSelfTo(accountId: string, target: InviteTarget): Promise<void>;

  /** Live game-client sessions — the ones with no `ended_at`. */
  listSessions(): Promise<GameSession[]>;
  listEvents(query: EventQuery): Promise<FeedEvent[]>;
  /** `null` means every account. */
  listFriends(accountId: string | null): Promise<FriendPresence[]>;
  /** `null` means every account. Notifications are state, not feed history — see the sink. */
  listNotifications(accountId: string | null): Promise<NotificationItem[]>;
  markNotificationSeen(id: string): Promise<void>;

  /**
   * Fetches one VRChat image through an online account, cached.
   *
   * `null` means upstream said the image does not exist (a 404), which the route turns into a 404.
   * No online account is a `ControlError(503, "no_account")` from the implementation — the daemon
   * has no cookie to fetch with, and pretending otherwise would return a broken image forever.
   *
   * The URL arriving here has **already passed the host allowlist**; see `parseImageUrl`.
   */
  fetchImage(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;

  getSettings(): Promise<Settings>;
  /** Merges the patch and resolves to the settings as they now stand. */
  updateSettings(patch: SettingsPatch): Promise<Settings>;

  /**
   * Subscribes to the live event bus for `GET /api/stream`. Returns an unsubscribe function, which
   * the route calls when the socket closes — a leak here is a leak per browser tab.
   */
  subscribeEvents(listener: (event: StreamEvent) => void): () => void;
}

/** Status codes a dependency may ask for. Anything not on this list is a bug, and so a 500. */
export type ControlErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503;

/** Thrown by a `ControlDeps` implementation to choose the status code. Anything else is a 500. */
export class ControlError extends Error {
  readonly status: ControlErrorStatus;
  readonly code: string;

  constructor(status: ControlErrorStatus, code: string, message?: string) {
    super(message ?? code);
    this.name = "ControlError";
    this.status = status;
    this.code = code;
  }
}

export interface ControlAppOptions {
  /** The port this instance will be bound to. The `Host` allowlist is built from it. */
  port: number;
  deps: ControlDeps;
  /** Resolves the session token. A function, so a rotated token needs no re-wiring. */
  token: TokenSource;
}

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;

/**
 * The only hosts `GET /api/image` will fetch from.
 *
 * **This is the daemon's SSRF boundary.** Every other outbound request the daemon makes goes to a
 * path it chose itself against `api.vrchat.cloud`; this is the one route where the *caller* names
 * the URL, and the caller is a web page. Without this list, anything that can reach the control
 * port — a malicious plugin's UI, a stored URL in a friend record VRChat let someone set — could
 * make the daemon fetch `http://169.254.169.254/`, `http://127.0.0.1:<proxy port>/`, or any
 * intranet host, and read the response back.
 */
const IMAGE_HOSTS: ReadonlySet<string> = new Set([
  "api.vrchat.cloud",
  "assets.vrchat.com",
  "files.vrchat.cloud",
]);

/** How long a browser may keep an image without revalidating. Icons change on the order of months. */
const IMAGE_CACHE_CONTROL = "private, max-age=604800, immutable";

/**
 * Validates and normalises the `url` query parameter of `GET /api/image`.
 *
 * Throws `ControlError(400, "invalid_url")` for anything the daemon must not fetch. The host match
 * is **exact** — deliberately not a suffix test, because `evil-api.vrchat.cloud.attacker.tld` ends
 * with nothing useful and `api.vrchat.cloud.attacker.tld` ends with `.attacker.tld`, yet a
 * `endsWith("vrchat.cloud")` check passes the first and a naive `includes` passes both.
 */
export function parseImageUrl(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new ControlError(400, "invalid_url", "url is required");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlError(400, "invalid_url", "url is not a URL");
  }

  // Plain http is refused rather than upgraded: an upgrade would hide a caller that meant to reach
  // something local, and VRChat serves every image over https anyway.
  if (url.protocol !== "https:") {
    throw new ControlError(400, "invalid_url", "url must be https");
  }

  // `URL` has already lowercased and punycoded the host, so this compares normalised forms.
  if (!IMAGE_HOSTS.has(url.hostname)) {
    throw new ControlError(400, "invalid_url", `host ${url.hostname} is not a VRChat image host`);
  }

  return url.toString();
}

/**
 * The ETag for an image URL: a hash of the (normalised) URL, not of the bytes.
 *
 * Hashing the URL means a conditional request is answered without fetching or even reading the
 * image — which is the entire point, since the expensive part is the upstream request. VRChat's
 * image URLs carry a file *version* in the path, so new bytes arrive under a new URL.
 */
export function imageETag(url: string): string {
  return `"${new Bun.CryptoHasher("sha256").update(url, "utf8").digest("hex").slice(0, 32)}"`;
}

/** `If-None-Match` is a comma-separated list, and may weaken each entry with a `W/` prefix. */
function matchesETag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((entry) => entry.trim().replace(/^W\//, ""))
    .includes(etag);
}

/**
 * The words VRChat uses for "nowhere you can follow". `/api/friends` and the log both pass these
 * through raw, so they reach the UI and would reach here if nothing stopped them.
 */
const UNJOINABLE_LOCATIONS: ReadonlySet<string> = new Set(["", "offline", "private", "traveling"]);

/** `wrld_` plus the id body. Length-capped so a pathological string cannot become a huge path. */
const WORLD_ID_PATTERN = /^wrld_[0-9A-Za-z_-]{1,64}$/;

/**
 * An instance id *with its tags* — `12345~hidden(usr_…)~region(eu)~nonce(…)`.
 *
 * The whole tail is sent, not just the number before the first `~`: the tags carry the access
 * level and the nonce, and VRChat rejects a self-invite to a closed instance quoted without them.
 * Every character this allows is left alone by percent-encoding, which is what makes it safe to
 * interpolate into a path directly — and the pattern is an allowlist precisely so `/`, `?`, `#`
 * and `%` cannot appear and turn one path segment into several.
 */
const INSTANCE_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_.~()-]{0,255}$/;

/**
 * Validates a VRChat location string and splits it for `POST /invite/myself/to/{world}:{instance}`.
 *
 * Server-side and strict, rather than trusting the caller: the UI is a web page, and the only
 * thing standing between a wrong location and a malformed VRChat request is this function. Every
 * rejection is a 400 with `invalid_location` so the UI branches on a code, not on a sentence.
 */
export function parseInviteLocation(raw: string | undefined): InviteTarget {
  if (raw === undefined) {
    throw new ControlError(400, "invalid_location", "location is required");
  }
  // `traveling:wrld_…` is a destination the client is mid-hop to. It has no instance to be invited
  // into yet, and by the time an invite arrived the client would be somewhere else.
  if (UNJOINABLE_LOCATIONS.has(raw) || raw.startsWith("traveling")) {
    throw new ControlError(
      400,
      "invalid_location",
      `${raw || "an empty location"} is not joinable`,
    );
  }

  // `indexOf`, not `split(":", 2)`: the instance id is everything after the *first* colon, and
  // splitting would silently discard anything after a second one instead of rejecting it.
  const separator = raw.indexOf(":");
  if (separator === -1) {
    throw new ControlError(400, "invalid_location", "location names no instance");
  }

  const worldId = raw.slice(0, separator);
  const instanceId = raw.slice(separator + 1);

  if (!WORLD_ID_PATTERN.test(worldId)) {
    throw new ControlError(400, "invalid_location", `${worldId} is not a world id`);
  }
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new ControlError(400, "invalid_location", "instance id contains something unexpected");
  }

  return { worldId, instanceId };
}

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

/** The Bun websocket handler for this app. `bind.ts` hands it to `Bun.serve`. */
export const controlWebSocketHandler = websocket;

export function createControlApp({ port, deps, token }: ControlAppOptions) {
  const app = new Hono()
    .use(hostGuard(port))
    .use(originGuard(port))
    .use(sessionAuth(token))

    .get("/api/status", async (c) => {
      const snapshot = await deps.status();
      return c.json({ version: APP_VERSION, ...snapshot });
    })

    .get("/api/accounts", async (c) => c.json(await deps.listAccounts()))

    .post("/api/accounts/login", async (c) => {
      const body = await readJsonObject(c.req.raw);
      const username = stringField(body, "username");
      const password = stringField(body, "password");
      if (username === undefined || password === undefined) {
        throw new ControlError(400, "invalid_body", "username and password are required");
      }
      return c.json(await deps.login({ username, password }));
    })

    .post("/api/accounts/:id/verify-2fa", async (c) => {
      const body = await readJsonObject(c.req.raw);
      const method = stringField(body, "method");
      const code = stringField(body, "code");
      if (!isTwoFactorMethod(method) || code === undefined) {
        throw new ControlError(400, "invalid_body", "method and code are required");
      }
      const account = await deps.verifyTwoFactor(c.req.param("id"), { method, code });
      return c.json({ status: "ok" as const, account });
    })

    .delete("/api/accounts/:id", async (c) => {
      await deps.removeAccount(c.req.param("id"));
      return c.json({ status: "ok" as const });
    })

    /*
     * "Take the client I already have running to this instance."
     *
     * The account is in the path because *which* account travels is the whole question when two
     * clients are running — the caller decides, the daemon does not guess. The location arrives as
     * one string because that is the shape everything upstream of here already has (a friend's
     * `location`, a session's `currentLocation`); splitting it is this route's job.
     */
    .post("/api/accounts/:id/invite-self", async (c) => {
      const body = await readJsonObject(c.req.raw);
      const target = parseInviteLocation(stringField(body, "location"));
      await deps.inviteSelfTo(c.req.param("id"), target);
      return c.json({ status: "ok" as const });
    })

    .get("/api/sessions", async (c) => c.json(await deps.listSessions()))

    .get("/api/events", async (c) => {
      const query: EventQuery = { limit: clampLimit(c.req.query("limit")) };
      const accountId = nonEmpty(c.req.query("accountId"));
      if (accountId !== undefined) query.accountId = accountId;
      const kind = nonEmpty(c.req.query("kind"));
      if (kind !== undefined) query.kind = kind;
      const before = integerParam(c.req.query("before"));
      if (before !== undefined) query.before = before;
      return c.json(await deps.listEvents(query));
    })

    .get("/api/friends", async (c) => {
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.listFriends(accountId));
    })

    .get("/api/notifications", async (c) => {
      const accountId = nonEmpty(c.req.query("accountId")) ?? null;
      return c.json(await deps.listNotifications(accountId));
    })

    .post("/api/notifications/:id/seen", async (c) => {
      await deps.markNotificationSeen(c.req.param("id"));
      return c.body(null, 204);
    })

    /*
     * The image proxy. `GET /api/image?url=<encodeURIComponent(absolute url)>`.
     *
     * A browser cannot load a VRChat image URL itself — they require the account's auth cookie and
     * the mandatory User-Agent — so every avatar in the UI comes through here. The route stays a
     * thin translation: validation, caching headers, and a call into `deps`.
     */
    .get("/api/image", async (c) => {
      const url = parseImageUrl(c.req.query("url"));
      const etag = imageETag(url);

      // Answered before touching `deps`: the whole value of an ETag here is skipping the upstream
      // fetch, and the tag is derived from the URL alone precisely so that is possible.
      if (matchesETag(c.req.header("If-None-Match"), etag)) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": IMAGE_CACHE_CONTROL },
        });
      }

      const image = await deps.fetchImage(url);
      if (image === null) throw new ControlError(404, "image_not_found");

      return new Response(image.bytes, {
        status: 200,
        headers: {
          "Content-Type": image.contentType,
          "Cache-Control": IMAGE_CACHE_CONTROL,
          ETag: etag,
        },
      });
    })

    .get("/api/settings", async (c) => c.json(await deps.getSettings()))

    .put("/api/settings", async (c) => {
      const body = await readJsonObject(c.req.raw);
      if (body === undefined) throw new ControlError(400, "invalid_body", "expected a JSON object");
      return c.json(await deps.updateSettings(body));
    })

    /*
     * The live feed. Same guards as every other route on this port — the token arrives as
     * `?token=`, because a browser WebSocket cannot set request headers.
     */
    .get(
      "/api/stream",
      upgradeWebSocket(() => {
        let unsubscribe: (() => void) | undefined;
        return {
          onOpen(_event, ws) {
            unsubscribe = deps.subscribeEvents((event) => {
              ws.send(JSON.stringify(event));
            });
            ws.send(JSON.stringify({ type: "ready", ts: Date.now(), payload: null }));
          },
          onClose() {
            unsubscribe?.();
            unsubscribe = undefined;
          },
        };
      }),
    )

    .onError((error, c) => {
      if (error instanceof ControlError) {
        return c.json({ error: error.code, message: error.message }, error.status);
      }
      return c.json({ error: "internal_error", message: String(error) }, 500);
    });

  return app;
}

/** The type the UI feeds to `hc<ControlApp>` for end-to-end typed calls. */
export type ControlApp = ReturnType<typeof createControlApp>;

async function readJsonObject(request: Request): Promise<Record<string, JsonValue> | undefined> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, JsonValue>;
}

function stringField(body: Record<string, JsonValue> | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isTwoFactorMethod(value: string | undefined): value is TwoFactorMethod {
  return value === "totp" || value === "emailOtp" || value === "otp";
}

function nonEmpty(raw: string | undefined): string | undefined {
  return raw === undefined || raw === "" ? undefined : raw;
}

function clampLimit(raw: string | undefined): number {
  const parsed = integerParam(raw);
  if (parsed === undefined || parsed <= 0) return DEFAULT_EVENT_LIMIT;
  return Math.min(parsed, MAX_EVENT_LIMIT);
}

function integerParam(raw: string | undefined): number | undefined {
  const value = nonEmpty(raw);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
