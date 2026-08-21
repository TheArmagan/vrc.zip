import type { Context, MiddlewareHandler } from "hono";
import { sessionTokensMatch } from "./session-token.ts";

/**
 * The three cross-cutting guards every vrc.zip port runs. See PLAN.md §1.8 and §1.10.
 *
 * They are middleware rather than per-route checks because "every request on every port" is the
 * actual requirement: a route added later must not be able to opt out by forgetting a line.
 */

/** Hostnames a loopback request may legitimately arrive under. */
export const ALLOWED_HOSTNAMES = ["127.0.0.1", "localhost", "local.vrc.zip"] as const;

/** Header the UI sends when it would rather not put the token in a query string. */
export const TOKEN_HEADER = "X-Vrcz-Token";

/** Query parameter the launch URL carries, so the first navigation can authenticate itself. */
export const TOKEN_QUERY_PARAM = "token";

export function allowedHosts(port: number): string[] {
  return ALLOWED_HOSTNAMES.map((name) => `${name}:${port}`);
}

/**
 * **The DNS-rebinding defense.** A page on `evil.example` can make the browser resolve its own
 * hostname to `127.0.0.1`, but it cannot change the `Host` header the browser then sends — that
 * stays `evil.example:PORT`. Rejecting an unrecognised `Host` is therefore what actually stops the
 * attack, and it is why this is mandatory on all three ports rather than advisory.
 *
 * An absent `Host` is rejected too. HTTP/1.1 requires it and HTTP/2 synthesises it from
 * `:authority`, so a request without one is either malformed or deliberately evasive.
 */
export function hostGuard(port: number): MiddlewareHandler {
  const allowed = new Set(allowedHosts(port));
  return async function hostGuardMiddleware(c, next) {
    const host = c.req.header("host");
    if (host === undefined || !allowed.has(host.toLowerCase())) {
      return c.json({ error: "forbidden_host" }, 403);
    }
    await next();
  };
}

/**
 * Validates `Origin` where the request carries one.
 *
 * Absent is allowed: `curl`, the CLI, and plugin runtimes are not browsers and send no `Origin`,
 * and rejecting them would buy nothing — a non-browser attacker sets whatever header it likes, so
 * `Origin` was never the defense. `Host` is (see `hostGuard`). A *present but wrong* `Origin` is a
 * real cross-site browser request, and gets a 403.
 */
export function originGuard(port: number): MiddlewareHandler {
  const allowed = new Set<string>();
  for (const host of allowedHosts(port)) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  return async function originGuardMiddleware(c, next) {
    const origin = c.req.header("origin");
    // `null` — a sandboxed iframe or a `file://` page — is not in the allowlist, so it falls into
    // the same rejection as any other foreign origin.
    if (origin !== undefined && !allowed.has(origin.toLowerCase())) {
      return c.json({ error: "forbidden_origin" }, 403);
    }
    await next();
  };
}

/** Resolves the token this port currently accepts. Async so the caller can read it off disk. */
export type TokenSource = () => string | Promise<string>;

/**
 * Session-token auth, accepting the three transports the UI actually needs:
 *
 * - `Authorization: Bearer <token>` — the CLI and anything scripted.
 * - `X-Vrcz-Token: <token>` — the UI's own fetches, once it has the token in memory.
 * - `?token=<token>` — the launch URL, which is the only way the very first navigation can carry
 *   credentials at all. The UI strips it from the address bar immediately after boot.
 */
export function sessionAuth(getToken: TokenSource): MiddlewareHandler {
  return async function sessionAuthMiddleware(c, next) {
    const presented = extractSessionToken(c);
    if (presented === undefined) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const expected = await getToken();
    if (expected === "" || !sessionTokensMatch(presented, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

/**
 * Pulls the token out of whichever transport carried it. Exported so the UI server can add its own
 * transport (a post-launch cookie) without re-implementing the other three.
 */
export function extractSessionToken(c: Context): string | undefined {
  const authorization = c.req.header("authorization");
  const tokenHeader = c.req.header(TOKEN_HEADER);
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  if (tokenHeader !== undefined && tokenHeader !== "") return tokenHeader;
  const fromQuery = c.req.query(TOKEN_QUERY_PARAM);
  if (fromQuery !== undefined && fromQuery !== "") return fromQuery;
  return undefined;
}
