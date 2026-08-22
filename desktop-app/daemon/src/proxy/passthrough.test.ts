import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { ROUTES, type Route } from "@vrcz/api";
import { type Cookie, CookieJar } from "../accounts/cookie-jar.ts";
import { RateLimiter } from "../net/rate-limiter.ts";
import type { RequestContext } from "../net/request.ts";
import { hashProxyToken, mintProxyToken } from "../security/proxy-tokens.ts";
import type { GrantRow, NewAuditEntry } from "../store/types.ts";
import {
  authCookie,
  BUDGET_WINDOW_MS,
  DEFAULT_GRANT_BUDGETS,
  type PassthroughDeps,
  type PassthroughRequest,
  passthrough,
} from "./passthrough.ts";
import { matchRoute, SUPPLEMENTAL_ROUTES } from "./route-table.ts";

/**
 * The pass-through's four rules, one describe block each.
 *
 * The upstream is a real `Bun.serve` rather than a `fetch` stub, because two of the properties
 * under test are HTTP-level and a stub cannot show them: that the upstream `Response` is returned
 * byte-for-byte, and that the app's own `Cookie` and `User-Agent` never reach it.
 */

// The supplement is included, because the file and image download routes only exist there — the
// pinned spec does not describe the URLs VRChat puts in its own responses. See `route-table.ts`.
const ROUTE_BY_ID = new Map(
  [...ROUTES, ...SUPPLEMENTAL_ROUTES].map((route) => [route.operationId, route]),
);

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
  /** Audit rows written, in order. See `isAuditable` — an ordinary read writes none. */
  audited: NewAuditEntry[];
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
  // The signed-in account carries a real session; the anonymous context has an empty jar of its own,
  // exactly as the composition root builds them. Giving both the same jar would make every
  // "did this go out anonymously" assertion vacuous.
  const context = (accountId: string, cookies: Cookie[]): RequestContext => ({
    accountId,
    jar: new CookieJar(cookies),
    userAgent: "vrc.zip/0.1.0 (me@example.com)",
    limiter,
    baseUrl: `http://127.0.0.1:${String(upstream.port)}`,
  });
  const signedIn = (): RequestContext =>
    context("usr_a", [{ name: "auth", value: "authcookie_REAL", expiresAt: null }]);
  const anonymous = (): RequestContext => context("vrczip:anonymous", []);

  const touched: string[] = [];
  const audited: NewAuditEntry[] = [];
  return {
    deps: {
      grants: {
        grantByTokenHash: () => options.grant ?? null,
        touchGrant: (id) => void touched.push(id),
        // Mirrors the store: the id is the row's position, so `finishAudit` can fill in the status
        // the same way an UPDATE would.
        appendAudit: (entry) => audited.push(entry),
        finishAudit: (id, status) => {
          const row = audited[id - 1];
          if (row !== undefined) row.status = status;
        },
        // Counted from the rows this harness has already collected, exactly as the store counts
        // them from the table — so a budget test exercises the real relationship between the audit
        // log and the budget rather than a number handed to it.
        countGrantScopeUsage: (grantId, scope, since) =>
          audited.filter(
            (row) =>
              row.grant_id === grantId &&
              row.scope === scope &&
              row.outcome === "allowed" &&
              row.ts >= since,
          ).length,
      },
      context: () => (options.signedIn === false ? null : signedIn()),
      anonymousContext: anonymous,
    },
    seen: () => seen,
    touched,
    audited,
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
      // Tying a public call to a real user's session buys nothing and says who they are.
      expect(h.seen()?.cookie).toBeNull();
      // Still our own honest User-Agent, which is the half VRChat does require.
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

describe("the audit log", () => {
  /*
   * PROGRESS.md decision 96. The rule is "anything that changes something, plus anything a
   * dangerous scope guards", and the second half is the part worth testing: a write-only log reads
   * as complete while an app quietly enumerates the user's moderation history.
   */
  const mutating = route("createAvatar");
  const dangerousRead = route("getPlayerModerations");
  const ordinaryRead = route("getUser");

  test("records a mutating call with what VRChat actually answered", async () => {
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([mutating.scope], token) });
    try {
      await passthrough(
        mutating,
        request({
          method: "POST",
          path: "/avatars",
          headers: new Headers({ cookie: `auth=${token}`, "user-agent": "Thing/1.0 (a@b.c)" }),
          body: new TextEncoder().encode("{}").buffer as ArrayBuffer,
        }),
        h.deps,
      );
      expect(h.audited).toHaveLength(1);
      expect(h.audited[0]).toMatchObject({
        outcome: "allowed",
        // The upstream status, not ours. An app being refused by VRChat itself looks identical to a
        // working one until this column says otherwise.
        status: 203,
        method: "POST",
        operation_id: "createAvatar",
        scope: mutating.scope,
        grant_id: "grant_1",
        account_id: "usr_a",
        // The grant's own name, not the `User-Agent` this request happened to carry — a grant is
        // the identity the user consented to, and a header is whatever the app says today.
        app_name: "MyApp",
      });
    } finally {
      h.close();
    }
  });

  test("records a read behind a dangerous scope, and not an ordinary one", async () => {
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([dangerousRead.scope, ordinaryRead.scope], token) });
    try {
      const headers = () => new Headers({ cookie: `auth=${token}` });
      await passthrough(
        dangerousRead,
        request({ path: "/auth/user/playermoderations", headers: headers() }),
        h.deps,
      );
      await passthrough(
        ordinaryRead,
        request({ path: "/users/usr_x", headers: headers() }),
        h.deps,
      );

      // Exactly one row, and it is the moderation read. `GET /users/{id}` at eighty a room would
      // bury the rows that mean something under rows that mean nothing.
      expect(h.audited.map((row) => row.operation_id)).toEqual(["getPlayerModerations"]);
    } finally {
      h.close();
    }
  });

  test("records a hard denial whether or not the rule would otherwise audit it", async () => {
    // A route-table flag, not a scope: somebody attempting to delete the user's account through the
    // mirror is the single most interesting row this table can hold, so it is forced.
    const denied = ROUTES.find((entry) => entry.hardDenied);
    if (denied === undefined) throw new Error("no hard-denied route in the table");
    const h = harness();
    try {
      await passthrough(
        denied,
        request({
          method: denied.method,
          path: "/users/usr_x/delete",
          headers: new Headers({ "user-agent": "Thing/1.0 (a@b.c)" }),
        }),
        h.deps,
      );
      expect(h.audited).toHaveLength(1);
      expect(h.audited[0]).toMatchObject({
        outcome: "hard_denied",
        status: 403,
        grant_id: null,
        // No grant to name, so the User-Agent the consent sheet would have shown.
        app_name: "Thing",
      });
    } finally {
      h.close();
    }
  });

  test("records a refusal, attributing it to whatever identity it presented", async () => {
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith(["friends:read"], token) });
    try {
      await passthrough(
        mutating,
        request({
          method: "POST",
          path: "/avatars",
          headers: new Headers({ cookie: `auth=${token}`, "user-agent": "Thing/1.0 (a@b.c)" }),
        }),
        h.deps,
      );
      expect(h.audited[0]).toMatchObject({ outcome: "denied_scope", status: 403 });
    } finally {
      h.close();
    }
  });

  test("writes nothing for a request carrying no credentials at all", async () => {
    // Nothing to attribute it to beyond a User-Agent anyone can type, and the handshake produces
    // these legitimately. A row per anonymous probe is noise on a table nothing prunes.
    const h = harness();
    try {
      await passthrough(mutating, request({ method: "POST", path: "/avatars" }), h.deps);
      expect(h.audited).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("records the account being offline, which is a refusal the app can do nothing about", async () => {
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([mutating.scope], token), signedIn: false });
    try {
      await passthrough(
        mutating,
        request({
          method: "POST",
          path: "/avatars",
          headers: new Headers({ cookie: `auth=${token}` }),
        }),
        h.deps,
      );
      expect(h.audited[0]).toMatchObject({ outcome: "account_offline", status: 503 });
    } finally {
      h.close();
    }
  });
});

describe("per-grant budgets", () => {
  /*
   * PROGRESS.md decision 95. The three scopes here are the ones whose abuse other people can *see* —
   * mass invites, mass friending, dragging strangers into a group — which is how a user gets
   * blocked, reported or moderated for something an app did. The per-account bucket already paces
   * requests; what it structurally cannot express is volume over an hour, and sixty invites spread
   * politely across one passes every rate limit there is.
   */
  const budgeted = route("createGroupInvite");
  const limit = DEFAULT_GRANT_BUDGETS[budgeted.scope];
  const unbudgeted = route("createAvatar");

  function spend(h: ReturnType<typeof harness>, token: string, times: number): Promise<Response>[] {
    return Array.from({ length: times }, () =>
      passthrough(
        budgeted,
        request({
          method: "POST",
          path: "/groups/grp_x/invites",
          headers: new Headers({ cookie: `auth=${token}` }),
        }),
        h.deps,
      ),
    );
  }

  test("refuses past the hourly allowance, in a shape an app's 429 handling already reads", async () => {
    if (limit === undefined) throw new Error("createGroupInvite should be budgeted");
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([budgeted.scope], token) });
    try {
      for (const call of spend(h, token, limit)) expect((await call).status).toBe(203);

      const refused = await spend(h, token, 1)[0];
      expect(refused?.status).toBe(429);
      expect(await refused?.json()).toMatchObject({
        error: {
          code: "budget_exhausted",
          status_code: 429,
          // Ours, and it says so: an app can tell "the user's proxy is pacing me" from "VRChat is
          // angry" and back off against the right thing.
          vrczip: true,
          scope: budgeted.scope,
          limit,
        },
      });
    } finally {
      h.close();
    }
  });

  test("the refusal never reaches VRChat, which is the entire point", async () => {
    if (limit === undefined) throw new Error("createGroupInvite should be budgeted");
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([budgeted.scope], token) });
    try {
      for (const call of spend(h, token, limit)) await call;
      const before = h.seen()?.path;
      await spend(h, token, 1)[0];
      // Nothing new was sent upstream: the last thing VRChat saw is the last allowed call.
      expect(h.seen()?.path).toBe(before);
    } finally {
      h.close();
    }
  });

  test("a refusal is audited but does not itself consume the allowance", async () => {
    // Otherwise an app exhausts its own budget by being denied, and the budget becomes permanent
    // the moment it first trips. Only `allowed` rows count — see `SQL.countGrantScopeUsage`.
    if (limit === undefined) throw new Error("createGroupInvite should be budgeted");
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([budgeted.scope], token) });
    try {
      for (const call of spend(h, token, limit)) await call;
      await spend(h, token, 1)[0];
      await spend(h, token, 1)[0];

      const allowed = h.audited.filter((row) => row.outcome === "allowed");
      const refused = h.audited.filter((row) => row.outcome === "rate_limited");
      expect(allowed).toHaveLength(limit);
      expect(refused).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  test("the window rolls, so an app that waits it out continues", async () => {
    if (limit === undefined) throw new Error("createGroupInvite should be budgeted");
    const token = mintProxyToken().token;
    let clock = 1_000_000;
    const h = harness({ grant: grantWith([budgeted.scope], token) });
    const deps = { ...h.deps, now: () => clock };
    try {
      const send = (): Promise<Response> =>
        passthrough(
          budgeted,
          request({
            method: "POST",
            path: "/groups/grp_x/invites",
            headers: new Headers({ cookie: `auth=${token}` }),
          }),
          deps,
        );

      for (let i = 0; i < limit; i++) await send();
      expect((await send()).status).toBe(429);

      clock += BUDGET_WINDOW_MS + 1;
      expect((await send()).status).toBe(203);
    } finally {
      h.close();
    }
  });

  test("holds under concurrency, because the slot is reserved before the call goes out", async () => {
    /*
     * The check reads a count and the call that follows takes time, so a budget that recorded the
     * spend *after* the response would let N simultaneous calls all read the same pre-spend number
     * and all pass. An app firing a hundred group invites at once is not a hypothetical shape — it
     * is the exact abuse this budget exists for, and it is the shape that would defeat it.
     */
    if (limit === undefined) throw new Error("createGroupInvite should be budgeted");
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([budgeted.scope], token) });
    try {
      const responses = await Promise.all(spend(h, token, limit + 10));
      const allowed = responses.filter((response) => response.status === 203);
      const refused = responses.filter((response) => response.status === 429);
      expect(allowed).toHaveLength(limit);
      expect(refused).toHaveLength(10);
    } finally {
      h.close();
    }
  });

  test("a scope with no budget is not counted against one", async () => {
    // Every scope but the three. A budget over all writes would punish a chatty-but-harmless app
    // for volume that costs the user nothing.
    expect(DEFAULT_GRANT_BUDGETS[unbudgeted.scope]).toBeUndefined();
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith([unbudgeted.scope], token) });
    try {
      for (let i = 0; i < 5; i++) {
        const response = await passthrough(
          unbudgeted,
          request({
            method: "POST",
            path: "/avatars",
            headers: new Headers({ cookie: `auth=${token}` }),
          }),
          h.deps,
        );
        expect(response.status).toBe(203);
      }
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

describe("responses whose body fetch already decoded", () => {
  /** An upstream that behaves like VRChat: gzipped JSON, announced as such. */
  function gzipHarness(): Harness {
    const seen: Seen | null = null;
    const payload = JSON.stringify({ clientApiKey: "JlE5Jldo", pad: "x".repeat(400) });
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        const body = gzipSync(Buffer.from(payload));
        return new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            "Content-Length": String(body.length),
          },
        });
      },
    });

    const limiter = new RateLimiter();
    const context = (accountId: string): RequestContext => ({
      accountId,
      jar: new CookieJar(),
      userAgent: "vrc.zip/0.1.0 (me@example.com)",
      limiter,
      baseUrl: `http://127.0.0.1:${String(upstream.port)}`,
    });

    return {
      deps: {
        grants: {
          grantByTokenHash: () => null,
          touchGrant: () => {},
          appendAudit: () => 1,
          finishAudit: () => {},
          countGrantScopeUsage: () => 0,
        },
        context: () => context("usr_a"),
        anonymousContext: () => context("vrczip:anonymous"),
      },
      seen: () => seen,
      touched: [],
      audited: [],
      close: () => upstream.stop(true),
    };
  }

  test("does not announce a Content-Encoding over a body that is no longer encoded", async () => {
    // What VRCX reported as an unsupported compression method: `fetch` decompresses transparently
    // and keeps the headers describing the compressed form, so the client gunzips plain JSON.
    const h = gzipHarness();
    try {
      const response = await passthrough(route("getConfig"), request(), h.deps);
      expect(response.headers.get("content-encoding")).toBeNull();
      // The compressed length would truncate the body a client reads by it.
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toMatchObject({ clientApiKey: "JlE5Jldo" });
    } finally {
      h.close();
    }
  });

  test("an uncompressed response is passed through as the very same object", async () => {
    const h = harness();
    try {
      const response = await passthrough(route("getConfig"), request(), h.deps);
      // Nothing was decoded, so nothing needed rebuilding.
      expect(response.headers.get("x-upstream")).toBe("yes");
      expect(response.status).toBe(203);
    } finally {
      h.close();
    }
  });
});

describe("the image and file routes the spec omits", () => {
  test("an avatar image URL routes to files:read rather than a 404", async () => {
    // `currentAvatarImageUrl` in a real User payload. Absent from openapi.json v1.20.8.
    const matched = matchRoute("GET", "/image/file_abc/3/1024");
    expect(matched?.route.operationId).toBe("downloadImageVersion");
    expect(matched?.route.scope).toBe("files:read");
    expect(matched?.params).toMatchObject({
      fileId: "file_abc",
      versionId: "3",
      resolution: "1024",
    });
  });

  test("a user icon URL routes too, in both of its overloaded forms", () => {
    expect(matchRoute("GET", "/file/file_icon/1/256")?.route.operationId).toBe(
      "downloadFileVersion",
    );
    expect(matchRoute("GET", "/file/file_pfp/2/file")?.route.operationId).toBe(
      "downloadFileVersion",
    );
  });

  test("the generated five-segment status route still wins its own shape", () => {
    // The supplement is four segments; adding it must not shadow what the spec does describe.
    expect(matchRoute("GET", "/file/file_x/1/file/status")?.route.operationId).toBe(
      "getFileDataUploadStatus",
    );
  });

  test("they are charged to the file rate bucket, not the API one", () => {
    // `tag: "files"` is what `passthrough` reads to pick the rate class. A screen full of avatars
    // charged to the API bucket queues presence and friend polling behind pictures.
    expect(matchRoute("GET", "/image/file_a/1/256")?.route.tag).toBe("files");
  });
});

describe("public reads downgrade rather than refuse", () => {
  const image = route("downloadImageVersion");
  const path = "/image/file_a/1/256";

  test("an image with no cookie at all is served, not 401'd", async () => {
    // VRCX renders avatars from <img> tags whose cookie jar never saw the login. VRChat itself
    // answers these unauthenticated — a bogus id gets 404 File not found, never 401 — so demanding
    // a grant here made every picture in the client a 401.
    const h = harness();
    try {
      const response = await passthrough(image, request({ path }), h.deps);
      expect(response.status).toBe(203);
      expect(h.seen()?.path).toBe(path);
      expect(h.touched).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("a caller presenting a grant with files:read gets the account's session", async () => {
    // The upgrade half: an image the account can see and the public cannot needs the cookie jar.
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith(["files:read"], token) });
    try {
      const response = await passthrough(
        image,
        request({ path, headers: new Headers({ cookie: `auth=${token}` }) }),
        h.deps,
      );
      expect(response.status).toBe(203);
      expect(h.seen()?.cookie).toBe("auth=authcookie_REAL");
      expect(h.touched).toEqual(["grant_1"]);
    } finally {
      h.close();
    }
  });

  test("a grant without files:read sees what anyone would, and is not refused", async () => {
    // Never 403 on a route VRChat does not gate — but never lend it the account's session either,
    // or a scope check would be bypassable through any public route.
    const token = mintProxyToken().token;
    const h = harness({ grant: grantWith(["friends:read"], token) });
    try {
      const response = await passthrough(
        image,
        request({ path, headers: new Headers({ cookie: `auth=${token}` }) }),
        h.deps,
      );
      expect(response.status).toBe(203);
      expect(h.seen()?.cookie).toBeNull();
      expect(h.touched).toEqual([]);
    } finally {
      h.close();
    }
  });
});
