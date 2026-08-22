import { describe, expect, test } from "bun:test";
import { CookieJar } from "../accounts/cookie-jar.ts";
import { initialDelay, jitter } from "./jitter.ts";
import {
  parseRetryAfter,
  RateLimiter,
  type RateLimiterOptions,
  VRCHAT_RATE_LIMIT_FILES_PER_IP_PER_SECOND,
  VRCHAT_RATE_LIMIT_PER_ACCOUNT_PER_SECOND,
  VRCHAT_RATE_LIMIT_PER_IP_PER_SECOND,
} from "./rate-limiter.ts";
import { basicAuthHeader, type RequestContext, vrcFetch } from "./request.ts";
import { buildUserAgent, validateContact } from "./user-agent.ts";

describe("user agent", () => {
  test("builds the mandated shape", () => {
    // A missing or generic UA is a hard 403 + waf_code 13799, on the WS handshake too.
    expect(buildUserAgent("me@somewhere.dev", "1.2.3")).toBe("vrc.zip/1.2.3 (me@somewhere.dev)");
  });

  test("rejects placeholder contacts rather than shipping dishonest attribution", () => {
    for (const bad of ["", "   ", "test", "n/a", "someone@example.com", "you@example.invalid"]) {
      expect(validateContact(bad).ok, `${bad} should be rejected`).toBe(false);
    }
  });

  test("rejects header injection and parentheses", () => {
    expect(validateContact("me@x.dev\r\nX-Evil: 1").ok).toBe(false);
    expect(validateContact("me@x.dev\nfoo").ok).toBe(false);
    expect(validateContact("me (not really)").ok).toBe(false);
  });

  test("accepts non-email contacts, because a fake email is the worse outcome", () => {
    expect(validateContact("discord: someuser").ok).toBe(true);
    expect(validateContact("https://github.com/someuser").ok).toBe(true);
  });

  test("throws rather than substituting a placeholder", () => {
    expect(() => buildUserAgent("test")).toThrow(/invalid User-Agent contact/);
  });
});

describe("parseRetryAfter", () => {
  const now = 1_750_000_000_000;

  test("reads delta-seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("0", now)).toBe(0);
  });

  test("reads an HTTP date", () => {
    const future = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBeLessThanOrEqual(30_000);
  });

  test("returns undefined for junk and for absent, so the caller uses its own backoff", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  function harness(overrides: RateLimiterOptions = {}) {
    let now = 0;
    const slept: number[] = [];
    const limiter = new RateLimiter({
      ratePerSecond: 1,
      burst: 2,
      // Generous by default so the per-account assertions below aren't measuring the global bucket.
      // The global bucket gets its own tests.
      globalRatePerSecond: 1000,
      globalBurst: 1000,
      baseBackoffMs: 1000,
      maxBackoffMs: 60_000,
      random: () => 0, // deterministic: no jitter added
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
      ...overrides,
    });
    return { limiter, slept, advance: (ms: number) => (now += ms), at: () => now };
  }

  test("spends the burst immediately, then paces", async () => {
    const { limiter, slept } = harness();
    await limiter.acquire("usr_a");
    await limiter.acquire("usr_a");
    expect(slept).toEqual([]);

    await limiter.acquire("usr_a");
    expect(slept).toEqual([1000]);
  });

  test("buckets are per-account and do not share tokens", async () => {
    // Six accounts are six users as far as VRChat is concerned. Coupling them would make one busy
    // account throttle the other five for no reason.
    const { limiter, slept } = harness();
    await limiter.acquire("usr_a");
    await limiter.acquire("usr_a");
    await limiter.acquire("usr_b");
    await limiter.acquire("usr_b");
    expect(slept).toEqual([]);
  });

  test("429 backoff is exponential from 1s and capped", () => {
    const { limiter } = harness();
    expect(limiter.record429()).toBe(1000);
    expect(limiter.record429()).toBe(2000);
    expect(limiter.record429()).toBe(4000);
    expect(limiter.record429()).toBe(8000);
    for (let i = 0; i < 10; i++) limiter.record429();
    expect(limiter.record429()).toBe(60_000);
  });

  test("jitter only ever lengthens the wait", () => {
    let r = 0;
    const { limiter } = harness({ random: () => r });
    r = 1;
    expect(limiter.record429()).toBe(1250); // 1000 * (1 + 1 * 0.25)
  });

  test("Retry-After wins when longer, but cannot shorten our backoff", () => {
    const a = harness().limiter;
    expect(a.record429(30_000)).toBe(30_000);

    const b = harness().limiter;
    b.record429();
    b.record429();
    b.record429(); // computed 4000
    // A Retry-After: 1 during a 429 storm must not talk us into hammering.
    expect(b.record429(1000)).toBe(8000);
  });

  test("the breaker is global — a 429 on one account stops every account", async () => {
    // Continuing to send from the same IP on other accounts is how a rate limit becomes a
    // moderation action.
    const { limiter, slept } = harness();
    limiter.record429();
    expect(limiter.isBackingOff).toBe(true);

    await limiter.acquire("usr_b");
    expect(slept[0]).toBe(1000);
  });

  test("the global bucket caps the whole IP, not each account", async () => {
    // VRChat's 20/s is per IP. Six accounts each politely under their own limit still add up, and
    // per-account limiting alone cannot see that.
    const { limiter, slept } = harness({
      ratePerSecond: 1000,
      burst: 1000,
      globalRatePerSecond: 4,
      globalBurst: 4,
    });

    for (const account of ["usr_a", "usr_b", "usr_c", "usr_d"]) {
      await limiter.acquire(account);
    }
    expect(slept).toEqual([]);

    // Five accounts' worth of "well-behaved" traffic still hits the IP ceiling.
    await limiter.acquire("usr_e");
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThan(0);
  });

  test("a contended call spends neither bucket", async () => {
    // Spending the account token while waiting on the global one would leak a token per contended
    // call and let the effective rate drift above the configured one.
    const { limiter } = harness({
      ratePerSecond: 2,
      burst: 2,
      globalRatePerSecond: 1,
      globalBurst: 1,
    });

    await limiter.acquire("usr_a"); // spends 1 account + 1 global
    await limiter.acquire("usr_a"); // waits for global, then spends the second account token
    // If the first contended attempt had leaked an account token, this third call would find the
    // account bucket empty and wait on it rather than on the global bucket.
    expect(limiter.consecutive429Count).toBe(0);
  });

  test("the shipped defaults sit under both of VRChat's documented ceilings", () => {
    // Two ceilings, not one: 20/s per account and 100/s per IP. A limit is what VRChat enforces,
    // not a target to sit on, so both defaults keep headroom under their own ceiling.
    expect(VRCHAT_RATE_LIMIT_PER_ACCOUNT_PER_SECOND).toBe(20);
    expect(VRCHAT_RATE_LIMIT_PER_IP_PER_SECOND).toBe(100);
    expect(VRCHAT_RATE_LIMIT_FILES_PER_IP_PER_SECOND).toBe(300);

    const defaults = new RateLimiter();
    expect(defaults.ratePerSecond).toBeLessThan(VRCHAT_RATE_LIMIT_PER_ACCOUNT_PER_SECOND);
    expect(defaults.globalRatePerSecond).toBeLessThan(VRCHAT_RATE_LIMIT_PER_IP_PER_SECOND);

    // The global bucket has to be the binding constraint before the per-account one is, or six
    // accounts each under 20/s would sail past the IP ceiling with nothing to stop them.
    expect(defaults.globalRatePerSecond).toBeGreaterThan(defaults.ratePerSecond);

    // Files are the roomiest tier by a wide margin. If this ever inverts, avatars are being
    // metered as if they were API calls.
    expect(defaults.fileRatePerSecond).toBeLessThan(VRCHAT_RATE_LIMIT_FILES_PER_IP_PER_SECOND);
    expect(defaults.fileRatePerSecond).toBeGreaterThan(defaults.globalRatePerSecond);
  });

  test("file requests do not spend the API budget", async () => {
    // The reason this matters: one friends screen is a few hundred icons. If they draw on the API
    // bucket, presence polling queues behind pictures on every cold start.
    const limiter = new RateLimiter({
      ratePerSecond: 1,
      burst: 1,
      globalRatePerSecond: 1,
      globalBurst: 1,
      fileRatePerSecond: 1,
      fileBurst: 4,
    });

    // Drain the file burst. None of it may touch the account or global API buckets.
    for (let i = 0; i < 4; i++) await limiter.acquire("usr_a", "file");

    // The API bucket is therefore still full: this must return immediately rather than waiting a
    // second for a refill.
    const started = Bun.nanoseconds();
    await limiter.acquire("usr_a");
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
    expect(elapsedMs).toBeLessThan(50);
  });

  test("a file request still waits out the shared 429 breaker", async () => {
    // One breaker for both tiers: being told to slow down means slowing down, not switching lanes.
    let now = 1_000_000;
    let slept = 0;
    const limiter = new RateLimiter({
      fileBurst: 100,
      now: () => now,
      // Advance the injected clock by exactly what was slept, so the breaker actually expires.
      // A no-op sleep here would spin on the real clock instead of testing anything.
      sleep: async (ms) => {
        slept += ms;
        now += ms;
      },
      random: () => 0,
    });

    limiter.record429();
    await limiter.acquire("usr_a", "file");
    expect(slept).toBeGreaterThanOrEqual(1_000);
  });

  /*
   * The roster's per-user fallback can be eighty `GET /users/{id}` on first sight of a busy public
   * instance. PROGRESS.md decision 102: it runs at `"low"` priority, which reserves headroom rather
   * than ordering a queue — the limiter has no queue to order.
   */
  test("low priority leaves a reserve; normal priority spends the whole burst", async () => {
    const { limiter, slept } = harness({ burst: 8, lowPriorityReserve: 3 });

    // Five of the eight, then the floor stops it: the reserve is what a normal call will find.
    for (let i = 0; i < 5; i++) await limiter.acquire("usr_a", "api", "low");
    expect(slept).toEqual([]);

    await limiter.acquire("usr_a", "api", "low");
    expect(slept).toHaveLength(1);

    // The same bucket, asked normally, hands over the reserve without waiting at all.
    const normal = harness({ burst: 8, lowPriorityReserve: 3 });
    for (let i = 0; i < 8; i++) await normal.limiter.acquire("usr_a");
    expect(normal.slept).toEqual([]);
  });

  test("a normal call never waits behind bulk low-priority work", async () => {
    // The point of the reserve, stated as the property it exists for.
    const { limiter, slept } = harness({ burst: 8, lowPriorityReserve: 3 });
    for (let i = 0; i < 5; i++) await limiter.acquire("usr_a", "api", "low");

    const before = slept.length;
    await limiter.acquire("usr_a");
    expect(slept.length).toBe(before);
  });

  test("the reserve applies to the IP bucket too, not only the account's own", async () => {
    // Otherwise eighty fetches across six accounts drain the shared bucket instead — the same
    // starvation one level up, invisible to per-account limiting.
    const { limiter, slept } = harness({
      burst: 1000,
      ratePerSecond: 1000,
      globalBurst: 8,
      globalRatePerSecond: 1,
      lowPriorityReserve: 3,
    });

    for (let i = 0; i < 5; i++) await limiter.acquire(`usr_${String(i)}`, "api", "low");
    expect(slept).toEqual([]);

    await limiter.acquire("usr_x", "api", "low");
    expect(slept).toHaveLength(1);
  });

  test("a blocked low-priority call waits for the floor, not for one token", async () => {
    // Waiting for a single token would wake it while the floor is still unmet, and it would spin.
    // One sleep, then through — never a sequence of them.
    const { limiter, slept } = harness({ burst: 4, ratePerSecond: 1, lowPriorityReserve: 3 });
    await limiter.acquire("usr_a", "api", "low"); // 4 -> 3, at the floor
    expect(slept).toEqual([]);

    await limiter.acquire("usr_a", "api", "low");
    expect(slept).toEqual([1000]);
  });

  test("the file tier honours priority as well, so `low` is never a silent no-op", async () => {
    const { limiter, slept } = harness({
      fileBurst: 4,
      fileRatePerSecond: 1,
      lowPriorityReserve: 3,
    });
    await limiter.acquire("usr_a", "file", "low");
    expect(slept).toEqual([]);
    await limiter.acquire("usr_a", "file", "low");
    expect(slept).toEqual([1000]);
  });

  test("the default reserve is a quarter of the burst and never exceeds it", async () => {
    // A reserve larger than the bucket would make every low-priority call wait forever, which is
    // why it is derived from the burst rather than defaulted to a constant.
    const { limiter, slept } = harness({ burst: 4, ratePerSecond: 1 });
    await limiter.acquire("usr_a", "api", "low");
    await limiter.acquire("usr_a", "api", "low");
    await limiter.acquire("usr_a", "api", "low");
    expect(slept).toEqual([]);

    await limiter.acquire("usr_a", "api", "low");
    expect(slept).toHaveLength(1);

    // burst 1 -> reserve 1: still reachable for a normal call, and low priority simply waits.
    const tiny = harness({ burst: 1, ratePerSecond: 1 });
    await tiny.limiter.acquire("usr_a");
    expect(tiny.slept).toEqual([]);
  });

  test("a success resets the counter fully rather than decaying", () => {
    const { limiter } = harness();
    limiter.record429();
    limiter.record429();
    limiter.recordSuccess();
    expect(limiter.consecutive429Count).toBe(0);
    expect(limiter.record429()).toBe(1000);
  });
});

describe("jitter", () => {
  test("adds between 0 and spread, never subtracts", () => {
    expect(jitter(1000, { random: () => 0 })).toBe(1000);
    expect(jitter(1000, { random: () => 1 })).toBe(1200);
    expect(jitter(1000, { random: () => 0.5, spread: 0.5 })).toBe(1250);
  });

  test("the first tick spreads across the whole interval, not just the jitter window", () => {
    // On a cold start every poller would otherwise fire inside the same narrow window — a small
    // synchronized spike of exactly the kind the guidelines ask us not to create.
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) delays.add(initialDelay(60_000, { random: () => i / 50 }));
    expect(delays.size).toBeGreaterThan(40);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });
});

describe("vrcFetch", () => {
  function context(
    handler: (request: Request) => Response | Promise<Response>,
    overrides: Partial<RequestContext> = {},
  ): { ctx: RequestContext; seen: Request[] } {
    const seen: Request[] = [];
    // A fake clock that the fake sleep actually advances. A no-op sleep against the real clock
    // would make `acquire` spin for the length of a real 429 backoff — the loop re-checks the
    // breaker each pass, which is correct behaviour and a slow test.
    let clock = 1_750_000_000_000;
    const ctx: RequestContext = {
      accountId: "usr_a",
      jar: new CookieJar(),
      userAgent: "vrc.zip/0.1.0 (me@somewhere.dev)",
      limiter: new RateLimiter({
        burst: 100,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
      baseUrl: "https://api.test.invalid/api/1",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push(request);
        return handler(request);
      },
      ...overrides,
    };
    return { ctx, seen };
  }

  test("always sends our User-Agent, and a caller cannot override it", async () => {
    const { ctx, seen } = context(() => new Response("{}"));
    await vrcFetch(ctx, "/auth/user", { headers: { "User-Agent": "SomeOtherApp/1.0" } });
    expect(seen[0]?.headers.get("User-Agent")).toBe("vrc.zip/0.1.0 (me@somewhere.dev)");
  });

  test("sends the jar's cookies and absorbs Set-Cookie from the response", async () => {
    const { ctx, seen } = context(() => {
      const headers = new Headers();
      headers.append("Set-Cookie", "auth=authcookie_new; Path=/");
      return new Response("{}", { headers });
    });
    ctx.jar.set({ name: "auth", value: "authcookie_old", expiresAt: null });

    await vrcFetch(ctx, "/auth/user");
    expect(seen[0]?.headers.get("Cookie")).toBe("auth=authcookie_old");
    expect(ctx.jar.get("auth")).toBe("authcookie_new");
  });

  test("a Basic-auth login sends no cookies at all", async () => {
    // A login must not present a stale session alongside a fresh credential.
    const { ctx, seen } = context(() => new Response("{}"));
    ctx.jar.set({ name: "auth", value: "authcookie_stale", expiresAt: null });

    await vrcFetch(ctx, "/auth/user", { basicAuth: { username: "u", password: "p" } });
    expect(seen[0]?.headers.get("Cookie")).toBeNull();
    expect(seen[0]?.headers.get("Authorization")).toBe(basicAuthHeader("u", "p"));
  });

  test("percent-encodes the Basic-auth pair", () => {
    // A password containing ':' would otherwise split the credential in the wrong place.
    const header = basicAuthHeader("user@x.dev", "p:a$s w:rd");
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("user%40x.dev:p%3Aa%24s%20w%3Ard");
  });

  test("retries a 429 and records the backoff", async () => {
    let calls = 0;
    const { ctx } = context(() => {
      calls++;
      return calls === 1
        ? new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } })
        : new Response("{}");
    });

    const response = await vrcFetch(ctx, "/auth/user");
    expect(calls).toBe(2);
    expect(response.status).toBe(200);
  });

  test("gives up on a 429 rather than retrying forever", async () => {
    let calls = 0;
    const { ctx } = context(() => {
      calls++;
      return new Response("rate limited", { status: 429 });
    });

    const response = await vrcFetch(ctx, "/auth/user");
    expect(response.status).toBe(429);
    expect(calls).toBe(6); // the first attempt plus MAX_429_RETRIES
  });

  test("retries a 401 exactly once, through the re-auth hook", async () => {
    let calls = 0;
    let reauths = 0;
    const { ctx } = context(
      () => {
        calls++;
        return calls === 1 ? new Response("unauthorized", { status: 401 }) : new Response("{}");
      },
      {
        onUnauthorized: async () => {
          reauths++;
          return true;
        },
      },
    );

    const response = await vrcFetch(ctx, "/auth/user");
    expect(response.status).toBe(200);
    expect(reauths).toBe(1);
  });

  test("does not loop when re-auth fails", async () => {
    let calls = 0;
    const { ctx } = context(
      () => {
        calls++;
        return new Response("unauthorized", { status: 401 });
      },
      { onUnauthorized: async () => false },
    );

    const response = await vrcFetch(ctx, "/auth/user");
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
  });

  test("returns the upstream Response untouched", async () => {
    // Phase 2's proxy forwards this byte-for-byte; re-encoding here would break that.
    const { ctx } = context(
      () =>
        new Response('{"error":{"message":"nope","status_code":403}}', {
          status: 403,
          headers: { "Content-Type": "application/json", "X-Upstream": "kept" },
        }),
    );

    const response = await vrcFetch(ctx, "/auth/user");
    expect(response.status).toBe(403);
    expect(response.headers.get("X-Upstream")).toBe("kept");
    expect(await response.text()).toBe('{"error":{"message":"nope","status_code":403}}');
  });
});
