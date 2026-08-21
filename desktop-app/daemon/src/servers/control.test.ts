import { describe, expect, test } from "bun:test";
import { APP_VERSION } from "@vrcz/shared";
import { TOKEN_HEADER } from "../security/guards.ts";
import { generateSessionToken } from "../security/session-token.ts";
import type { ControlDeps } from "./control.ts";
import {
  type ControlAccount,
  ControlError,
  createControlApp,
  type EventQuery,
  type Settings,
  type StreamEvent,
} from "./control.ts";

const PORT = 7775;
const TOKEN = generateSessionToken();

const ACCOUNT: ControlAccount = {
  id: "usr_00000000-0000-0000-0000-000000000000",
  displayName: "Tester",
  addedAt: 1_700_000_000_000,
  enabled: true,
  lastSeenAt: null,
  connection: "connected",
};

interface Recorder {
  eventQueries: EventQuery[];
  friendQueries: (string | null)[];
  removed: string[];
  listeners: ((event: StreamEvent) => void)[];
  unsubscribed: number;
}

function fakeDeps(overrides: Partial<ControlDeps> = {}): { deps: ControlDeps; seen: Recorder } {
  const seen: Recorder = {
    eventQueries: [],
    friendQueries: [],
    removed: [],
    listeners: [],
    unsubscribed: 0,
  };
  let settings: Settings = { theme: "dark" };

  const deps: ControlDeps = {
    status: async () => ({
      degradedKeychain: false,
      backend: "windows-credential-manager",
      accounts: 1,
      rateLimit: { limit: 20, remaining: 20, queued: 0, retryAfter: null },
    }),
    listAccounts: async () => [ACCOUNT],
    login: async ({ username }) =>
      username === "needs2fa"
        ? { status: "requires-2fa", accountId: ACCOUNT.id, methods: ["totp", "emailOtp"] }
        : { status: "ok", account: ACCOUNT },
    verifyTwoFactor: async () => ACCOUNT,
    removeAccount: async (id) => {
      if (id !== ACCOUNT.id) throw new ControlError(404, "no_such_account");
      seen.removed.push(id);
    },
    listSessions: async () => [
      {
        id: 1,
        accountId: ACCOUNT.id,
        displayName: "Tester",
        startedAt: 1_700_000_000_000,
        vrMode: "Desktop",
        currentLocation: null,
        currentWorldId: null,
      },
    ],
    listEvents: async (query) => {
      seen.eventQueries.push(query);
      return [];
    },
    listFriends: async (accountId) => {
      seen.friendQueries.push(accountId);
      return [];
    },
    getSettings: async () => settings,
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    subscribeEvents: (listener) => {
      seen.listeners.push(listener);
      return () => {
        seen.unsubscribed += 1;
      };
    },
    ...overrides,
  };

  return { deps, seen };
}

function app(deps: ControlDeps) {
  return createControlApp({ port: PORT, deps, token: () => TOKEN });
}

async function call(
  deps: ControlDeps,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...init.headers };
  return await app(deps).fetch(
    new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers }),
  );
}

describe("control API guards", () => {
  test("a foreign Host is rejected", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, "/api/status", { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  test("a missing token is 401", async () => {
    const { deps } = fakeDeps();
    const res = await app(deps).fetch(
      new Request(`http://127.0.0.1:${PORT}/api/status`, {
        headers: { host: `localhost:${PORT}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("all three token transports reach the route", async () => {
    const { deps } = fakeDeps();
    const host = `127.0.0.1:${PORT}`;
    const url = `http://127.0.0.1:${PORT}/api/status`;

    const bearer = await app(deps).fetch(
      new Request(url, { headers: { host, authorization: `Bearer ${TOKEN}` } }),
    );
    const header = await app(deps).fetch(
      new Request(url, { headers: { host, [TOKEN_HEADER]: TOKEN } }),
    );
    const query = await app(deps).fetch(
      new Request(`${url}?token=${TOKEN}`, { headers: { host } }),
    );

    expect([bearer.status, header.status, query.status]).toEqual([200, 200, 200]);
  });
});

describe("control API routes", () => {
  test("GET /api/status reports the app version alongside the daemon snapshot", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, "/api/status");
    expect(await res.json()).toEqual({
      version: APP_VERSION,
      degradedKeychain: false,
      backend: "windows-credential-manager",
      accounts: 1,
      rateLimit: { limit: 20, remaining: 20, queued: 0, retryAfter: null },
    });
  });

  test("GET /api/accounts lists accounts", async () => {
    const { deps } = fakeDeps();
    expect(await (await call(deps, "/api/accounts")).json()).toEqual([ACCOUNT]);
  });

  test("POST /api/accounts/login returns ok or a 2FA challenge", async () => {
    const { deps } = fakeDeps();
    const ok = await call(deps, "/api/accounts/login", {
      method: "POST",
      body: JSON.stringify({ username: "tester", password: "hunter2" }),
    });
    expect(await ok.json()).toEqual({ status: "ok", account: ACCOUNT });

    const challenge = await call(deps, "/api/accounts/login", {
      method: "POST",
      body: JSON.stringify({ username: "needs2fa", password: "hunter2" }),
    });
    expect(await challenge.json()).toEqual({
      status: "requires-2fa",
      accountId: ACCOUNT.id,
      methods: ["totp", "emailOtp"],
    });
  });

  test("POST /api/accounts/login 400s on a malformed body", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, "/api/accounts/login", {
      method: "POST",
      body: JSON.stringify({ username: "tester" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/accounts/:id/verify-2fa rejects an unknown method", async () => {
    const { deps } = fakeDeps();
    const bad = await call(deps, `/api/accounts/${ACCOUNT.id}/verify-2fa`, {
      method: "POST",
      body: JSON.stringify({ method: "carrier-pigeon", code: "123456" }),
    });
    expect(bad.status).toBe(400);

    const good = await call(deps, `/api/accounts/${ACCOUNT.id}/verify-2fa`, {
      method: "POST",
      body: JSON.stringify({ method: "totp", code: "123456" }),
    });
    expect(await good.json()).toEqual({ status: "ok", account: ACCOUNT });
  });

  test("DELETE /api/accounts/:id removes, and 404s for an unknown id", async () => {
    const { deps, seen } = fakeDeps();
    const ok = await call(deps, `/api/accounts/${ACCOUNT.id}`, { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect(seen.removed).toEqual([ACCOUNT.id]);

    const missing = await call(deps, "/api/accounts/usr_nope", { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "no_such_account" });
  });

  test("GET /api/sessions returns live sessions", async () => {
    const { deps } = fakeDeps();
    const sessions = (await (await call(deps, "/api/sessions")).json()) as unknown[];
    expect(sessions).toHaveLength(1);
  });

  test("GET /api/events forwards and clamps its query", async () => {
    const { deps, seen } = fakeDeps();
    await call(deps, "/api/events");
    await call(deps, "/api/events?accountId=usr_1&kind=friend.online&limit=5&before=1700000000000");
    await call(deps, "/api/events?limit=99999");
    await call(deps, "/api/events?limit=nonsense&before=nonsense&accountId=");

    expect(seen.eventQueries).toEqual([
      { limit: 100 },
      { limit: 5, accountId: "usr_1", kind: "friend.online", before: 1_700_000_000_000 },
      { limit: 500 },
      { limit: 100 },
    ]);
  });

  test("GET /api/friends passes null for every account", async () => {
    const { deps, seen } = fakeDeps();
    await call(deps, "/api/friends");
    await call(deps, "/api/friends?accountId=usr_1");
    expect(seen.friendQueries).toEqual([null, "usr_1"]);
  });

  test("GET and PUT /api/settings round-trip a patch", async () => {
    const { deps } = fakeDeps();
    expect(await (await call(deps, "/api/settings")).json()).toEqual({ theme: "dark" });
    const updated = await call(deps, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ theme: "light" }),
    });
    expect(await updated.json()).toEqual({ theme: "light" });
  });

  test("an unexpected dependency failure is a 500, not a crash", async () => {
    const { deps } = fakeDeps({
      status: async () => {
        throw new Error("store is on fire");
      },
    });
    const res = await call(deps, "/api/status");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "internal_error" });
  });

  test("the control port serves no proxy route", async () => {
    const { deps } = fakeDeps();
    const res = await call(deps, "/api/1/auth/user");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/stream", () => {
  test("guards apply before the upgrade", async () => {
    const { deps, seen } = fakeDeps();
    const res = await app(deps).fetch(
      new Request(`http://127.0.0.1:${PORT}/api/stream`, {
        headers: { host: `127.0.0.1:${PORT}` },
      }),
    );
    expect(res.status).toBe(401);
    expect(seen.listeners).toEqual([]);
  });

  test("subscribes on open and unsubscribes on close", async () => {
    const { deps, seen } = fakeDeps();
    const port = 7791;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, srv) =>
        createControlApp({ port, deps, token: () => TOKEN }).fetch(request, srv),
      websocket: (await import("./control.ts")).controlWebSocketHandler,
    });
    // The app's Host allowlist is built from `port`, so ask under that name and let Bun route by
    // the real socket. `Host` is what the guard reads; the connection is still to `server.port`.
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/stream?token=${TOKEN}`, {
      headers: { host: `127.0.0.1:${port}` },
    });

    const first = await new Promise<string>((resolvePromise, rejectPromise) => {
      socket.addEventListener("message", (event) => resolvePromise(String(event.data)));
      socket.addEventListener("error", () => rejectPromise(new Error("socket error")));
    });
    expect(JSON.parse(first)).toMatchObject({ type: "ready" });
    expect(seen.listeners).toHaveLength(1);

    const pushed = new Promise<string>((resolvePromise) => {
      socket.addEventListener("message", (event) => resolvePromise(String(event.data)));
    });
    seen.listeners[0]?.({ type: "event.appended", ts: 1_700_000_000_000, payload: { id: 1 } });
    expect(JSON.parse(await pushed)).toMatchObject({ type: "event.appended" });

    socket.close();
    await Bun.sleep(50);
    expect(seen.unsubscribed).toBe(1);
    server.stop(true);
  });
});
