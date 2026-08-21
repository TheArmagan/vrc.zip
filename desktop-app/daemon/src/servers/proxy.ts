import { Hono } from "hono";
import { hostGuard, originGuard, sessionAuth, type TokenSource } from "../security/guards.ts";

/**
 * The VRChat API mirror on `:7774`. See PLAN.md §1.8 and §Phase 2.
 *
 * **Phase 2 fills this in.** What exists here now is the port binding and the middleware chain,
 * because those are the parts the rest of Phase 1 depends on and the parts worth having under test
 * before any route exists: the `Host` allowlist has to hold on this port too, and standing the
 * instance up early means the "three separate instances" property is structural from the start
 * rather than something to retrofit.
 *
 * When Phase 2 lands, routes are registered one per operation from the generated route table — not
 * a catch-all — so that an unknown path falls through to VRChat's real 404 shape, and so that a
 * route with no scope mapping fails to register. `scopeGuard`, `rateBudget`, and `auditLog` join
 * the chain below `sessionAuth`, and auth switches from the session token to grant tokens from the
 * token store.
 */

export interface ProxyAppOptions {
  /** The port this instance will be bound to. The `Host` allowlist is built from it. */
  port: number;
  /**
   * Resolves the accepted token. Phase 1 accepts the session token; Phase 2 replaces this with a
   * grant-token lookup, which is why it is a function rather than a string.
   */
  token: TokenSource;
}

export function createProxyApp({ port, token }: ProxyAppOptions) {
  const app = new Hono()
    .use(hostGuard(port))
    .use(originGuard(port))
    .use(sessionAuth(token))
    .all("*", (c) =>
      c.json(
        {
          error: "not_implemented",
          message: "The VRChat API mirror lands in Phase 2.",
        },
        501,
      ),
    );

  return app;
}

export type ProxyApp = ReturnType<typeof createProxyApp>;
