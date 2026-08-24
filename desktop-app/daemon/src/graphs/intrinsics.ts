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

import { type NodeDefinition, RESERVED_NODE_NAMESPACE } from "@vrcz/plugin-api/nodes";

/**
 * The namespace the daemon registers its own node types under. Not available to plugins.
 *
 * Declared in `@vrcz/plugin-api` beside the qualified-id convention it reserves, and re-exported
 * here so the graph runtime has one name for it. `NodeRegistry.register` is where a plugin is
 * refused for claiming it.
 */
export const BUILTIN_NAMESPACE = RESERVED_NODE_NAMESPACE;

export const WAIT_TYPE = `${BUILTIN_NAMESPACE}/wait`;
export const BRANCH_TYPE = `${BUILTIN_NAMESPACE}/branch`;
export const FOREACH_TYPE = `${BUILTIN_NAMESPACE}/foreach`;
export const COLLECT_TYPE = `${BUILTIN_NAMESPACE}/collect`;
export const STOP_WHEN_TYPE = `${BUILTIN_NAMESPACE}/stop-when`;

/**
 * The manual trigger's type id.
 *
 * Named here rather than in `builtins/triggers.ts` because the control API has to find it in a saved
 * document to answer `POST /api/graphs/:id/run`, and a route reaching into the built-in node set for
 * a string is a route that breaks quietly when the set is rearranged.
 */
export const RUN_NOW_TYPE = `${BUILTIN_NAMESPACE}/run-now`;

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

/**
 * How long a `Wait` waits when its document does not say.
 *
 * Named rather than written twice, because the engine has to apply it too: a config `default` is
 * only ever applied by the editor when a node is created, so a document that arrived by import or
 * by hand can perfectly well reach the engine with no `durationMs` at all. Reading that as `0` —
 * which is what the engine did — parked the run with `resumeAt = now` and continued it on the very
 * next sweep, so a `Wait` in an imported graph did not wait.
 */
export const DEFAULT_WAIT_MS = 60_000;

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
      default: DEFAULT_WAIT_MS,
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

/**
 * Iteration, and the reason its outputs are not interchangeable.
 *
 * `item` and `index` are the loop body: whatever they reach runs once per element. `done` and
 * `results` are what happens **after**, and the engine uses that split to work out which nodes
 * belong to the body at all — the body is what `item` reaches minus what `done` reaches. So a node
 * wired to `done` is after the loop by construction rather than by a flag somebody has to set.
 * `foreachBodies` in `@vrcz/shared` is that subtraction, and the canvas draws the loop's tinted
 * region from the same function so the boundary on screen is the one the engine walks.
 *
 * `results` is what a `vrcz/collect` in the body appended, in order. It is `list<json>` and it is
 * always produced — an empty list when nothing collected — because a loop that ran zero times has
 * still finished, and gating the after-the-loop branch on whether anything was collected would make
 * "no friends online" look identical to "the loop never ran".
 *
 * `list` is `json` rather than a list type because `list<T>` joins the lattice in 4.3. A value that
 * is not an array iterates zero times, which is the same thing an empty list does.
 *
 * **`delayMs` paces the loop, and it is not a `Wait`.** A `Wait` inside a body is refused because
 * parking mid-iteration would mean persisting which item the loop was on and everything it had
 * accumulated, and a resume would have to reconstruct a scope rather than a node. This waits in
 * process instead: nothing is persisted, nothing has to survive a restart, and a daemon that stops
 * mid-loop simply loses the run the way it loses any other running one. That is what makes it
 * expressible when the durable version is not — and it is the answer to the real question behind
 * "why can I not put a Wait in here", which is almost always "I am sending forty invites and VRChat
 * is counting". The total is bounded; see `GraphLimits.maxForeachDelayMs`.
 */
const FOREACH_DEFINITION: NodeDefinition = {
  id: "foreach",
  kind: "action",
  title: "For each",
  description: "Runs everything below Item once per element, in order.",
  category: "Control",
  // `list<json>`, not `json`: every typed list widens to it, so a producer of `list<friend>` wires
  // straight in, and a raw `json` needs the explicit `vrcz/as-list` step. That conversion being
  // visible on the canvas is the point — a lattice that let `json` in here would check nothing.
  inputs: [{ id: "list", label: "List", type: "list<json>", required: true }],
  outputs: [
    { id: "item", label: "Item", type: "json" },
    { id: "index", label: "Index", type: "number" },
    // Named `Done` rather than `After`, which is what it said until the canvas grew an implicit
    // `after` **input** on every node. One word for two opposite things — "everything downstream of
    // this ran" and "do not run until that one has" — on the same screen is a collision, not a
    // synonym. The port id is unchanged, so no saved edge moves.
    { id: "done", label: "Done", type: "number", description: "How many items ran." },
    {
      id: "results",
      label: "Results",
      type: "list<json>",
      description: "What each Collect in the body appended, in order.",
    },
  ],
  config: [
    {
      // `number` rather than `duration`, to match the `Wait` node beside it in the palette: both
      // store integer ms, the editor draws them identically, and one of the two spelling it
      // differently is a difference that means nothing.
      kind: "number",
      id: "delayMs",
      label: "Wait between items (ms)",
      description:
        "Paced, not parked. Leave it at zero unless the body sends something VRChat counts.",
      min: 0,
      default: 0,
    },
  ],
  body: [
    { kind: "literal", text: "For each item in " },
    { kind: "port", port: "list" },
  ],
};

/**
 * The loop's way of producing something, rather than only causing something.
 *
 * A `foreach` on its own is side effects: it invites, it posts, it writes. Anything it *worked out*
 * died with the iteration, because the next one clears the body. `Collect` is where an author says
 * which value survives — it appends whatever is wired into it to the enclosing loop's `results`,
 * once per iteration.
 *
 * **The enclosing loop is the innermost one it is drawn in**, which is the scoping every language
 * gives a `break` and the only one that needs no explaining. A `Collect` drawn outside every loop
 * fails the run with a sentence rather than quietly collecting into nothing.
 *
 * It passes its value straight out again so it can sit mid-chain instead of only at the end.
 */
const COLLECT_DEFINITION: NodeDefinition = {
  id: "collect",
  kind: "action",
  title: "Collect",
  description: "Adds a value to the enclosing For each's Results, once per item.",
  category: "Control",
  inputs: [{ id: "value", label: "Value", type: "json", required: true }],
  outputs: [{ id: "out", label: "Out", type: "json", description: "The same value, passed on." }],
  body: [
    { kind: "literal", text: "Collect " },
    { kind: "port", port: "value" },
  ],
};

/**
 * Ending a loop early, and why the current item still finishes.
 *
 * Stopping mid-item would mean abandoning a scope halfway through, and the walk has never had to do
 * that: it runs a scope until nothing in it is ready, which is the same loop that drains the outer
 * run. So a true `when` records "no more items after this one" and the rest of the body runs as
 * drawn. That is also the honest behaviour for a body that has already sent an invite — a `break`
 * that skipped the note explaining the invite would be worse than one that did not.
 *
 * `Done` and `Results` still fire, carrying the count and the values from the items that ran.
 */
const STOP_WHEN_DEFINITION: NodeDefinition = {
  id: "stop-when",
  kind: "action",
  title: "Stop when",
  description: "Ends the enclosing For each after this item. The rest of this item still runs.",
  category: "Control",
  inputs: [{ id: "when", label: "When", type: "boolean", required: true }],
  outputs: [
    { id: "out", label: "Out", type: "boolean", description: "The same answer, passed on." },
  ],
  body: [
    { kind: "literal", text: "Stop when " },
    { kind: "port", port: "when" },
  ],
};

/** Every intrinsic, by qualified type id. */
export const INTRINSIC_DEFINITIONS: ReadonlyMap<string, NodeDefinition> = new Map([
  [WAIT_TYPE, WAIT_DEFINITION],
  [BRANCH_TYPE, BRANCH_DEFINITION],
  [FOREACH_TYPE, FOREACH_DEFINITION],
  [COLLECT_TYPE, COLLECT_DEFINITION],
  [STOP_WHEN_TYPE, STOP_WHEN_DEFINITION],
]);

export function isIntrinsic(type: string): boolean {
  return INTRINSIC_DEFINITIONS.has(type);
}
