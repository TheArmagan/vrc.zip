import { afterEach, describe, expect, test } from "bun:test";
import { emptySeries, WINDOW_SECONDS } from "../net/request-meter.ts";
import { ConsentRegistry } from "../proxy/consent.ts";
import type { ProxyDeps } from "../proxy/handshake.ts";
import { generateSessionToken } from "../security/session-token.ts";
import { MEMORY, Store } from "../store/store.ts";
import { type BoundServers, bindServer, bindServers, launchUrl } from "./bind.ts";
import type { ControlDeps } from "./control.ts";

const TOKEN = generateSessionToken();

/** The narrowest thing that satisfies `ControlDeps`; these tests never reach a handler body. */
const deps: ControlDeps = {
  status: async () => ({
    degradedKeychain: false,
    backend: "file",
    accounts: 0,
    rateLimit: {
      api: { rate: 80, burst: 100, available: 100, queued: 0 },
      files: { rate: 240, burst: 300, available: 300, queued: 0 },
      accounts: [],
      perAccountRate: 16,
      queued: 0,
      retryAfter: null,
      consecutive429: 0,
      used: emptySeries(),
      windowSeconds: WINDOW_SECONDS,
    },
  }),
  listAccounts: async () => [],
  listPendingConsent: async () => [],
  setConsentAccount: async () => {
    throw new Error("unused");
  },
  denyConsent: async () => {},
  listConnectedApps: async () => [],
  revokeConnectedApp: async () => {},
  revokeAllConnectedApps: async () => 0,
  listAppAudit: async () => [],
  listPlugins: async () => [],
  installPlugin: async () => {
    throw new Error("unused");
  },
  enablePlugin: async () => {
    throw new Error("unused");
  },
  disablePlugin: async () => {
    throw new Error("unused");
  },
  uninstallPlugin: async () => {},
  listGraphs: async () => [],
  getGraph: async () => {
    throw new Error("unused");
  },
  createGraph: async () => {
    throw new Error("unused");
  },
  updateGraph: async () => {
    throw new Error("unused");
  },
  deleteGraph: async () => {},
  setGraphEnabled: async () => {
    throw new Error("unused");
  },
  setGraphArmed: async () => {
    throw new Error("unused");
  },
  listGraphRuns: async () => [],
  publishPluginPanel: () => {},
  publishPluginToast: () => {},
  runPluginCommand: async () => {},
  listPluginPanels: async () => [],
  dispatchPluginIntent: async () => {},
  setPluginDryRun: async () => {
    throw new Error("not used in this test");
  },
  listPendingPluginConsents: async () => [],
  approvePluginConsent: async () => false,
  denyPluginConsent: async () => false,
  streamClientCount: () => 0,
  login: async () => ({ status: "requires-2fa", accountId: "usr_1", methods: ["totp"] }),
  verifyTwoFactor: async () => {
    throw new Error("unused");
  },
  removeAccount: async () => {},
  inviteSelfTo: async () => {},
  listInstanceUsers: async () => {
    throw new Error("unused");
  },
  listSessions: async () => [],
  listEvents: async () => [],
  listEventKinds: async () => [],
  listNotificationTypes: async () => [],
  listFriends: async () => [],
  listNotifications: async () => [],
  fetchImage: async () => null,
  markNotificationSeen: async () => {},
  getUser: async () => {
    throw new Error("unused");
  },
  setUserNote: async () => {
    throw new Error("unused");
  },
  getWorld: async () => {
    throw new Error("unused");
  },
  listWorlds: async () => ({ worlds: {} }),
  resolveAvatarByFile: async (fileId) => ({ fileId, avatarId: null }),
  getAvatar: async () => {
    throw new Error("unused");
  },
  selectAvatar: async () => {},
  getInstance: async () => {
    throw new Error("unused");
  },
  listUserGroups: async () => ({ groups: [] }),
  listUsers: async () => ({ users: [] }),
  getGroup: async () => {
    throw new Error("unused");
  },
  listMutualFriends: async () => ({ users: [], hasMore: false }),
  listGroupMembers: async () => ({ members: [], hasMore: false }),
  listGroupPosts: async () => ({ posts: [], hasMore: false }),
  listGroupInstances: async () => ({ instances: [] }),
  listWorldInstances: async () => ({ instances: [], accountsConsulted: 0, failedAccountIds: [] }),
  listGroupGalleryImages: async () => ({ images: [], hasMore: false }),
  inviteUserTo: async () => {
    throw new Error("unused");
  },
  requestInviteFrom: async () => {
    throw new Error("unused");
  },
  boop: async () => {
    throw new Error("unused");
  },
  listWebhooks: async () => [],
  deleteWebhook: async () => {},
  setAppBudget: async () => {
    throw new Error("unused");
  },
  getRetention: async () => {
    throw new Error("unused");
  },
  updateRetention: async () => {
    throw new Error("unused");
  },
  runRetention: async () => {
    throw new Error("unused");
  },
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

  test("requires the session token on the two ports that use one", async () => {
    bound = await bindServers({ deps, token: () => TOKEN, ports: { ui: 0, proxy: 0, control: 0 } });
    for (const server of [bound.ui, bound.control]) {
      expect((await fetch(`${server.url}/api/status`)).status).toBe(401);
    }
  });

  /** The mirror's collaborators, over a throwaway in-memory database. */
  function proxyDeps(): ProxyDeps {
    const store = Store.open(MEMORY);
    return {
      consent: new ConsentRegistry({ store }),
      grants: store,
      resolveAccount: () => null,
      currentUser: () => null,
    };
  }

  test("the mirror does not take a session token, and is not open either", async () => {
    // Phase 2 changed the model on `:7774` on purpose: an app authenticates by *logging in*, with
    // Basic auth and a consent sheet, exactly as it would against VRChat. A pre-shared token would
    // defeat the whole handshake, whose point is that a stock client library needs no modification.
    // What replaces it is that there is nothing to reach without a grant.
    bound = await bindServers({
      deps,
      proxyDeps: proxyDeps(),
      token: () => TOKEN,
      ports: { ui: 0, proxy: 0, control: 0 },
    });

    // No credentials at all: VRChat's own missing-credentials 401, not a vrc.zip auth error.
    const anonymous = await fetch(`${bound.proxy.url}/api/1/auth/user`, {
      headers: { "user-agent": "SomeApp/1.0 me@somewhere.dev" },
    });
    expect(anonymous.status).toBe(401);

    // And the session token buys nothing here — it is not a credential this port understands.
    const withToken = await fetch(`${bound.proxy.url}/api/1/auth/user`, {
      headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "SomeApp/1.0 me@somewhere.dev" },
    });
    expect(withToken.status).toBe(401);
  });

  test("the mirror answers 503 when the daemon has not wired the handshake up", async () => {
    // `bindServers` without `proxyDeps`: the port still binds, because the three-instance shape is
    // structural, and every route says so rather than half-working.
    bound = await bindServers({ deps, token: () => TOKEN, ports: { ui: 0, proxy: 0, control: 0 } });
    const res = await fetch(`${bound.proxy.url}/api/1/auth`, {
      headers: { "user-agent": "SomeApp/1.0 me@somewhere.dev" },
    });
    expect(res.status).toBe(503);
  });

  test("the control API is only on the control port", async () => {
    bound = await bindServers({ deps, token: () => TOKEN, ports: { ui: 0, proxy: 0, control: 0 } });
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await fetch(`${bound.control.url}/api/status`, { headers: auth })).status).toBe(200);
    // On the mirror the same path is not a route at all, and gets VRChat's real 404 — never the
    // control route, and never a catch-all guessing what was meant.
    const mirrored = await fetch(`${bound.proxy.url}/api/status`, { headers: auth });
    expect(mirrored.status).toBe(404);
    expect(await mirrored.json()).toEqual({ error: { message: '"Not Found"', status_code: 404 } });
  });
});

describe("launchUrl", () => {
  test("carries the session token, which is the only credential the first navigation has", () => {
    expect(launchUrl("http://127.0.0.1:7773", TOKEN)).toBe(`http://127.0.0.1:7773/?token=${TOKEN}`);
  });
});
