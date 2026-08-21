/**
 * The typed client for the local daemon's HTTP API.
 *
 * This file is the UI's copy of the daemon contract. It deliberately does not import from
 * `daemon/` — the UI is a browser bundle and the daemon is a Bun program; sharing types across
 * that boundary belongs in `@vrcz/shared` once the shapes have stopped moving. Until then this
 * is the single place in the UI where a wire shape is written down, and every screen reads its
 * types from here.
 *
 * All timestamps are integer unix milliseconds.
 */

import { clearToken, getToken } from "./session.ts";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** A VRChat account the daemon holds credentials for. */
export interface Account {
  readonly id: string;
  readonly displayName: string;
  readonly username: string;
  /** Whether the daemon should keep this account's pipeline connected. */
  readonly enabled: boolean;
  /** Unix ms of the last pipeline frame or API response attributed to this account. */
  readonly lastSeenAt: number | null;
  /** Whether the daemon currently holds a live pipeline connection for this account. */
  readonly online: boolean;
}

export type BackendKind = "sqlite" | "memory";

export interface RateLimitStatus {
  /** Requests still available in the current window. */
  readonly remaining: number;
  /** Window size, in requests. */
  readonly limit: number;
  /** Unix ms at which `remaining` returns to `limit`. */
  readonly resetAt: number;
}

export interface DaemonStatus {
  readonly version: string;
  /**
   * True when the OS keychain was unavailable and credentials fell back to a weaker store.
   * The UI must say so loudly and permanently while it holds — see `KeychainWarning.svelte`.
   */
  readonly degradedKeychain: boolean;
  readonly backend: BackendKind;
  readonly accounts: number;
  readonly rateLimit: RateLimitStatus;
}

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

/** One player currently present in a running game client's instance. */
export interface SessionPlayer {
  readonly displayName: string;
  /** Null until the log line carrying the id is seen; the name always arrives first. */
  readonly userId: string | null;
  readonly joinedAt: number;
}

/** How a game client ended. Null while it is still running. */
export type SessionExitKind = "clean" | "crash" | "killed" | null;

/**
 * A running (or recently ended) VRChat game client. Sessions and accounts are different sets:
 * a client can run without the daemon knowing which account it belongs to (`accountId: null`),
 * and an account can be logged in with no client running. The UI never conflates them.
 */
export interface GameSession {
  readonly id: string;
  readonly accountId: string | null;
  /** The client's own display name if known, else a placeholder the daemon chose. */
  readonly displayName: string;
  readonly worldName: string | null;
  /** Full instance location, e.g. `wrld_xxx:12345~friends(usr_xxx)`. */
  readonly location: string | null;
  readonly vrMode: boolean;
  readonly exitKind: SessionExitKind;
  readonly startedAt: number;
  readonly players: readonly SessionPlayer[];
}

/**
 * Event kinds the feed knows how to render. The union stays open on purpose: the daemon will
 * grow kinds faster than this file does, and an unrecognised kind must still list rather than
 * disappear or crash a filter.
 */
export type KnownEventKind =
  | "friend-online"
  | "friend-offline"
  | "friend-location"
  | "friend-add"
  | "friend-delete"
  | "friend-request"
  | "notification"
  | "invite"
  | "invite-request"
  | "player-join"
  | "player-leave"
  | "world-change"
  | "session-start"
  | "session-end";

export type EventKind = KnownEventKind | (string & {});

export interface FeedEvent {
  readonly id: string;
  readonly accountId: string | null;
  readonly ts: number;
  readonly kind: EventKind;
  /** The user, world, or notification the event is about, when it is about one thing. */
  readonly subjectId: string | null;
  readonly location: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type FriendStatus = "active" | "join me" | "ask me" | "busy" | "offline";

export type TrustLevel =
  | "visitor"
  | "new"
  | "user"
  | "known"
  | "trusted"
  | "veteran"
  | "troll"
  | "vrchat-team";

export interface Friend {
  readonly id: string;
  readonly displayName: string;
  readonly status: FriendStatus;
  readonly statusDescription: string;
  /** `offline`, `private`, `traveling`, or a full instance id. */
  readonly location: string;
  readonly trustLevel: TrustLevel;
  readonly online: boolean;
}

export interface Settings {
  /** Start the daemon when the user logs into the OS. */
  readonly launchOnStartup: boolean;
  /** Raise a notification for these event kinds. */
  readonly notifyOn: readonly EventKind[];
  /** Days of event history to keep before rollup. */
  readonly retentionDays: number;
  /** Presence poll interval in seconds, used when the pipeline is not carrying presence. */
  readonly presencePollSeconds: number;
  readonly theme: "dark" | "light";
  /** Watch the VRChat log directory for running game clients. */
  readonly watchGameLogs: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every failure this client can produce, tagged so screens branch on a field instead of
 * string-matching a message. `offline` means the request never reached a server at all — that
 * is the only state that earns the full-screen "daemon not running" treatment.
 */
export type ApiErrorKind = "offline" | "unauthorized" | "http" | "malformed";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** The daemon's machine-readable error code, when it sent one. */
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
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs === "" ? path : `${path}?${qs}`;
}

async function readErrorBody(
  response: Response,
): Promise<{ message: string; code: string | null }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const message = typeof record.message === "string" ? record.message : null;
      const code = typeof record.code === "string" ? record.code : null;
      if (message !== null) return { message, code };
      if (code !== null) return { message: code, code };
    }
  } catch {
    /* not JSON — fall through to the status line */
  }
  return { message: response.statusText || `HTTP ${response.status}`, code: null };
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    // Same-origin in production, proxied in dev. Cookies are never part of this contract.
    credentials: "omit",
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
    clearToken();
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
    request<DaemonStatus>("/api/status", withSignal(signal)),

  accounts: {
    list: (signal?: AbortSignal): Promise<Account[]> =>
      request<Account[]>("/api/accounts", withSignal(signal)),

    login: (username: string, password: string): Promise<LoginResult> =>
      request<LoginResult>("/api/accounts/login", {
        method: "POST",
        body: { username, password },
      }),

    verifyTwoFactor: (
      accountId: string,
      method: TwoFactorMethod,
      code: string,
    ): Promise<VerifyTwoFactorResult> =>
      request<VerifyTwoFactorResult>(`/api/accounts/${encodeURIComponent(accountId)}/verify-2fa`, {
        method: "POST",
        body: { method, code },
      }),

    remove: (accountId: string): Promise<void> =>
      request<void>(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" }),
  },

  sessions: (signal?: AbortSignal): Promise<GameSession[]> =>
    request<GameSession[]>("/api/sessions", withSignal(signal)),

  events: (query: EventQuery = {}, signal?: AbortSignal): Promise<FeedEvent[]> =>
    request<FeedEvent[]>("/api/events", {
      query: {
        accountId: query.accountId,
        kind: query.kind,
        limit: query.limit,
        before: query.before,
      },
      ...withSignal(signal),
    }),

  friends: (accountId?: string, signal?: AbortSignal): Promise<Friend[]> =>
    request<Friend[]>("/api/friends", {
      query: { accountId },
      ...withSignal(signal),
    }),

  settings: {
    get: (signal?: AbortSignal): Promise<Settings> =>
      request<Settings>("/api/settings", withSignal(signal)),

    update: (patch: Partial<Settings>): Promise<Settings> =>
      request<Settings>("/api/settings", { method: "PUT", body: patch }),
  },
} as const;
