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

  /** Live game-client sessions — the ones with no `ended_at`. */
  listSessions(): Promise<GameSession[]>;
  listEvents(query: EventQuery): Promise<FeedEvent[]>;
  /** `null` means every account. */
  listFriends(accountId: string | null): Promise<FriendPresence[]>;
  /** `null` means every account. Notifications are state, not feed history — see the sink. */
  listNotifications(accountId: string | null): Promise<NotificationItem[]>;
  markNotificationSeen(id: string): Promise<void>;

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
