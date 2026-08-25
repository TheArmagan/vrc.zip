import { describe, expect, test } from "vitest";
import { GraphHistory, HISTORY_LIMIT, type HistoryNode, touchedBetween } from "./history.svelte.ts";

interface TestNode extends HistoryNode {
  readonly id: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

interface TestEdge {
  readonly id: string;
}

function node(id: string, x = 0, config: Record<string, unknown> = {}): TestNode {
  return { id, position: { x, y: 0 }, data: { config } };
}

function history(): GraphHistory<TestNode, TestEdge> {
  const stack = new GraphHistory<TestNode, TestEdge>();
  stack.reset({ nodes: [node("a")], edges: [] });
  return stack;
}

describe("GraphHistory", () => {
  test("a freshly loaded document has nothing to undo and is clean", () => {
    const stack = history();
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
    expect(stack.atSaved).toBe(true);
  });

  test("walks back and forward through pushes", () => {
    const stack = history();
    stack.push({ nodes: [node("a"), node("b")], edges: [] });
    expect(stack.canUndo).toBe(true);

    expect(stack.undo()?.nodes.map((entry) => entry.id)).toEqual(["a"]);
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(true);

    expect(stack.redo()?.nodes.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(stack.redo()).toBeNull();
  });

  test("undoing back to the saved entry is clean again, and redoing away is not", () => {
    const stack = history();
    stack.push({ nodes: [node("a"), node("b")], edges: [] });
    expect(stack.atSaved).toBe(false);
    stack.undo();
    expect(stack.atSaved).toBe(true);
    stack.redo();
    expect(stack.atSaved).toBe(false);
  });

  test("a save moves the clean point without clearing the stack", () => {
    const stack = history();
    stack.push({ nodes: [node("a"), node("b")], edges: [] });
    stack.markSaved();
    expect(stack.atSaved).toBe(true);
    // The whole point: a save is not a wall.
    expect(stack.canUndo).toBe(true);
    stack.undo();
    expect(stack.atSaved).toBe(false);
  });

  test("a push after an undo throws the redo tail away", () => {
    const stack = history();
    stack.push({ nodes: [node("a"), node("b")], edges: [] });
    stack.undo();
    stack.push({ nodes: [node("a"), node("c")], edges: [] });
    expect(stack.canRedo).toBe(false);
    expect(stack.undo()?.nodes.map((entry) => entry.id)).toEqual(["a"]);
  });

  test("pushes carrying the same key are one step", () => {
    const stack = history();
    stack.push({ nodes: [node("a", 0, { text: "h" })], edges: [] }, "a:text");
    stack.push({ nodes: [node("a", 0, { text: "hi" })], edges: [] }, "a:text");
    stack.push({ nodes: [node("a", 0, { text: "hip" })], edges: [] }, "a:text");
    // One press takes the whole word back, not its last letter.
    expect(stack.undo()?.nodes[0]?.data["config"]).toEqual({});
    expect(stack.canUndo).toBe(false);
  });

  test("seal ends a run, so returning to the same field is a new step", () => {
    const stack = history();
    stack.push({ nodes: [node("a", 0, { text: "hi" })], edges: [] }, "a:text");
    stack.seal();
    stack.push({ nodes: [node("a", 0, { text: "hi there" })], edges: [] }, "a:text");
    expect(stack.undo()?.nodes[0]?.data["config"]).toEqual({ text: "hi" });
  });

  test("a different key starts a new step", () => {
    const stack = history();
    stack.push({ nodes: [node("a", 0, { text: "hi" })], edges: [] }, "a:text");
    stack.push({ nodes: [node("a", 0, { text: "hi", other: 1 })], edges: [] }, "a:other");
    expect(stack.undo()?.nodes[0]?.data["config"]).toEqual({ text: "hi" });
  });

  test("an entry cannot be spoiled by editing what was pushed", () => {
    const stack = history();
    const live = node("a", 10);
    stack.push({ nodes: [live], edges: [] });
    live.position.x = 999;
    live.data["config"] = { changed: true };
    stack.undo();
    expect(stack.redo()?.nodes[0]?.position.x).toBe(10);
  });

  test("drops the oldest entries past the limit", () => {
    const stack = history();
    for (let step = 0; step < HISTORY_LIMIT + 20; step += 1) {
      stack.push({ nodes: [node("a", step)], edges: [] });
    }
    let depth = 0;
    while (stack.undo() !== null) depth += 1;
    expect(depth).toBe(HISTORY_LIMIT - 1);
  });
});

describe("touchedBetween", () => {
  test("names a node the step brought back", () => {
    expect(touchedBetween([node("a")], [node("a"), node("b")])).toEqual(new Set(["b"]));
  });

  test("names a node that moved", () => {
    expect(touchedBetween([node("a", 0)], [node("a", 40)])).toEqual(new Set(["a"]));
  });

  test("names a node whose config changed", () => {
    expect(touchedBetween([node("a", 0, { n: 1 })], [node("a", 0, { n: 2 })])).toEqual(
      new Set(["a"]),
    );
  });

  test("names a node whose breakpoint was toggled", () => {
    const before = node("a");
    const after = node("a");
    after.data["breakpoint"] = true;
    expect(touchedBetween([before], [after])).toEqual(new Set(["a"]));
  });

  test("says nothing when nothing changed", () => {
    expect(touchedBetween([node("a", 0, { n: 1 })], [node("a", 0, { n: 1 })]).size).toBe(0);
  });

  test("a removal touches nothing, because there is nothing left to select", () => {
    expect(touchedBetween([node("a"), node("b")], [node("a")]).size).toBe(0);
  });
});
