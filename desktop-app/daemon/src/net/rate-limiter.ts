/**
 * Rate limiting and 429 backoff. See PLAN.md §1.4 and the risk register.
 *
 * Two independent mechanisms, and they are not interchangeable:
 *
 * - A **per-account token bucket** paces one account's own requests. Buckets do not share tokens,
 *   because a user with six accounts is six users as far as VRChat is concerned, and coupling them
 *   would make one busy account throttle the other five for no reason.
 * - A **global circuit breaker** halts *everything* on a 429. A 429 is VRChat telling us we are
 *   over the line; continuing to send on other accounts from the same IP is how a rate limit becomes
 *   a moderation action.
 *
 * Every wait is jittered. VRChat's guidelines explicitly say not to create synchronized traffic
 * spikes, and a fleet of clients all backing off for exactly 1s then retrying in lockstep is the
 * textbook way to build one.
 */

export interface RateLimiterOptions {
  /** Sustained requests per second, per account. */
  readonly ratePerSecond?: number;
  /** How many requests one account may spend at once after an idle period. */
  readonly burst?: number;
  /** Sustained requests per second across *every* account. See `VRCHAT_RATE_LIMIT_PER_SECOND`. */
  readonly globalRatePerSecond?: number;
  /** How many requests may be spent at once across every account. */
  readonly globalBurst?: number;
  /** First backoff step after a 429. PLAN.md §Guardrails: exponential from 1s. */
  readonly baseBackoffMs?: number;
  /** Ceiling on the backoff, so a long outage doesn't park us for an hour. */
  readonly maxBackoffMs?: number;
  /** Injected for tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/**
 * VRChat's documented API limit: **20 requests per second, and it is per IP, not per account.**
 *
 * This is the number that makes the global bucket below load-bearing rather than belt-and-braces.
 * Six accounts polling politely at 5/s each is 30/s from one IP — comfortably over the line, with
 * every individual account looking well-behaved. Per-account limiting alone cannot see that.
 */
export const VRCHAT_RATE_LIMIT_PER_SECOND = 20;

const DEFAULTS = {
  // Per account: enough for responsive UI actions, low enough that one account cannot eat the
  // whole IP budget and starve the other five.
  ratePerSecond: 5,
  burst: 10,
  // Globally: 80% of the documented ceiling. The headroom is deliberate — the limit is what VRChat
  // *enforces*, not a target to sit on, and our clock and theirs do not agree on where a second
  // starts. Backing off from a 429 we caused is strictly worse than being slightly slower.
  globalRatePerSecond: Math.floor(VRCHAT_RATE_LIMIT_PER_SECOND * 0.8),
  globalBurst: VRCHAT_RATE_LIMIT_PER_SECOND,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
} as const;

interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

function refill(bucket: Bucket, now: number, ratePerSecond: number, capacity: number): void {
  const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
  bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedMs / 1000) * ratePerSecond);
  bucket.lastRefillAt = now;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  /** The IP-wide budget. Every account draws from this one in addition to its own. */
  readonly #global: Bucket;
  readonly #rate: number;
  readonly #burst: number;
  readonly #globalRate: number;
  readonly #globalBurst: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  /** Consecutive 429s. Reset by the first success, not decayed — see `recordSuccess`. */
  #consecutive429 = 0;
  /** Unix ms before which nothing may be sent, on any account. */
  #blockedUntil = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.#rate = options.ratePerSecond ?? DEFAULTS.ratePerSecond;
    this.#burst = options.burst ?? DEFAULTS.burst;
    this.#globalRate = options.globalRatePerSecond ?? DEFAULTS.globalRatePerSecond;
    this.#globalBurst = options.globalBurst ?? DEFAULTS.globalBurst;
    this.#baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.#random = options.random ?? Math.random;
    this.#global = { tokens: this.#globalBurst, lastRefillAt: this.#now() };
  }

  /** True while the global breaker is open. Surfaced in the UI so a stall is never mysterious. */
  get isBackingOff(): boolean {
    return this.#now() < this.#blockedUntil;
  }

  get backoffRemainingMs(): number {
    return Math.max(0, this.#blockedUntil - this.#now());
  }

  get consecutive429Count(): number {
    return this.#consecutive429;
  }

  /** The IP-wide sustained rate in effect. Surfaced so settings can show it against the ceiling. */
  get globalRatePerSecond(): number {
    return this.#globalRate;
  }

  /**
   * Blocks until this account may send. Honours the global breaker first, then the account's bucket.
   */
  async acquire(accountId: string): Promise<void> {
    // Loop rather than compute once: while we were waiting out the breaker, another response may
    // have arrived and extended it.
    for (;;) {
      const globalWait = this.backoffRemainingMs;
      if (globalWait > 0) {
        await this.#sleep(globalWait);
        continue;
      }

      const wait = this.#reserve(accountId);
      if (wait === 0) return;
      await this.#sleep(wait);
    }
  }

  /**
   * Takes one token from the account's bucket *and* one from the global bucket, or returns how long
   * to wait for whichever is further away.
   *
   * Both must have a token before either is spent. Spending from one while waiting on the other
   * would leak tokens on every contended call and quietly let the effective rate drift above the
   * configured one.
   */
  #reserve(accountId: string): number {
    const now = this.#now();
    const bucket = this.#buckets.get(accountId) ?? { tokens: this.#burst, lastRefillAt: now };

    refill(bucket, now, this.#rate, this.#burst);
    refill(this.#global, now, this.#globalRate, this.#globalBurst);
    this.#buckets.set(accountId, bucket);

    if (bucket.tokens >= 1 && this.#global.tokens >= 1) {
      bucket.tokens -= 1;
      this.#global.tokens -= 1;
      return 0;
    }

    const accountWait = bucket.tokens >= 1 ? 0 : ((1 - bucket.tokens) / this.#rate) * 1000;
    const globalWait =
      this.#global.tokens >= 1 ? 0 : ((1 - this.#global.tokens) / this.#globalRate) * 1000;
    return Math.max(1, Math.ceil(Math.max(accountWait, globalWait)));
  }

  /**
   * Records a 429 and opens the global breaker.
   *
   * `retryAfterMs` from the response wins when present — the server telling us how long to wait is
   * strictly better information than our own doubling — but is still floored at our computed
   * backoff, so a `Retry-After: 1` during a sustained 429 storm can't talk us into hammering.
   */
  record429(retryAfterMs?: number): number {
    this.#consecutive429 += 1;

    const exponential = Math.min(
      this.#maxBackoffMs,
      this.#baseBackoffMs * 2 ** (this.#consecutive429 - 1),
    );
    const base = Math.max(exponential, retryAfterMs ?? 0);
    // Full jitter on the top 25%: enough to decorrelate concurrent clients without making the
    // backoff meaningfully shorter than intended.
    const delay = Math.min(this.#maxBackoffMs, Math.round(base * (1 + this.#random() * 0.25)));

    this.#blockedUntil = Math.max(this.#blockedUntil, this.#now() + delay);
    return delay;
  }

  /**
   * Records a non-429 response.
   *
   * The counter resets fully rather than decaying. A decay would keep us near the top of the
   * exponential after a single stray 429 hours ago, and the cost of being wrong in this direction —
   * one extra 429 — is far smaller than the cost of the other one.
   */
  recordSuccess(): void {
    this.#consecutive429 = 0;
  }

  /** Clears the breaker. For the UI's explicit "try now" button, not for automatic use. */
  reset(): void {
    this.#consecutive429 = 0;
    this.#blockedUntil = 0;
  }
}

/**
 * Parses `Retry-After`, which is either delta-seconds or an HTTP date.
 * Returns `undefined` for anything we can't read, so the caller falls back to its own backoff.
 */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null) return undefined;

  const trimmed = value.trim();

  // Decide numeric-vs-date up front. Falling through from a rejected number to `Date.parse` is a
  // trap: `Date.parse("-5")` succeeds (it reads as a year), so a malformed delta-seconds would come
  // back as a confident, wrong answer instead of "I don't know".
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }

  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);

  return undefined;
}
