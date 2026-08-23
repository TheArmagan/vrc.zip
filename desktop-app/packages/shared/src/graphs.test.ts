import { describe, expect, test } from "bun:test";
import {
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  graphRoots,
  isGraphConcurrency,
  MAX_GRAPH_NODES,
  reachableFrom,
  validateGraphDocument,
} from "./graphs.ts";

function node(id: string, type = "vrcz/log"): GraphNode {
  return { id, type, position: { x: 0, y: 0 }, config: {} };
}

function edge(id: string, from: string, to: string, port = "in"): GraphEdge {
  return { id, from: { node: from, port: "out" }, to: { node: to, port } };
}

function doc(nodes: GraphNode[], edges: GraphEdge[]): GraphDocument {
  return { nodes, edges };
}

/** Every path in an issue list, so a test can assert on where a failure was reported. */
function paths(document: unknown): string[] {
  return validateGraphDocument(document).issues.map((issue) => issue.path);
}

describe("validateGraphDocument", () => {
  test("accepts an empty document and a wired one", () => {
    expect(validateGraphDocument(doc([], [])).ok).toBe(true);
    const ok = doc([node("a"), node("b")], [edge("e1", "a", "b")]);
    expect(validateGraphDocument(ok)).toEqual({ ok: true, issues: [] });
  });

  test("refuses anything that is not a document", () => {
    expect(validateGraphDocument(null).ok).toBe(false);
    expect(validateGraphDocument("{}").ok).toBe(false);
    expect(paths({ nodes: {}, edges: [] })).toEqual(["nodes"]);
    expect(paths({ nodes: [], edges: null })).toEqual(["edges"]);
  });

  test("names the path of every malformed node", () => {
    const bad = {
      nodes: [
        { id: "", type: "vrcz/log", position: { x: 0, y: 0 }, config: {} },
        { id: "b", type: "", position: { x: 0, y: 0 }, config: {} },
        { id: "c", type: "vrcz/log", position: { x: 0, y: Number.NaN }, config: {} },
        { id: "d", type: "vrcz/log", position: { x: 0, y: 0 }, config: { n: null } },
        { id: "e", type: "vrcz/log", position: { x: 0, y: 0 }, config: {}, defHash: 7 },
      ],
      edges: [],
    };

    expect(paths(bad)).toEqual([
      "nodes[0].id",
      "nodes[1].type",
      "nodes[2].position",
      "nodes[3].config.n",
      "nodes[4].defHash",
    ]);
  });

  test("reports every problem rather than the first", () => {
    // A canvas that surfaces one broken thing per save is a canvas nobody finishes fixing.
    const bad = doc([node("a"), node("a")], [edge("e1", "a", "ghost")]);
    const result = validateGraphDocument(bad);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(1);
  });

  test("catches a duplicate node id and a duplicate edge id", () => {
    expect(paths(doc([node("a"), node("a")], []))).toEqual(["nodes[1].id"]);
    const dupEdge = doc([node("a"), node("b")], [edge("e1", "a", "b"), edge("e1", "b", "a", "x")]);
    expect(validateGraphDocument(dupEdge).issues.map((i) => i.message)).toContain(
      'duplicate edge id "e1"',
    );
  });

  test("refuses an edge that points at a node which is not there, naming the side", () => {
    const result = validateGraphDocument(doc([node("a")], [edge("e1", "a", "ghost")]));
    expect(result.issues).toEqual([{ path: "edges[0].to.node", message: 'no node "ghost"' }]);
  });

  test("reports both ends of an edge in one pass", () => {
    const result = validateGraphDocument(doc([], [edge("e1", "x", "y")]));
    expect(result.issues.map((i) => i.path)).toEqual(["edges[0].from.node", "edges[0].to.node"]);
  });

  test("refuses a self-edge", () => {
    const result = validateGraphDocument(doc([node("a")], [edge("e1", "a", "a")]));
    expect(result.issues[0]?.message).toBe("a node cannot be wired to itself");
  });

  test("refuses two producers for one input port", () => {
    // No defined merge exists, and picking whichever arrived last means the graph behaves
    // differently on a busy evening than it does under test.
    const two = doc(
      [node("a"), node("b"), node("c")],
      [edge("e1", "a", "c", "in"), edge("e2", "b", "c", "in")],
    );
    const result = validateGraphDocument(two);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.message)).toContain('input "c.in" already has an edge');

    // The same producer feeding two *different* inputs is fan-out, which is the point of a DAG.
    const fanOut = doc(
      [node("a"), node("b"), node("c")],
      [edge("e1", "a", "b"), edge("e2", "a", "c")],
    );
    expect(validateGraphDocument(fanOut).ok).toBe(true);
  });

  test("finds a cycle and names the loop", () => {
    const cyclic = doc(
      [node("a"), node("b"), node("c")],
      [edge("e1", "a", "b"), edge("e2", "b", "c", "in2"), edge("e3", "c", "a", "in3")],
    );
    const result = validateGraphDocument(cyclic);
    expect(result.ok).toBe(false);
    const cycle = result.issues.find((i) => i.message.startsWith("cycle:"));
    expect(cycle?.path).toBe("edges");
    expect(cycle?.message).toContain("->");
  });

  test("a diamond is not a cycle", () => {
    const diamond = doc(
      [node("a"), node("b"), node("c"), node("d")],
      [
        edge("e1", "a", "b"),
        edge("e2", "a", "c"),
        edge("e3", "b", "d", "left"),
        edge("e4", "c", "d", "right"),
      ],
    );
    expect(validateGraphDocument(diamond).ok).toBe(true);
  });

  test("survives a long chain without recursing", () => {
    // The validator runs on a document that arrived over HTTP, so depth is hostile input.
    const nodes = Array.from({ length: MAX_GRAPH_NODES }, (_, i) => node(`n${i}`));
    const edges = nodes.slice(1).map((n, i) => edge(`e${i}`, `n${i}`, n.id, `in${i}`));
    expect(validateGraphDocument(doc(nodes, edges)).ok).toBe(true);
  });

  test("enforces the node and edge ceilings", () => {
    const nodes = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) => node(`n${i}`));
    expect(paths(doc(nodes, []))).toContain("nodes");
  });
});

describe("graph traversal", () => {
  test("roots are the nodes nothing feeds", () => {
    const document = doc(
      [node("t1"), node("t2"), node("a")],
      [edge("e1", "t1", "a"), edge("e2", "t2", "a", "other")],
    );
    expect(graphRoots(document).sort()).toEqual(["t1", "t2"]);
  });

  test("a run walks only what its own trigger reaches", () => {
    // Two trigger roots, one shared tail and one branch each. A fire from t1 must not touch t2's
    // branch, whose nodes would have no inputs.
    const document = doc(
      [node("t1"), node("t2"), node("only1"), node("only2")],
      [edge("e1", "t1", "only1"), edge("e2", "t2", "only2")],
    );
    expect([...reachableFrom(document, "t1")].sort()).toEqual(["only1", "t1"]);
    expect([...reachableFrom(document, "t2")].sort()).toEqual(["only2", "t2"]);
  });

  test("reachability terminates on a diamond", () => {
    const document = doc(
      [node("a"), node("b"), node("c"), node("d")],
      [
        edge("e1", "a", "b"),
        edge("e2", "a", "c"),
        edge("e3", "b", "d", "left"),
        edge("e4", "c", "d", "right"),
      ],
    );
    expect(reachableFrom(document, "a").size).toBe(4);
  });
});

describe("concurrency modes", () => {
  test("knows the three, and nothing else", () => {
    expect(isGraphConcurrency("parallel")).toBe(true);
    expect(isGraphConcurrency("queue")).toBe(true);
    expect(isGraphConcurrency("drop")).toBe(true);
    expect(isGraphConcurrency("whenever")).toBe(false);
    expect(isGraphConcurrency(undefined)).toBe(false);
  });
});
