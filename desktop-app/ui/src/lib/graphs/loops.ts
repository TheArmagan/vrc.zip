/**
 * Where a loop's body begins and ends, as far as the canvas is concerned.
 *
 * The engine already answers this — `foreachBodies` in `@vrcz/shared` is the subtraction it walks —
 * so nothing here re-derives it. What this module adds is the two things the daemon has no use for:
 * turning a body into a rectangle to tint, and telling an author *before* they save that a `Wait`
 * inside a `For each` will fail the run.
 *
 * The `Wait` rule is enforced in the engine and always will be; a client is a client. Checking it
 * here as well is not duplication for its own sake — it is the difference between finding out at
 * edit time and finding out at 3 AM when the run that was supposed to fire did not.
 */

import { foreachBodies, type GraphDocument, innermostLoop } from "@vrcz/shared";

/** The intrinsic type ids the canvas has to recognise structurally, same as the engine. */
export const FOREACH_TYPE = "vrcz/foreach";
export const WAIT_TYPE = "vrcz/wait";
/**
 * The manual trigger, which the toolbar's Run now fires.
 *
 * Here with the other structural ids rather than in the editor, for the same reason they are: a type
 * id the client has to recognise *as a shape* is the kind of string that gets copied into four files
 * and then changed in three. It mirrors `RUN_NOW_TYPE` in `daemon/src/graphs/intrinsics.ts`.
 */
export const RUN_NOW_TYPE = "vrcz/run-now";
export const COLLECT_TYPE = "vrcz/collect";
export const STOP_WHEN_TYPE = "vrcz/stop-when";

/** A node as the canvas holds it: enough to find the loops and to measure them. */
export interface CanvasNode {
  readonly id: string;
  readonly type: string;
  readonly position: { readonly x: number; readonly y: number };
  /** Measured by Svelte Flow once the card has rendered. Absent on the first frame. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface CanvasEdge {
  readonly source: string;
  readonly sourceHandle: string | null;
  readonly target: string;
  readonly targetHandle: string | null;
}

/** One loop's body, and the box to draw behind it. */
export interface LoopRegion {
  readonly loopId: string;
  readonly body: ReadonlySet<string>;
  /** How deeply nested, so a loop inside a loop can be tinted a step further. */
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How far the tint extends past the outermost card in the body, in flow units. */
const PADDING = 28;
/** Room at the top for the region's label, which sits above the first card rather than over it. */
const LABEL_ROOM = 22;
/** What a card measures before Svelte Flow has measured it. Matches the card's own width. */
const ASSUMED_WIDTH = 224;
const ASSUMED_HEIGHT = 96;

/**
 * The body of every loop on the canvas, keyed by the loop's node id.
 *
 * A thin wrapper, and it exists so no component has to know that "the loop nodes" means "the nodes
 * whose type is the foreach intrinsic" — which is the kind of string that gets copied into four
 * files and then changed in three.
 */
export function bodiesOf(document: GraphDocument): Map<string, Set<string>> {
  return foreachBodies(
    document,
    document.nodes.filter((node) => node.type === FOREACH_TYPE).map((node) => node.id),
  );
}

/**
 * The document a canvas full of Svelte Flow nodes represents, for the graph helpers in `shared`.
 *
 * Position and config are what a *saved* document carries and neither matters to reachability, so
 * they are filled with zeroes rather than threaded through. The alternative was a second set of
 * reachability helpers that take a different shape, which is the drift this avoids.
 */
export function documentOf(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): GraphDocument {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: { x: 0, y: 0 },
      config: {},
    })),
    edges: edges.map((edge, index) => ({
      id: `e${String(index)}`,
      from: { node: edge.source, port: edge.sourceHandle ?? "" },
      to: { node: edge.target, port: edge.targetHandle ?? "" },
    })),
  };
}

/**
 * A tinted box per loop, in flow coordinates.
 *
 * A loop whose body is empty gets **no** region: a rectangle around nothing is a rectangle around
 * the loop card itself, which reads as "this node is broken" rather than "you have not wired the
 * body yet". Regions are returned outermost first, so a nested one paints on top of its parent and
 * the nesting is visible as a second layer of tint rather than as a fight over z-order.
 */
export function loopRegions(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): LoopRegion[] {
  const bodies = bodiesOf(documentOf(nodes, edges));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const regions: LoopRegion[] = [];

  for (const [loopId, body] of bodies) {
    // The loop card is drawn inside its own region: it is what the region is named after, and a
    // box that starts to the right of the node it belongs to reads as a box around something else.
    const members = [loopId, ...body].flatMap((id) => {
      const node = byId.get(id);
      return node === undefined ? [] : [node];
    });
    if (body.size === 0 || members.length === 0) continue;

    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const node of members) {
      left = Math.min(left, node.position.x);
      top = Math.min(top, node.position.y);
      right = Math.max(right, node.position.x + (node.width ?? ASSUMED_WIDTH));
      bottom = Math.max(bottom, node.position.y + (node.height ?? ASSUMED_HEIGHT));
    }

    regions.push({
      loopId,
      body,
      depth: depthOf(bodies, loopId),
      x: left - PADDING,
      y: top - PADDING - LABEL_ROOM,
      width: right - left + PADDING * 2,
      height: bottom - top + PADDING * 2 + LABEL_ROOM,
    });
  }

  return regions.sort((a, b) => a.depth - b.depth);
}

/** How many loops enclose this one. Zero for a top-level loop. */
function depthOf(bodies: ReadonlyMap<string, ReadonlySet<string>>, loopId: string): number {
  let depth = 0;
  for (const [other, body] of bodies) {
    if (other !== loopId && body.has(loopId)) depth += 1;
  }
  return depth;
}

/** Something the canvas can tell an author about their graph before the daemon has to. */
export interface LoopProblem {
  readonly nodeId: string;
  readonly message: string;
}

/**
 * The loop rules a canvas can check on its own.
 *
 * Three of them, and each is something the engine refuses at run time with a sentence — so this
 * says the same sentence while the graph is still being drawn. Everything else about a loop is
 * either checked on save by the daemon or is not a rule at all.
 *
 * `breakpoints` is which nodes carry one. Passed in rather than read off `CanvasNode`, because a
 * breakpoint lives in the saved document and this shape is the canvas's own reduced view of it —
 * and because the rule only bites for a graph in debug mode, which is a fact about the graph rather
 * than about any node on it. An empty set is the ordinary case and costs nothing.
 */
export function loopProblems(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  breakpoints: ReadonlySet<string> = new Set(),
): LoopProblem[] {
  const bodies = bodiesOf(documentOf(nodes, edges));
  const inABody = new Set([...bodies.values()].flatMap((body) => [...body]));
  const problems: LoopProblem[] = [];

  for (const node of nodes) {
    if (node.type === WAIT_TYPE && inABody.has(node.id)) {
      problems.push({
        nodeId: node.id,
        message: "A Wait cannot be used inside a For each. This run would fail.",
      });
    }
    if (breakpoints.has(node.id) && inABody.has(node.id)) {
      // The same limit as `Wait`, and it has the same cause: parking mid-iteration would mean
      // persisting a loop's scope, and a parked run names one node because that is all a run has
      // ever needed to say. Said here so it is found while placing the breakpoint rather than by
      // watching a run die on it.
      problems.push({
        nodeId: node.id,
        message: "A breakpoint cannot be used inside a For each. This run would fail.",
      });
    }
    if (node.type === COLLECT_TYPE || node.type === STOP_WHEN_TYPE) {
      if (innermostLoop(bodies, node.id) === null) {
        problems.push({
          nodeId: node.id,
          message: `${node.type === COLLECT_TYPE ? "Collect" : "Stop when"} has to be inside a For each.`,
        });
      }
    }
  }

  return problems;
}
