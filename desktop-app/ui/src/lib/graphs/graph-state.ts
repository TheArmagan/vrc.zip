/**
 * What state a graph is in, as one answer instead of three switches read together.
 *
 * The list used to say this by omission: a `Rehearsing` badge appeared for one of the four states
 * and the other three were "work it out from the two toggles below". Off and armed looked identical
 * at a glance, which is the one pair that must not — one of them is sending real invites.
 *
 * The order below is the order the checks run in, and it is deliberate. `disabledReason` wins over
 * everything: a graph the daemon switched off is not "off", it is *stopped*, and the difference is
 * whether somebody chose it.
 */

import type { GraphSummary } from "$lib/api.ts";

export type GraphStateKind = "stopped" | "off" | "rehearsing" | "armed";

export interface GraphState {
  readonly kind: GraphStateKind;
  /** Shown beside the dot. Short enough to sit in a meta row. */
  readonly label: string;
  /** A CSS colour, for the rail and the dot. */
  readonly color: string;
  /** The sentence under it, when there is room. Empty when the label says everything. */
  readonly detail: string;
}

export function graphState(graph: GraphSummary): GraphState {
  if (graph.disabledReason !== null) {
    return {
      kind: "stopped",
      label: "Stopped",
      color: "var(--destructive)",
      // The daemon's own words. It is the only one of the four that carries a reason, and burying
      // that reason behind a hover was how a graph stayed off for a week without anybody knowing.
      detail: graph.disabledReason,
    };
  }
  if (!graph.enabled) {
    return { kind: "off", label: "Off", color: "var(--muted-foreground)", detail: "" };
  }
  if (!graph.armed) {
    return {
      kind: "rehearsing",
      label: "Rehearsing",
      color: "var(--warning)",
      detail: "Runs, but nothing it sends leaves this machine.",
    };
  }
  return { kind: "armed", label: "Armed", color: "var(--success)", detail: "" };
}

/**
 * What a graph watches for, in the words of the palette.
 *
 * Type ids arrive on the summary and the titles come from the catalogue the client already holds —
 * see `triggerTypes` in `@vrcz/shared` for why the daemon does not resolve them itself. A type this
 * build has never heard of falls back to the half of the id after the slash, which is a worse name
 * than its title and a much better one than nothing.
 *
 * Deduplicated, because two `When a friend comes online` triggers on one canvas is a normal thing to
 * build and "a friend comes online, a friend comes online" is not a sentence.
 */
export function watchesFor(
  triggerTypes: readonly string[],
  titleOf: (type: string) => string | null,
): string[] {
  const seen = new Set<string>();
  for (const type of triggerTypes) {
    seen.add(titleOf(type) ?? type.slice(type.indexOf("/") + 1));
  }
  return [...seen];
}
