import type { GraphSummary, StreamFrame } from "@vrcz/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { graphs } from "./graphs.svelte.ts";

/**
 * Sonner is mocked rather than rendered.
 *
 * What this module decides is *whether and how loudly to speak*, which is a pure function of the
 * frame and the graph's own debug flag. Rendering a real toast would test svelte-sonner, and it
 * needs a DOM host component that no other test in this directory sets up.
 *
 * `vi.mock` is hoisted above the imports, so the module under test has to be pulled in afterwards —
 * a static import would bind the real `toast` before the mock existed.
 */
const raised: { kind: string; title: string }[] = [];

vi.mock("svelte-sonner", () => ({
  toast: {
    error: (title: string) => {
      raised.push({ kind: "error", title });
      return raised.length;
    },
    info: (title: string) => {
      raised.push({ kind: "info", title });
      return raised.length;
    },
    message: (title: string) => {
      raised.push({ kind: "message", title });
      return raised.length;
    },
  },
}));

const { graphDebug } = await import("./graph-debug.svelte.ts");

function summary(id: string, debug: boolean): GraphSummary {
  return {
    id,
    name: `Graph ${id}`,
    description: "",
    enabled: true,
    armed: true,
    debug,
    concurrency: "parallel",
    accountId: null,
    disabledReason: null,
    nodeCount: 0,
    triggerTypes: [],
    lastRunAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function frame(type: string, data: Record<string, unknown>): StreamFrame {
  return {
    type,
    ts: 0,
    payload: {
      accountId: null,
      sessionId: null,
      displayName: null,
      subjectId: null,
      location: null,
      data,
    },
  } as StreamFrame;
}

let clock = 0;

beforeEach(() => {
  raised.length = 0;
  clock = 0;
  graphDebug.setClock(() => clock);
  // The module is a singleton, so a burst from the last test would otherwise still be "in progress"
  // against a clock that has just been rewound to zero.
  graphDebug.reset();
  graphs.graphs = [summary("watched", true), summary("quiet", false)];
  graphs.loaded = true;
});

describe("who gets toasted", () => {
  test("a graph nobody put in debug mode says nothing", () => {
    graphDebug.apply(frame("graph.node.error", { graphId: "quiet", node: "n1", message: "no" }));
    expect(raised).toEqual([]);
  });

  test("a graph this build has never heard of says nothing either", () => {
    // The right way round: a missed toast costs one event you can still find in the run log, and
    // the other choice is every graph on the machine shouting at somebody who just opened the app.
    graphDebug.apply(frame("graph.node.error", { graphId: "unknown", node: "n1" }));
    expect(raised).toEqual([]);
  });

  test("a swallowed node failure is the loud one", () => {
    // The list's name wins over the one in the payload, which is a snapshot from the moment the
    // event was emitted. A graph renamed since then should be toasted under what it is called now.
    graphDebug.apply(
      frame("graph.node.error", { graphId: "watched", graphName: "Renamed away", message: "boom" }),
    );
    expect(raised).toEqual([{ kind: "error", title: "Graph watched: a node failed" }]);
  });

  test("a rehearsal note is the quiet one, and is named from the list", () => {
    // `graph.note` is emitted straight to the bus by the action that rehearsed, so unlike every
    // other kind here it carries no `graphName` at all. Reading the payload alone titled every
    // rehearsal note "A graph", which is precisely useless on a machine with eleven of them.
    graphDebug.apply(frame("graph.note", { graphId: "watched", note: "would" }));
    expect(raised[0]).toEqual({ kind: "message", title: "Graph watched" });
  });

  test("a run finishing is not news", () => {
    // A graph firing every minute would turn a debugging session into a wall of "it worked", and
    // the run log already says so without interrupting anything.
    graphDebug.apply(frame("graph.run.finished", { graphId: "watched" }));
    expect(raised).toEqual([]);
  });
});

describe("a burst", () => {
  test("one node failing forty times is a few toasts and a count", () => {
    for (let i = 0; i < 40; i += 1) {
      graphDebug.apply(frame("graph.node.error", { graphId: "watched", node: "n1", message: "x" }));
    }
    // Three real ones, then a single line that updates in place. Forty stacked toasts is a screen
    // you can neither read nor use, which is the opposite of what a debugger is for.
    expect(raised.filter((entry) => entry.kind === "error")).toHaveLength(3);
    expect(raised.at(-1)?.title).toContain("more");
  });

  test("two different nodes failing at once are two toasts", () => {
    // Keyed by node as well as by graph, because this is the case where the second one is the news.
    graphDebug.apply(frame("graph.node.error", { graphId: "watched", node: "n1" }));
    graphDebug.apply(frame("graph.node.error", { graphId: "watched", node: "n2" }));
    expect(raised.filter((entry) => entry.kind === "error")).toHaveLength(2);
  });

  test("the next fire is its own burst", () => {
    for (let i = 0; i < 10; i += 1) {
      graphDebug.apply(frame("graph.node.error", { graphId: "watched", node: "n1" }));
    }
    const before = raised.filter((entry) => entry.kind === "error").length;
    clock += 60_000;
    graphDebug.apply(frame("graph.node.error", { graphId: "watched", node: "n1" }));
    expect(raised.filter((entry) => entry.kind === "error")).toHaveLength(before + 1);
  });
});
