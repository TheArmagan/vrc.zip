/**
 * Control-flow nodes, which the engine executes itself rather than dispatching.
 *
 * `NodeDefinition` has exactly three kinds — trigger, condition, action — and that is right for
 * everything a node *does*. Waiting and branching are not things a node does; they are things that
 * happen to a **run**. A `wait` that was an ordinary action would have to block inside a handler,
 * which is precisely what parking exists to avoid, and a `branch` would have to be able to tell the
 * engine which of its outputs to consider unproduced.
 *
 * So these are intrinsics: reserved type ids the engine recognises structurally. They still carry
 * real {@link NodeDefinition}s, because the editor's palette, `checkEdge` and the body template all
 * read the same object as every other node — being special to the engine does not make them special
 * to the canvas.
 *
 * They live in the reserved namespace, which is also where 4.3's built-ins register. Nothing
 * enforces that a plugin cannot claim it yet; the registry's qualified ids are `<pluginId>/<nodeId>`
 * and no plugin id may be the reserved word, which is the check 4.3 owes.
 */

import type { NodeDefinition } from "@vrcz/plugin-api/nodes";

/** The namespace the daemon registers its own node types under. Not available to plugins. */
export const BUILTIN_NAMESPACE = "vrcz";

export const WAIT_TYPE = `${BUILTIN_NAMESPACE}/wait`;
export const BRANCH_TYPE = `${BUILTIN_NAMESPACE}/branch`;

/**
 * The port every node implicitly has on its output side.
 *
 * It is produced **only** when the node throws, which is what makes "route the failure onward" work
 * with no special case in the walk: an error port with no outgoing edge means the run aborts, and
 * one with an edge means everything downstream of it runs while the node's real outputs stay
 * unproduced and their branches skip. Reserved, so a definition may not declare a port called
 * `error` — 4.3 is where `validateNodeDefinition` starts refusing it.
 */
export const ERROR_PORT = "error";

/** How a parked run behaves when the daemon was down past its resume time. */
export const WAIT_ON_MISSED = ["resume", "skip"] as const;

export type WaitOnMissed = (typeof WAIT_ON_MISSED)[number];

/**
 * How late a resume may be before it counts as *missed* rather than merely late.
 *
 * A timer that fires a few seconds after its deadline is a busy event loop, not a machine that was
 * asleep. Only past this does the wait node's `onMissed` policy get consulted.
 */
export const MISSED_RESUME_GRACE_MS = 60_000;

const WAIT_DEFINITION: NodeDefinition = {
  id: "wait",
  kind: "action",
  title: "Wait",
  description: "Pauses the run, then continues. The run survives a restart while it waits.",
  category: "Control",
  inputs: [{ id: "in", label: "In", type: "json", description: "Passed through to Out." }],
  outputs: [{ id: "out", label: "Out", type: "json" }],
  config: [
    {
      kind: "number",
      id: "durationMs",
      label: "Wait for (ms)",
      min: 0,
      default: 60_000,
      required: true,
    },
    {
      kind: "select",
      id: "onMissed",
      label: "If the app was closed past this time",
      // The author's choice, and it has to be: a graph that means "when I next start up, do this"
      // and one that means "nudge them in five minutes" want opposite answers to the same question.
      options: [
        { value: "resume", label: "Continue anyway" },
        { value: "skip", label: "Give up on the run" },
      ],
      default: "resume",
    },
  ],
  body: [
    { kind: "literal", text: "Wait " },
    { kind: "config", field: "durationMs" },
    { kind: "literal", text: "ms" },
  ],
};

const BRANCH_DEFINITION: NodeDefinition = {
  id: "branch",
  kind: "action",
  title: "Branch",
  description: "Sends the run down one of two paths.",
  category: "Control",
  inputs: [
    { id: "value", label: "If", type: "boolean", required: true },
    { id: "payload", label: "Carry", type: "json" },
  ],
  outputs: [
    { id: "true", label: "Then", type: "json" },
    { id: "false", label: "Else", type: "json" },
  ],
  body: [
    { kind: "literal", text: "Branch on " },
    { kind: "port", port: "value" },
  ],
};

/** Every intrinsic, by qualified type id. */
export const INTRINSIC_DEFINITIONS: ReadonlyMap<string, NodeDefinition> = new Map([
  [WAIT_TYPE, WAIT_DEFINITION],
  [BRANCH_TYPE, BRANCH_DEFINITION],
]);

export function isIntrinsic(type: string): boolean {
  return INTRINSIC_DEFINITIONS.has(type);
}
