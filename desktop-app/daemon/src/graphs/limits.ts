/**
 * The three ceilings, and the counters behind them.
 *
 * An explosion can start in three places and each needs its own bound (PLAN.md §Phase 4, decision
 * 206). The existing rate limiter was explicitly **not** accepted as cover for this: it guards the
 * VRChat direction and says nothing about webhooks, UDP, or a `foreach` expanding without bound.
 *
 * - **Fire rate**, per trigger instance. `maxFiresPerMinute` has been a declared field on
 *   `TriggerNodeDefinition` since 3.10 and enforced nowhere; this is where it starts meaning
 *   something.
 * - **Run size**, per run. The bound on how far one fire can expand.
 * - **Runs per hour**, per graph. The bound on sustained volume, and the only one whose response is
 *   to switch the graph off — the other two drop or fail a single run, which a graph can recover
 *   from on the next fire. A graph running two hundred times an hour is not recovering.
 *
 * The counters are in memory rather than in SQLite on purpose: they are rate windows, not history,
 * and a restart resetting them is correct. What a restart must *not* reset is the graph that was
 * disabled for hitting one, which is why that outcome is a column and an event.
 */

export interface GraphLimits {
  /** Fires per minute for a trigger whose definition does not name its own. */
  readonly defaultFiresPerMinute: number;
  /** Nodes one run may execute. `foreach` expansion counts against it. */
  readonly maxNodesPerRun: number;
  /**
   * Items one `foreach` may run over.
   *
   * Separate from the run ceiling because it catches the case that one cannot: a loop with an empty
   * body executes no nodes, so a list of a million would spin without the run ever growing.
   */
  readonly maxForeachItems: number;
  /** Runs one graph may start per hour before it is switched off. */
  readonly maxRunsPerHour: number;
  /** Live runs one `parallel` graph may hold at once. */
  readonly maxParallelRuns: number;
  /** Fires one `queue` graph may hold waiting for a slot. */
  readonly maxQueuedRuns: number;
}

export const DEFAULT_GRAPH_LIMITS: GraphLimits = {
  defaultFiresPerMinute: 120,
  maxNodesPerRun: 500,
  maxForeachItems: 1_000,
  maxRunsPerHour: 200,
  maxParallelRuns: 4,
  maxQueuedRuns: 32,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * A sliding window of timestamps per key.
 *
 * Timestamps rather than a bucket count, because the question is "how many in the last minute", and
 * a fixed bucket answers "how many since the last reset" — which lets twice the ceiling through at
 * a bucket boundary. Pruned on read, so an idle key costs nothing to keep.
 */
export class SlidingWindow {
  readonly #windowMs: number;
  readonly #hits = new Map<string, number[]>();

  constructor(windowMs: number) {
    this.#windowMs = windowMs;
  }

  /** Records a hit and answers how many are in the window, including this one. */
  hit(key: string, now: number): number {
    const kept = this.#prune(key, now);
    kept.push(now);
    this.#hits.set(key, kept);
    return kept.length;
  }

  count(key: string, now: number): number {
    return this.#prune(key, now).length;
  }

  forget(key: string): void {
    this.#hits.delete(key);
  }

  clear(): void {
    this.#hits.clear();
  }

  #prune(key: string, now: number): number[] {
    const cutoff = now - this.#windowMs;
    const kept = (this.#hits.get(key) ?? []).filter((ts) => ts > cutoff);
    this.#hits.set(key, kept);
    return kept;
  }
}

/** The two rate windows an engine keeps. Grouped so a test can reset both in one call. */
export class GraphCounters {
  readonly fires = new SlidingWindow(MINUTE_MS);
  readonly runs = new SlidingWindow(HOUR_MS);

  clear(): void {
    this.fires.clear();
    this.runs.clear();
  }
}
