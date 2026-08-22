import { describe, expect, test } from "bun:test";
import { RateLimiter, type RateLimiterOptions } from "./rate-limiter.ts";

/**
 * Instrumentation tests. The behavioural ones (pacing, the breaker, `Retry-After`) live in
 * `net.test.ts`; these only assert that `snapshot()` and the queue counters describe what the
 * limiter is actually doing.
 *
 * The harness here holds sleeps open rather than resolving them like the one in `net.test.ts`,
 * because a waiter that has already returned is exactly the thing these tests must not observe.
 */
function harness(overrides: RateLimiterOptions = {}) {
  let now = 0;
  const pending: Array<{ ms: number; resolve: () => void }> = [];
  const limiter = new RateLimiter({
    ratePerSecond: 1,
    burst: 2,
    // Generous unless a test overrides it, so per-account assertions aren't measuring the IP bucket.
    globalRatePerSecond: 1000,
    globalBurst: 1000,
    fileRatePerSecond: 1,
    fileBurst: 2,
    random: () => 0,
    now: () => now,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        pending.push({ ms, resolve });
      }),
    ...overrides,
  });

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  async function wakeAll(): Promise<void> {
    const waiters = pending.splice(0, pending.length);
    now += Math.max(0, ...waiters.map((w) => w.ms));
    for (const waiter of waiters) waiter.resolve();
    await tick();
  }

  /** Wake sleepers until nothing is waiting; a woken caller may need another round of refill. */
  async function drain(): Promise<void> {
    for (let i = 0; i < 20 && pending.length > 0; i++) await wakeAll();
  }

  return {
    limiter,
    pending,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
    wakeAll,
    drain,
    tick,
  };
}

describe("RateLimiter.snapshot", () => {
  test("available drops as calls are made and refills with time", async () => {
    const { limiter, advance } = harness();

    // Nothing has asked yet, so there is no account bucket to report.
    expect(limiter.snapshot().perAccount).toEqual([]);
    expect(limiter.snapshot().globalApi.available).toBe(1000);

    await limiter.acquire("usr_a");
    const spent = limiter.snapshot();
    expect(spent.perAccount).toEqual([
      { accountId: "usr_a", rate: 1, burst: 2, available: 1, queued: 0 },
    ]);
    expect(spent.globalApi.available).toBe(999);

    // Exact at call time, not rounded: half a second of a 1/s refill really is half a token.
    advance(500);
    expect(limiter.snapshot().perAccount[0]?.available).toBe(1.5);

    // And it caps at the burst rather than growing forever.
    advance(10_000);
    expect(limiter.snapshot().perAccount[0]?.available).toBe(2);
  });

  test("file and API tiers report independently", async () => {
    const { limiter } = harness({ burst: 5, fileBurst: 2, fileRatePerSecond: 1 });

    await limiter.acquire("usr_a", "file");
    await limiter.acquire("usr_a", "file");

    const after = limiter.snapshot();
    expect(after.files.available).toBe(0);
    expect(after.files.burst).toBe(2);
    // A file call is charged to neither the account bucket nor the IP API budget.
    expect(after.perAccount).toEqual([]);
    expect(after.globalApi.available).toBe(1000);
  });

  test("reports the shared breaker", () => {
    const { limiter, advance, at } = harness();

    const idle = limiter.snapshot();
    expect(idle.backingOff).toBe(false);
    expect(idle.retryAfter).toBeNull();
    expect(idle.consecutive429).toBe(0);

    limiter.record429(); // 1000ms, no jitter (random: () => 0)
    const open = limiter.snapshot();
    expect(open.backingOff).toBe(true);
    expect(open.retryAfter).toBe(at() + 1000);
    expect(open.consecutive429).toBe(1);

    // The count survives the breaker closing — it is reset by a success, not by time.
    advance(1000);
    const closed = limiter.snapshot();
    expect(closed.backingOff).toBe(false);
    expect(closed.retryAfter).toBeNull();
    expect(closed.consecutive429).toBe(1);

    limiter.recordSuccess();
    expect(limiter.snapshot().consecutive429).toBe(0);
  });
});

describe("RateLimiter queue accounting", () => {
  test("queued rises while callers are blocked and returns to zero once they drain", async () => {
    const h = harness({ burst: 1, ratePerSecond: 1 });
    const { limiter } = h;

    await limiter.acquire("usr_a");
    expect(limiter.snapshot().queuedTotal).toBe(0);

    const blocked = [limiter.acquire("usr_a"), limiter.acquire("usr_a")];
    await h.tick();

    const waiting = limiter.snapshot();
    expect(waiting.perAccount[0]).toMatchObject({ accountId: "usr_a", queued: 2 });
    expect(waiting.globalApi.queued).toBe(2);
    expect(waiting.files.queued).toBe(0);
    // Not the sum: an API call waits on its account bucket *and* the IP one.
    expect(waiting.queuedTotal).toBe(2);

    await h.drain();
    await Promise.all(blocked);

    const drained = limiter.snapshot();
    expect(drained.queuedTotal).toBe(0);
    expect(drained.globalApi.queued).toBe(0);
    expect(drained.perAccount[0]?.queued).toBe(0);
  });

  test("per-account queues stay separate", async () => {
    const h = harness({ burst: 1, ratePerSecond: 1 });
    const { limiter } = h;

    await limiter.acquire("usr_a");
    await limiter.acquire("usr_b");

    const blocked = [limiter.acquire("usr_a"), limiter.acquire("usr_a"), limiter.acquire("usr_b")];
    await h.tick();

    const snap = limiter.snapshot();
    const byId = new Map(snap.perAccount.map((entry) => [entry.accountId, entry.queued]));
    expect(byId.get("usr_a")).toBe(2);
    expect(byId.get("usr_b")).toBe(1);
    expect(snap.globalApi.queued).toBe(3);
    expect(snap.queuedTotal).toBe(3);

    await h.drain();
    await Promise.all(blocked);
    expect(limiter.snapshot().queuedTotal).toBe(0);
  });

  test("a blocked file call does not appear in any account queue", async () => {
    const h = harness({ burst: 5, ratePerSecond: 5, fileBurst: 1, fileRatePerSecond: 1 });
    const { limiter } = h;

    await limiter.acquire("usr_a", "file");
    const blockedFile = limiter.acquire("usr_a", "file");
    await h.tick();

    const snap = limiter.snapshot();
    expect(snap.files.queued).toBe(1);
    expect(snap.globalApi.queued).toBe(0);
    expect(snap.queuedTotal).toBe(1);
    expect(snap.perAccount.find((entry) => entry.accountId === "usr_a")?.queued ?? 0).toBe(0);

    // And the account tier is genuinely unblocked while a file call waits.
    await limiter.acquire("usr_a");
    expect(h.pending.length).toBe(1);

    await h.drain();
    await blockedFile;
    expect(limiter.snapshot().files.queued).toBe(0);
  });

  test("callers waiting out the breaker are counted, on both tiers", async () => {
    const h = harness();
    const { limiter } = h;

    limiter.record429();
    const blocked = [limiter.acquire("usr_a"), limiter.acquire("usr_a", "file")];
    await h.tick();

    const snap = limiter.snapshot();
    expect(snap.globalApi.queued).toBe(1);
    expect(snap.files.queued).toBe(1);
    expect(snap.queuedTotal).toBe(2);

    await h.drain();
    await Promise.all(blocked);
    expect(limiter.snapshot().queuedTotal).toBe(0);
  });

  test("a throwing sleep cannot leak the count", async () => {
    let now = 0;
    const limiter = new RateLimiter({
      ratePerSecond: 1,
      burst: 1,
      globalRatePerSecond: 1000,
      globalBurst: 1000,
      now: () => now,
      sleep: () => Promise.reject(new Error("aborted")),
    });

    await limiter.acquire("usr_a");
    await expect(limiter.acquire("usr_a")).rejects.toThrow("aborted");

    now += 1;
    const snap = limiter.snapshot();
    expect(snap.queuedTotal).toBe(0);
    expect(snap.globalApi.queued).toBe(0);
    expect(snap.perAccount[0]?.queued).toBe(0);
  });
});
