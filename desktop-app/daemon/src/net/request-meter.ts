import { RATE_WINDOW_SECONDS, type RateSeries } from "@vrcz/shared";

/**
 * What the daemon is actually spending, per second, per account and per app.
 *
 * The rate limiter knows the *ceiling*; nothing knew the load. That gap is why the shell could only
 * ever show `80/s` — a constant read off the configuration, dressed as a live reading. It is also
 * the gap PLAN.md §Phase 3 names as the sharpest edge in the whole system: a plugin or a connected
 * app polling too hard gets **the user** rate-limited or moderated, and the user blames vrc.zip. You
 * cannot show them who is eating the budget without measuring who is eating the budget.
 *
 * The shape is a ring of one-second counters per series, ten minutes deep. Counters rather than
 * timestamps because the answer is always a count over a window, and a ring rather than a growing
 * list because this runs for weeks: a daemon that remembers every request it ever made in order to
 * draw a sparkline has replaced one resource problem with a worse one.
 *
 * **Series are pruned when they go quiet.** A grant that made one request a month ago must not keep
 * 600 slots alive for the life of the process — apps come and go, and the set of keys is not bounded
 * by anything the daemon controls.
 */

/**
 * How far back the history goes. Ten minutes, one bucket per second.
 *
 * Defined in `@vrcz/shared` and re-exported here: the UI sizes its own buffer from the same number,
 * and two declarations that must agree are one declaration that has not drifted *yet*.
 */
export const WINDOW_SECONDS = RATE_WINDOW_SECONDS;

/** The live-total series, which has no id of its own. */
const TOTAL = "total";

/** Re-exported so callers reading a series do not need two imports for one concept. */
export type { RateSeries };

/** An empty answer, for a key that has never been seen. Cheaper than allocating a series for it. */
export function emptySeries(): RateSeries {
  return { current: 0, history: new Array<number>(WINDOW_SECONDS).fill(0), peak: 0, total: 0 };
}

class Series {
  /** Ring of per-second counts, indexed by `second % WINDOW_SECONDS`. */
  readonly buckets = new Int32Array(WINDOW_SECONDS);
  /** The most recent second written to, absolute. */
  lastSecond = 0;
  /** Sum of `buckets`, kept incrementally so pruning does not have to scan. */
  sum = 0;

  /**
   * Rolls the ring forward to `second`, zeroing whatever it passes over.
   *
   * The clamp matters: a series idle for an hour would otherwise loop 3600 times to clear 600
   * slots, and the answer for any gap wider than the window is the same — everything is stale.
   */
  advance(second: number): void {
    if (second <= this.lastSecond) return;
    const steps = Math.min(second - this.lastSecond, WINDOW_SECONDS);
    for (let i = 1; i <= steps; i += 1) {
      const slot = (this.lastSecond + i) % WINDOW_SECONDS;
      this.sum -= this.buckets[slot] ?? 0;
      this.buckets[slot] = 0;
    }
    this.lastSecond = second;
  }
}

export interface RequestMeterOptions {
  /** Overridden in tests, which drive the clock rather than waiting on it. */
  readonly now?: () => number;
}

/** One request, and who to charge it to. */
export interface RequestTags {
  /** The account whose session made it. Null for the anonymous pass-through context. */
  readonly accountId: string | null;
  /** The grant that asked for it, when a third-party app did. */
  readonly grantId?: string | null;
}

export class RequestMeter {
  readonly #series = new Map<string, Series>();
  readonly #now: () => number;

  constructor(options: RequestMeterOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /**
   * Counts one request against the total, its account, and its grant.
   *
   * Called from `vrcFetch` and nowhere else, for the same reason the limiter is: that is the one
   * path to VRChat, so "every request is counted" is structural rather than a convention every
   * future call site has to remember. A 429 retry counts again, because it is another request that
   * really went out — a meter that hid retries would under-report exactly when it matters most.
   */
  record(tags: RequestTags): void {
    const second = Math.floor(this.#now() / 1000);
    this.#bump(TOTAL, second);
    if (tags.accountId !== null) this.#bump(accountKey(tags.accountId), second);
    if (tags.grantId !== null && tags.grantId !== undefined) {
      this.#bump(grantKey(tags.grantId), second);
    }
  }

  /** Everything the daemon is spending, across every account. */
  total(): RateSeries {
    return this.#read(TOTAL);
  }

  account(accountId: string): RateSeries {
    return this.#read(accountKey(accountId));
  }

  grant(grantId: string): RateSeries {
    return this.#read(grantKey(grantId));
  }

  /** The last complete second only, which is what the live stream frame carries. */
  currentTotal(): number {
    return this.#currentOf(TOTAL);
  }

  currentAccount(accountId: string): number {
    return this.#currentOf(accountKey(accountId));
  }

  currentGrant(grantId: string): number {
    return this.#currentOf(grantKey(grantId));
  }

  /**
   * Drops series that have been silent for the whole window.
   *
   * Called on a timer rather than on read, because the read path runs once per second per connected
   * client and the prune walks every key. Nothing breaks if it never runs; the memory just does not
   * come back.
   */
  prune(): number {
    const second = Math.floor(this.#now() / 1000);
    let dropped = 0;
    for (const [key, series] of this.#series) {
      series.advance(second);
      if (series.sum === 0) {
        this.#series.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** How many series are being kept. Diagnostics only. */
  get seriesCount(): number {
    return this.#series.size;
  }

  #bump(key: string, second: number): void {
    let series = this.#series.get(key);
    if (series === undefined) {
      series = new Series();
      series.lastSecond = second;
      this.#series.set(key, series);
    }
    series.advance(second);
    const slot = second % WINDOW_SECONDS;
    series.buckets[slot] = (series.buckets[slot] ?? 0) + 1;
    series.sum += 1;
  }

  #currentOf(key: string): number {
    const series = this.#series.get(key);
    if (series === undefined) return 0;
    const second = Math.floor(this.#now() / 1000);
    series.advance(second);
    // The second in progress is partial; the one before it is the last complete reading.
    return series.buckets[(second - 1 + WINDOW_SECONDS) % WINDOW_SECONDS] ?? 0;
  }

  #read(key: string): RateSeries {
    const series = this.#series.get(key);
    if (series === undefined) return emptySeries();

    const second = Math.floor(this.#now() / 1000);
    series.advance(second);

    // Oldest first, ending on the last complete second — the same reading `current` reports, so a
    // sparkline and the number beside it never disagree.
    const history = new Array<number>(WINDOW_SECONDS);
    let peak = 0;
    let total = 0;
    for (let i = 0; i < WINDOW_SECONDS; i += 1) {
      const at = second - WINDOW_SECONDS + i;
      const value =
        at < 0
          ? 0
          : (series.buckets[((at % WINDOW_SECONDS) + WINDOW_SECONDS) % WINDOW_SECONDS] ?? 0);
      history[i] = value;
      if (value > peak) peak = value;
      total += value;
    }

    return {
      current: history[WINDOW_SECONDS - 1] ?? 0,
      history,
      peak,
      total,
    };
  }
}

function accountKey(accountId: string): string {
  return `a:${accountId}`;
}

function grantKey(grantId: string): string {
  return `g:${grantId}`;
}
