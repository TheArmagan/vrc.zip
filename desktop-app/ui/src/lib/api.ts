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

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export interface EventQuery {
  readonly accountId?: string | undefined;
  /** An exact bus kind. The daemon has no prefix filter, so `gamelog.*` is filtered client-side. */
  readonly kind?: string | undefined;
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
  },

  sessions: (signal?: AbortSignal): Promise<GameSession[]> =>
    request<GameSession[]>("/sessions", withSignal(signal)),

  events: (query: EventQuery = {}, signal?: AbortSignal): Promise<FeedEvent[]> =>
    request<FeedEvent[]>("/events", {
      query: {
        accountId: query.accountId,
        kind: query.kind,
        limit: query.limit,
        before: query.before,
      },
      ...withSignal(signal),
    }),

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
