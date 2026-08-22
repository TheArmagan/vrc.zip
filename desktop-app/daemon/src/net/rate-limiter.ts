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
  /** Sustained requests per second across *every* account. See `VRCHAT_RATE_LIMIT_PER_IP_PER_SECOND`. */
  readonly globalRatePerSecond?: number;
  /** How many requests may be spent at once across every account. */
  readonly globalBurst?: number;
  /** Sustained *file* requests per second across every account. */
  readonly fileRatePerSecond?: number;
  /** How many file requests may be spent at once across every account. */
  readonly fileBurst?: number;
  /**
   * How many tokens a `"low"` priority call must leave behind in whichever bucket it draws from.
   *
   * Defaults to a quarter of each burst. See `RatePriority`.
   */
  readonly lowPriorityReserve?: number;
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
 * VRChat enforces **two** limits, and conflating them is how you either throttle yourself to a
 * sixth of the available throughput or walk into a 429 with every account looking well-behaved:
 *
 *  - **20 req/s per account.**
 *  - **100 req/s per IP**, across every account on the machine.
 *
 * The per-IP ceiling is what makes the global bucket below load-bearing rather than
 * belt-and-braces. Six accounts each politely under their own 20/s is up to 120/s from one IP —
 * over the line, with no individual account exceeding anything. Per-account limiting alone is
 * structurally unable to see that, which is why there are two buckets and not one.
 */
export const VRCHAT_RATE_LIMIT_PER_ACCOUNT_PER_SECOND = 20;
export const VRCHAT_RATE_LIMIT_PER_IP_PER_SECOND = 100;

/**
 * **File requests get their own, far larger per-IP ceiling: 300 req/s.**
 *
 * Images, avatars, and icons are served by a different tier than the API, and charging them to the
 * 100/s API budget is a self-inflicted stall: one friends screen is a few hundred icons, which
 * would eat the entire API allowance and leave presence polling queued behind pictures. They are
 * metered separately for that reason, not as an optimisation.
 */
export const VRCHAT_RATE_LIMIT_FILES_PER_IP_PER_SECOND = 300;

/** Which ceiling a call is charged against. */
export type RateClass = "api" | "file";

/**
 * How willing a call is to be the one that waits.
 *
 * `"low"` is for work that is *bulk, speculative and never urgent* — today that is the roster's
 * per-user fallback, which can be eighty `GET /users/{id}` on first sight of a busy public instance
 * (PROGRESS.md decision 102). Left at `"normal"` it is structurally able to drain the account bucket
 * and leave presence polling, a pipeline re-auth, or the thing the user just clicked queued behind
 * decoration.
 *
 * **It is a reserve, not a queue.** A `"low"` call may only take a token while the bucket still
 * holds `lowPriorityReserve` more than it needs, so there is always headroom for a `"normal"` one.
 * That is deliberately weaker than priority ordering: this limiter has no queue to order — callers
 * race for tokens as they refill — and the requirement decision 102 actually names is headroom, not
 * fairness. Guaranteeing that a `"normal"` call never waits *behind* bulk work is what a reserve
 * gives; guaranteeing it goes first would mean building a queue, which is a much larger change to a
 * load-bearing component for a property nothing yet needs.
 *
 * The trade to know about: sustained `"normal"` traffic at the full configured rate would starve
 * `"low"` indefinitely. That is the correct direction to fail in — and it is not reachable in
 * practice, because the buckets refill at 16/s per account while normal traffic is a small fraction
 * of that.
 */
export type RatePriority = "normal" | "low";

/**
 * Both defaults are **80% of the corresponding ceiling**, and the headroom is deliberate: a limit
 * is what VRChat *enforces*, not a target to sit on, and our clock and theirs do not agree on
 * where a second starts. Backing off from a 429 we caused is strictly worse than being slightly
 * slower. The same rule is applied at both levels so there is one policy to reason about.
 */
const DEFAULTS = {
  ratePerSecond: Math.floor(VRCHAT_RATE_LIMIT_PER_ACCOUNT_PER_SECOND * 0.8),
  burst: VRCHAT_RATE_LIMIT_PER_ACCOUNT_PER_SECOND,
  globalRatePerSecond: Math.floor(VRCHAT_RATE_LIMIT_PER_IP_PER_SECOND * 0.8),
  globalBurst: VRCHAT_RATE_LIMIT_PER_IP_PER_SECOND,
  fileRatePerSecond: Math.floor(VRCHAT_RATE_LIMIT_FILES_PER_IP_PER_SECOND * 0.8),
  fileBurst: VRCHAT_RATE_LIMIT_FILES_PER_IP_PER_SECOND,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
} as const;

/**
 * A quarter of the burst, in whichever bucket is being drawn from.
 *
 * Big enough that a `"normal"` call arriving during bulk work finds a token waiting rather than a
 * refill to sit through, and small enough that bulk work still gets three quarters of the budget
 * when nothing else is asking. Expressed as a fraction of each burst rather than a flat count so
 * the account bucket (20) and the IP bucket (100) both get a proportionate floor.
 */
const LOW_PRIORITY_RESERVE_FRACTION = 0.25;

interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

/**
 * One bucket's live state.
 *
 * `rate` and `burst` are what is *configured* (already at 80% of the ceiling for `rate`, see
 * `DEFAULTS`); `available` is what is actually left right now, and `queued` is how many `acquire()`
 * calls are currently blocked on this bucket.
 */
export interface RateBucketSnapshot {
  /** Sustained refill, tokens per second. */
  readonly rate: number;
  /** Capacity — how much may be spent at once after an idle period. */
  readonly burst: number;
  /**
   * Tokens left, refilled to the moment `snapshot()` was called. **Unrounded**: the bucket refills
   * continuously, so 3.4 is the true answer and rounding it here would throw away the only
   * information a caller needs to decide whether to show "3" or "3.4". Display code floors it.
   */
  readonly available: number;
  /** `acquire()` calls currently sleeping on this bucket. */
  readonly queued: number;
}

/** A per-account bucket, tagged with whose it is. */
export interface AccountRateBucketSnapshot extends RateBucketSnapshot {
  readonly accountId: string;
}

/**
 * Everything the limiter knows about itself, at one instant.
 *
 * Three buckets because there are three ceilings, and a single number cannot describe them: an
 * account can be starved while the IP budget is untouched, and the file tier is independent of
 * both. Collapsing them is what made the old gauge unreadable.
 */
export interface RateLimiterSnapshot {
  /** One entry per account the limiter has seen, or that something is currently queued behind. */
  readonly perAccount: readonly AccountRateBucketSnapshot[];
  /** The IP-wide API budget every account also draws from. */
  readonly globalApi: RateBucketSnapshot;
  /** The IP-wide file budget. Not paired with any per-account bucket — see `#files`. */
  readonly files: RateBucketSnapshot;
  /**
   * Blocked `acquire()` calls in total. Not the sum of the fields above: an `"api"` call is queued
   * against its account bucket *and* the global one, and would be double-counted.
   */
  readonly queuedTotal: number;
  /** The shared 429 breaker: true while nothing may be sent on any account or either tier. */
  readonly backingOff: boolean;
  /** Unix ms the breaker opens at, or `null` when it is closed. */
  readonly retryAfter: number | null;
  readonly consecutive429: number;
}

function refill(bucket: Bucket, now: number, ratePerSecond: number, capacity: number): void {
  const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
  bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedMs / 1000) * ratePerSecond);
  bucket.lastRefillAt = now;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  /** The IP-wide API budget. Every account draws from this one in addition to its own. */
  readonly #global: Bucket;
  /**
   * The IP-wide *file* budget. Deliberately **not** paired with a per-account bucket.
   *
   * The per-account bucket exists to stop one account starving the others under a shared ceiling.
   * Files have their own ceiling, three times the API one, so that fairness problem barely exists —
   * while charging icons to a 16/s per-account bucket would make a 200-friend screen take twelve
   * seconds to paint. VRChat documents no per-account file limit, and inventing one here would be
   * us throttling ourselves against a rule that does not exist.
   */
  readonly #files: Bucket;
  readonly #rate: number;
  readonly #burst: number;
  readonly #globalRate: number;
  readonly #globalBurst: number;
  readonly #fileRate: number;
  readonly #fileBurst: number;
  readonly #lowPriorityReserve: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  /** Consecutive 429s. Reset by the first success, not decayed — see `recordSuccess`. */
  #consecutive429 = 0;
  /** Unix ms before which nothing may be sent, on any account. */
  #blockedUntil = 0;

  /**
   * How many `acquire()` calls are currently sleeping, per account / on the global API bucket / on
   * the file bucket.
   *
   * Counted rather than derived, because there is nothing to derive it from: callers race for
   * tokens as they refill and the limiter holds no queue (see `RatePriority`). A waiter is only
   * visible while it is inside `acquire()`, so the count has to be taken there.
   */
  readonly #queuedByAccount = new Map<string, number>();
  #queuedGlobalApi = 0;
  #queuedFiles = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.#rate = options.ratePerSecond ?? DEFAULTS.ratePerSecond;
    this.#burst = options.burst ?? DEFAULTS.burst;
    this.#globalRate = options.globalRatePerSecond ?? DEFAULTS.globalRatePerSecond;
    this.#globalBurst = options.globalBurst ?? DEFAULTS.globalBurst;
    this.#fileRate = options.fileRatePerSecond ?? DEFAULTS.fileRatePerSecond;
    this.#fileBurst = options.fileBurst ?? DEFAULTS.fileBurst;
    // Derived from the burst rather than defaulted to a constant, so a caller that shrinks the
    // burst for a test does not accidentally get a reserve larger than the bucket — which would
    // make every low-priority call wait forever.
    this.#lowPriorityReserve =
      options.lowPriorityReserve ?? Math.ceil(this.#burst * LOW_PRIORITY_RESERVE_FRACTION);
    this.#baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.#random = options.random ?? Math.random;
    this.#global = { tokens: this.#globalBurst, lastRefillAt: this.#now() };
    this.#files = { tokens: this.#fileBurst, lastRefillAt: this.#now() };
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

  /** The per-account sustained rate in effect. Shown against the per-account ceiling. */
  get ratePerSecond(): number {
    return this.#rate;
  }

  /** The IP-wide sustained file rate in effect. */
  get fileRatePerSecond(): number {
    return this.#fileRate;
  }

  /**
   * Blocks until this account may send. Honours the global breaker first, then the buckets.
   *
   * `rateClass` picks which ceiling the call is charged against — `"file"` for images and other
   * file-tier fetches, `"api"` for everything else. The **breaker is shared**: a 429 on either tier
   * stops both. That is deliberate, and it is the safe direction to be wrong in. VRChat may well
   * throttle the tiers independently, but if we are being told to slow down we would rather pause
   * more than we strictly must than keep hammering one tier while apologising on the other.
   *
   * `priority` decides how much of the bucket this call is willing to leave alone — see
   * `RatePriority`. The breaker is honoured first either way: nothing outranks a 429.
   */
  async acquire(
    accountId: string,
    rateClass: RateClass = "api",
    priority: RatePriority = "normal",
  ): Promise<void> {
    const floor = priority === "low" ? this.#lowPriorityReserve : 0;

    // Counted once on the first sleep and released in `finally`, not paired around each sleep: a
    // caller that wakes, finds the bucket still empty and sleeps again never stopped waiting, and
    // flickering the gauge to zero between iterations would misreport that as a drain. The `finally`
    // is what makes a throw or an aborted caller unable to leak the count.
    let counted = false;
    try {
      // Loop rather than compute once: while we were waiting out the breaker, another response may
      // have arrived and extended it.
      for (;;) {
        const globalWait = this.backoffRemainingMs;
        if (globalWait > 0) {
          if (!counted) {
            counted = true;
            this.#enterQueue(accountId, rateClass);
          }
          await this.#sleep(globalWait);
          continue;
        }

        const wait =
          rateClass === "file" ? this.#reserveFile(floor) : this.#reserve(accountId, floor);
        if (wait === 0) return;
        if (!counted) {
          counted = true;
          this.#enterQueue(accountId, rateClass);
        }
        await this.#sleep(wait);
      }
    } finally {
      if (counted) this.#leaveQueue(accountId, rateClass);
    }
  }

  /**
   * Everything the limiter currently knows, for the control API's gauge.
   *
   * `available` is **exact at the moment of the call**, not an estimate: each bucket is refilled to
   * `now()` before it is read, which is the same arithmetic `acquire()` does. That precision is the
   * whole point — the numbers this replaces were derived from the configured rate and the breaker
   * flag, so they described the *configuration* rather than the limiter, and were wrong exactly when
   * someone was looking at them to find out why something was slow.
   *
   * Refilling mutates the buckets, which is deliberate and harmless: a refill to now is idempotent
   * and is what the next `acquire()` would have done anyway.
   */
  snapshot(): RateLimiterSnapshot {
    const now = this.#now();
    refill(this.#global, now, this.#globalRate, this.#globalBurst);
    refill(this.#files, now, this.#fileRate, this.#fileBurst);

    // Union of the two maps: a bucket exists from an account's first call, and a queue entry can in
    // principle outlive nothing — but taking both means the gauge can never show a waiter with no
    // row to sit in.
    const accountIds = new Set([...this.#buckets.keys(), ...this.#queuedByAccount.keys()]);
    const perAccount: AccountRateBucketSnapshot[] = [];
    for (const accountId of accountIds) {
      const bucket = this.#buckets.get(accountId);
      if (bucket) refill(bucket, now, this.#rate, this.#burst);
      perAccount.push({
        accountId,
        rate: this.#rate,
        burst: this.#burst,
        available: bucket?.tokens ?? this.#burst,
        queued: this.#queuedByAccount.get(accountId) ?? 0,
      });
    }

    return {
      perAccount,
      globalApi: {
        rate: this.#globalRate,
        burst: this.#globalBurst,
        available: this.#global.tokens,
        queued: this.#queuedGlobalApi,
      },
      files: {
        rate: this.#fileRate,
        burst: this.#fileBurst,
        available: this.#files.tokens,
        queued: this.#queuedFiles,
      },
      queuedTotal: this.#queuedGlobalApi + this.#queuedFiles,
      backingOff: now < this.#blockedUntil,
      retryAfter: now < this.#blockedUntil ? this.#blockedUntil : null,
      consecutive429: this.#consecutive429,
    };
  }

  /**
   * An `"api"` call is charged to two buckets and so waits on both; a `"file"` call waits on the
   * file bucket alone, matching what `#reserveFile` actually consults.
   */
  #enterQueue(accountId: string, rateClass: RateClass): void {
    if (rateClass === "file") {
      this.#queuedFiles += 1;
      return;
    }
    this.#queuedGlobalApi += 1;
    this.#queuedByAccount.set(accountId, (this.#queuedByAccount.get(accountId) ?? 0) + 1);
  }

  #leaveQueue(accountId: string, rateClass: RateClass): void {
    if (rateClass === "file") {
      this.#queuedFiles = Math.max(0, this.#queuedFiles - 1);
      return;
    }
    this.#queuedGlobalApi = Math.max(0, this.#queuedGlobalApi - 1);
    const remaining = (this.#queuedByAccount.get(accountId) ?? 0) - 1;
    // Drop the key at zero rather than leaving a 0 behind, so an account that was never seen again
    // doesn't sit in the map — and in the snapshot — forever.
    if (remaining > 0) this.#queuedByAccount.set(accountId, remaining);
    else this.#queuedByAccount.delete(accountId);
  }

  /**
   * Takes one token from the file bucket alone. No account bucket is consulted — see `#files`.
   */
  #reserveFile(floor: number): number {
    const now = this.#now();
    refill(this.#files, now, this.#fileRate, this.#fileBurst);

    // `1 + floor` throughout: a low-priority call needs its own token *plus* the headroom it has
    // promised to leave. The wait it computes is the wait until that is true, not until one token
    // exists — otherwise it would wake, find the floor still unmet, and spin.
    const needed = 1 + floor;
    if (this.#files.tokens >= needed) {
      this.#files.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((needed - this.#files.tokens) / this.#fileRate) * 1000));
  }

  /**
   * Takes one token from the account's bucket *and* one from the global bucket, or returns how long
   * to wait for whichever is further away.
   *
   * Both must have a token before either is spent. Spending from one while waiting on the other
   * would leak tokens on every contended call and quietly let the effective rate drift above the
   * configured one.
   */
  #reserve(accountId: string, floor: number): number {
    const now = this.#now();
    const bucket = this.#buckets.get(accountId) ?? { tokens: this.#burst, lastRefillAt: now };

    refill(bucket, now, this.#rate, this.#burst);
    refill(this.#global, now, this.#globalRate, this.#globalBurst);
    this.#buckets.set(accountId, bucket);

    // The floor applies to both buckets. Reserving headroom on the account bucket alone would leave
    // eighty roster fetches across six accounts free to drain the shared IP bucket, which is the
    // same starvation one level up.
    const needed = 1 + floor;
    if (bucket.tokens >= needed && this.#global.tokens >= needed) {
      bucket.tokens -= 1;
      this.#global.tokens -= 1;
      return 0;
    }

    const accountWait =
      bucket.tokens >= needed ? 0 : ((needed - bucket.tokens) / this.#rate) * 1000;
    const globalWait =
      this.#global.tokens >= needed
        ? 0
        : ((needed - this.#global.tokens) / this.#globalRate) * 1000;
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
