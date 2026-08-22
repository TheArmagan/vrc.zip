import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DispatchContext, PluginGrant } from "@vrcz/plugin-api";
import type { JsonValue } from "@vrcz/shared";
import { CookieJar } from "../accounts/cookie-jar.ts";
import { RateLimiter } from "../net/rate-limiter.ts";
import type { RequestContext } from "../net/request.ts";
import { RequestMeter } from "../net/request-meter.ts";
import { DispatchError } from "./dispatcher.ts";
import { createVrchatMethods, type PluginVrchatDeps } from "./plugin-vrchat.ts";
import type { GatedMethodTable } from "./scope-gate.ts";

/**
 * A real `Bun.serve` rather than a `fetch` stub, per PLAN.md §1.10: the layer under test reaches
 * VRChat through `vrcFetch`, and a stub would paper over the HTTP-level behaviour that path exists
 * to get right.
 */
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let requests: { path: string; cookie: string | null; userAgent: string | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: `${url.pathname}${url.search}`,
        cookie: request.headers.get("cookie"),
        userAgent: request.headers.get("user-agent"),
      });
      // Which account is asking decides what comes back — the reason a cache may never be keyed on
      // the URL alone. `auth=a` is a friend of the subject; `auth=b` is not.
      const asFriend = (request.headers.get("cookie") ?? "").includes("auth=a");

      if (url.pathname === "/auth/user/friends") {
        return Response.json([
          {
            id: "usr_friend",
            displayName: "Friend",
            status: "active",
            statusDescription: "",
            location: "wrld_1:99~region(eu)",
            userIcon: "",
            currentAvatarThumbnailImageUrl: "https://api.vrchat.cloud/img/thumb.png",
            last_platform: "standalonewindows",
          },
        ]);
      }
      if (url.pathname === "/users/usr_friend") {
        return Response.json({
          id: "usr_friend",
          displayName: "Friend",
          bio: asFriend ? "only friends see this" : "",
          isFriend: asFriend,
          location: asFriend ? "wrld_1:99~region(eu)" : "private",
        });
      }
      if (url.pathname === "/users/usr_a/groups") {
        return Response.json([{ id: "grp_1", name: "Group One", memberCount: 12 }]);
      }
      if (url.pathname === "/worlds/wrld_1") {
        return Response.json({ id: "wrld_1", name: "World One", capacity: 32, authorId: "usr_x" });
      }
      if (url.pathname.startsWith("/instances/")) {
        return Response.json({
          worldId: "wrld_1",
          instanceId: "99",
          type: "public",
          userCount: 7,
          full: false,
        });
      }
      if (url.pathname === "/groups/grp_missing") {
        return new Response(JSON.stringify({ error: { message: "gone" } }), { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(() => {
  server.stop(true);
});

const GRANT: PluginGrant = {
  pluginId: "plug",
  scopes: ["friends:read", "users:read", "worlds:read", "instances:read", "groups:read"],
  accountIds: ["usr_a"],
};

const limiter = new RateLimiter();
const meter = new RequestMeter();

function contextFor(accountId: string, pluginId: string): RequestContext {
  return {
    accountId,
    jar: new CookieJar([
      { name: "auth", value: accountId === "usr_a" ? "a" : "b", expiresAt: null },
    ]),
    userAgent: "vrc.zip/test (tests@vrc.zip)",
    limiter,
    baseUrl,
    meter,
    // The plugin id rides along so the meter can say which plugin is spending. PLAN.md §Phase 3
    // correction 3: the user gets rate-limited for a plugin's behaviour and deserves to know who.
    grantId: `plugin:${pluginId}`,
  };
}

function methods(overrides: Partial<PluginVrchatDeps> = {}): GatedMethodTable {
  return createVrchatMethods({ context: contextFor, ...overrides });
}

function ctx(accountId?: string, grant: PluginGrant = GRANT): DispatchContext {
  return {
    grant,
    deadline: Date.now() + 5_000,
    signal: new AbortController().signal,
    ...(accountId === undefined ? {} : { accountId }),
  };
}

async function invoke(
  table: GatedMethodTable,
  method: string,
  params: JsonValue | undefined,
  accountId: string | undefined = "usr_a",
): Promise<JsonValue | undefined> {
  const entry = table[method];
  if (entry === undefined) throw new Error(`no method ${method}`);
  const result = await entry.method.invoke(params, ctx(accountId));
  if (!result.ok) throw new DispatchError(result.code, result.message);
  return result.value;
}

describe("the method table", () => {
  test("carries the shared registry's scopes, not a plugin namespace", () => {
    const table = methods();
    expect(table["vrchat.friends.list"]?.method.scope).toBe("friends:read");
    expect(table["vrchat.users.get"]?.method.scope).toBe("users:read");
    expect(table["vrchat.worlds.get"]?.method.scope).toBe("worlds:read");
    expect(table["vrchat.instances.get"]?.method.scope).toBe("instances:read");
    expect(table["vrchat.groups.get"]?.method.scope).toBe("groups:read");
    // Discovering which accounts you were given must not itself cost a scope.
    expect(table["vrchat.accounts.list"]?.method.scope).toBeNull();
    expect(table["vrchat.accounts.list"]?.method.cost).toBe(0);
  });

  test("holds no write method: outbound actions land with the dry-run gesture, not here", () => {
    for (const name of Object.keys(methods())) {
      expect(name.startsWith("vrchat.")).toBe(true);
    }
    expect(Object.keys(methods())).not.toContain("vrchat.invite.send");
  });
});

describe("vrchat.accounts.list", () => {
  test("answers from the grant, with no upstream call at all", async () => {
    const before = requests.length;
    const table = methods({
      account: (id) => ({ id, displayName: "A", online: true }),
    });
    expect(await invoke(table, "vrchat.accounts.list", undefined, undefined)).toEqual([
      { id: "usr_a", displayName: "A", online: true },
    ]);
    expect(requests.length).toBe(before);
  });
});

describe("reads", () => {
  test("projects a friends page rather than passing VRChat's shape through", async () => {
    const friends = await invoke(methods(), "vrchat.friends.list", { n: 10 });
    expect(friends).toEqual([
      {
        id: "usr_friend",
        displayName: "Friend",
        status: "active",
        // VRChat spells "unset" as "", not by omission — so this is null, not "".
        statusDescription: null,
        location: "wrld_1:99~region(eu)",
        bio: null,
        platform: "standalonewindows",
        isFriend: null,
        imageUrl: "https://api.vrchat.cloud/img/thumb.png",
      },
    ]);
  });

  test("pages through the query VRChat expects", async () => {
    requests = [];
    await invoke(methods(), "vrchat.friends.list", { n: 5, offset: 10, offline: true });
    expect(requests[0]?.path).toBe("/auth/user/friends?n=5&offset=10&offline=true");
  });

  test("reads a world, an instance, and a group", async () => {
    const table = methods();
    expect(await invoke(table, "vrchat.worlds.get", { worldId: "wrld_1" })).toMatchObject({
      id: "wrld_1",
      name: "World One",
      capacity: 32,
    });
    expect(
      await invoke(table, "vrchat.instances.get", { location: "wrld_1:99~region(eu)" }),
    ).toMatchObject({ worldId: "wrld_1", userCount: 7, full: false });
    expect(await invoke(table, "vrchat.groups.list", undefined)).toEqual([
      {
        id: "grp_1",
        name: "Group One",
        shortCode: null,
        description: null,
        ownerId: null,
        memberCount: 12,
        iconUrl: null,
        bannerUrl: null,
      },
    ]);
  });

  test("every call goes out tagged with the plugin id, so the UI can name who is spending", async () => {
    await invoke(methods(), "vrchat.worlds.get", { worldId: "wrld_1" });
    expect(meter.grant("plugin:plug").total).toBeGreaterThan(0);
  });

  test("an upstream error becomes E_UPSTREAM carrying the status, never a host detail", async () => {
    const failure = await invoke(methods(), "vrchat.groups.get", { groupId: "grp_missing" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DispatchError);
    if (failure instanceof DispatchError) {
      expect(failure.code).toBe("E_UPSTREAM");
      expect(failure.data).toEqual({ status: 404 });
    }
  });

  test("an account that is not signed in is E_UNAVAILABLE, not a crash", async () => {
    const table = methods({ context: () => null });
    await expect(invoke(table, "vrchat.worlds.get", { worldId: "wrld_1" })).rejects.toMatchObject({
      code: "E_UNAVAILABLE",
    });
  });
});

describe("the cache", () => {
  test("is keyed by (account, path) — the same URL answers two accounts differently", async () => {
    const table = methods({ cacheTtlMs: 60_000 });
    requests = [];

    const asFriend = await invoke(table, "vrchat.users.get", { userId: "usr_friend" }, "usr_a");
    const asStranger = await invoke(table, "vrchat.users.get", { userId: "usr_friend" }, "usr_b");

    // Two calls, because `GET /users/{id}` returns different fields to a friend and a stranger.
    // A cache keyed on the URL alone would have served the friend's view to the stranger.
    expect(requests).toHaveLength(2);
    expect(asFriend).toMatchObject({ bio: "only friends see this", isFriend: true });
    expect(asStranger).toMatchObject({ bio: null, isFriend: false });

    // The second read for each account is served from the cache.
    await invoke(table, "vrchat.users.get", { userId: "usr_friend" }, "usr_a");
    expect(requests).toHaveLength(2);
  });

  test("never caches a volatile read", async () => {
    const table = methods({ cacheTtlMs: 60_000 });
    requests = [];
    await invoke(table, "vrchat.instances.get", { location: "wrld_1:99~region(eu)" });
    await invoke(table, "vrchat.instances.get", { location: "wrld_1:99~region(eu)" });
    expect(requests).toHaveLength(2);
  });
});

describe("parameters", () => {
  test("are parsed by the method, so a handler never sees a raw one", async () => {
    const table = methods();
    const bad = [
      ["vrchat.users.get", {}],
      ["vrchat.users.get", { userId: "" }],
      ["vrchat.friends.list", { n: 500 }],
      ["vrchat.friends.list", { offline: "yes" }],
      ["vrchat.instances.get", { location: "private" }],
      ["vrchat.worlds.search", { search: "" }],
    ] as const;

    for (const [method, params] of bad) {
      const entry = table[method];
      if (entry === undefined) throw new Error(`no method ${method}`);
      const result = await entry.method.invoke(params, ctx("usr_a"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("E_BAD_REQUEST");
    }
  });
});
