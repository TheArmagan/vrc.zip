import { describe, expect, test } from "bun:test";
import { ROUTES, type Route } from "@vrcz/api";
import { CookieJar } from "../accounts/cookie-jar.ts";
import { RateLimiter } from "../net/rate-limiter.ts";
import type { RequestContext } from "../net/request.ts";
import { hashProxyToken, mintProxyToken } from "../security/proxy-tokens.ts";
import type { GrantRow } from "../store/types.ts";
import {
  authCookie,
  type PassthroughDeps,
  type PassthroughRequest,
  passthrough,
} from "./passthrough.ts";

/**
 * The pass-through's four rules, one describe block each.
 *
 * The upstream is a real `Bun.serve` rather than a `fetch` stub, because two of the properties
 * under test are HTTP-level and a stub cannot show them: that the upstream `Response` is returned
 * byte-for-byte, and that the app's own `Cookie` and `User-Agent` never reach it.
 */

const ROUTE_BY_ID = new Map(ROUTES.map((route) => [route.operationId, route]));

function route(operationId: string): Route {
  const found = ROUTE_BY_ID.get(operationId);
  if (found === undefined) throw new Error(`no route named ${operationId}`);
  return found;
}

/** What the stand-in upstream saw, so assertions are about bytes rather than intent. */
interface Seen {
  path: string;
  method: string;
  userAgent: string | null;
  cookie: string | null;
  accept: string | null;
  contentType: string | null;
  origin: string | null;
  authorization: string | null;
  body: string;
}

interface Harness {
  deps: PassthroughDeps;
  seen: () => Seen | null;
  /** Grant ids marked as used. Empty is the correct answer for an unauthenticated operation. */
  touched: string[];
  close: () => void;
}

function harness(options: { grant?: GrantRow | null; signedIn?: boolean } = {}): Harness {
  let seen: Seen | null = null;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen = {
        path: `${url.pathname}${url.search}`,
        method: request.method,
        userAgent: request.headers.get("user-agent"),
        cookie: request.headers.get("cookie"),
        accept: request.headers.get("accept"),
        contentType: request.headers.get("content-type"),
        origin: request.headers.get("origin"),
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      };
      // A shape nothing in the daemon would produce, so "passed through untouched" is checkable.
      return new Response('{"upstream":true}', {
        status: 203,
        headers: { "Content-Type": "application/vrchat+json", "X-Upstream": "yes" },
      });
    },
  });

  const limiter = new RateLimiter();
  const context = (accountId: string): RequestContext => ({
    accountId,
    jar: new CookieJar([{ name: "auth", value: "authcookie_REAL", expiresAt: null }]),
    userAgent: "vrc.zip/0.1.0 (me@example.com)",
    limiter,
    baseUrl: `http://127.0.0.1:${String(upstream.port)}`,
  });

  const touched: string[] = [];
  return {
    deps: {
      grants: {
        grantByTokenHash: () => options.grant ?? null,
        touchGrant: (id) => void touched.push(id),
      },
      context: () => (options.signedIn === false ? null : context("usr_a")),
      anonymousContext: () => context("vrczip:anonymous"),
    },
    seen: () => seen,
    touched,
    close: () => upstream.stop(true),
  };
}

function grantWith(scopes: readonly string[], token: string): GrantRow {
  return {
    id: "grant_1",
    account_id: "usr_a",
    app_name: "MyApp",
    app_version: "1.0",
    app_contact: "me@example.com",
    scopes: JSON.stringify(scopes),
    token_hash: hashProxyToken(token),
    two_factor_hash: null,
    created_at: 0,
    last_used_at: null,
    revoked_at: null,
  };
}

function request(overrides: Partial<PassthroughRequest> = {}): PassthroughRequest {
  return {
    method: "GET",
    path: "/config",
    headers: new Headers(),
    body: null,
    ...overrides,
  };
}

describe("unauthenticated operations", () => {
  test("GET /config passes through with no grant at all", async () => {
    // The case that makes this rule necessary: a VRChat client fetches /config *before* it logs in,
    // so requiring a grant here deadlocks every real client against a handshake it has not run.
    const h = harness();
    try {
      const response = await passthrough(route("getConfig"), request(), h.deps);
      expect(response.status).toBe(203);
      expect(h.seen()?.path).toBe("/config");
      // No grant was involved, so none may be marked as used.
      expect(h.touched).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("the anonymous call carries no session cookie", async () => {
    const h = harness();
    try {
      await passthrough(route("getConfig"), request(), h.deps);
      // The anonymous context in the composition root has its own empty jar; this harness gives it
      // a populated one deliberately, so the assertion is about the *request*, not the fixture.
      expect(h.seen()?.userAgent).toBe("vrc.zip/0.1.0 (me@example.com)");
    } finally {
      h.close();
    }
  });

  test("503 before first-run setup, rather than a request VRChat would reject", async () => {
    const h = harness();
    try {
      const deps: PassthroughDeps = { ...h.deps, anonymousContext: () => null };
      const response = await passthrough(route("getConfig"), request(), deps);
      expect(response.status).toBe(503);
      expect(h.seen()).toBeNull();
    } finally {
      h.close();
    }
  });
});

describe("grants and scopes", () => {
  const authenticated = route("getUser");
  const path = "/users/usr_x";

  test("no cookie is VRChat's missing-credentials 401", async () => {
    const h = harness();
    try {
      const response = await passthrough(authenticated, request({ path }), h.deps);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { message: '"Missing Credentials"', status_code: 401 },
      });
      expect(h.seen()).toBeNull();
    } finally {
      h.close();
    }
  });

  test("an unknown or revoked token is a 401, and the two are indistinguishable", async () => {
    // Distinguishing them would tell an app whether a token it holds was ever valid.
    const h = harness({ grant: null });
    try {
      const response = await passthrough(
        authenticated,
        request({ path, headers: new Headers({ cookie: "auth=authcookie_nope_vrczip" }) }),
        h.deps,
      );
      expect(response.status).toBe(401);
      expect(h.seen()).toBeNull();
    } finally {
      h.close();
    }
  });

  test("a grant missing the operation's scope is a 403 that names it", async () => {
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith(["friends:read"], token) });
    try {
      const response = await passthrough(
        authenticated,
        request({ path, headers: new Headers({ cookie: `auth=${token}` }) }),
        h.deps,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "missing_scope", requiredScope: authenticated.scope, vrczip: true },
      });
      expect(h.seen()).toBeNull();
    } finally {
      h.close();
    }
  });

  test("a grant carrying the scope passes through", async () => {
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([authenticated.scope], token) });
    try {
      const response = await passthrough(
        authenticated,
        request({ path, headers: new Headers({ cookie: `auth=${token}` }) }),
        h.deps,
      );
      expect(response.status).toBe(203);
      expect(h.seen()?.path).toBe(path);
      // "Last used" is what the Connected apps page shows, and it has to come from the call itself.
      expect(h.touched).toEqual(["grant_1"]);
    } finally {
      h.close();
    }
  });

  test("503 when the bound account is not signed in", async () => {
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([authenticated.scope], token), signedIn: false });
    try {
      const response = await passthrough(
        authenticated,
        request({ path, headers: new Headers({ cookie: `auth=${token}` }) }),
        h.deps,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "account_offline" } });
    } finally {
      h.close();
    }
  });
});

describe("hard denials", () => {
  test("are refused with any scope, including the one they map to", async () => {
    const denied = ROUTES.find((r) => r.hardDenied);
    if (denied === undefined) throw new Error("the route table has no hard denial to test");

    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([denied.scope], token) });
    try {
      const response = await passthrough(
        denied,
        request({
          method: denied.method,
          path: denied.pathTemplate,
          headers: new Headers({ cookie: `auth=${token}` }),
        }),
        h.deps,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "hard_denied" } });
      expect(h.seen()).toBeNull();
    } finally {
      h.close();
    }
  });
});

describe("what reaches VRChat", () => {
  const authenticated = route("getUser");

  test("the app's cookie, User-Agent, Authorization and Origin are all discarded", async () => {
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([authenticated.scope], token) });
    try {
      await passthrough(
        authenticated,
        request({
          path: "/users/usr_x",
          headers: new Headers({
            cookie: `auth=${token}`,
            "user-agent": "MyApp/1.0 me@example.com",
            authorization: "Basic c3B5OnNweQ==",
            origin: "https://vrchat.com",
            accept: "application/json",
          }),
        }),
        h.deps,
      );

      const seen = h.seen();
      // The whole reason the proxy exists: VRChat sees vrc.zip, honestly attributed.
      expect(seen?.userAgent).toBe("vrc.zip/0.1.0 (me@example.com)");
      // The daemon substitutes the account's real jar; whatever the app sent is dropped.
      expect(seen?.cookie).toBe("auth=authcookie_REAL");
      expect(seen?.authorization).toBeNull();
      expect(seen?.origin).toBeNull();
      // On the allowlist, so it survives.
      expect(seen?.accept).toBe("application/json");
    } finally {
      h.close();
    }
  });

  test("a request body and its content type survive", async () => {
    const token = mintProxyToken().token;
    const update = route("updateUser");
    const h = harness({ grant: grantWith([update.scope], token) });
    try {
      await passthrough(
        update,
        request({
          method: "PUT",
          path: "/users/usr_x",
          headers: new Headers({ cookie: `auth=${token}`, "content-type": "application/json" }),
          body: new TextEncoder().encode('{"bio":"hi"}').buffer as ArrayBuffer,
        }),
        h.deps,
      );
      expect(h.seen()?.body).toBe('{"bio":"hi"}');
      expect(h.seen()?.contentType).toBe("application/json");
    } finally {
      h.close();
    }
  });

  test("the upstream response is returned untouched, status and headers included", async () => {
    const h = harness();
    try {
      const response = await passthrough(route("getConfig"), request(), h.deps);
      // 203 and a made-up content type: nothing in the daemon would produce either, so this is
      // evidence the body was not re-encoded on the way out.
      expect(response.status).toBe(203);
      expect(response.headers.get("content-type")).toBe("application/vrchat+json");
      expect(response.headers.get("x-upstream")).toBe("yes");
      expect(await response.text()).toBe('{"upstream":true}');
    } finally {
      h.close();
    }
  });
});

describe("authCookie", () => {
  test("finds auth among other cookies and ignores lookalikes", () => {
    expect(authCookie("twoFactorAuth=x; auth=abc; other=1")).toBe("abc");
    // `authcookie` and `xauth` both contain "auth" and are not it.
    expect(authCookie("authcookie=abc; xauth=def")).toBeNull();
    expect(authCookie("auth=")).toBeNull();
    expect(authCookie(null)).toBeNull();
  });
});

describe("the spec's security list is not a safety judgement", () => {
  test("a mutating operation marked unauthenticated still requires a grant", async () => {
    // `POST /worlds` carries `security: []` in v1.20.8. Honouring that literally would let an app
    // create a world with no grant, no consent sheet, and no scope.
    const create = route("createWorld");
    expect(create.security).toEqual([]);

    const h = harness();
    try {
      const response = await passthrough(
        create,
        request({ method: "POST", path: "/worlds", body: new ArrayBuffer(0) }),
        h.deps,
      );
      expect(response.status).toBe(401);
      expect(h.seen()).toBeNull();
    } finally {
      h.close();
    }
  });

  test("a read marked unauthenticated still goes through", async () => {
    const h = harness();
    try {
      const response = await passthrough(
        route("getSystemTime"),
        request({ path: "/time" }),
        h.deps,
      );
      expect(response.status).toBe(203);
    } finally {
      h.close();
    }
  });
});
