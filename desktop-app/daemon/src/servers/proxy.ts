import type { Scope } from "@vrcz/shared";
import type { ServerWebSocket } from "bun";
import { type Context, Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { getCookie } from "hono/cookie";
import {
  getCurrentUser,
  logout,
  type ProxyDeps,
  type RequestLike,
  verifyAuthToken,
  verifyTwoFactor,
} from "../proxy/handshake.ts";
import { passthrough } from "../proxy/passthrough.ts";
import { deadSessionFrame, type PipelineSink, pipelineToken } from "../proxy/pipeline-mirror.ts";
import { createProxyLogger, type ProxyLogger, proxyAccessLog } from "../proxy/request-log.ts";
import { matchRoute } from "../proxy/route-table.ts";
import { vrchatError, vrczipError } from "../proxy/vrchat-shapes.ts";
import { hostGuard, originGuard } from "../security/guards.ts";
import { hashProxyToken } from "../security/proxy-tokens.ts";

/**
 * The VRChat API mirror on `:7774`. See PLAN.md §1.8 and §Phase 2.
 *
 * Same paths, bodies, status codes, and error shapes as `api.vrchat.cloud/api/1`, so an existing
 * VRChat client library works by changing only its base URL — which is also why this is its own
 * `Hono` instance on its own port rather than a prefix on a shared app. The mirror must be
 * structurally unable to serve a control route.
 *
 * **There is no session-token guard here, and that is the design.** An app authenticates by
 * *logging in* — Basic auth, a consent sheet, a pairing code — exactly as it would against VRChat.
 * A pre-shared token would defeat the whole handshake, which exists so a stock client library needs
 * no modification at all. `hostGuard` and `originGuard` still run: they are what stops a web page
 * from reaching this port, and they are not authentication in the first place.
 *
 * **The pass-through is one handler behind `matchRoute`, not 297 registered Hono routes.** PLAN.md
 * §1.8 asks for the latter, for two properties: an unknown path must fall through to VRChat's real
 * 404 rather than to a catch-all's guess, and an operation with no scope mapping must fail to
 * register. Both already hold here — `matchRoute` returns null for a path the table does not know,
 * and the codegen test asserts every operation maps to exactly one scope — and registering the
 * table into Hono would additionally have to translate `/instances/{worldId}:{instanceId}`, two
 * parameters and a separator inside one segment, into a router with different matching rules than
 * the table's own. Two matchers that must agree is a worse position than one.
 */

/** VRChat's own base path. An app changes its base URL and nothing else. */
export const MIRROR_PREFIX = "/api/1";

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

/** The Bun websocket handler for the mirror. `bind.ts` hands it to `Bun.serve`. */
export const proxyWebSocketHandler = websocket;

/** The logger every caller that does not want one gets. Its `enabled` is false, so nothing runs. */
const NO_LOGGING: ProxyLogger = createProxyLogger({});

export interface ProxyAppOptions {
  /** The port this instance will be bound to. The `Host` allowlist is built from it. */
  port: number;
  /**
   * The handshake's collaborators. Absent until the composition root has an account manager to
   * offer, in which case every route answers 503 rather than half-working.
   */
  deps?: ProxyDeps | undefined;
  /** Opt-in request logging. Omitted, nothing is logged and nothing is even built. */
  logger?: ProxyLogger | undefined;
}

export function createProxyApp({ port, deps, logger }: ProxyAppOptions) {
  const app = new Hono()
    .use(hostGuard(port))
    .use(originGuard(port))
    // After the guards, so a rejected `Host` is logged as the 403 it became rather than as a request
    // that was served. See `proxy/request-log.ts`.
    .use(
      proxyAccessLog(logger ?? NO_LOGGING, (method, path) => {
        const inside = mirrorPath(path);
        if (inside === null) return "(not the mirror)";
        // Naming the two 404s apart is the whole reason this resolver exists: a path that maps to no
        // operation is a route table gap, and a path that maps to one is VRChat's own answer.
        return matchRoute(method, inside)?.route.operationId ?? "(no route)";
      }),
    )

    // --- the handshake ------------------------------------------------------
    .get(`${MIRROR_PREFIX}/auth/user`, (c) => withDeps(deps, (d) => getCurrentUser(request(c), d)))
    .post(`${MIRROR_PREFIX}/auth/twofactorauth/:method/verify`, (c) => {
      const method = c.req.param("method");
      // VRChat has exactly three verifiers and 404s anything else. The proxy accepts all three and
      // treats them identically — the code being typed is a vrc.zip pairing code either way, and
      // refusing the one an app happens to prefer would break clients for no gain.
      if (!["totp", "emailotp", "otp"].includes(method)) return notFound();
      return withDeps(deps, (d) => verifyTwoFactor(request(c), d));
    })
    .get(`${MIRROR_PREFIX}/auth`, (c) => withDeps(deps, (d) => verifyAuthToken(request(c), d)))
    .put(`${MIRROR_PREFIX}/logout`, (c) => withDeps(deps, (d) => logout(request(c), d)))

    // --- the pipeline mirror ------------------------------------------------
    // `wss://pipeline.vrchat.cloud/?authToken=…` is path `/`, not under `/api/1` — the real pipeline
    // is a different host entirely, and the forward proxy rewrites the host while leaving the path
    // alone. So this route sits beside the mirror rather than inside it. See §2.9.
    .get(
      "/",
      upgradeWebSocket((c) => {
        let detach: (() => void) | undefined;
        return {
          onOpen(_event, ws) {
            const bound = resolvePipelineClient(deps, c.req.url, c.req.header("cookie") ?? null);
            if (bound === null) {
              // Exactly what VRChat does with a dead token: accept the socket, say why, hang up.
              // A client that reconnects on close and re-authenticates on this frame behaves
              // correctly against the mirror for the same reason it does against VRChat.
              ws.send(deadSessionFrame());
              ws.close(1008, "unauthorized");
              return;
            }
            detach = bound.subscribe({
              send: (frame) => ws.send(frame),
              close: (code, reason) => ws.close(code, reason),
            });
          },
          onClose() {
            detach?.();
            detach = undefined;
          },
          onError() {
            detach?.();
            detach = undefined;
          },
        };
      }),
    )

    // --- everything else ----------------------------------------------------
    .all("*", async (c) => {
      const path = mirrorPath(c.req.path);
      if (path === null) return notFound();

      const matched = matchRoute(c.req.method, path);
      if (matched === null) return notFound();

      return withDeps(deps, async (d) => {
        if (d.passthrough === undefined) {
          return vrczipError(
            503,
            "not_ready",
            "The vrc.zip mirror cannot reach VRChat yet. Finish first-run setup.",
          );
        }
        // The query string comes off the raw URL rather than being rebuilt from parsed params:
        // re-encoding it would reorder repeats and normalise escapes, and the mirror's contract is
        // that VRChat sees what the app sent.
        const query = c.req.url.slice(c.req.url.indexOf(c.req.path) + c.req.path.length);
        return passthrough(
          matched.route,
          {
            method: c.req.method,
            path: `${path}${query}`,
            headers: c.req.raw.headers,
            body: bodyless(c.req.method) ? null : await c.req.raw.arrayBuffer(),
          },
          d.passthrough,
        );
      });
    });

  return app;
}

export type ProxyApp = ReturnType<typeof createProxyApp>;

/** The path as VRChat sees it, or null when the request was not aimed at the mirror at all. */
function mirrorPath(path: string): string | null {
  if (path === MIRROR_PREFIX) return "/";
  return path.startsWith(`${MIRROR_PREFIX}/`) ? path.slice(MIRROR_PREFIX.length) : null;
}

/**
 * The grant behind a pipeline handshake, as something that can be subscribed with.
 *
 * Returns null for every failure — no token, an unknown or revoked one, a mirror with no pipeline
 * wired — because a client cannot act differently on any of them and telling them apart would say
 * whether a token it holds was ever valid.
 */
function resolvePipelineClient(
  deps: ProxyDeps | undefined,
  url: string,
  cookieHeader: string | null,
): { subscribe: (sink: PipelineSink) => () => void } | null {
  if (deps?.pipeline === undefined) return null;

  const token = pipelineToken(url, cookieHeader);
  if (token === null) return null;

  const grant = deps.grants.grantByTokenHash(hashProxyToken(token));
  if (grant === null) return null;

  let scopes: Scope[];
  try {
    const parsed: unknown = JSON.parse(grant.scopes);
    scopes = Array.isArray(parsed) ? (parsed.filter((s) => typeof s === "string") as Scope[]) : [];
  } catch {
    // A grant row we cannot read authorises nothing, which fails closed.
    scopes = [];
  }

  const mirror = deps.pipeline;
  return { subscribe: (sink) => mirror.subscribe(grant.account_id, scopes, sink) };
}

/** `fetch` refuses a body on these, and VRChat defines none for them either. */
function bodyless(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD" || upper === "DELETE";
}

/** VRChat's real 404 shape. An unknown path gets this rather than a catch-all's guess. */
function notFound(): Response {
  return vrchatError(404, "Not Found");
}

function withDeps(
  deps: ProxyDeps | undefined,
  handler: (deps: ProxyDeps) => Response | Promise<Response>,
): Response | Promise<Response> {
  if (deps === undefined) {
    return vrczipError(503, "not_ready", "The vrc.zip proxy is not accepting logins yet.");
  }
  return handler(deps);
}

/**
 * Adapts Hono's context to the handshake's `RequestLike`.
 *
 * The handshake takes this narrow shape rather than a `Context` so its tests need no framework and
 * no server — the flow is the part worth testing exhaustively, and a route table around it is not.
 */
function request(c: Context): RequestLike {
  return {
    method: c.req.method,
    header: (name) => c.req.header(name),
    cookie: (name) => getCookie(c, name),
    json: () => c.req.json(),
  };
}
