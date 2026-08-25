import { describe, expect, test } from "vitest";
import {
  type CanvasEdge,
  type CanvasNode,
  COLLECT_TYPE,
  FOREACH_TYPE,
  loopProblems,
  loopRegions,
  STOP_WHEN_TYPE,
  WAIT_TYPE,
} from "./loops.ts";

function node(id: string, type: string, x = 0, y = 0): CanvasNode {
  return { id, type, position: { x, y }, width: 200, height: 100 };
}

function edge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): CanvasEdge {
  return { source, sourceHandle, target, targetHandle };
}

describe("loopRegions", () => {
  test("a region covers the loop and everything its Item reaches", () => {
    const nodes = [
      node("trigger", "vrcz/run-now", 0, 0),
      node("loop", FOREACH_TYPE, 300, 0),
      node("body", "vrcz/note", 600, 40),
    ];
    const edges = [edge("trigger", "out", "loop", "list"), edge("loop", "item", "body", "in")];

    const [region] = loopRegions(nodes, edges);

    expect(region?.loopId).toBe("loop");
    expect([...(region?.body ?? [])]).toEqual(["body"]);
    // Left of the loop card and right of the body card, with room for the label above.
    expect(region?.x).toBeLessThan(300);
    expect((region?.x ?? 0) + (region?.width ?? 0)).toBeGreaterThan(800);
    expect(region?.y).toBeLessThan(0);
  });

  test("a node wired to Results is outside the region, not inside it", () => {
    // The whole reason `results` joined `done` in the after-the-loop set. Without it the node that
    // reads what the loop collected would be drawn as part of the body that collected it.
    const nodes = [node("loop", FOREACH_TYPE, 0, 0), node("reader", "vrcz/note", 400, 0)];
    const edges = [edge("loop", "results", "reader", "in")];

    expect(loopRegions(nodes, edges)).toEqual([]);
  });

  test("a loop with nothing wired to Item gets no region at all", () => {
    // A box around one node reads as "this node is broken" rather than "you have not wired it yet".
    const nodes = [node("loop", FOREACH_TYPE)];

    expect(loopRegions(nodes, [])).toEqual([]);
  });

  test("a nested loop is one step deeper than the one containing it", () => {
    const nodes = [
      node("outer", FOREACH_TYPE, 0, 0),
      node("inner", FOREACH_TYPE, 300, 0),
      node("body", "vrcz/note", 600, 0),
    ];
    const edges = [edge("outer", "item", "inner", "list"), edge("inner", "item", "body", "in")];

    const regions = loopRegions(nodes, edges);

    // Outermost first, so the inner tint paints on top of its parent rather than under it.
    expect(regions.map((region) => [region.loopId, region.depth])).toEqual([
      ["outer", 0],
      ["inner", 1],
    ]);
  });
});

describe("loopProblems", () => {
  test("a Wait inside a body is flagged before the run can fail on it", () => {
    const nodes = [node("loop", FOREACH_TYPE), node("wait", WAIT_TYPE)];
    const edges = [edge("loop", "item", "wait", "in")];

    expect(loopProblems(nodes, edges)).toEqual([
      { nodeId: "wait", message: "A Wait cannot be used inside a For each. This run would fail." },
    ]);
  });

  test("a Wait after the loop is fine", () => {
    const nodes = [node("loop", FOREACH_TYPE), node("wait", WAIT_TYPE)];
    const edges = [edge("loop", "done", "wait", "in")];

    expect(loopProblems(nodes, edges)).toEqual([]);
  });

  test("a Collect or Stop when outside every loop is flagged, in the daemon's words", () => {
    const nodes = [node("collect", COLLECT_TYPE), node("stop", STOP_WHEN_TYPE)];

    expect(loopProblems(nodes, []).map((problem) => problem.message)).toEqual([
      "Collect has to be inside a For each.",
      "Stop when has to be inside a For each.",
    ]);
  });

  test("a Collect inside a body is not flagged", () => {
    const nodes = [node("loop", FOREACH_TYPE), node("collect", COLLECT_TYPE)];
    const edges = [edge("loop", "item", "collect", "value")];

    expect(loopProblems(nodes, edges)).toEqual([]);
  });

  test("a breakpoint inside a body is flagged while it is being placed", () => {
    // The engine refuses this at run time for the same reason it refuses a `Wait` there. Saying so
    // here is the difference between finding out while you are placing the mark and finding out by
    // watching a run die on it.
    const nodes = [node("loop", FOREACH_TYPE), node("inner", "vrcz/note")];
    const edges = [edge("loop", "item", "inner", "in")];

    expect(loopProblems(nodes, edges, new Set(["inner"]))).toEqual([
      {
        nodeId: "inner",
        message: "A breakpoint cannot be used inside a For each. This run would fail.",
      },
    ]);
  });

  test("a breakpoint outside every loop is fine", () => {
    const nodes = [node("loop", FOREACH_TYPE), node("after", "vrcz/note")];
    const edges = [edge("loop", "done", "after", "in")];

    expect(loopProblems(nodes, edges, new Set(["after"]))).toEqual([]);
  });
});
