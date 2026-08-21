import { describe, expect, test } from "bun:test";
import { EventBus } from "../bus/event-bus.ts";
import { RateLimiter } from "../net/rate-limiter.ts";
import type { RequestContext } from "../net/request.ts";
import { MEMORY, Store } from "../store/index.ts";
import { CookieJar } from "./cookie-jar.ts";
import { type NotificationAccounts, NotificationService } from "./notifications.ts";

const ACCOUNT = "usr_alice";

interface Call {
  readonly path: string;
}

/**
 * A fake account whose `context()` routes through an injected fetch. `vrcFetch` honours
 * `ctx.fetch`, so this exercises the real request path — rate limiter included — without a socket.
 */
function accountsWith(
  handler: (path: string) => Response,
  calls: Call[],
  state = "online",
): NotificationAccounts {
  const context = (): RequestContext => ({
    accountId: ACCOUNT,
    jar: new CookieJar(),
    userAgent: "vrc.zip/test (tests@somewhere.dev)",
    limiter: new RateLimiter({ burst: 500, globalBurst: 500, fileBurst: 500 }),
    baseUrl: "https://api.vrchat.cloud/api/1",
    fetch: (input: string) => {
      const path = input.replace("https://api.vrchat.cloud/api/1", "");
      calls.push({ path });
      return Promise.resolve(handler(path));
    },
  });

  return {
    get: () => ({ state, context }),
    list: () => [{ id: ACCOUNT, state }],
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function seeded(): Store {
  const store = Store.open(MEMORY);
  store.upsertAccount({
    id: ACCOUNT,
    display_name: "Alice",
    added_at: 1_700_000_000_000,
    enabled: 1,
    last_seen_at: null,
  });
  return store;
}

describe("NotificationService", () => {
  test("backfills the pending backlog the socket could never have delivered", async () => {
    // The bug this service exists for: the pipeline carries deltas, so a user signing in with 300
    // notifications already waiting saw an empty screen.
    const store = seeded();
    const calls: Call[] = [];
    const accounts = accountsWith((path) => {
      if (!path.startsWith("/auth/user/notifications")) return json([]);
      const offset = Number(new URL(`https://x${path}`).searchParams.get("offset"));
      // 250 pending, in pages of 100.
      const page = Array.from({ length: Math.max(0, Math.min(100, 250 - offset)) }, (_, i) => ({
        id: `not_${String(offset + i)}`,
        type: "friendRequest",
        senderUserId: `usr_sender_${String(offset + i)}`,
        message: "",
        created_at: "2026-08-01T10:00:00.000Z",
      }));
      return json(page);
    }, calls);

    const service = new NotificationService({ accounts, store, bus: new EventBus() });
    await service.refresh(ACCOUNT);

    expect(store.listNotifications(ACCOUNT, 1000)).toHaveLength(250);

    // Three pages, then it stops: a short page is the last page, so there is no wasted fourth
    // request per refresh, per account, forever.
    const v1 = calls.filter((call) => call.path.startsWith("/auth/user/notifications"));
    expect(v1).toHaveLength(3);
    expect(v1[0]?.path).toContain("offset=0");
    expect(v1[2]?.path).toContain("offset=200");
    store.close();
  });

  test("fetches both generations, because each carries categories the other does not", async () => {
    const store = seeded();
    const calls: Call[] = [];
    const accounts = accountsWith((path) => {
      if (path.startsWith("/auth/user/notifications")) {
        return json([{ id: "not_v1", type: "invite", senderUserId: "usr_a" }]);
      }
      if (path.startsWith("/notifications")) {
        return json([
          {
            id: "not_v2",
            category: "group.announcement",
            senderUserId: "usr_b",
            title: "Group post",
            createdAt: "2026-08-01T10:00:00.000Z",
          },
        ]);
      }
      return json([]);
    }, calls);

    const service = new NotificationService({ accounts, store, bus: new EventBus() });
    await service.refresh(ACCOUNT);

    const rows = store.listNotifications(ACCOUNT, 100);
    expect(rows.map((row) => row.id).sort()).toEqual(["not_v1", "not_v2"]);
    // v2 names the kind `category` and the text `title`; mapping only v1's field names would store
    // both as "unknown" with no message.
    expect(rows.find((row) => row.id === "not_v2")?.type).toBe("group.announcement");
    expect(rows.find((row) => row.id === "not_v2")?.message).toBe("Group post");
    store.close();
  });

  test("a generation that fails does not abort the other", async () => {
    // v2 404ing for an account must not cost that account its friend requests.
    const store = seeded();
    const accounts = accountsWith((path) => {
      if (path.startsWith("/auth/user/notifications")) {
        return json([{ id: "not_v1", type: "invite", senderUserId: "usr_a" }]);
      }
      return new Response("nope", { status: 404 });
    }, []);

    const service = new NotificationService({ accounts, store, bus: new EventBus() });
    await service.refresh(ACCOUNT);

    expect(store.listNotifications(ACCOUNT, 100)).toHaveLength(1);
    store.close();
  });

  test("REST `details` is decoded, not stored as an escaped blob", async () => {
    // The generated types are explicit: `details` is a JSON-encoded *string* over REST and a real
    // object over the socket. Passing it through would put JSON-inside-JSON in the column for
    // exactly half of all notifications.
    const store = seeded();
    const accounts = accountsWith(
      (path) =>
        path.startsWith("/auth/user/notifications")
          ? json([
              {
                id: "not_1",
                type: "invite",
                senderUserId: "usr_a",
                details: JSON.stringify({ worldId: "wrld_x:1" }),
              },
            ])
          : json([]),
      [],
    );

    const service = new NotificationService({ accounts, store, bus: new EventBus() });
    await service.refresh(ACCOUNT);

    const row = store.listNotifications(ACCOUNT, 10)[0];
    expect(JSON.parse(row?.data ?? "null")).toEqual({ worldId: "wrld_x:1" });
    store.close();
  });

  test("malformed `details` is kept rather than thrown away", async () => {
    // VRChat has shipped malformed payloads before. Losing the notification is worse than storing
    // a string we could not parse.
    const store = seeded();
    const accounts = accountsWith(
      (path) =>
        path.startsWith("/auth/user/notifications")
          ? json([{ id: "not_1", type: "invite", senderUserId: "usr_a", details: "{not json" }])
          : json([]),
      [],
    );

    const service = new NotificationService({ accounts, store, bus: new EventBus() });
    await service.refresh(ACCOUNT);

    expect(store.listNotifications(ACCOUNT, 10)[0]?.data).toBe(JSON.stringify("{not json"));
    store.close();
  });

  test("announces one summary event, not one per notification", async () => {
    // A backlog replayed as live events would raise a desktop notification per row and bury the
    // feed with years-old friend requests presented as new.
    const store = seeded();
    const bus = new EventBus();
    const kinds: string[] = [];
    bus.subscribe((event) => {
      kinds.push(event.kind);
    });

    const accounts = accountsWith(
      (path) =>
        path.startsWith("/auth/user/notifications")
          ? json(
              Array.from({ length: 5 }, (_, i) => ({
                id: `not_${String(i)}`,
                type: "friendRequest",
                senderUserId: `usr_${String(i)}`,
              })),
            )
          : json([]),
      [],
    );

    await new NotificationService({ accounts, store, bus }).refresh(ACCOUNT);

    expect(kinds).toEqual(["notification.synced"]);
    store.close();
  });

  test("v2 is requested once, because it has no offset to page with", async () => {
    // v2 takes `limit` only. Sending `offset` is accepted and ignored, so a paging loop would
    // re-read the same first page until the cap, rewriting identical rows on every poll.
    const store = seeded();
    const calls: Call[] = [];
    const accounts = accountsWith((path) => {
      if (path.startsWith("/auth/user/notifications")) return json([]);
      // A deliberately *full* page: with paging logic this is what would never terminate.
      return json(
        Array.from({ length: 10 }, (_, i) => ({
          id: `not_v2_${String(i)}`,
          category: "group.announcement",
          senderUserId: "usr_b",
        })),
      );
    }, calls);

    await new NotificationService({
      accounts,
      store,
      bus: new EventBus(),
      pageSize: 10,
      maxPerGeneration: 100,
    }).refresh(ACCOUNT);

    const v2 = calls.filter((call) => call.path.startsWith("/notifications"));
    expect(v2).toHaveLength(1);
    expect(v2[0]?.path).toContain("limit=");
    expect(v2[0]?.path).not.toContain("offset=");
    store.close();
  });

  test("an offline account is not polled", async () => {
    const store = seeded();
    const calls: Call[] = [];
    const accounts = accountsWith(() => json([]), calls, "offline");

    await new NotificationService({ accounts, store, bus: new EventBus() }).refresh(ACCOUNT);

    expect(calls).toHaveLength(0);
    store.close();
  });

  test("paging is capped so a misbehaving endpoint cannot loop forever", async () => {
    // A full page every time means "there is more" every time. Without the cap this never returns.
    const store = seeded();
    const calls: Call[] = [];
    const accounts = accountsWith((path) => {
      if (!path.startsWith("/auth/user/notifications")) return json([]);
      const offset = Number(new URL(`https://x${path}`).searchParams.get("offset"));
      return json(
        Array.from({ length: 10 }, (_, i) => ({
          id: `not_${String(offset + i)}`,
          type: "invite",
          senderUserId: "usr_a",
        })),
      );
    }, calls);

    await new NotificationService({
      accounts,
      store,
      bus: new EventBus(),
      pageSize: 10,
      maxPerGeneration: 50,
    }).refresh(ACCOUNT);

    expect(calls.filter((call) => call.path.startsWith("/auth/user/notifications"))).toHaveLength(
      5,
    );
    store.close();
  });
});
