/**
 * Where the graph on screen currently is, while it is running.
 *
 * ## Why this polls, and why only while you are looking
 *
 * The daemon rewrites `graph_runs.state` at every node boundary, which already records the node a
 * run last executed and which item each `For each` is on. So the live readout costs one GET against
 * a row that was being written anyway — and when nothing is on screen, it costs nothing at all,
 * because the polling starts with `watch()` and stops with `stop()`.
 *
 * The alternative was a control-stream message per node, or per iteration. Both put traffic on the
 * bus for every run of every enabled graph whether or not a canvas exists to read it, and the bus is
 * the spine: a subscriber that is slow because it is decoding progress nobody asked for is a
 * subscriber that slows the pipeline reader. Progress is not an event. It is the answer to a
 * question, and it is only a question while somebody is asking.
 *
 * ## Why it is a singleton
 *
 * `graphs.svelte.ts` says the editor's *document* must not be — two open canvases would share one
 * draft. This is the opposite kind of state: it is a fact about the daemon rather than an edit, so
 * two viewers of one graph want the same answer and there is nothing to lose by sharing it. One
 * graph is watched at a time; `watch()` on a second replaces the first rather than running two
 * pollers, which is what a single-window app actually does when you navigate.
 */

import type { GraphRunSummary } from "@vrcz/shared";
import { SvelteMap } from "svelte/reactivity";
import { api } from "$lib/api.ts";

/**
 * How often to ask. Fast enough that a loop over a few dozen items visibly ticks, slow enough that
 * an idle editor is two requests a second against a local SQLite read.
 */
const INTERVAL_MS = 500;

class GraphRunState {
  /** Runs in flight for the watched graph, newest first. Empty when nothing is running. */
  runs = $state<GraphRunSummary[]>([]);
  /** Every loop currently iterating, by its node id. A `SvelteMap` so a card can read it live. */
  loops = new SvelteMap<string, { at: number; of: number }>();
  /** The node each in-flight run last executed. A set because a graph may run in parallel. */
  active = new SvelteMap<string, true>();

  #graphId: string | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  /**
   * The graph a poll is outstanding for, rather than a bare "a poll is outstanding".
   *
   * The distinction is what makes switching graphs immediate. This was a boolean, and `watch` calls
   * `stop()` and then `refresh()` — so arriving on a second canvas while the first one's poll was
   * still in the air made that first refresh a no-op, and the new graph's readout stayed blank for a
   * whole tick. Overlap is still refused *per graph*, which is the thing that actually matters: two
   * answers about the same run can arrive out of order and rewind the position.
   */
  #pollingFor: string | null = null;

  /** True when anything at all is running, which is what decides whether the canvas dims. */
  get running(): boolean {
    return this.runs.length > 0;
  }

  /**
   * Starts watching one graph, replacing whatever was being watched.
   *
   * Idempotent for the same id, because the caller is an `$effect` that re-runs whenever anything
   * it read changed — restarting the timer on every unrelated change would mean the poll never
   * actually fired on a busy canvas.
   */
  watch(graphId: string): void {
    if (this.#graphId === graphId && this.#timer !== undefined) return;
    this.stop();
    this.#graphId = graphId;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#graphId = null;
    this.runs = [];
    this.loops.clear();
    this.active.clear();
  }

  /**
   * One poll.
   *
   * Overlapping requests are dropped rather than queued: the answer is a position, so a late reply
   * arriving after a newer one would rewind the readout. A failure is silent for the same reason a
   * missing position is — the daemon being briefly unreachable is not something to put a red box on
   * a canvas about, and the next tick is 500ms away.
   */
  async refresh(): Promise<void> {
    const graphId = this.#graphId;
    if (graphId === null || this.#pollingFor === graphId) return;
    this.#pollingFor = graphId;
    try {
      const runs = await api.graphs.runs(graphId);
      if (this.#graphId !== graphId) return;
      this.runs = runs;
      sync(
        this.loops,
        runs.flatMap((run) =>
          run.loops.map((loop) => [loop.nodeId, { at: loop.at, of: loop.of }] as const),
        ),
      );
      sync(
        this.active,
        runs.flatMap((run) => (run.currentNode === null ? [] : [[run.currentNode, true] as const])),
      );
    } catch {
      // Deliberately silent. See above.
    } finally {
      // Only if it is still ours. A poll left over from the previous graph must not clear the flag
      // belonging to the one that replaced it.
      if (this.#pollingFor === graphId) this.#pollingFor = null;
    }
  }
}

/**
 * Rewrites a map in place to hold exactly `entries`.
 *
 * In place rather than `clear()` then fill, because clearing is a structural change every reader of
 * the map sees: a card watching one key would flicker to "not running" and back on every single
 * poll, twice a second, for the whole length of a run.
 */
function sync<V>(map: SvelteMap<string, V>, entries: readonly (readonly [string, V])[]): void {
  const next = new Map(entries);
  for (const key of [...map.keys()]) if (!next.has(key)) map.delete(key);
  for (const [key, value] of next) {
    if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) map.set(key, value);
  }
}

export const graphRun = new GraphRunState();
