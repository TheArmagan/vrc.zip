import {
  type EventFamily,
  familyOf,
  type GameSession,
  isEventFrame,
  isScope,
  type JsonValue,
  type Scope,
  STREAM_READY,
  type StreamEventFrame,
  type StreamFrame,
  type WebhookRegistered,
  type WebhookRegistration,
  type WebhookSummary,
} from "@vrcz/shared";
import type { ServerWebSocket } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { createBunWebSocket } from "hono/bun";
import { getCookie } from "hono/cookie";
import { isProxyToken } from "../security/proxy-tokens.ts";

/**
 * The **third-party** surface of the control port — PLAN.md §"Control API — :7775", step 2.10.
 *
 * Everything else on `:7775` is the UI's private surface behind the session token. This is the part
 * an *app* may reach: the enriched event stream, the session list, and webhook registration, for
 * something that already went through the consent handshake on `:7774` and holds a grant.
 *
 * ## Why a separate sub-app under `/app`
 *
 * The two surfaces differ in who is on the other end, so they differ in what authenticates and in
 * what a bug costs. Splitting them by path prefix rather than by middleware ordering makes the
 * separation **default-deny by construction**: a route added to `/api/…` tomorrow is not reachable
 * by an app no matter what its author forgot, because it is not in this file. The alternative —
 * one route table with per-route auth — makes app-reachability the default and every new route a
 * chance to widen the surface by omission. Same reasoning as the three separate Hono instances on
 * the three ports (PLAN.md §1.8), one level down.
 *
 * ## Mounting
 *
 * This instance declares its routes **relative** to {@link APP_API_PREFIX}, so the control app
 * mounts it with `app.route(APP_API_PREFIX, createAppApi({ deps }))` and `GET /sessions` here is
 * `GET /app/sessions` on the wire.
 *
 * It must be mounted **after** `hostGuard`/`originGuard` and **before** `sessionAuth`: those two
 * are about the browser and apply to everything on the port, while `sessionAuth` is the UI's
 * credential and would reject every app before it got here. Nothing in this file assumes any
 * authentication has already happened — it does its own, from scratch, on every request.
 */

/** Where the control app mounts this instance. Exported so the mount point has one spelling. */
export const APP_API_PREFIX = "/app";

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

/**
 * The Bun websocket handler, for `Bun.serve`.
 *
 * `hono/bun`'s handler is a module-level singleton that dispatches through `ws.data`, so this is
 * the very same object `controlWebSocketHandler` is — wiring either one wires both. It is exported
 * anyway so that a reader of `bind.ts` is not left inferring that from an implementation detail.
 */
export const appWebSocketHandler = websocket;

/**
 * A live grant, as this surface needs it. The store's `GrantRow` with the parts an app route reads
 * already resolved: `scopes` parsed out of its JSON column, and nothing else carried over.
 *
 * **No token and no hash.** The grant is looked up *by* the presented credential; carrying the
 * credential forward past that point would put it within reach of a handler, and from there of a
 * response body, which is exactly the leak `authcookie_<id>_vrczip` exists to prevent.
 */
export interface AppGrant {
  readonly id: string;
  /**
   * The one account this grant is bound to. Every route here filters on it — a grant is consent to
   * see *one* account, and multi-account is the daemon's posture, not the app's.
   */
  readonly accountId: string;
  /** Already expanded: a `*` or `**` request is expanded at consent, never re-expanded here. */
  readonly scopes: readonly Scope[];
  /** For log lines and error messages. Never used in an authorization decision. */
  readonly appName: string;
}

/**
 * The daemon capabilities this surface needs, and nothing else.
 *
 * Shaped by what the six routes ask for rather than by what the daemon happens to expose — the same
 * posture as `ControlDeps`, and for the same reason: the seam stays small enough to fake in a few
 * lines, which is what makes the routes testable without a store, a bus, or a socket.
 */
export interface AppApiDeps {
  /**
   * Resolves a presented credential to a live grant, or null.
   *
   * "Live" is the whole contract: the token must hash to a `grants` row whose `revoked_at` is null.
   * A revoked grant resolves to **null**, not to a grant with a flag on it — a caller that has to
   * remember to check a second field is a caller that will one day forget.
   *
   * Takes the raw token because the hash is the store's business; the route has already
   * shape-checked it with `isProxyToken`, so an obviously-foreign credential never reaches a
   * lookup. Implementations must not treat a session token as a match under any circumstances.
   */
  resolveGrant(token: string): Promise<AppGrant | null>;

  /**
   * Watches one grant for revocation, calling `onRevoked` when it happens, and returns an
   * unsubscribe.
   *
   * Exists solely for `GET /stream`. A socket authenticated once at the handshake would otherwise
   * keep streaming a revoked app events for as long as it stayed connected — the same hole
   * `PipelineMirror.disconnectGrant` closes on `:7774`, and the reason revoking an app in the UI
   * has to reach sockets and not just the next request.
   */
  watchGrant(grantId: string, onRevoked: () => void): () => void;

  /**
   * Live game-client sessions — the ones with no `ended_at` — across **every** account, unfiltered.
   *
   * Unfiltered on purpose: the visibility rule is `visibleSessions`, a pure function this file
   * owns and tests, rather than a filter argument the implementation could get subtly wrong out of
   * sight. Sessions, not accounts, are the unit here (PLAN.md §1.7), so the list legitimately
   * contains rows with `accountId === null`.
   */
  listSessions(): Promise<GameSession[]>;

  /**
   * Subscribes to the enriched event stream. Returns an unsubscribe the socket calls on close — a
   * leak here is a leak per connected app, which outlives a browser tab by design.
   *
   * Delivers every frame the UI stream would get; `canSeeEvent` decides what this app is shown.
   */
  subscribeEvents(listener: (frame: StreamFrame) => void): () => void;

  /**
   * Registers a webhook for this grant and mints its signing secret.
   *
   * `registration` has already been validated by `parseWebhookRegistration`, including that
   * `accountId` is this grant's own account or null. The returned {@link WebhookRegistered} is the
   * only place the secret ever exists on the wire.
   */
  registerWebhook(grantId: string, registration: WebhookRegistration): Promise<WebhookRegistered>;

  /** This grant's webhooks, newest first. Never another grant's, and never the user's own. */
  listWebhooks(grantId: string): Promise<WebhookSummary[]>;

  /**
   * Deletes one of this grant's webhooks. Resolves **false** when the id is unknown *or* belongs to
   * someone else — the two are deliberately indistinguishable, so a probe cannot enumerate what
   * other apps have registered.
   */
  deleteWebhook(grantId: string, webhookId: string): Promise<boolean>;
}

/** Status codes this surface answers with. Anything else is a bug, and so a 500. */
export type AppApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 503;

/**
 * Thrown to choose a status and an error code.
 *
 * Its own class rather than `ControlError` from `control.ts`: this sub-app has its own error
 * envelope (it carries `scope` on a 403) and its own `onError`, and an app on the other end should
 * not have its failure modes change because a UI route's error type was refactored.
 */
export class AppApiError extends Error {
  readonly status: AppApiErrorStatus;
  readonly code: string;
  /** The scope a 403 is about. Absent on every other status. */
  readonly scope: Scope | undefined;

  constructor(status: AppApiErrorStatus, code: string, message?: string, scope?: Scope) {
    super(message ?? code);
    this.name = "AppApiError";
    this.status = status;
    this.code = code;
    this.scope = scope;
  }
}

/**
 * The Hono environment: the resolved grant, put on the context by the auth middleware and read by
 * every handler.
 *
 * A typed `Variables` entry rather than a cast at each use. `c.get("grant")` is then `AppGrant`
 * with no `as` anywhere, which matters more here than elsewhere — this value *is* the
 * authorization decision, and a cast is a place where a wrong one would typecheck.
 */
export interface AppApiEnv {
  Variables: {
    grant: AppGrant;
  };
}

export interface AppApiOptions {
  deps: AppApiDeps;
}

/**
 * The scope that gates each event family.
 *
 * Keyed on the **family** rather than on the kind, because that is the granularity the consent
 * screen speaks in: a user who granted `friends:read` agreed to "read your friends list and their
 * online status", and that sentence covers `friend.online` and `friend.location` alike. Per-kind
 * mapping would mean a table that has to grow every time the daemon learns a new event, and a kind
 * missing from it would be a silent hole rather than a drop.
 *
 * Three families are deliberately **absent**, and absence means dropped (see `scopeForEventKind`):
 *
 *  - `consent` — the pairing flow itself. An app watching other apps arrive at the consent sheet is
 *    exactly the surveillance this whole handshake exists to prevent, and no scope should buy it.
 *  - `content` — vrc.zip's own cache bookkeeping. It describes the daemon, not the account.
 *  - `other` — the fallback family for a kind from a newer daemon than this build. Passing an
 *    unrecognised kind through would mean every future event ships app-readable by default.
 */
const EVENT_SCOPE_BY_FAMILY: Partial<Readonly<Record<EventFamily, Scope>>> = {
  friend: "friends:read",
  user: "users:read",
  notification: "notifications:read",
  // Both log-derived families. `gamelog.*` and `session.*` are two views of one thing — a running
  // game client — and splitting them across two scopes would let an app see the joins without the
  // session they happened in, which is precisely the correlation `sessions:read` describes.
  gamelog: "sessions:read",
  session: "sessions:read",
  account: "account:read",
  // The pipeline socket's connection state is a statement about the account's live link, and an app
  // reading presence needs it to know whether "no events" means "nothing happened" or "we are down".
  pipeline: "account:read",
  group: "groups:read",
  instance: "instances:read",
  economy: "economy:read",
};

/**
 * The scope an event kind needs, or null when nothing maps to it.
 *
 * **Default-deny.** Null is the answer for anything unmapped, and every caller treats null as "drop
 * it" rather than "no scope required". Exported because the mapping is the interesting half of the
 * stream filter and deserves to be asserted directly.
 */
export function scopeForEventKind(kind: string): Scope | null {
  return EVENT_SCOPE_BY_FAMILY[familyOf(kind)] ?? null;
}

/** True when the grant holds `scope`. One spelling, so no route compares arrays itself. */
export function grantHasScope(grant: AppGrant, scope: Scope): boolean {
  return grant.scopes.includes(scope);
}

/**
 * Whether one event frame may be shown to one grant. The whole per-event filter, as a pure function
 * so it can be tested without a socket.
 *
 * Three independent gates, all of which must pass:
 *
 *  1. **The account.** An app is bound to one account and sees nothing about the others. This is
 *     first because it is the cheapest and the one whose failure is the most serious.
 *  2. **Unlinked events.** `accountId === null` is a VRChat client signed into an account vrc.zip
 *     does not manage — a normal state (PLAN.md §1.7), and one that leaks the *existence* of
 *     accounts the user never added, along with their display names. It takes the dangerous
 *     `sessions:unlinked` scope, which cannot arrive through a wildcard.
 *  3. **The kind.** Default-deny via `scopeForEventKind`.
 */
export function canSeeEvent(frame: StreamEventFrame, grant: AppGrant): boolean {
  const { accountId } = frame.payload;
  if (accountId === null) {
    if (!grantHasScope(grant, "sessions:unlinked")) return false;
  } else if (accountId !== grant.accountId) {
    return false;
  }

  const scope = scopeForEventKind(frame.type);
  if (scope === null) return false;
  return grantHasScope(grant, scope);
}

/**
 * The sessions one grant may see, out of every live session.
 *
 * The same two rules as `canSeeEvent`'s first two gates, and pure for the same reason. A session
 * with a null `accountId` is an unmanaged client, so it is behind `sessions:unlinked`; the
 * `sessions:read` check itself is the route's `requireScope`, not this function's job.
 */
export function visibleSessions(sessions: readonly GameSession[], grant: AppGrant): GameSession[] {
  const unlinked = grantHasScope(grant, "sessions:unlinked");
  return sessions.filter((session) =>
    session.accountId === null ? unlinked : session.accountId === grant.accountId,
  );
}

/**
 * Parses a `grants.scopes` column into scopes this build understands.
 *
 * Here rather than in the wiring because the *consequence* of getting it wrong is here: a scope
 * string this build has never heard of must not be carried around as if it authorized something,
 * so unknown entries are dropped rather than kept as opaque strings. A malformed column yields an
 * empty list — a grant that authorizes nothing, which is the safe reading of "we cannot tell what
 * this authorizes".
 */
export function parseGrantScopes(json: string): Scope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is Scope => typeof value === "string" && isScope(value));
}

/**
 * The credential an app presents, out of whichever transport carried it.
 *
 * The same three spellings `pipelineToken` accepts on `:7774`, so an app authenticates against both
 * surfaces with one credential in one place: VRChat's own `auth` cookie, which is what a client
 * built against the real API already sends; `?authToken=`/`?auth=`, which is the only way a browser
 * `WebSocket` can carry anything; and `Authorization: Bearer`, for anything scripted.
 *
 * Deliberately **not** the session token's transports. `X-Vrcz-Token` and `?token=` are the UI's,
 * and a surface that accepted them would make every `/app` route reachable with the session
 * credential — which is the exact confusion the path split exists to prevent. `Authorization` is
 * shared, and harmless: a session token fails `isProxyToken` on shape.
 */
export function presentedGrantToken(request: Request, cookieHeader: string | undefined): string {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (match?.[1] !== undefined) return match[1];
  }

  let params: URLSearchParams | undefined;
  try {
    params = new URL(request.url).searchParams;
  } catch {
    params = undefined;
  }
  const fromQuery = params?.get("authToken") ?? params?.get("auth");
  if (fromQuery !== undefined && fromQuery !== null && fromQuery !== "") return fromQuery;

  if (cookieHeader !== undefined && cookieHeader !== "") return cookieHeader;
  return "";
}

/** The most kind patterns one webhook will take. Beyond this the caller wants `*`. */
export const MAX_WEBHOOK_KINDS = 64;

/** A URL longer than this is a mistake, and it would be stored and retried forever. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

/**
 * An exact kind (`friend.online`), a family prefix (`friend.*`), or everything (`*`).
 *
 * An allowlist rather than a "no weird characters" test: these strings are matched against event
 * kinds on every delivery decision, and a pattern language that accepted arbitrary text would be a
 * pattern language somebody eventually implements as a regex.
 */
const WEBHOOK_KIND_PATTERN = /^(\*|[a-z][a-z0-9_]*\.(\*|[a-z][a-z0-9_]*))$/;

/**
 * Validates a `POST /app/webhooks` body.
 *
 * **Rejects rather than clamps**, everywhere. A truncated kind list or a silently-swapped account
 * would leave the app believing it registered something it did not, and the first evidence would be
 * events that never arrive — the least debuggable failure this surface can produce.
 *
 * `grant` is passed in because two of the rules are about it: a webhook may only be pinned to the
 * grant's own account, and an omitted `accountId` means "this grant's account" rather than "all".
 */
export function parseWebhookRegistration(
  body: Record<string, JsonValue> | undefined,
  grant: AppGrant,
): WebhookRegistration {
  if (body === undefined) {
    throw new AppApiError(400, "invalid_body", "a JSON object body is required");
  }

  const url = body.url;
  if (typeof url !== "string" || url === "") {
    throw new AppApiError(400, "invalid_body", "url is required");
  }
  if (url.length > MAX_WEBHOOK_URL_LENGTH) {
    throw new AppApiError(
      400,
      "invalid_body",
      `url is at most ${String(MAX_WEBHOOK_URL_LENGTH)} characters`,
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AppApiError(400, "invalid_body", "url is not a URL");
  }
  // Plain `http` is allowed, unlike on `GET /api/image`, and the difference is not an oversight:
  // vrc.zip is local-only, the app receiving these is on this machine, and `http://127.0.0.1:…` is
  // the ordinary case. Anything that is not an HTTP scheme — `file:`, `javascript:` — is refused.
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new AppApiError(400, "invalid_body", "url must be http or https");
  }

  const registration: {
    url: string;
    kinds?: readonly string[];
    accountId?: string | null;
  } = { url: parsedUrl.toString() };

  const kinds = body.kinds;
  if (kinds !== undefined && kinds !== null) {
    if (!Array.isArray(kinds)) {
      throw new AppApiError(400, "invalid_body", "kinds must be an array of strings");
    }
    if (kinds.length > MAX_WEBHOOK_KINDS) {
      throw new AppApiError(
        400,
        "invalid_body",
        `at most ${String(MAX_WEBHOOK_KINDS)} kind patterns per webhook`,
      );
    }
    const patterns: string[] = [];
    for (const kind of kinds) {
      if (typeof kind !== "string" || !WEBHOOK_KIND_PATTERN.test(kind)) {
        throw new AppApiError(
          400,
          "invalid_body",
          "each kind must be an exact kind, a family prefix like friend.*, or *",
        );
      }
      patterns.push(kind);
    }
    registration.kinds = patterns;
  }

  const accountId = body.accountId;
  if (accountId !== undefined && accountId !== null) {
    if (typeof accountId !== "string") {
      throw new AppApiError(400, "invalid_body", "accountId must be a string or null");
    }
    // A grant is consent to see one account, so naming another is refused rather than quietly
    // rewritten — an app that thinks it registered for a second account should learn that it did
    // not, at the moment it asks.
    if (accountId !== grant.accountId) {
      throw new AppApiError(403, "forbidden_account", "this grant cannot see that account");
    }
  }
  // Absent or null both mean "this grant's account". There is no all-accounts webhook here: the UI
  // can register one, an app cannot.
  registration.accountId = grant.accountId;

  return registration;
}

/**
 * The third-party sub-app. Mount at {@link APP_API_PREFIX}.
 *
 * Every route is `requireScope`d. That is not a convention, it is the design: this surface has no
 * unauthenticated and no unscoped route, and adding one would mean writing a route that omits the
 * middleware in a file where every neighbour has it.
 */
export function createAppApi({ deps }: AppApiOptions) {
  const app = new Hono<AppApiEnv>()

    /*
     * Authentication. Runs on every route including the WebSocket upgrade, and assumes nothing has
     * happened before it — `sessionAuth` is mounted *after* this sub-app precisely so an app never
     * meets it, which means there is no earlier check to inherit.
     *
     * The shape test comes before the lookup so a session token, a VRChat cookie, or a stray string
     * is refused without touching the store. It also means the one thing that could authenticate
     * here — a live grant token — is the only thing that ever gets hashed and looked up.
     */
    .use("*", async (c, next) => {
      const presented = presentedGrantToken(c.req.raw, getCookie(c, "auth"));
      if (presented === "" || !isProxyToken(presented)) {
        return c.json(
          {
            error: "unauthorized",
            message: "this surface takes a vrc.zip proxy grant token, not a session token",
          },
          401,
        );
      }

      const grant = await deps.resolveGrant(presented);
      if (grant === null) {
        return c.json(
          { error: "unauthorized", message: "that grant is unknown or has been revoked" },
          401,
        );
      }

      c.set("grant", grant);
      await next();
    })

    /*
     * Live game clients. Behind `sessions:read`, filtered to this grant's account, with unlinked
     * clients behind the second, dangerous scope — see `visibleSessions`.
     */
    .get("/sessions", requireScope("sessions:read"), async (c) => {
      const sessions = await deps.listSessions();
      return c.json(visibleSessions(sessions, c.get("grant")));
    })

    /*
     * The enriched stream — the reason most apps are here at all, and the surface `:7774`'s
     * byte-faithful pipeline mirror cannot offer, because these events do not exist upstream.
     *
     * Two things this does that the UI's `/api/stream` does not, both because the reader is an app:
     * every frame goes through `canSeeEvent`, and the grant is watched for revocation so the socket
     * dies with it. A socket checked once at the handshake and never again would turn "revoke this
     * app" into "revoke this app, next time it reconnects".
     */
    .get(
      "/stream",
      requireScope("sessions:read"),
      upgradeWebSocket((c) => {
        const grant = c.get("grant");
        let unsubscribe: (() => void) | undefined;
        let unwatch: (() => void) | undefined;

        return {
          onOpen(_event, ws) {
            unsubscribe = deps.subscribeEvents((frame) => {
              // `ready` and `rate` are not events: one is this socket's own handshake and the other
              // is a reading of what the *daemon* is spending, which is nobody's app's business.
              if (!isEventFrame(frame)) return;
              if (!canSeeEvent(frame, grant)) return;
              ws.send(JSON.stringify(frame));
            });

            unwatch = deps.watchGrant(grant.id, () => {
              ws.close(1008, "grant revoked");
            });

            ws.send(JSON.stringify({ type: STREAM_READY, ts: Date.now(), payload: null }));
          },
          onClose() {
            unsubscribe?.();
            unsubscribe = undefined;
            unwatch?.();
            unwatch = undefined;
          },
        };
      }),
    )

    /*
     * Webhooks. All three behind `webhooks:write`, including the listing — reading back what you
     * registered is part of the same capability, and there is no `webhooks:read` to hold.
     */
    .post("/webhooks", requireScope("webhooks:write"), async (c) => {
      const grant = c.get("grant");
      const body = await readJsonObject(c.req.raw);
      const registration = parseWebhookRegistration(body, grant);
      // The one response in the system that carries a signing secret. It is minted here, returned
      // once, and stored hashed — the same posture as a grant token, for the same reason.
      return c.json(await deps.registerWebhook(grant.id, registration), 201);
    })

    .get("/webhooks", requireScope("webhooks:write"), async (c) =>
      c.json(await deps.listWebhooks(c.get("grant").id)),
    )

    /*
     * A webhook belonging to another grant is a **404**, not a 403. A 403 would confirm the id
     * exists, which is enough to enumerate what other apps on this machine are watching.
     */
    .delete("/webhooks/:id", requireScope("webhooks:write"), async (c) => {
      const deleted = await deps.deleteWebhook(c.get("grant").id, c.req.param("id"));
      if (!deleted) {
        throw new AppApiError(404, "unknown_webhook", "no such webhook");
      }
      return c.json({ status: "ok" as const });
    })

    .onError((error, c) => {
      if (error instanceof AppApiError) {
        return c.json(
          error.scope === undefined
            ? { error: error.code, message: error.message }
            : { error: error.code, message: error.message, scope: error.scope },
          error.status,
        );
      }
      return c.json({ error: "internal_error", message: String(error) }, 500);
    });

  return app;
}

/** The type a typed client feeds to `hc<AppApi>`. */
export type AppApi = ReturnType<typeof createAppApi>;

/**
 * Refuses a request whose grant lacks `scope`, naming the missing scope in the body.
 *
 * Naming it is the point. An app told only "forbidden" cannot tell a missing scope from a wrong
 * account from a bad route, and its author's next move is to ask for `**` — which is the outcome a
 * useless error message actually produces.
 *
 * The parameter is typed `Scope`, so a scope can only be written here as a value the registry
 * already declares; a typo does not compile.
 */
function requireScope(scope: Scope): MiddlewareHandler<AppApiEnv> {
  return async function scopeGuardMiddleware(c, next) {
    if (!grantHasScope(c.get("grant"), scope)) {
      throw new AppApiError(403, "insufficient_scope", `this app was not granted ${scope}`, scope);
    }
    await next();
  };
}

/** A JSON object body, or undefined for anything that is not one. Same helper as `control.ts`. */
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
