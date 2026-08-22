import { describe, expect, test } from "bun:test";
import type { GameSession, Scope, StreamEventFrame, WebhookSummary } from "@vrcz/shared";
import { Hono } from "hono";
import { generateSessionToken } from "../security/session-token.ts";
import {
  APP_API_PREFIX,
  type AppApiDeps,
  type AppGrant,
  canSeeEvent,
  createAppApi,
  MAX_WEBHOOK_KINDS,
  parseGrantScopes,
  scopeForEventKind,
  visibleSessions,
} from "./app-api.ts";

const PORT = 7775;

/** A token of ours, in the shape `mintProxyToken` produces. */
const GRANT_TOKEN = "authcookie_00000000-0000-4000-8000-000000000001_vrczip";
/** VRChat's own shape — no `_vrczip` suffix — which must never authenticate here. */
const REAL_COOKIE = "authcookie_00000000-0000-4000-8000-000000000002";

const ACCOUNT_ID = "usr_00000000-0000-0000-0000-00000000000a";
const OTHER_ACCOUNT_ID = "usr_00000000-0000-0000-0000-00000000000b";

function grantWith(scopes: readonly Scope[]): AppGrant {
  return { id: "grant_1", accountId: ACCOUNT_ID, scopes, appName: "MyApp" };
}

const SESSIONS: GameSession[] = [
  {
    id: 1,
    accountId: ACCOUNT_ID,
    displayName: "Tester",
    startedAt: 1_700_000_000_000,
    vrMode: "vr",
    currentLocation: "wrld_a:1",
    currentWorldId: "wrld_a",
  },
  {
    id: 2,
    accountId: OTHER_ACCOUNT_ID,
    displayName: "Someone Else",
    startedAt: 1_700_000_001_000,
    vrMode: null,
    currentLocation: null,
    currentWorldId: null,
  },
  {
    // A client signed into an account vrc.zip does not manage. Normal, and the reason
    // `sessions:unlinked` exists — it names an account the user never added.
    id: 3,
    accountId: null,
    displayName: "Unmanaged Alt",
    startedAt: 1_700_000_002_000,
    vrMode: "desktop",
    currentLocation: null,
    currentWorldId: null,
  },
];

const WEBHOOK: WebhookSummary = {
  id: "wh_1",
  grantId: "grant_1",
  appName: "MyApp",
  url: "http://127.0.0.1:9000/hook",
  kinds: ["friend.*"],
  accountId: ACCOUNT_ID,
  createdAt: 1_700_000_000_000,
  disabledAt: null,
  disabledReason: null,
  deliveredCount: 0,
  deadCount: 0,
  lastDeliveryAt: null,
  lastStatus: null,
  lastError: null,
  pending: 0,
};

interface Recorder {
  resolved: string[];
  registered: { grantId: string; url: string; kinds?: readonly string[] }[];
  deleted: { grantId: string; webhookId: string }[];
  watched: string[];
}

function fakeDeps(
  grant: AppGrant | null,
  overrides: Partial<AppApiDeps> = {},
): { deps: AppApiDeps; seen: Recorder } {
  const seen: Recorder = { resolved: [], registered: [], deleted: [], watched: [] };

  const deps: AppApiDeps = {
    async resolveGrant(token) {
      seen.resolved.push(token);
      return grant;
    },
    watchGrant(grantId) {
      seen.watched.push(grantId);
      return () => {};
    },
    async listSessions() {
      return SESSIONS;
    },
    subscribeEvents() {
      return () => {};
    },
    async registerWebhook(grantId, registration) {
      const entry: { grantId: string; url: string; kinds?: readonly string[] } = {
        grantId,
        url: registration.url,
      };
      if (registration.kinds !== undefined) entry.kinds = registration.kinds;
      seen.registered.push(entry);
      return { webhook: { ...WEBHOOK, url: registration.url }, secret: "whsec_abc123" };
    },
    async listWebhooks() {
      return [WEBHOOK];
    },
    async deleteWebhook(grantId, webhookId) {
      seen.deleted.push({ grantId, webhookId });
      // The fixture owns exactly one webhook. Anything else is another grant's, or nothing.
      return webhookId === WEBHOOK.id;
    },
    ...overrides,
  };

  return { deps, seen };
}

/**
 * Mounts the sub-app the way `control.ts` does — under `APP_API_PREFIX` on a parent instance — so
 * the tests exercise the paths an app actually calls rather than the relative ones.
 */
function app(deps: AppApiDeps) {
  return new Hono().route(APP_API_PREFIX, createAppApi({ deps }));
}

async function call(
  deps: AppApiDeps,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = {
    host: `127.0.0.1:${PORT}`,
    authorization: `Bearer ${GRANT_TOKEN}`,
    ...init.headers,
  };
  return await app(deps).fetch(
    new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers }),
  );
}

describe("app API authentication", () => {
  test("no token is 401", async () => {
    const { deps, seen } = fakeDeps(grantWith(["sessions:read"]));
    const res = await app(deps).fetch(
      new Request(`http://127.0.0.1:${PORT}/app/sessions`, {
        headers: { host: `127.0.0.1:${PORT}` },
      }),
    );
    expect(res.status).toBe(401);
    // Nothing was even looked up: the shape test runs before the store does any work.
    expect(seen.resolved).toEqual([]);
  });

  test("a session-shaped token is 401 and never reaches the store", async () => {
    const { deps, seen } = fakeDeps(grantWith(["sessions:read"]));
    const res = await call(deps, "/app/sessions", {
      headers: { authorization: `Bearer ${generateSessionToken()}` },
    });
    expect(res.status).toBe(401);
    expect(seen.resolved).toEqual([]);
  });

  test("a VRChat-shaped cookie is 401", async () => {
    const { deps } = fakeDeps(grantWith(["sessions:read"]));
    const res = await call(deps, "/app/sessions", {
      headers: { authorization: "", cookie: `auth=${REAL_COOKIE}` },
    });
    expect(res.status).toBe(401);
  });

  test("a revoked grant is 401", async () => {
    // `resolveGrant` answering null is what "revoked" looks like from here — see its contract.
    const { deps, seen } = fakeDeps(null);
    const res = await call(deps, "/app/sessions");
    expect(res.status).toBe(401);
    expect(seen.resolved).toEqual([GRANT_TOKEN]);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  test("the token is accepted from the auth cookie and from ?authToken=", async () => {
    const { deps } = fakeDeps(grantWith(["sessions:read"]));
    const viaCookie = await call(deps, "/app/sessions", {
      headers: { authorization: "", cookie: `auth=${GRANT_TOKEN}` },
    });
    expect(viaCookie.status).toBe(200);

    const viaQuery = await call(deps, `/app/sessions?authToken=${GRANT_TOKEN}`, {
      headers: { authorization: "" },
    });
    expect(viaQuery.status).toBe(200);
  });
});

describe("app API scope guard", () => {
  test("a live grant missing the scope is 403 naming it", async () => {
    const { deps } = fakeDeps(grantWith(["friends:read"]));
    const res = await call(deps, "/app/sessions");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "insufficient_scope",
      scope: "sessions:read",
    });
  });

  test("webhook routes are behind webhooks:write", async () => {
    const { deps } = fakeDeps(grantWith(["sessions:read"]));
    const res = await call(deps, "/app/webhooks");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ scope: "webhooks:write" });
  });
});

describe("GET /app/sessions", () => {
  test("only this grant's account, and no unlinked clients without the scope", async () => {
    const { deps } = fakeDeps(grantWith(["sessions:read"]));
    const res = await call(deps, "/app/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GameSession[];
    expect(body.map((session) => session.id)).toEqual([1]);
  });

  test("sessions:unlinked adds the unmanaged client and nothing else", async () => {
    const { deps } = fakeDeps(grantWith(["sessions:read", "sessions:unlinked"]));
    const res = await call(deps, "/app/sessions");
    const body = (await res.json()) as GameSession[];
    // Still not session 2: another *managed* account is never visible, dangerous scope or not.
    expect(body.map((session) => session.id)).toEqual([1, 3]);
  });

  test("visibleSessions is the whole rule, without a request", () => {
    expect(visibleSessions(SESSIONS, grantWith(["sessions:read"])).map((s) => s.id)).toEqual([1]);
    expect(
      visibleSessions(SESSIONS, grantWith(["sessions:read", "sessions:unlinked"])).map((s) => s.id),
    ).toEqual([1, 3]);
  });
});

describe("the stream's per-event filter", () => {
  function frame(kind: string, accountId: string | null): StreamEventFrame {
    return {
      type: kind,
      ts: 1_700_000_000_000,
      payload: {
        accountId,
        sessionId: null,
        displayName: null,
        subjectId: null,
        location: null,
        data: null,
      },
    };
  }

  test("another account's events are dropped", () => {
    const grant = grantWith(["friends:read", "sessions:unlinked"]);
    expect(canSeeEvent(frame("friend.online", ACCOUNT_ID), grant)).toBe(true);
    expect(canSeeEvent(frame("friend.online", OTHER_ACCOUNT_ID), grant)).toBe(false);
  });

  test("an unmappable kind is dropped even with every mapped scope held", () => {
    const grant = grantWith([
      "friends:read",
      "users:read",
      "sessions:read",
      "account:read",
      "groups:read",
    ]);
    // `consent.*` is deliberately unmapped, and so is a kind from a newer daemon.
    expect(canSeeEvent(frame("consent.pending", ACCOUNT_ID), grant)).toBe(false);
    expect(canSeeEvent(frame("something.invented_later", ACCOUNT_ID), grant)).toBe(false);
    expect(scopeForEventKind("consent.pending")).toBeNull();
    expect(scopeForEventKind("something.invented_later")).toBeNull();
  });

  test("an unlinked event needs the dangerous scope", () => {
    const withoutIt = grantWith(["sessions:read"]);
    const withIt = grantWith(["sessions:read", "sessions:unlinked"]);
    expect(canSeeEvent(frame("gamelog.player_join", null), withoutIt)).toBe(false);
    expect(canSeeEvent(frame("gamelog.player_join", null), withIt)).toBe(true);
  });

  test("the kind's scope is still required for an unlinked event", () => {
    // Holding the dangerous scope is not a bypass of the mapping — both gates apply.
    const grant = grantWith(["sessions:unlinked"]);
    expect(canSeeEvent(frame("gamelog.player_join", null), grant)).toBe(false);
  });

  test("the mapping covers the families an app is meant to read", () => {
    expect(scopeForEventKind("friend.location")).toBe("friends:read");
    expect(scopeForEventKind("user.updated")).toBe("users:read");
    expect(scopeForEventKind("notification.received")).toBe("notifications:read");
    expect(scopeForEventKind("session.start")).toBe("sessions:read");
    expect(scopeForEventKind("gamelog.world_enter")).toBe("sessions:read");
    expect(scopeForEventKind("group.joined")).toBe("groups:read");
    expect(scopeForEventKind("instance.queue_ready")).toBe("instances:read");
    expect(scopeForEventKind("economy.update")).toBe("economy:read");
    expect(scopeForEventKind("content.refresh")).toBeNull();
  });
});

describe("webhooks", () => {
  const scopes: Scope[] = ["webhooks:write"];

  test("the secret is returned once, and never by the listing", async () => {
    const { deps } = fakeDeps(grantWith(scopes));
    const created = await call(deps, "/app/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:9000/hook", kinds: ["friend.*"] }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ secret: "whsec_abc123" });

    const listed = await call(deps, "/app/webhooks");
    expect(listed.status).toBe(200);
    const body = await listed.text();
    expect(body).not.toContain("whsec_");
    expect(body).not.toContain("secret");
  });

  test("a webhook is pinned to the grant's account", async () => {
    const { deps, seen } = fakeDeps(grantWith(scopes));
    await call(deps, "/app/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:9000/hook" }),
    });
    expect(seen.registered).toHaveLength(1);
    expect(seen.registered[0]?.grantId).toBe("grant_1");
  });

  test("naming another account is refused rather than rewritten", async () => {
    const { deps, seen } = fakeDeps(grantWith(scopes));
    const res = await call(deps, "/app/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:9000/hook", accountId: OTHER_ACCOUNT_ID }),
    });
    expect(res.status).toBe(403);
    expect(seen.registered).toEqual([]);
  });

  test("a bad body is rejected, not clamped", async () => {
    const { deps, seen } = fakeDeps(grantWith(scopes));
    const cases: unknown[] = [
      {},
      { url: "not a url" },
      { url: "file:///etc/passwd" },
      { url: "http://127.0.0.1:9000/hook", kinds: "friend.*" },
      { url: "http://127.0.0.1:9000/hook", kinds: ["friend.online; drop"] },
      {
        url: "http://127.0.0.1:9000/hook",
        kinds: Array.from({ length: MAX_WEBHOOK_KINDS + 1 }, () => "*"),
      },
    ];
    for (const body of cases) {
      const res = await call(deps, "/app/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(seen.registered).toEqual([]);
  });

  test("deleting another grant's webhook is a 404", async () => {
    const { deps } = fakeDeps(grantWith(scopes));
    const mine = await call(deps, `/app/webhooks/${WEBHOOK.id}`, { method: "DELETE" });
    expect(mine.status).toBe(200);

    const theirs = await call(deps, "/app/webhooks/wh_someone_else", { method: "DELETE" });
    expect(theirs.status).toBe(404);
    // The body says nothing about whether it exists — the whole point of answering 404.
    expect(await theirs.json()).toMatchObject({ error: "unknown_webhook" });
  });
});

describe("parseGrantScopes", () => {
  test("keeps known scopes and drops everything else", () => {
    expect(parseGrantScopes(JSON.stringify(["friends:read", "not:a:scope", 7]))).toEqual([
      "friends:read",
    ]);
  });

  test("a malformed column authorizes nothing", () => {
    expect(parseGrantScopes("{")).toEqual([]);
    expect(parseGrantScopes('"friends:read"')).toEqual([]);
  });
});
