/**
 * Request rate, live.
 *
 * Two sources feed one picture, and the split is the whole design:
 *
 *  - **The REST payload seeds it.** `/api/status`, `/api/accounts` and `/api/apps` each carry ten
 *    minutes of one-second buckets for their series. That is the history, fetched once with the
 *    card it belongs to.
 *  - **The `rate` frame extends it.** Once a second, the daemon sends only the newest value per
 *    series, and this appends. Re-sending the whole window every second would be two kilobytes per
 *    series to say one number changed, and the client already has the rest.
 *
 * **Every known series advances on every frame**, including the ones the frame does not mention.
 * The daemon omits zero-valued keys deliberately — an idle daemon with ten series would otherwise
 * send ten zeroes a second forever — so a missing key means zero, and a series that only advanced
 * when it was mentioned would freeze at its last busy value and read as permanently saturated.
 */

import { RATE_WINDOW_SECONDS, type RateFrame, type RateSeries } from "@vrcz/shared";
import { SvelteMap } from "svelte/reactivity";

/** Ten minutes of one-second buckets. The daemon fills exactly this many. */
export const WINDOW_SECONDS = RATE_WINDOW_SECONDS;

/** A series the UI can draw: oldest first, always exactly `WINDOW_SECONDS` long. */
function seed(series: RateSeries | undefined): number[] {
  const history = series?.history ?? [];
  const out = new Array<number>(WINDOW_SECONDS).fill(0);
  // Right-aligned: the newest value is always the last slot, whatever length arrived.
  const take = Math.min(history.length, WINDOW_SECONDS);
  for (let i = 0; i < take; i += 1) {
    out[WINDOW_SECONDS - take + i] = history[history.length - take + i] ?? 0;
  }
  return out;
}

function push(into: number[], value: number): number[] {
  const next = into.slice(1);
  next.push(value);
  return next;
}

class RatesState {
  /** Everything the daemon is spending, across every account. */
  total = $state<number[]>(seed(undefined));
  /** The IP-wide ceiling. A constant off the daemon's configuration, not a measurement. */
  limit = $state(0);
  /** Unix ms at which a 429 backoff lifts, or null. */
  retryAfter = $state<number | null>(null);

  /**
   * `SvelteMap` so adding or removing a series is reactive. The arrays inside are replaced rather
   * than mutated on every append, which is what makes a component reading one of them re-render —
   * a reactive map says nothing about the objects it holds.
   */
  readonly #accounts = new SvelteMap<string, number[]>();
  readonly #grants = new SvelteMap<string, number[]>();

  /** The last complete second, across everything. What the shell shows beside the limit. */
  get current(): number {
    return this.total[this.total.length - 1] ?? 0;
  }

  /** The busiest single second in the window, so a sparkline has something to scale to. */
  get peak(): number {
    let peak = 0;
    for (const value of this.total) if (value > peak) peak = value;
    return peak;
  }

  account(id: string): number[] {
    return this.#accounts.get(id) ?? seed(undefined);
  }

  grant(id: string): number[] {
    return this.#grants.get(id) ?? seed(undefined);
  }

  /** Seeds the total from `/api/status`. */
  seedTotal(series: RateSeries, limit: number, retryAfter: number | null): void {
    this.total = seed(series);
    this.limit = limit;
    this.retryAfter = retryAfter;
  }

  seedAccount(id: string, series: RateSeries): void {
    this.#accounts.set(id, seed(series));
  }

  seedGrant(id: string, series: RateSeries): void {
    this.#grants.set(id, seed(series));
  }

  /** Forgets a series. Called when a grant is revoked, so its history does not outlive it. */
  forgetGrant(id: string): void {
    this.#grants.delete(id);
  }

  /** One second's worth of readings, from the live socket. */
  apply(frame: RateFrame): void {
    this.total = push(this.total, frame.total);
    this.limit = frame.limit;
    this.retryAfter = frame.retryAfter;

    // Every known series, not only the mentioned ones — see the module comment.
    for (const [id, history] of this.#accounts) {
      this.#accounts.set(id, push(history, frame.accounts[id] ?? 0));
    }
    for (const [id, history] of this.#grants) {
      this.#grants.set(id, push(history, frame.grants[id] ?? 0));
    }
  }
}

export const rates = new RatesState();
