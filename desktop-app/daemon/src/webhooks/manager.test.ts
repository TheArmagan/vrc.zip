import { afterEach, describe, expect, test } from "bun:test";
import type { BusEvent } from "../bus/event-bus.ts";
import { MEMORY, Store } from "../store/store.ts";
import { WebhookManager, type WebhookManagerOptions } from "./manager.ts";
import { verifyWebhookSignature, WEBHOOK_HEADERS } from "./signature.ts";
import { WebhookUrlError } from "./url.ts";

/**
 * The delivery subsystem, driven against a **real `Bun.serve`** rather than a `fetch` stub.
 *
 * CLAUDE.md's rule, and it earns its keep twice over here: the two behaviours this module is most
 * likely to get wrong — a 3xx that must not be followed, and an attempt that must time out — are
 * both properties of the HTTP client, and a stub would simply return whatever the test told it to
 * and prove nothing.
 *
 * The clock is injected everywhere, so no test waits on a backoff.
 */

const T0 = 1_700_000_000_000;

interface Received {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface Receiver {
  readonly requests: Received[];
  readonly url: string;
  readonly origin: string;
}

type Responder = (index: number) => Response | Promise<Response>;

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const releases: Array<() => void> = [];
const stores: Store[] = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) store.close();
});

function receiver(respond: Responder = () => new Response("ok")): Receiver {
  const requests: Received[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.text();
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key] = value;
      });
      requests.push({ path: new URL(request.url).pathname, headers, body });
      return respond(requests.length - 1);
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  return { requests, url: `${origin}/hook`, origin };
}

function openStore(): Store {
  const store = Store.open(MEMORY);
  stores.push(store);
  // `webhooks.account_id` is a real foreign key, so an account-scoped webhook needs an account.
  store.upsertAccount({
    id: "usr_alice",
    display_name: "Alice",
    added_at: T0,
    enabled: 1,
    last_seen_at: null,
  });
  return store;
}

interface Harness {
  readonly store: Store;
  readonly manager: WebhookManager;
  /** Mutable injected clock. Nothing in these tests waits on real time. */
  set(now: number): void;
  advance(ms: number): void;
}

function harness(overrides: Partial<WebhookManagerOptions> = {}): Harness {
  const store = openStore();
  let now = T0;
  const manager = new WebhookManager({
    store,
    now: () => now,
    // Zero randomness: the backoff is then exactly the exponential, which is the thing under test.
    random: () => 0,
    timeoutMs: 2_000,
    ...overrides,
  });
  return {
    store,
    manager,
    set(value) {
      now = value;
    },
    advance(ms) {
      now += ms;
    },
  };
}

function event(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    kind: "friend.online",
    accountId: "usr_alice",
    ts: T0,
    subjectId: "usr_bob",
    ...overrides,
  } as BusEvent;
}

describe("registration", () => {
  test("hands back the secret once and stores only its hash", () => {
    const { store, manager } = harness();
    const hook = receiver();

    const { webhook, secret } = manager.register({ url: hook.url, kinds: ["friend.*"] });

    expect(webhook.url).toBe(hook.url);
    expect(JSON.parse(webhook.kinds)).toEqual(["friend.*"]);
    // The point of hashing: dumping the table yields nothing the receiver would accept as a secret.
    expect(JSON.stringify(store.listWebhooks())).not.toContain(secret);
    expect(webhook.secret_hash).not.toBe(secret);
  });

  test("refuses an SSRF target before a row exists, and refuses an empty filter", () => {
    const { store, manager } = harness();

    expect(() => manager.register({ url: "http://169.254.169.254/", kinds: ["*"] })).toThrow(
      WebhookUrlError,
    );
    expect(() => manager.register({ url: "https://hooks.example.com/", kinds: ["nope!"] })).toThrow(
      WebhookUrlError,
    );
    expect(store.listWebhooks()).toHaveLength(0);
  });

  test("remove takes the queued deliveries with it", () => {
    const { store, manager } = harness();
    const hook = receiver();
    const { webhook } = manager.register({ url: hook.url, kinds: ["*"] });

    manager.onEvent(event());
    expect(store.listWebhookDeliveries(webhook.id)).toHaveLength(1);

    expect(manager.remove(webhook.id)).toBe(true);
    expect(store.listWebhookDeliveries(webhook.id)).toHaveLength(0);
    expect(manager.remove(webhook.id)).toBe(false);
  });
});

describe("delivery", () => {
  test("signs the body, carries the ids, and marks the row delivered", async () => {
    const { store, manager, set } = harness();
    const hook = receiver();
    const { webhook, secret } = manager.register({ url: hook.url, kinds: ["friend.*"] });

    manager.onEvent(event());
    set(T0 + 1_234);
    expect(await manager.tick()).toBe(1);

    const sent = hook.requests[0];
    expect(sent).toBeDefined();
    if (sent === undefined) return;

    expect(sent.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(sent.body)).toMatchObject({
      kind: "friend.online",
      accountId: "usr_alice",
      subjectId: "usr_bob",
    });

    const timestamp = Number(sent.headers[WEBHOOK_HEADERS.timestamp]);
    expect(timestamp).toBe(T0 + 1_234);
    expect(
      verifyWebhookSignature(
        secret,
        timestamp,
        sent.body,
        sent.headers[WEBHOOK_HEADERS.signature] ?? "",
      ),
    ).toBe(true);

    const [row] = store.listWebhookDeliveries(webhook.id);
    expect(row?.delivered_at).toBe(T0 + 1_234);
    expect(row?.last_status).toBe(200);
    expect(sent.headers[WEBHOOK_HEADERS.delivery]).toBe(row?.id);
    expect(sent.headers[WEBHOOK_HEADERS.event]).toBe(row?.event_id);
    expect(sent.headers[WEBHOOK_HEADERS.eventKind]).toBe("friend.online");

    expect(store.getWebhook(webhook.id)?.delivered_count).toBe(1);
  });

  test("one event fans out to every matching webhook under one event id", async () => {
    const { store, manager } = harness();
    const a = receiver();
    const b = receiver();
    const first = manager.register({ url: a.url, kinds: ["*"] }).webhook;
    const second = manager.register({ url: b.url, kinds: ["friend.online"] }).webhook;
    manager.register({ url: receiver().url, kinds: ["gamelog.*"] });

    manager.onEvent(event());
    // Two sends in one scan: different webhooks are independent of each other.
    expect(await manager.tick()).toBe(2);

    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(store.listWebhookDeliveries(first.id)[0]?.event_id).toBe(
      store.listWebhookDeliveries(second.id)[0]?.event_id ?? "",
    );
  });

  test("does not deliver to a webhook whose account filter excludes the event", async () => {
    const { manager } = harness();
    const hook = receiver();
    manager.register({ url: hook.url, kinds: ["*"], accountId: "usr_alice" });

    manager.onEvent(event({ accountId: "usr_bob" }));
    expect(await manager.tick()).toBe(0);
    expect(hook.requests).toHaveLength(0);
  });

  test("deliveries to one webhook are serialised, oldest first", async () => {
    const { manager, advance } = harness();
    const hook = receiver();
    manager.register({ url: hook.url, kinds: ["*"] });

    manager.onEvent(event({ subjectId: "usr_one" }));
    advance(1);
    manager.onEvent(event({ subjectId: "usr_two" }));

    // One scan, one send: the second event waits for the first to leave the queue.
    expect(await manager.tick()).toBe(1);
    expect(await manager.tick()).toBe(1);

    expect(hook.requests.map((r) => JSON.parse(r.body).subjectId)).toEqual(["usr_one", "usr_two"]);
  });
});

describe("retries", () => {
  test("backs off exponentially and re-sends byte-identical bytes", async () => {
    const { store, manager, set } = harness({
      baseBackoffMs: 1_000,
      maxBackoffMs: 8_000,
      maxAttempts: 6,
    });
    const hook = receiver((index) => new Response("boom", { status: index < 4 ? 500 : 200 }));
    const { webhook, secret } = manager.register({ url: hook.url, kinds: ["*"] });

    manager.onEvent(event());

    const schedule: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = store.listWebhookDeliveries(webhook.id)[0];
      expect(await manager.tick()).toBe(1);
      const after = store.listWebhookDeliveries(webhook.id)[0];
      expect(after?.delivered_at).toBeNull();
      schedule.push((after?.next_attempt_at ?? 0) - (before?.next_attempt_at ?? 0));
      set(after?.next_attempt_at ?? 0);
    }

    // 1s, 2s, 4s, then the 8s ceiling — capped, not doubling forever over a blip.
    expect(schedule).toEqual([1_000, 2_000, 4_000, 8_000]);

    // The fifth attempt succeeds.
    expect(await manager.tick()).toBe(1);
    expect(store.listWebhookDeliveries(webhook.id)[0]?.delivered_at).not.toBeNull();
    expect(store.listWebhookDeliveries(webhook.id)[0]?.attempts).toBe(5);

    // Every attempt carried the same bytes under a fresh timestamp — a retry must not re-render.
    const bodies = new Set(hook.requests.map((r) => r.body));
    expect(bodies.size).toBe(1);
    for (const sent of hook.requests) {
      expect(
        verifyWebhookSignature(
          secret,
          Number(sent.headers[WEBHOOK_HEADERS.timestamp]),
          sent.body,
          sent.headers[WEBHOOK_HEADERS.signature] ?? "",
        ),
      ).toBe(true);
    }

    // A success clears the auto-disable counter rather than decaying it.
    expect(store.getWebhook(webhook.id)?.consecutive_dead).toBe(0);
  });

  test("dead-letters after the last attempt and stops trying", async () => {
    const { store, manager, set } = harness({ baseBackoffMs: 1_000, maxAttempts: 3 });
    const hook = receiver(() => new Response("nope", { status: 503 }));
    const { webhook } = manager.register({ url: hook.url, kinds: ["*"] });

    manager.onEvent(event());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await manager.tick();
      set((store.listWebhookDeliveries(webhook.id)[0]?.next_attempt_at ?? 0) + 1);
    }

    const row = store.listWebhookDeliveries(webhook.id)[0];
    expect(hook.requests).toHaveLength(3);
    expect(row?.attempts).toBe(3);
    expect(row?.dead_at).not.toBeNull();
    expect(row?.last_status).toBe(503);
    expect(row?.last_error).toContain("HTTP 503");

    // Dead is terminal: no further scan picks it up.
    set(T0 + 1_000_000);
    expect(await manager.tick()).toBe(0);
    expect(hook.requests).toHaveLength(3);

    expect(store.getWebhook(webhook.id)?.dead_count).toBe(1);
    expect(store.getWebhook(webhook.id)?.consecutive_dead).toBe(1);
  });

  test("auto-disables after consecutive dead deliveries, and drains what is left", async () => {
    const { store, manager, advance } = harness({ maxAttempts: 1, maxDeadBeforeDisable: 2 });
    const hook = receiver(() => new Response("nope", { status: 500 }));
    const { webhook } = manager.register({ url: hook.url, kinds: ["*"] });

    manager.onEvent(event({ subjectId: "usr_one" }));
    advance(1);
    manager.onEvent(event({ subjectId: "usr_two" }));
    advance(1);
    manager.onEvent(event({ subjectId: "usr_three" }));

    await manager.tick();
    expect(store.getWebhook(webhook.id)?.disabled_at).toBeNull();

    await manager.tick();
    const disabled = store.getWebhook(webhook.id);
    expect(disabled?.disabled_at).not.toBeNull();
    expect(disabled?.disabled_reason).toContain("auto-disabled");

    // The third delivery is dead-lettered without a request: a disabled webhook costs nothing.
    await manager.tick();
    expect(hook.requests).toHaveLength(2);
    const rows = store.listWebhookDeliveries(webhook.id);
    expect(rows.every((row) => row.dead_at !== null)).toBe(true);
    expect(rows[0]?.last_error).toBe("webhook disabled");

    // And it is out of the dispatch set, so nothing new is queued for it either.
    manager.onEvent(event());
    expect(store.listWebhookDeliveries(webhook.id)).toHaveLength(3);
  });
});

describe("hostile responses", () => {
  test("a 3xx is a failure and is never followed", async () => {
    const { store, manager } = harness();
    const target = receiver();
    const hook = receiver(
      () => new Response(null, { status: 302, headers: { location: `${target.origin}/moved` } }),
    );
    const { webhook } = manager.register({ url: hook.url, kinds: ["*"] });

    manager.onEvent(event());
    await manager.tick();

    // The whole point: following the redirect would re-open every check `url.ts` made, since the
    // 302 could point anywhere — including back into the user's LAN.
    expect(target.requests).toHaveLength(0);

    const row = store.listWebhookDeliveries(webhook.id)[0];
    expect(row?.last_status).toBe(302);
    expect(row?.last_error).toContain("redirect refused");
    // Permanent, so it burns one attempt rather than eight: a redirect will not stop being one.
    expect(row?.dead_at).not.toBeNull();
    expect(row?.attempts).toBe(1);
  });

  test("a 410 Gone is permanent, while a 404 is retried", async () => {
    const { store, manager } = harness({ maxAttempts: 5 });
    const gone = receiver(() => new Response(null, { status: 410 }));
    const missing = receiver(() => new Response(null, { status: 404 }));
    const a = manager.register({ url: gone.url, kinds: ["*"] }).webhook;
    const b = manager.register({ url: missing.url, kinds: ["*"] }).webhook;

    manager.onEvent(event());
    await manager.tick();

    expect(store.listWebhookDeliveries(a.id)[0]?.dead_at).not.toBeNull();
    // A receiver that deployed a broken route and fixed it five minutes later is the common story.
    expect(store.listWebhookDeliveries(b.id)[0]?.dead_at).toBeNull();
  });

  test("an endpoint that never answers times out and is retried, not dropped", async () => {
    const { store, manager } = harness({ timeoutMs: 60, baseBackoffMs: 1_000 });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.push(() => {
      release();
    });

    const hook = receiver(async () => {
      await held;
      return new Response("late");
    });
    const { webhook } = manager.register({ url: hook.url, kinds: ["*"] });

    manager.onEvent(event());
    await manager.tick();

    const row = store.listWebhookDeliveries(webhook.id)[0];
    expect(row?.last_status).toBeNull();
    expect(row?.last_error).toContain("timed out");
    // Still pending: a slow receiver is exactly what the backoff exists for.
    expect(row?.dead_at).toBeNull();
    expect(row?.next_attempt_at).toBe(T0 + 1_000);
  });

  test("a huge response body is capped rather than read whole", async () => {
    const { store, manager } = harness();
    const hook = receiver(() => new Response("x".repeat(5_000_000), { status: 500 }));
    const { webhook } = manager.register({ url: hook.url, kinds: ["*"] });

    manager.onEvent(event());
    await manager.tick();

    const row = store.listWebhookDeliveries(webhook.id)[0];
    expect(row?.last_status).toBe(500);
    // An endpoint answering a webhook with a gigabyte must not become a place to store data.
    expect((row?.last_error ?? "").length).toBeLessThan(300);
  });
});

describe("lifecycle", () => {
  test("start and stop are idempotent and leave nothing scanning", () => {
    const { manager } = harness({ scanIntervalMs: 50, sleep: () => Promise.resolve() });

    manager.start();
    manager.start();
    expect(manager.isRunning).toBe(true);

    manager.stop();
    manager.stop();
    expect(manager.isRunning).toBe(false);
  });

  test("a queued delivery survives the manager being rebuilt around the same store", async () => {
    const { store, manager } = harness({ maxAttempts: 1 });
    const hook = receiver();
    const { webhook } = manager.register({ url: hook.url, kinds: ["*"] });
    manager.onEvent(event());
    manager.stop();

    // The queue is a table, so a second manager — a restarted daemon — picks the row up.
    let now = T0 + 10_000;
    const revived = new WebhookManager({ store, now: () => now, random: () => 0 });
    expect(await revived.tick()).toBe(1);
    now += 1;

    expect(hook.requests).toHaveLength(1);
    expect(store.listWebhookDeliveries(webhook.id)[0]?.delivered_at).toBe(T0 + 10_000);
  });
});
