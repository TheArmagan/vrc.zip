/**
 * Turning a run into something a person can read afterwards.
 *
 * The engine's `RunState` already holds everything that flowed through a graph — that is how the
 * walk gates on a missing key — so a trace is not new bookkeeping so much as a decision to keep a
 * copy of what was there anyway. What this module owns is the *shrinking*: a port can carry a
 * whole VRChat user object or a friends list, and a recording of forty of those per run, ten runs
 * deep, is a debugging feature that costs more disk than the app it is debugging.
 *
 * Three rules, all of them lossy on purpose:
 *
 *  1. **A value is summarised, never stored whole.** Past `GRAPH_TRACE_VALUE_LIMIT` characters of
 *     JSON it is cut and the cut is *visible* — see {@link TRUNCATED}. A trace that silently showed
 *     you the first 512 characters of a body would be worse than no trace, because you would read
 *     it as the whole answer.
 *  2. **A step count is bounded.** A `For each` over a thousand items is not read step by step, and
 *     the earliest steps are the ones that explain the run.
 *  3. **Nothing here throws.** It runs inside the settle path of a run that is otherwise finishing
 *     correctly, and a circular object in somebody's node output must not be able to take that
 *     down. Anything `JSON.stringify` refuses comes back as a description of itself.
 */

import type { PortValues } from "@vrcz/plugin-api/nodes";
import { GRAPH_TRACE_STEP_LIMIT, GRAPH_TRACE_VALUE_LIMIT, type GraphTraceStep } from "@vrcz/shared";

/**
 * What a cut value looks like.
 *
 * A marked object rather than a truncated string, so the editor can render "…" as a state rather
 * than leaving somebody to wonder whether the value really did end mid-word.
 */
export const TRUNCATED = "__vrczTruncated";

export interface TruncatedValue {
  readonly [TRUNCATED]: true;
  /** As much as fits, as JSON text. Deliberately text: it is no longer the value, it is a look. */
  readonly preview: string;
  /** How long the whole thing was, in JSON characters. The number that says how much you lost. */
  readonly length: number;
}

/**
 * One port value, small enough to keep.
 *
 * Primitives pass through untouched, which covers most of what a graph actually carries: ids,
 * counts, flags and short strings all survive verbatim, and those are the values somebody is
 * usually squinting at a wire trying to see.
 */
export function summariseValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    return value.length <= GRAPH_TRACE_VALUE_LIMIT
      ? value
      : cut(value.slice(0, GRAPH_TRACE_VALUE_LIMIT), value.length);
  }

  const json = stringify(value);
  if (json === null) return "[unreadable]";
  if (json.length <= GRAPH_TRACE_VALUE_LIMIT) {
    // Re-parsed rather than handed back as text, so the editor gets a real object to expand. The
    // round trip is also what strips anything that survived `stringify` in a shape we cannot keep.
    try {
      return JSON.parse(json) as unknown;
    } catch {
      return "[unreadable]";
    }
  }
  return cut(json.slice(0, GRAPH_TRACE_VALUE_LIMIT), json.length);
}

/** Every port of one node, summarised. `undefined` entries are dropped, not recorded as null. */
export function summarisePorts(values: PortValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [port, value] of Object.entries(values)) {
    if (value === undefined) continue;
    out[port] = summariseValue(value);
  }
  return out;
}

/**
 * Appends a step, if this run is being traced and there is room.
 *
 * Room rather than a rolling window: the *first* three hundred steps are what explain a run, and a
 * window would keep the tail of a runaway loop and throw away the trigger that started it.
 */
export function pushStep(trace: GraphTraceStep[] | undefined, step: GraphTraceStep): void {
  if (trace === undefined || trace.length >= GRAPH_TRACE_STEP_LIMIT) return;
  trace.push(step);
}

function cut(preview: string, length: number): TruncatedValue {
  return { [TRUNCATED]: true, preview, length };
}

/** `JSON.stringify` that answers null instead of throwing on a cycle or a BigInt. */
function stringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
