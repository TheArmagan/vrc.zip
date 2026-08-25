import type { GraphDocument } from "@vrcz/shared";
import { describe, expect, test } from "vitest";
import {
  CLIPBOARD_KIND,
  getBuffer,
  PASTE_OFFSET,
  parseFragment,
  placeFragment,
  serializeFragment,
  setBuffer,
} from "./clipboard.ts";

function doc(): GraphDocument {
  return {
    nodes: [
      { id: "a", type: "vrcz/log", position: { x: 100, y: 40 }, config: { text: "hi" } },
      { id: "b", type: "vrcz/log", position: { x: 180, y: 90 }, config: {}, breakpoint: true },
    ],
    edges: [{ id: "e1", from: { node: "a", port: "out" }, to: { node: "b", port: "in" } }],
  };
}

/** Ids in the order they are asked for, which is nodes first and then edges. */
function counter(): (kind: "node" | "edge") => string {
  let n = 0;
  return (kind) => {
    n += 1;
    return `${kind}${String(n)}`;
  };
}

describe("serializeFragment / parseFragment", () => {
  test("round-trips a fragment", () => {
    expect(parseFragment(serializeFragment(doc()))).toEqual(doc());
  });

  test("refuses text that is not one of ours", () => {
    expect(parseFragment("")).toBeNull();
    expect(parseFragment("just some text")).toBeNull();
    expect(parseFragment(JSON.stringify({ nodes: [], edges: [] }))).toBeNull();
    expect(
      parseFragment(JSON.stringify({ kind: "somebody/else", version: 1, document: doc() })),
    ).toBeNull();
  });

  test("keeps a node carrying fields this build does not know about", () => {
    const text = JSON.stringify({
      kind: CLIPBOARD_KIND,
      version: 1,
      document: {
        nodes: [
          {
            id: "a",
            type: "future/node",
            position: { x: 0, y: 0 },
            config: {},
            somethingNew: true,
          },
        ],
        edges: [],
      },
    });
    expect(parseFragment(text)?.nodes[0]?.type).toBe("future/node");
  });

  test("drops a wire with an end outside the fragment", () => {
    const text = JSON.stringify({
      kind: CLIPBOARD_KIND,
      version: 1,
      document: {
        nodes: [{ id: "a", type: "vrcz/log", position: { x: 0, y: 0 }, config: {} }],
        edges: [{ id: "e1", from: { node: "a", port: "out" }, to: { node: "gone", port: "in" } }],
      },
    });
    expect(parseFragment(text)?.edges).toEqual([]);
  });

  test("a payload with no usable node is not a fragment", () => {
    const text = JSON.stringify({
      kind: CLIPBOARD_KIND,
      version: 1,
      document: { nodes: [{ id: 7 }], edges: [] },
    });
    expect(parseFragment(text)).toBeNull();
  });
});

describe("placeFragment", () => {
  test("gives every node and edge a new id, and rewires between the copies", () => {
    const placed = placeFragment(doc(), null, counter());
    expect(placed.nodes.map((node) => node.id)).toEqual(["node1", "node2"]);
    expect(placed.edges[0]).toEqual({
      id: "edge3",
      from: { node: "node1", port: "out" },
      to: { node: "node2", port: "in" },
    });
  });

  test("with nowhere to be, steps the whole group down and right", () => {
    const placed = placeFragment(doc(), null, counter());
    expect(placed.nodes.map((node) => node.position)).toEqual([
      { x: 100 + PASTE_OFFSET, y: 40 + PASTE_OFFSET },
      { x: 180 + PASTE_OFFSET, y: 90 + PASTE_OFFSET },
    ]);
  });

  test("lands the group's corner on the paste point, keeping its shape", () => {
    const placed = placeFragment(doc(), { x: 500, y: 500 }, counter());
    expect(placed.nodes.map((node) => node.position)).toEqual([
      { x: 500, y: 500 },
      { x: 580, y: 550 },
    ]);
  });

  test("carries the config and the breakpoint", () => {
    const placed = placeFragment(doc(), null, counter());
    expect(placed.nodes[0]?.config).toEqual({ text: "hi" });
    expect(placed.nodes[1]?.breakpoint).toBe(true);
  });

  test("does not edit the fragment it was given", () => {
    const original = doc();
    placeFragment(original, { x: 9, y: 9 }, counter());
    expect(original).toEqual(doc());
  });
});

describe("the buffer", () => {
  test("holds the last copy", () => {
    setBuffer(doc());
    expect(getBuffer()).toEqual(doc());
  });
});
