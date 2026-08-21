/**
 * The typed client for the local daemon's control API.
 *
 * This file is the UI's copy of the daemon contract. It deliberately does not import from
 * `daemon/` — the UI is a browser bundle and the daemon is a Bun program; sharing types across
 * that boundary belongs in `@vrcz/shared` once the shapes have stopped moving. Until then this
 * is the single place in the UI where a wire shape is written down, and every screen reads its
 * types from here.
 *
 * Every shape below was read off `daemon/src/servers/control.ts` and
 * `daemon/src/wiring/control-deps.ts`, not guessed. All timestamps are integer unix milliseconds.
 */

import { API_BASE } from "./config.ts";
import { getToken } from "./session.ts";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * How the daemon currently stands with an account. This is about credentials and the pipeline
 * socket, never about a running game client — those are `GameSession`s, a different set.
 */
export type AccountConnection = "connected" | "connecting" | "disconnected" | "needs-2fa";

/** A VRChat account the daemon holds credentials for. */
export interface Account {
  readonly id: string;
  readonly displayName: string;
  /** Unix ms the account was added to vrc.zip. */
  readonly addedAt: number;
  readonly enabled: boolean;
  /** Unix ms of the last pipeline frame attributed to this account, or null when never seen. */
  readonly lastSeenAt: number | null;
  readonly connection: AccountConnection;
  /**
   * Absolute VRChat user-icon URL, or null when the account has none cached yet. Never put this
   * in an `<img src>` directly — VRChat's image host wants the account's auth cookie and a
   * User-Agent the browser cannot set, and answers a bare request with 401/403. Run it through
   * `imageUrl()` below, which points at the daemon's same-origin streaming proxy.
   */
  readonly iconUrl: string | null;
}

export interface RateLimitStatus {
  /** Requests permitted per second across all accounts. */
  readonly limit: number;
  /** Tokens currently available. */
  readonly remaining: number;
  /** Requests waiting on the limiter right now. */
  readonly queued: number;
  /** Unix ms at which a 429 backoff lifts, or null when not backing off. */
  readonly retryAfter: number | null;
}

export interface DaemonStatus {
  readonly version: string;
  /**
   * True when the OS keychain was unavailable and the master key fell back to a plain 0600 file.
   * The UI must say so loudly and permanently while it holds — see `KeychainWarning.svelte`.
   */
  readonly degradedKeychain: boolean;
  /** Which secret backend is in use. A free-form name from the daemon, shown as-is in settings. */
  readonly backend: string;
  readonly accounts: number;
  readonly rateLimit: RateLimitStatus;
}

/** The 2FA challenges VRChat issues. `otp` is a one-time recovery code, not an app code. */
export type TwoFactorMethod = "totp" | "emailOtp" | "otp";

export type LoginResult =
  | { readonly status: "ok"; readonly account: Account }
  | {
      readonly status: "requires-2fa";
      readonly accountId: string;
      readonly methods: readonly TwoFactorMethod[];
    };

export interface VerifyTwoFactorResult {
  readonly status: "ok";
  readonly account: Account;
}

/**
 * A running VRChat game client, reconstructed from its log file.
 *
 * Sessions and accounts are different sets. A client can run without the daemon knowing which
 * account it belongs to (`accountId: null` — "unlinked"), and an account can be signed in with no
 * client running at all. Six accounts and two sessions is a normal state, and no screen in this
 * app is allowed to imply otherwise.
 */
export interface GameSession {
  /** The store's integer row id. Not the identifier the event stream uses — see `stream.ts`. */
  readonly id: number;
  readonly accountId: string | null;
  /** The display name the client authenticated as, or null while the log has not said yet. */
  readonly displayName: string | null;
  readonly startedAt: number;
  /** The raw VR mode string out of the log (`Standalone`, `Oculus`, `None`, …), or null. */
  readonly vrMode: string | null;
  /** Full instance location, e.g. `wrld_xxx:12345~friends(usr_xxx)`. */
  readonly currentLocation: string | null;
  readonly currentWorldId: string | null;
}

/**
 * Bus kinds the UI has vocabulary for. Deliberately a widened union: the daemon grows kinds faster
 * than this file does, and an unrecognised kind must still list rather than disappear from a feed
 * or break a filter.
 */
export type KnownEventKind =
  | "friend.online"
  | "friend.offline"
  | "friend.active"
  | "friend.location"
  | "friend.updated"
  | "friend.added"
  | "friend.removed"
  | "user.updated"
  | "user.location"
  | "notification.received"
  | "notification.received_v2"
  | "notification.updated"
  | "notification.deleted"
  | "notification.responded"
  | "notification.seen"
  | "notification.hidden"
  | "notification.cleared"
  | "gamelog.player_join"
  | "gamelog.player_leave"
  | "gamelog.world_enter"
  | "gamelog.location_join"
  | "gamelog.portal_spawn"
  | "gamelog.destination_set"
  | "gamelog.left_room"
  | "gamelog.join_failed"
  | "gamelog.screenshot"
  | "gamelog.app_quit"
  | "gamelog.vr_mode"
  | "gamelog.authenticated"
  | "session.start"
  | "session.update"
  | "session.end"
  | "account.state"
  | "pipeline.state"
  | "economy.update";

export type EventKind = KnownEventKind | (string & {});

/** The top-level namespace of a dotted bus kind: `gamelog.player_join` -> `gamelog`. */
export type EventFamily =
  | "friend"
  | "user"
  | "notification"
  | "gamelog"
  | "session"
  | "account"
  | "pipeline"
  | "group"
  | "instance"
  | "economy"
  | "content"
  | "other";

export const EVENT_FAMILIES: readonly EventFamily[] = [
  "friend",
  "notification",
  "gamelog",
  "session",
  "user",
  "group",
  "instance",
  "account",
  "pipeline",
  "economy",
  "content",
  "other",
];

export function familyOf(kind: string): EventFamily {
  const head = kind.split(".", 1)[0] ?? "";
  return (EVENT_FAMILIES as readonly string[]).includes(head) ? (head as EventFamily) : "other";
}

/** One row of the unified feed. `payload` is the bus event's payload, shape-per-kind. */
export interface FeedEvent {
  readonly id: number;
  /** Null for a client signed into an account vrc.zip does not manage. Normal, not an error. */
  readonly accountId: string | null;
  readonly ts: number;
  /**
   * Null on every stored row today — the feed writer does not yet resolve the log watcher's string
   * session id onto the store's integer row id. Live stream frames do carry one.
   */
  readonly sessionId: number | null;
  readonly kind: EventKind;
  readonly subjectId: string | null;
  readonly location: string | null;
  readonly payload: unknown;
}

/** VRChat's own presence strings. Anything else is passed through and rendered as unknown. */
export type FriendStatus = "active" | "join me" | "ask me" | "busy" | "offline" | (string & {});

export interface Friend {
  readonly id: string;
  readonly displayName: string;
  readonly status: FriendStatus;
  readonly statusDescription: string | null;
  /** `offline`, `private`, `traveling`, or a full instance id. Null when unknown. */
  readonly location: string | null;
  readonly worldId: string | null;
  /** `standalonewindows`, `android`, … or null. */
  readonly platform: string | null;
  readonly lastSeenAt: number | null;
  /** Absolute VRChat user-icon URL, or null. Load it through `imageUrl()`, never directly. */
  readonly iconUrl: string | null;
}

/**
 * One VRChat user, merged from VRChat's own profile and vrc.zip's local record of them.
 * Read off `UserDetail` in `daemon/src/servers/control.ts`.
 *
 * `GET /users/{id}` returns *fewer fields* for a caller who is not a friend — see PROGRESS.md
 * §Gotchas — which is why `accountId` is part of the answer rather than a detail of how it was
 * fetched, and why `isFriend` is worth carrying: it is the daemon saying plainly which of the two
 * shapes this is, so the modal never has to infer it from a run of empty fields.
 *
 * `friendedAt` and `note` are the two fields VRChat has never heard of. They come from vrc.zip's
 * own store, and they are what makes this screen worth having.
 */
export interface UserProfile {
  readonly id: string;
  readonly displayName: string;
  /** Whose eyes this was seen through. */
  readonly accountId: string;
  /** Unix ms the VRChat body was fetched. */
  readonly fetchedAt: number;
  /** True when the daemon answered from `user_cache` rather than a live fetch. */
  readonly cached: boolean;
  readonly bio: string | null;
  readonly bioLinks: readonly string[];
  readonly pronouns: string | null;
  readonly status: FriendStatus;
  readonly statusDescription: string | null;
  /** VRChat's coarser presence field (`online`/`active`/`offline`), distinct from `status`. */
  readonly state: string | null;
  /** VRChat's own tag strings (`system_trust_veteran`, `language_eng`, …). An open set. */
  readonly tags: readonly string[];
  /** Resolved out of `tags` by the daemon: `trusted`, `known`, `user`, `visitor`, … */
  readonly trustLevel: string;
  readonly platform: string | null;
  readonly lastPlatform: string | null;
  /** `offline`, `private`, `traveling`, `""`, or a full instance id — VRChat's raw string. */
  readonly location: string | null;
  readonly worldId: string | null;
  readonly isFriend: boolean;
  /** Unix ms. VRChat sends a date string; the daemon converts, so the wire stays integer ms. */
  readonly dateJoined: number | null;
  readonly lastLogin: number | null;
  /** Absolute VRChat user-icon URL, or null. Load it through `imageUrl()`, never directly. */
  readonly iconUrl: string | null;
  /** Unix ms this account first recorded the friendship. Null when never friends. */
  readonly friendedAt: number | null;
  /** The local, private note. Null when unset. */
  readonly note: string | null;
  readonly noteUpdatedAt: number | null;

  /**
   * VRChat's age-verification state: `verified`, `18+`, `hidden`, or null. `hidden` means the
   * user has one and chose not to publish it, which is **not** the same as not having one — the
   * UI must not render "unverified" for it, and does not. See `ageVerifiedLabel` in `format.ts`.
   */
  readonly ageVerificationStatus: string | null;
  readonly ageVerified: boolean;
  /**
   * The profile banner, an absolute VRChat URL — through `imageUrl()`, never directly.
   *
   * Null is the common case: most users have never set one. The header is built to look finished
   * without it rather than to leave a gap where an image should have been.
   */
  readonly bannerUrl: string | null;
  /** VRChat's own classification of the banner it sent (`profilePicOverride`, `none`, …). */
  readonly bannerType: string | null;
  /**
   * The group this user chose to display beside their name, or null.
   *
   * **Null is the ordinary answer** — most people represent no group — and it arrives on a plain
   * 200. It is not an empty state to apologise for, and not a reason to draw a placeholder.
   */
  readonly representedGroup: UserGroup | null;
}

/**
 * The identifier is `id`. VRChat's own payload calls it `groupId` and additionally carries a
 * separate `id` meaning the *membership row*, which is a different thing entirely — the daemon
 * normalises that away and sends the group's own id as `id`, like every other entity here.
 *
 * This mismatched once and it is worth remembering how it presented: the daemon sent `id`, this
 * type said `groupId`, and the Groups tab keyed its list on `group.groupId`. Every key was
 * `undefined`, which Svelte 5 treats as a hard error, so the tab died while the network tab showed
 * a perfectly good 200. A wire contract that only the type system believes is not a contract.
 */
export interface UserGroup {
  readonly id: string;
  readonly name: string;
  /** The short code shown as `NAME.1234`, or null when VRChat did not send one. */
  readonly shortCode: string | null;
  readonly discriminator: string | null;
  readonly description: string | null;
  readonly memberCount: number | null;
  /** Absolute VRChat URLs. Load through `imageUrl()`, never directly. */
  readonly iconUrl: string | null;
  readonly bannerUrl: string | null;
  /** VRChat's group privacy string — `default` or `private`. Null when it did not say. */
  readonly privacy: string | null;
  readonly isRepresenting: boolean;
}

/** A friend the asking account and the viewed user have in common. */
export interface MutualFriend {
  readonly id: string;
  readonly displayName: string;
  /** Resolved by the daemon out of VRChat's tags, the same way `UserProfile.trustLevel` is. */
  readonly trustLevel: string;
  readonly status: FriendStatus;
  readonly iconUrl: string | null;
}

/**
 * One page of mutual friends.
 *
 * Paged on purpose: two people with a thousand friends each have a mutual list nobody wants
 * fetched in one breath, and the daemon walks a friend list to compute it. `hasMore` is the
 * daemon's word for it, not a guess from the page length.
 */
export interface MutualFriendPage {
  readonly users: readonly MutualFriend[];
  readonly hasMore: boolean;
}

/** The window into the mutual-friends list. `n` is VRChat's own name for a page size. */
export interface MutualFriendQuery {
  readonly accountId?: string | undefined;
  readonly n?: number | undefined;
  readonly offset?: number | undefined;
}

/** What `PUT /api/users/:id/note` answers with. `note` is null when the note was cleared. */
export interface UserNote {
  readonly accountId: string;
  readonly userId: string;
  readonly note: string | null;
  readonly updatedAt: number | null;
}

/** The daemon's cap (`MAX_NOTE_LENGTH`). Enforced here too, so the 400 is never the first hint. */
export const MAX_NOTE_LENGTH = 256;

/**
 * One row of a VRChat notification inbox, as the daemon stores it.
 *
 * Rows are never deleted — VRChat's `clear-notification` frame carries no content at all, so
 * deleting on it would mean guessing which rows it meant. `seen` is therefore the only thing that
 * changes, and the screen filters on it rather than waiting for rows to disappear.
 */
export interface NotificationItem {
  readonly id: string;
  readonly accountId: string;
  readonly ts: number;
  /**
   * VRChat's own type string: `friendRequest`, `invite`, `requestInvite`, `message`, `votetokick`,
   * group announcements, and whatever they add next. An open set — unknown types render
   * generically rather than being dropped.
   */
  readonly type: string;
  readonly senderUserId: string | null;
  readonly senderDisplayName: string | null;
  readonly message: string | null;
  readonly seen: boolean;
  readonly data: unknown;
}

/**
 * Just enough of a world to render `wrld_0ae3e886-52e…` as somewhere a person has heard of.
 *
 * The shape the **batch** resolver serves, and small on purpose: a feed page is a hundred rows and
 * a row needs a name, a thumbnail and an author — not a tag list and a visit count a hundred times
 * over. Read off `WorldSummary` in `daemon/src/servers/control.ts`.
 */
export interface WorldSummary {
  readonly id: string;
  /** The daemon falls back to the id, so this is never empty. */
  readonly name: string;
  /** Absolute VRChat URL. Never an `<img src>` — run it through `imageUrl()`. */
  readonly thumbnailImageUrl: string | null;
  readonly authorName: string | null;
  readonly capacity: number | null;
}

/** The full world record, for the world modal. All timestamps are integer unix milliseconds. */
export interface WorldDetail extends WorldSummary {
  readonly description: string | null;
  readonly authorId: string | null;
  /** Absolute VRChat URL. Through `imageUrl()`, never directly. */
  readonly imageUrl: string | null;
  readonly recommendedCapacity: number | null;
  /** VRChat's own tag strings (`author_tag_…`, `system_approved`, …). An open set. */
  readonly tags: readonly string[];
  /** `public`, `private`, `hidden` — VRChat's word for who may find this world. */
  readonly releaseStatus: string | null;
  readonly visits: number | null;
  readonly favorites: number | null;
  /** VRChat's own metrics. Passed through verbatim; vrc.zip derives nothing from them. */
  readonly heat: number | null;
  readonly popularity: number | null;
  /**
   * How many people are in this world across every instance, as of `fetchedAt` — which under the
   * daemon's cache TTL can be hours old. For "who is in *this* instance", read the instance.
   */
  readonly occupants: number | null;
  /** Null for an unpublished world — VRChat sends the literal string `"none"`, the daemon nulls it. */
  readonly publicationDate: number | null;
  readonly labsPublicationDate: number | null;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly version: number | null;
  readonly fetchedAt: number;
  /** True when the daemon answered from `world_cache` rather than a live fetch. */
  readonly cached: boolean;
}

/** The most ids `GET /api/worlds` accepts at once — the daemon 400s on more. */
export const MAX_WORLD_IDS = 50;

/** One instance's own record: the live counts, the access type, the region. */
export interface InstanceInfo {
  readonly worldId: string;
  /** The instance id *with* its tags, as VRChat quotes it. */
  readonly instanceId: string;
  /** `public`, `hidden`, `friends`, `private`, `group` — VRChat's own word, not `parseLocation`'s. */
  readonly type: string | null;
  readonly ownerId: string | null;
  readonly region: string | null;
  readonly capacity: number | null;
  readonly userCount: number | null;
  /** VRChat sends both `userCount` and `n_users` and they can disagree; both come through. */
  readonly nUsers: number | null;
  readonly full: boolean;
  readonly canRequestInvite: boolean;
  /** Unix ms, or null while the instance is open. */
  readonly closedAt: number | null;
  readonly hardClose: boolean | null;
  readonly queueEnabled: boolean;
  readonly queueSize: number | null;
  readonly tags: readonly string[];
  readonly active: boolean;
  /** Free: VRChat embeds the whole world record in the instance response. */
  readonly world: WorldSummary | null;
}

/**
 * The answer to `GET /api/instances`.
 *
 * Shaped like `InstanceUsers`, `unavailable` included, so callers branch the same way on both.
 * Two upstream answers land in `unavailable` and **neither is a failure**: a closed instance 404s
 * — every instance ends that way — and an id VRChat dislikes comes back as a literal `null` body
 * with a 200.
 */
export interface InstanceDetail {
  readonly location: string;
  readonly fetchedAt: number;
  readonly source: "instance" | "unavailable";
  readonly instance: InstanceInfo | null;
}

export interface SettingsPorts {
  readonly ui: number;
  readonly proxy: number;
  readonly control: number;
}

export interface Settings {
  /**
   * The contact address VRChat sees in the User-Agent. First-run critical: the daemon refuses to
   * talk to VRChat at all until this is set, and `POST /api/accounts/login` 409s with
   * `setup_required`.
   */
  readonly contact: string;
  readonly ports: SettingsPorts;
  /** `local.vrc.zip` instead of `127.0.0.1`. Opt-in; needs a daemon restart to take effect. */
  readonly useLocalDomain: boolean;
  /** Overrides log discovery. Empty means "whatever discovery found". */
  readonly logDirectories: readonly string[];
  readonly openBrowserOnStart: boolean;
}

/** The subset of `Settings` that `PUT /api/settings` accepts. Ports are read-only over the wire. */
export interface SettingsPatch {
  readonly contact?: string;
  readonly useLocalDomain?: boolean;
  readonly logDirectories?: readonly string[];
  readonly openBrowserOnStart?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every failure this client can produce, tagged so screens branch on a field instead of
 * string-matching a message. `offline` means the request never reached a server at all — that is
 * the only state that earns the full-screen "daemon not running" treatment.
 */
export type ApiErrorKind = "offline" | "unauthorized" | "http" | "malformed";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** The daemon's machine-readable code — the `error` field of its JSON error body. */
  readonly code: string | null;

  constructor(kind: ApiErrorKind, message: string, status: number | null, code: string | null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export function isOffline(error: unknown): boolean {
  return error instanceof ApiError && error.kind === "offline";
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * True for the 503 `GET /api/users/:id` answers with when no account is signed in.
 *
 * This is a normal state, not a failure: a user profile can only be read through somebody's
 * credentials, and vrc.zip may hold none that are online. Callers say so in words rather than
 * showing an error.
 */
export function isNoAccountOnline(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

/** True for a 404 — the daemon looked and VRChat does not know that user id. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** True for the 409 the daemon returns when no contact address has been configured yet. */
export function isSetupRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "setup_required";
}

/** A human-facing sentence for any thrown value, so no screen ever renders `[object Object]`. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Notified when the daemon's reachability flips, so the shell can swap in the offline screen. */
type ReachabilityListener = (reachable: boolean) => void;

const reachabilityListeners = new Set<ReachabilityListener>();
let lastReachable: boolean | null = null;

export function onReachabilityChange(listener: ReachabilityListener): () => void {
  reachabilityListeners.add(listener);
  return () => {
    reachabilityListeners.delete(listener);
  };
}

function reportReachable(reachable: boolean): void {
  if (lastReachable === reachable) return;
  lastReachable = reachable;
  for (const listener of reachabilityListeners) listener(reachable);
}

type QueryValue = string | number | boolean | null | undefined;

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly signal?: AbortSignal;
}

function buildUrl(path: string, query: RequestOptions["query"]): string {
  const base = `${API_BASE}${path}`;
  if (query === undefined) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs === "" ? base : `${base}?${qs}`;
}

/**
 * The same-origin path that serves a VRChat user icon.
 *
 * VRChat's image host requires the owning account's auth cookie and a User-Agent the browser is
 * not allowed to set, so an `<img src={account.iconUrl}>` gets a 401/403 every time. The daemon
 * fetches the bytes with those headers attached and streams them back from `GET /api/image`, which
 * is same-origin and therefore carries the page's `vrcz_session` cookie automatically.
 *
 * Returns `undefined` for a missing icon so the value can be handed straight to `<AvatarImage>` —
 * bits-ui treats a falsy `src` as a load error and leaves the initials fallback in place.
 */
export function imageUrl(iconUrl: string | null | undefined): string | undefined {
  if (iconUrl === null || iconUrl === undefined || iconUrl === "") return undefined;
  return buildUrl("/image", { url: iconUrl });
}

/** The daemon's error body is `{ error: <code>, message: <sentence> }`. */
async function readErrorBody(
  response: Response,
): Promise<{ message: string; code: string | null }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const code =
        typeof record.error === "string"
          ? record.error
          : typeof record.code === "string"
            ? record.code
            : null;
      const message = typeof record.message === "string" ? record.message : null;
      if (message !== null) return { message, code };
      if (code !== null) return { message: code, code };
    }
  } catch {
    /* not JSON — fall through to the status line */
  }
  return { message: response.statusText || `HTTP ${String(response.status)}`, code: null };
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    // The UI port hands out an HttpOnly `vrcz_session` cookie on first navigation; sending it
    // keeps requests authenticated even if the in-memory token is ever lost.
    credentials: "same-origin",
  };
  if (options.signal !== undefined) init.signal = options.signal;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (cause) {
    // An abort is the caller withdrawing, not the daemon dying. Reporting it as unreachable
    // would flash the offline screen every time a screen unmounts with a request in flight.
    if (isAbort(cause)) throw cause;
    reportReachable(false);
    throw new ApiError("offline", "The vrc.zip daemon is not reachable.", null, null);
  }

  reportReachable(true);

  if (response.status === 401 || response.status === 403) {
    // The token is deliberately *not* discarded here. It arrived in the launch URL and cannot be
    // re-obtained from inside the page, so throwing it away turns a transient 401 into a dead tab.
    const { message, code } = await readErrorBody(response);
    throw new ApiError("unauthorized", message, response.status, code);
  }

  if (!response.ok) {
    const { message, code } = await readErrorBody(response);
    throw new ApiError("http", message, response.status, code);
  }

  if (response.status === 204) return undefined as T;

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      "malformed",
      "The daemon sent a response this build cannot read.",
      response.status,
      null,
    );
  }
}

/** One person as VRChat describes them, scoped to the instance that was asked about. */
export interface InstanceUser {
  readonly id: string;
  readonly displayName: string;
  /** Absolute VRChat URL. Never an `<img src>` — run it through `imageUrl()` from `api.ts`. */
  readonly iconUrl: string | null;
  /** `trusted`, `known`, `user`, `basic`, `visitor`, … Resolved out of VRChat's tags. */
  readonly trustLevel: string;
  /**
   * `verified`, `18+`, `hidden`, or null. `hidden` means the person *is* verified and chose not to
   * publish it, so it must never render as "unverified" — see `ageVerifiedLabel` in `format.ts`.
   */
  readonly ageVerificationStatus: string | null;
  readonly ageVerified: boolean;
  /** Whether the *asking account* is friends with them. Two accounts get two different answers. */
  readonly isFriend: boolean;
  readonly platform: string | null;
  readonly developerType: string | null;
}

export interface InstanceUsers {
  readonly location: string;
  readonly fetchedAt: number;
  readonly source: "instance" | "unavailable";
  readonly users: readonly InstanceUser[];
}

function rosterRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rosterStr(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Defensive decoding, in the same spirit as the pipeline's.
 *
 * A row missing an `id` or a `displayName` is dropped rather than rendered as a blank name, and
 * every optional field is narrowed rather than cast. The cost of being wrong here is a roster row
 * that lies about somebody's trust rank, which is worse than a row with no chips on it.
 */
function decodeUser(value: unknown): InstanceUser | null {
  const row = rosterRecord(value);
  if (row === null) return null;
  const id = rosterStr(row, "id");
  const displayName = rosterStr(row, "displayName");
  if (id === null || displayName === null) return null;
  return {
    id,
    displayName,
    iconUrl: rosterStr(row, "iconUrl"),
    trustLevel: rosterStr(row, "trustLevel") ?? "",
    ageVerificationStatus: rosterStr(row, "ageVerificationStatus"),
    ageVerified: row.ageVerified === true,
    isFriend: row.isFriend === true,
    platform: rosterStr(row, "platform"),
    developerType: rosterStr(row, "developerType"),
  };
}

function decodeInstanceUsers(body: unknown, location: string): InstanceUsers {
  const root = rosterRecord(body);
  const rawUsers = root?.users;
  const users =
    Array.isArray(rawUsers) === true
      ? rawUsers.map(decodeUser).filter((user): user is InstanceUser => user !== null)
      : [];
  return {
    location: (root === null ? null : rosterStr(root, "location")) ?? location,
    fetchedAt: typeof root?.fetchedAt === "number" ? root.fetchedAt : Date.now(),
    // Anything other than the literal "instance" means we have no attributes to show, and saying
    // so is always the safe direction to be wrong in.
    source: root?.source === "instance" ? "instance" : "unavailable",
    users,
  };
}

/**
 * Worlds, decoded rather than cast.
 *
 * The batch resolver is the reason. Its whole contract is that one bad id must not cost the other
 * forty-nine their names, so a malformed *entry* is dropped for the same reason a malformed id is:
 * a row keeps its `shortId` fallback, which is exactly what an unresolved world should look like.
 * `tags` gets normalised in both shapes because it is the one field the UI iterates, and an
 * `undefined` there is a render-time crash rather than a missing chip.
 */
function decodeWorldSummary(value: unknown): WorldSummary | null {
  const row = rosterRecord(value);
  if (row === null) return null;
  const id = rosterStr(row, "id");
  if (id === null) return null;
  return {
    id,
    name: rosterStr(row, "name") ?? id,
    thumbnailImageUrl: rosterStr(row, "thumbnailImageUrl"),
    authorName: rosterStr(row, "authorName"),
    capacity: typeof row.capacity === "number" ? row.capacity : null,
  };
}

function decodeWorldBatch(body: unknown): Record<string, WorldSummary> {
  const worlds = rosterRecord(rosterRecord(body)?.worlds);
  if (worlds === null) return {};
  const out: Record<string, WorldSummary> = {};
  for (const [id, value] of Object.entries(worlds)) {
    const world = decodeWorldSummary(value);
    if (world !== null) out[id] = world;
  }
  return out;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function decodeWorldDetail(body: unknown, worldId: string): WorldDetail {
  const row = rosterRecord(body) ?? {};
  const summary = decodeWorldSummary({ ...row, id: rosterStr(row, "id") ?? worldId });
  const numeric = (key: string): number | null =>
    typeof row[key] === "number" && Number.isFinite(row[key]) ? (row[key] as number) : null;
  return {
    ...(summary ?? {
      id: worldId,
      name: worldId,
      thumbnailImageUrl: null,
      authorName: null,
      capacity: null,
    }),
    description: rosterStr(row, "description"),
    authorId: rosterStr(row, "authorId"),
    imageUrl: rosterStr(row, "imageUrl"),
    recommendedCapacity: numeric("recommendedCapacity"),
    tags: stringList(row.tags),
    releaseStatus: rosterStr(row, "releaseStatus"),
    visits: numeric("visits"),
    favorites: numeric("favorites"),
    heat: numeric("heat"),
    popularity: numeric("popularity"),
    occupants: numeric("occupants"),
    publicationDate: numeric("publicationDate"),
    labsPublicationDate: numeric("labsPublicationDate"),
    createdAt: numeric("createdAt"),
    updatedAt: numeric("updatedAt"),
    version: numeric("version"),
    fetchedAt: numeric("fetchedAt") ?? Date.now(),
    cached: row.cached === true,
  };
}

function decodeInstanceDetail(body: unknown, location: string): InstanceDetail {
  const root = rosterRecord(body);
  const raw = rosterRecord(root?.instance);
  const fetchedAt = typeof root?.fetchedAt === "number" ? root.fetchedAt : Date.now();
  // Anything other than the literal "instance" means there is nothing to show, and saying so is
  // always the safe direction to be wrong in — a closed instance is the ordinary case here.
  if (raw === null || root?.source !== "instance") {
    return { location, fetchedAt, source: "unavailable", instance: null };
  }
  const numeric = (key: string): number | null =>
    typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : null;
  return {
    location: rosterStr(root, "location") ?? location,
    fetchedAt,
    source: "instance",
    instance: {
      worldId: rosterStr(raw, "worldId") ?? "",
      instanceId: rosterStr(raw, "instanceId") ?? "",
      type: rosterStr(raw, "type"),
      ownerId: rosterStr(raw, "ownerId"),
      region: rosterStr(raw, "region"),
      capacity: numeric("capacity"),
      userCount: numeric("userCount"),
      nUsers: numeric("nUsers"),
      full: raw.full === true,
      canRequestInvite: raw.canRequestInvite === true,
      closedAt: numeric("closedAt"),
      hardClose: typeof raw.hardClose === "boolean" ? raw.hardClose : null,
      queueEnabled: raw.queueEnabled === true,
      queueSize: numeric("queueSize"),
      tags: stringList(raw.tags),
      active: raw.active === true,
      world: decodeWorldSummary(raw.world),
    },
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export interface EventQuery {
  readonly accountId?: string | undefined;
  /** An exact bus kind. The daemon has no prefix filter, so `gamelog.*` is filtered client-side. */
  readonly kind?: string | undefined;
  /**
   * Everything vrc.zip ever recorded *about* one subject, newest first. A subject is usually a
   * user id, but the bus also files world, group, and notification ids here — see `subjectOf` in
   * `daemon/src/wiring/`. The user modal only ever passes a `usr_…`.
   */
  readonly subjectId?: string | undefined;
  /**
   * One game client, by its `sessions.id`. Stored `gamelog.*` rows have always carried this; the
   * game log used to filter client-side on live frames only, on the false belief that the column
   * was null.
   *
   * `accountId`, `sessionId`, and `subjectId` are **mutually exclusive** — the daemon 400s on any
   * two together rather than silently picking one, so a caller can never get a confident answer
   * about a different axis than it asked for.
   */
  readonly sessionId?: number | undefined;
  readonly limit?: number | undefined;
  /** Unix ms. Returns events strictly older than this, for backwards pagination. */
  readonly before?: number | undefined;
}

/** `exactOptionalPropertyTypes` makes `{ signal }` with an undefined signal a type error. */
function withSignal(signal: AbortSignal | undefined): RequestOptions {
  return signal === undefined ? {} : { signal };
}

export const api = {
  status: (signal?: AbortSignal): Promise<DaemonStatus> =>
    request<DaemonStatus>("/status", withSignal(signal)),

  accounts: {
    list: (signal?: AbortSignal): Promise<Account[]> =>
      request<Account[]>("/accounts", withSignal(signal)),

    login: (username: string, password: string): Promise<LoginResult> =>
      request<LoginResult>("/accounts/login", {
        method: "POST",
        body: { username, password },
      }),

    verifyTwoFactor: (
      accountId: string,
      method: TwoFactorMethod,
      code: string,
    ): Promise<VerifyTwoFactorResult> =>
      request<VerifyTwoFactorResult>(`/accounts/${encodeURIComponent(accountId)}/verify-2fa`, {
        method: "POST",
        body: { method, code },
      }),

    remove: (accountId: string): Promise<void> =>
      request<void>(`/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" }),

    /**
     * Asks VRChat to invite this account to `location`, so the game client already signed into it
     * can travel there by accepting the notification.
     *
     * This is the "a client is already running" half of joining; `launchLink()` is the other half.
     * The daemon validates the location and answers 400 `invalid_location` for anything not
     * joinable, 409 `account_offline` when the account has no live session, and 403
     * `invite_forbidden` when VRChat will not let it in.
     */
    inviteSelf: (accountId: string, location: string): Promise<{ readonly status: "ok" }> =>
      request<{ readonly status: "ok" }>(`/accounts/${encodeURIComponent(accountId)}/invite-self`, {
        method: "POST",
        body: { location },
      }),
  },

  sessions: (signal?: AbortSignal): Promise<GameSession[]> =>
    request<GameSession[]>("/sessions", withSignal(signal)),

  events: (query: EventQuery = {}, signal?: AbortSignal): Promise<FeedEvent[]> =>
    request<FeedEvent[]>("/events", {
      query: {
        accountId: query.accountId,
        kind: query.kind,
        subjectId: query.subjectId,
        sessionId: query.sessionId,
        limit: query.limit,
        before: query.before,
      },
      ...withSignal(signal),
    }),

  users: {
    /**
     * One user, merged from VRChat and the local store.
     *
     * `accountId` picks whose credentials the lookup runs through, and it matters: VRChat answers
     * `GET /users/{id}` with different fields depending on whether the *caller* is a friend, so
     * two accounts asking about the same person get two different answers. Omit it and the daemon
     * chooses an online account itself.
     *
     * Throws 404 for a user id VRChat does not know and 503 when no account is online — the
     * latter is an ordinary state, see `isNoAccountOnline`.
     */
    get: (userId: string, accountId?: string, signal?: AbortSignal): Promise<UserProfile> =>
      request<UserProfile>(`/users/${encodeURIComponent(userId)}`, {
        query: { accountId },
        ...withSignal(signal),
      }),

    /**
     * The groups a user is in, with the represented one flagged.
     *
     * VRChat only returns the memberships the *asking* account is allowed to see, so a short list
     * — or an empty one — is an ordinary answer about a user with many groups, not a failed read.
     * The envelope is unwrapped here because it carries nothing else worth threading through.
     *
     * 503 when no account is online, exactly like `get` — see `isNoAccountOnline`.
     */
    groups: async (
      userId: string,
      accountId?: string,
      signal?: AbortSignal,
    ): Promise<UserGroup[]> =>
      (
        await request<{ readonly groups: readonly UserGroup[] }>(
          `/users/${encodeURIComponent(userId)}/groups`,
          { query: { accountId }, ...withSignal(signal) },
        )
      ).groups.slice(),

    /**
     * One page of the friends the asking account and this user have in common.
     *
     * Paged, and the envelope is kept whole: `hasMore` is the only honest basis for a "load more"
     * control, and inferring it from `users.length === n` would guess wrong on an exact fit.
     */
    mutualFriends: (
      userId: string,
      options: MutualFriendQuery = {},
      signal?: AbortSignal,
    ): Promise<MutualFriendPage> =>
      request<MutualFriendPage>(`/users/${encodeURIComponent(userId)}/mutual-friends`, {
        query: { accountId: options.accountId, n: options.n, offset: options.offset },
        ...withSignal(signal),
      }),

    /**
     * Writes the local, private note. Never leaves this machine — this is not VRChat's
     * `/userNotes`. An empty string clears it.
     */
    setNote: (userId: string, note: string, accountId?: string): Promise<UserNote> =>
      request<UserNote>(`/users/${encodeURIComponent(userId)}/note`, {
        method: "PUT",
        query: { accountId },
        body: { note },
      }),
  },

  worlds: {
    /**
     * One world in full, for the world modal.
     *
     * The daemon serves a cached world without any account signed in — a world is the same record
     * whoever asks — so a cold laptop still names the places in its own feed. A cache miss with
     * nobody online is a 503 (`isNoAccountOnline`), and a deleted world is a 404 (`isNotFound`).
     * Deleted worlds are common enough that the modal treats it as an outcome, not a fault.
     */
    get: (worldId: string, accountId?: string | null, signal?: AbortSignal): Promise<WorldDetail> =>
      request<unknown>(`/worlds/${encodeURIComponent(worldId)}`, {
        query: { accountId },
        ...withSignal(signal),
      }).then((body) => decodeWorldDetail(body, worldId)),

    /**
     * Names for many worlds in one request. The endpoint the world-name resolver exists to use.
     *
     * **An id that could not be resolved is simply absent from the map** — never an error, never a
     * null entry. Absent does not prove "deleted", either: with no account signed in the daemon
     * answers from cache alone, so everything it has never seen is missing. See
     * `state/world-names.svelte.ts` for why that makes "unresolvable" a cooldown rather than a
     * permanent verdict.
     */
    list: (
      ids: readonly string[],
      accountId?: string | null,
      signal?: AbortSignal,
    ): Promise<Record<string, WorldSummary>> =>
      ids.length === 0
        ? Promise.resolve({})
        : request<unknown>("/worlds", {
            query: { ids: ids.join(","), accountId },
            ...withSignal(signal),
          }).then(decodeWorldBatch),
  },

  /**
   * One instance's live record — occupancy, access type, region, queue, whether it is still open.
   *
   * `source: "unavailable"` is an ordinary answer, not a failure: instances close, and a closed one
   * is exactly what a location string from an hour ago points at.
   */
  instance: (
    location: string,
    accountId?: string | null,
    signal?: AbortSignal,
  ): Promise<InstanceDetail> =>
    request<unknown>("/instances", {
      query: {
        location,
        ...(accountId === null || accountId === undefined || accountId === "" ? {} : { accountId }),
      },
      ...withSignal(signal),
    }).then((body) => decodeInstanceDetail(body, location)),

  /**
   * Attributes for everyone VRChat believes is in `location`, seen through `accountId`.
   *
   * `accountId` is not decoration: `isFriend` is a statement about the asking account, and VRChat
   * only fills the roster at all for an account standing in that instance. Omit it and the daemon
   * picks an online account itself.
   *
   * A well-formed `source: "unavailable"` is the **normal** answer for an instance nobody signed
   * in is standing in — the design working, not a failure. Callers render the log-derived roster
   * with a plain sentence rather than an error state.
   */
  instanceUsers: async (
    location: string,
    accountId?: string | null,
    signal?: AbortSignal,
  ): Promise<InstanceUsers> => {
    const raw = await request<unknown>("/instance-users", {
      query: {
        location,
        ...(accountId === null || accountId === undefined || accountId === "" ? {} : { accountId }),
      },
      ...withSignal(signal),
    });
    return decodeInstanceUsers(raw, location);
  },

  friends: (accountId?: string, signal?: AbortSignal): Promise<Friend[]> =>
    request<Friend[]>("/friends", {
      query: { accountId },
      ...withSignal(signal),
    }),

  notifications: {
    list: (accountId?: string, signal?: AbortSignal): Promise<NotificationItem[]> =>
      request<NotificationItem[]>("/notifications", {
        query: { accountId },
        ...withSignal(signal),
      }),

    markSeen: (id: string): Promise<void> =>
      request<void>(`/notifications/${encodeURIComponent(id)}/seen`, { method: "POST" }),
  },

  settings: {
    get: (signal?: AbortSignal): Promise<Settings> =>
      request<Settings>("/settings", withSignal(signal)),

    update: (patch: SettingsPatch): Promise<Settings> =>
      request<Settings>("/settings", { method: "PUT", body: patch }),
  },
} as const;
