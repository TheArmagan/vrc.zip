/**
 * The recording of a graph's last few runs, and the three things the editor reads out of it.
 *
 * One fetch feeds all three, which is why they are one module:
 *
 *  - **the run log**, a list of runs with their steps,
 *  - **the wire peek**, the value that was on an edge the last time anything flowed down it,
 *  - **the canvas markers**, the ring around the node that failed and the fade on the ones that
 *    never ran.
 *
 * ## Why this is a fetch and not a poll
 *
 * `graph-run.svelte.ts` polls, and it should: it answers "where is it right now", which changes
 * twice a second. A trace answers "what did it do", which changes exactly once per run — so this
 * refreshes when a run count drops, when the editor says so, and never on a timer. An idle canvas
 * with the debugger on costs nothing here.
 *
 * ## Why the selected run is an index rather than a copy
 *
 * A refresh replaces the list, and a held copy would go stale the moment the run it describes
 * scrolled off the end of the ten the daemon keeps. Holding the **id** and resolving it every time
 * means a run that has aged out simply falls back to the newest one, which is what somebody
 * scrubbing through a log wants anyway.
 */

import type { GraphTrace, GraphTraceStep } from "@vrcz/shared";
import { api, describeError } from "$lib/api.ts";

/** The marker that a value was too big to keep whole. Mirrors `daemon/src/graphs/trace.ts`. */
export const TRUNCATED = "__vrczTruncated";

export interface TruncatedValue {
  readonly [TRUNCATED]: true;
  readonly preview: string;
  readonly length: number;
}

export function isTruncated(value: unknown): value is TruncatedValue {
  return typeof value === "object" && value !== null && TRUNCATED in value;
}

class GraphTracesState {
  traces = $state.raw<GraphTrace[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  /** Which run the canvas and the inspector are showing. Null means "the newest one there is". */
  selectedRunId = $state<string | null>(null);

  #graphId: string | null = null;
  #generation = 0;

  /** The run everything on screen is reading. Null when nothing has been recorded yet. */
  get selected(): GraphTrace | null {
    const chosen = this.traces.find((trace) => trace.runId === this.selectedRunId);
    return chosen ?? this.traces[0] ?? null;
  }

  /** What each node did in the selected run, by node id. The canvas's whole source of truth. */
  get steps(): Map<string, GraphTraceStep> {
    const map = new Map<string, GraphTraceStep>();
    // Last wins. A node inside a `For each` has one step per iteration, and the one worth drawing
    // on the card is the most recent — which is also the one that explains where the loop stopped.
    for (const step of this.selected?.steps ?? []) map.set(step.nodeId, step);
    return map;
  }

  /**
   * The value that came out of one port in the selected run, for the edge peek.
   *
   * A port with no entry is not "null" — it is the missing key the whole runtime gates on, and the
   * edge below it was dead. `undefined` here means exactly that, and the editor draws it as such.
   */
  output(nodeId: string, port: string): unknown {
    const outputs = this.steps.get(nodeId)?.outputs;
    if (outputs === undefined || !(port in outputs)) return undefined;
    return outputs[port];
  }

  /** Switches graphs, dropping whatever was held for the last one. */
  watch(graphId: string): void {
    if (this.#graphId === graphId) return;
    this.#graphId = graphId;
    this.traces = [];
    this.selectedRunId = null;
    this.error = null;
    void this.refresh();
  }

  stop(): void {
    this.#graphId = null;
    this.traces = [];
    this.selectedRunId = null;
    this.error = null;
    this.loading = false;
  }

  /**
   * Re-reads the recording.
   *
   * A generation counter rather than an abort, the same choice `graphs.svelte.ts` makes and for the
   * same reason: two overlapping reads are the ordinary result of a run finishing while somebody
   * pressed Refresh, and the loser has to be ignored rather than torn down.
   */
  async refresh(): Promise<void> {
    const graphId = this.#graphId;
    if (graphId === null) return;
    const generation = ++this.#generation;
    this.loading = true;
    try {
      const traces = await api.graphs.traces(graphId);
      if (generation !== this.#generation || this.#graphId !== graphId) return;
      this.traces = traces;
      this.error = null;
    } catch (cause) {
      if (generation !== this.#generation) return;
      this.error = describeError(cause);
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  async clear(): Promise<void> {
    const graphId = this.#graphId;
    if (graphId === null) return;
    try {
      await api.graphs.clearTraces(graphId);
      this.traces = [];
      this.selectedRunId = null;
    } catch (cause) {
      this.error = describeError(cause);
    }
  }
}

/**
 * One value, as a line of text on a card or in a tooltip.
 *
 * Short on purpose: this is what a wire is labelled with, and a label that wraps to three lines is
 * one nobody reads. The inspector shows the whole thing.
 */
export function previewValue(value: unknown, max = 48): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (isTruncated(value)) return `${clip(value.preview, max)} (${String(value.length)} chars)`;
  if (typeof value === "string") return value === "" ? '""' : clip(value, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
  return clip(JSON.stringify(value) ?? "{}", max);
}

function clip(text: string, max: number): string {
  // Three periods, typed. See the house rule about characters a keyboard produces.
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

export const graphTraces = new GraphTracesState();
