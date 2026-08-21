import { afterEach, describe, expect, test } from "bun:test";
import { generateSessionToken } from "../security/session-token.ts";
import { type BoundServers, bindServer, bindServers, launchUrl } from "./bind.ts";
import type { ControlDeps } from "./control.ts";

const TOKEN = generateSessionToken();

/** The narrowest thing that satisfies `ControlDeps`; these tests never reach a handler body. */
const deps: ControlDeps = {
  status: async () => ({
    degradedKeychain: false,
    backend: "file",
    accounts: 0,
    rateLimit: { limit: 20, remaining: 20, queued: 0, retryAfter: null },
  }),
  listAccounts: async () => [],
  login: async () => ({ status: "requires-2fa", accountId: "usr_1", methods: ["totp"] }),
  verifyTwoFactor: async () => {
    throw new Error("unused");
  },
  removeAccount: async () => {},
  listSessions: async () => [],
  listEvents: async () => [],
  listFriends: async () => [],
  getSettings: async () => ({}),
  updateSettings: async () => ({}),
  subscribeEvents: () => () => {},
};

let bound: BoundServers | undefined;

afterEach(async () => {
  await bound?.stop();
  bound = undefined;
});

describe("bindServer", () => {
  test("falls back to an ephemeral port when the preferred one is taken", async () => {
    const squatter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no") });
    const taken = squatter.port;
    expect(taken).toBeDefined();

    const server = bindServer({
      port: taken as number,
      createApp: (port) => ({ fetch: async () => new Response(String(port)) }),
    });
    try {
      expect(server.fellBack).toBe(true);
      expect(server.port).not.toBe(taken);
      // The app is built from the port actually bound, not the one asked for — otherwise every
      // guard on a fallen-back server would reject its own traffic.
      const res = await fetch(server.url);
      expect(await res.text()).toBe(String(server.port));
    } finally {
      server.server.stop(true);
      squatter.stop(true);
    }
  });

  test("keeps the preferred port when it is free", () => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const free = probe.port as number;
    probe.stop(true);

    const server = bindServer({
      port: free,
      createApp: () => ({ fetch: async () => new Response("ok") }),
    });
    try {
      expect(server.port).toBe(free);
      expect(server.fellBack).toBe(false);
    } finally {
      server.server.stop(true);
    }
  });
});

describe("bindServers", () => {
  test("binds three separate instances and reports their URLs", async () => {
    bound = await bindServers({ deps, token: () => TOKEN, ports: { ui: 0, proxy: 0, control: 0 } });
    const ports = [bound.ui.port, bound.proxy.port, bound.control.port];
    expect(new Set(ports).size).toBe(3);
    expect(bound.urls).toEqual({
      uiUrl: bound.ui.url,
      proxyUrl: bound.proxy.url,
      controlUrl: bound.control.url,
    });
  });

  test("rejects a foreign Host on every port — PLAN.md §1.10", async () => {
    bound = await bindServers({ deps, token: () => TOKEN, ports: { ui: 0, proxy: 0, control: 0 } });
    for (const server of [bound.ui, bound.proxy, bound.control]) {
      const res = await fetch(`${server.url}/api/status`, {
        headers: { host: "evil.example", authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(403);
    }
  });

  test("requires the session token on every port", async () => {
    bound = await bindServers({ deps, token: () => TOKEN, ports: { ui: 0, proxy: 0, control: 0 } });
    for (const server of [bound.ui, bound.proxy, bound.control]) {
      expect((await fetch(`${server.url}/api/status`)).status).toBe(401);
    }
  });

  test("the proxy port answers 501 until Phase 2 fills it in", async () => {
    bound = await bindServers({ deps, token: () => TOKEN, ports: { ui: 0, proxy: 0, control: 0 } });
    const res = await fetch(`${bound.proxy.url}/api/1/auth/user`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(501);
  });

  test("the control API is only on the control port", async () => {
    bound = await bindServers({ deps, token: () => TOKEN, ports: { ui: 0, proxy: 0, control: 0 } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${bound.control.url}/api/status`, { headers: auth })).status).toBe(200);
    // On the mirror the same path is a 501 placeholder, never the control route.
    expect((await fetch(`${bound.proxy.url}/api/status`, { headers: auth })).status).toBe(501);
  });
});

describe("launchUrl", () => {
  test("carries the session token, which is the only credential the first navigation has", () => {
    expect(launchUrl("http://127.0.0.1:7773", TOKEN)).toBe(`http://127.0.0.1:7773/?token=${TOKEN}`);
  });
});
