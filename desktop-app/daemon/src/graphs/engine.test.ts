import { describe, expect, test } from "bun:test";
import type { NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import { AFTER_PORT } from "@vrcz/plugin-api/nodes";
import type { GraphDocument, GraphEdge, GraphNode } from "@vrcz/shared";
import type { BusEvent } from "../bus/event-bus.ts";
import { EventBus } from "../bus/event-bus.ts";
import { MEMORY, Store } from "../store/store.ts";
import { GraphEngine } from "./engine.ts";
import {
  BRANCH_TYPE,
  COLLECT_TYPE,
  DEFAULT_WAIT_MS,
  ERROR_PORT,
  FOREACH_TYPE,
  STOP_WHEN_TYPE,
  WAIT_TYPE,
} from "./intrinsics.ts";
import type { ArmRequest, ExecuteContext, NodeProvider } from "./types.ts";

const T0 = 1_700_000_000_000;
const ACCOUNT = "usr_owner";

/* -------------------------------------------------------------------------------------------- */
/* Harness                                                                                        */
/* -------------------------------------------------------------------------------------------- */

type Handler = (
  inputs: PortValues,
  config: Readonly<Record<string, string | number | boolean>>,
  context: ExecuteContext,
) => PortValues | Promise<PortValues>;

/**
 * The engine is written against `NodeProvider`, which is what makes 4.2 testable before 4.3 exists.
 * This is four methods and a pair of maps, and the engine cannot tell it from the real one.
 */
class FakeProvider implements NodeProvider {
  readonly definitions = new Map<string, NodeDefinition>();
  readonly handlers = new Map<string, Handler>();
  readonly armed = new Map<string, ArmRequest>();
  readonly disarmed: string[] = [];
  readonly executed: {
    type: string;
    inputs: PortValues;
    config: Readonly<Record<string, string | number | boolean>>;
    context: ExecuteContext;
  }[] = [];

  trigger(type: string, maxFiresPerMinute?: number): this {
    this.definitions.set(type, {
      id: type,
      kind: "trigger",
      title: type,
      outputs: [{ id: "out", label: "Out", type: "json" }],
      ...(maxFiresPerMinute === undefined ? {} : { maxFiresPerMinute }),
    });
    return this;
  }

  /** A node with no inputs — a literal, a clock, a friend list. The engine calls these sources. */
  source(type: string, handler: Handler, outputs = ["out"]): this {
    this.definitions.set(type, {
      id: type,
      kind: "action",
      title: type,
      inputs: [],
      outputs: outputs.map((id) => ({ id, label: id, type: "json" as const })),
    });
    this.handlers.set(type, handler);
    return this;
  }

  /**
   * A node that declares an input but does not insist on one — the shape the five id literals took
   * on when they grew an optional `Id` port. Wired, it is an ordinary node; unwired, it is a source.
   */
  optional(type: string, handler: Handler, required = false): this {
    this.definitions.set(type, {
      id: type,
      kind: "action",
      title: type,
      inputs: [{ id: "in", label: "In", type: "json", ...(required ? { required } : {}) }],
      outputs: [{ id: "out", label: "out", type: "json" }],
    });
    this.handlers.set(type, handler);
    return this;
  }

  node(type: string, kind: "action" | "condition", handler: Handler, outputs = ["out"]): this {
    this.definitions.set(type, {
      id: type,
      kind,
      title: type,
      inputs: [{ id: "in", label: "In", type: "json" }],
      outputs: outputs.map((id) => ({ id, label: id, type: "json" as const })),
    });
    this.handlers.set(type, handler);
    return this;
  }

  definition(type: string): NodeDefinition | null {
    return this.definitions.get(type) ?? null;
  }

  async arm(_type: string, request: ArmRequest): Promise<void> {
    this.armed.set(request.instanceId, request);
    await Promise.resolve();
  }

  async disarm(_type: string, instanceId: string): Promise<void> {
    this.armed.delete(instanceId);
    this.disarmed.push(instanceId);
    await Promise.resolve();
  }

  async execute(
    type: string,
    inputs: PortValues,
    config: Readonly<Record<string, string | number | boolean>>,
    context: ExecuteContext,
  ): Promise<PortValues> {
    this.executed.push({ type, inputs, config, context });
    const handler = this.handlers.get(type);
    if (handler === undefined) throw new Error(`no handler for ${type}`);
    return await handler(inputs, config, context);
  }

  /** Every node type executed, in order. The assertion most of these tests actually want. */
  get order(): string[] {
    return this.executed.map((entry) => entry.type);
  }
}

function node(id: string, type: string, config: Record<string, string | number | boolean> = {}) {
  return { id, type, position: { x: 0, y: 0 }, config } satisfies GraphNode;
}

function edge(id: string, from: string, to: string, fromPort = "out", toPort = "in"): GraphEdge {
  return { id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } };
}

interface Harness {
  readonly store: Store;
  readonly bus: EventBus;
  readonly provider: FakeProvider;
  readonly engine: GraphEngine;
  readonly events: BusEvent[];
  readonly errors: string[];
  /** Every pause the engine asked for, in order. Recorded rather than taken. */
  readonly slept: number[];
  now: number;
  graph(document: GraphDocument, overrides?: Partial<GraphOverrides>): string;
  /** Builds a second engine over the same database, which is what a restart looks like. */
  restart(): GraphEngine;
}

interface GraphOverrides {
  id: string;
  enabled: number;
  armed: number;
  concurrency: string;
}

function harness(limits?: Parameters<typeof makeEngine>[3]): Harness {
  const store = Store.open(MEMORY);
  store.upsertAccount({
    id: ACCOUNT,
    display_name: "Owner",
    added_at: T0,
    enabled: 1,
    last_seen_at: null,
  });
  const bus = new EventBus();
  const provider = new FakeProvider();
  const events: BusEvent[] = [];
  const errors: string[] = [];
  const slept: number[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });

  const state = { now: T0 };
  const engine = makeEngine(store, bus, provider, limits, () => state.now, errors, slept);

  return {
    store,
    bus,
    provider,
    engine,
    events,
    errors,
    slept,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    graph(document, overrides = {}) {
      const id = overrides.id ?? `g${String(store.listGraphs().length + 1)}`;
      store.insertGraph({
        id,
        name: `Graph ${id}`,
        description: "",
        enabled: overrides.enabled ?? 1,
        // Armed by default, because most of these tests are about the walk rather than about
        // dry-run; the dry-run tests say so explicitly.
        armed: overrides.armed ?? 1,
        concurrency: overrides.concurrency ?? "parallel",
        account_id: ACCOUNT,
        definition: JSON.stringify(document),
        created_at: state.now,
        updated_at: state.now,
      });
      return id;
    },
    restart() {
      return makeEngine(store, bus, provider, limits, () => state.now, errors, slept);
    },
  };
}

function makeEngine(
  store: Store,
  bus: EventBus,
  provider: FakeProvider,
  limits: Record<string, number> | undefined,
  now: () => number,
  errors: string[],
  slept: number[],
): GraphEngine {
  return new GraphEngine({
    store,
    bus,
    provider,
    now,
    // Recorded, not taken. A test that asserts a two-second pause happened must not take two
    // seconds; what matters is that the engine asked, and for how long.
    sleep: async (ms) => {
      slept.push(ms);
      await Promise.resolve();
    },
    // No sweep timer: the tests call `resumeDue()` themselves, so nothing depends on wall-clock.
    sweepMs: 0,
    ...(limits === undefined ? {} : { limits }),
    onError: (message) => {
      errors.push(message);
    },
  });
}

function kinds(events: readonly BusEvent[]): string[] {
  return events.map((event) => event.kind);
}

function payloadOf(events: readonly BusEvent[], kind: string): Record<string, unknown> {
  const found = events.find((event) => event.kind === kind);
  return (found?.payload ?? {}) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------------------------- */
/* The walk                                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe("the walk", () => {
  test("runs a chain in order, records it, and leaves no row behind", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("a", "action", (inputs) => ({ out: `a:${String(inputs.in)}` }))
      .node("b", "action", (inputs) => ({ out: `b:${String(inputs.in)}` }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "a"), node("n3", "b")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3")],
    });

    await h.engine.fire(id, "n1", { out: "go" });

    expect(h.provider.order).toEqual(["a", "b"]);
    expect(h.provider.executed[1]?.inputs.in).toBe("a:go");
    // A run that ended is gone from `graph_runs`; its record is the event.
    expect(h.store.listGraphRuns(id)).toHaveLength(0);
    expect(kinds(h.events)).toEqual(["graph.run.finished"]);
    expect(payloadOf(h.events, "graph.run.finished").triggerNode).toBe("n1");
  });

  test("a diamond runs every node exactly once", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("left", "action", () => ({ out: 1 }))
      .node("right", "action", () => ({ out: 2 }))
      .node("join", "action", () => ({ out: 3 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "left"), node("n3", "right"), node("n4", "join")],
      edges: [
        edge("e1", "n1", "n2"),
        edge("e2", "n1", "n3"),
        edge("e3", "n2", "n4", "out", "l"),
        edge("e4", "n3", "n4", "out", "r"),
      ],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["left", "right", "join"]);
    expect(h.provider.executed[2]?.inputs).toEqual({ l: 1, r: 2 });
  });

  test("a run walks only what its own trigger reaches", async () => {
    // Two trigger roots. A fire from one must not run the other's branch, whose nodes have no
    // inputs and would be executed with nothing.
    const h = harness();
    h.provider
      .trigger("t")
      .node("mine", "action", () => ({ out: 1 }))
      .node("theirs", "action", () => ({ out: 2 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "t"), node("n3", "mine"), node("n4", "theirs")],
      edges: [edge("e1", "n1", "n3"), edge("e2", "n2", "n4")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["mine"]);
  });

  test("a false condition gates everything downstream of it", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("check", "condition", () => ({ out: false }))
      .node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "check"), node("n3", "after")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["check"]);
    // Gated, not failed: the graph did what it was told, which was nothing.
    expect(kinds(h.events)).toEqual(["graph.run.finished"]);
  });

  test("a true condition lets the run through", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("check", "condition", () => ({ out: true }))
      .node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "check"), node("n3", "after")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["check", "after"]);
  });

  /*
   * Decision 281: `run after` is the one port where a `false` is a refusal rather than a value.
   *
   * An action's boolean output dropped straight on `run after` is the shortest way to say "only
   * when this is true", and it used to be an edge that changed nothing at all — the node always
   * produces the port, so the edge was never dead and the run always continued.
   */
  test("a false on run after stops the node, like an unproduced port", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("check", "action", () => ({ out: false }))
      .node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "check"), node("n3", "after")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3", "out", AFTER_PORT)],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["check"]);
    expect(kinds(h.events)).toEqual(["graph.run.finished"]);
  });

  test("a true on run after lets it through", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("check", "action", () => ({ out: true }))
      .node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "check"), node("n3", "after")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3", "out", AFTER_PORT)],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["check", "after"]);
  });

  test("false is still an ordinary value on every other port", async () => {
    // The rule is about `run after` and nothing else. A graph that carries a boolean around and
    // compares it, formats it, or stores it must keep getting `false` rather than a skip.
    const h = harness();
    h.provider
      .trigger("t")
      .node("check", "action", () => ({ out: false }))
      .node("after", "action", (inputs) => ({ out: `saw:${String(inputs.in)}` }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "check"), node("n3", "after")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["check", "after"]);
    expect(h.provider.executed[1]?.inputs).toEqual({ in: false });
  });

  test("only a boolean false refuses: zero, empty and null still run", async () => {
    // `false` is the answer "no". `0` and `""` are values that happen to be falsy, and a node
    // sequenced after a counter that reached zero is not a node the author wanted skipped.
    for (const value of [0, "", null]) {
      const h = harness();
      h.provider
        .trigger("t")
        .node("check", "action", () => ({ out: value }))
        .node("after", "action", () => ({ out: 1 }));
      const id = h.graph({
        nodes: [node("n1", "t"), node("n2", "check"), node("n3", "after")],
        edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3", "out", AFTER_PORT)],
      });

      await h.engine.fire(id, "n1", { out: null });

      expect(h.provider.order).toEqual(["check", "after"]);
    }
  });

  test("a branch takes one side and skips the other", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("then", "action", () => ({ out: 1 }))
      .node("else", "action", () => ({ out: 2 }));
    const document: GraphDocument = {
      nodes: [node("n1", "t"), node("n2", BRANCH_TYPE), node("n3", "then"), node("n4", "else")],
      edges: [
        edge("e1", "n1", "n2", "out", "value"),
        edge("e2", "n2", "n3", "true"),
        edge("e3", "n2", "n4", "false"),
      ],
    };
    const id = h.graph(document);

    await h.engine.fire(id, "n1", { out: true });
    expect(h.provider.order).toEqual(["then"]);

    const other = h.graph(document, { id: "g2" });
    await h.engine.fire(other, "n1", { out: false });
    expect(h.provider.order).toEqual(["then", "else"]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Iteration                                                                                      */
/* -------------------------------------------------------------------------------------------- */

describe("foreach", () => {
  /** trigger -> foreach -> body, with an optional node wired to the loop's `done`. */
  function loop(h: Harness, options: { after?: boolean } = {}): string {
    return h.graph({
      nodes: [
        node("n1", "t"),
        node("n2", FOREACH_TYPE),
        node("n3", "body"),
        ...(options.after === true ? [node("n4", "after")] : []),
      ],
      edges: [
        edge("e1", "n1", "n2", "out", "list"),
        edge("e2", "n2", "n3", "item"),
        ...(options.after === true ? [edge("e3", "n2", "n4", "done")] : []),
      ],
    });
  }

  test("runs the body once per element, in order, with the item", async () => {
    const h = harness();
    h.provider.trigger("t").node("body", "action", () => ({ out: 1 }));
    const id = loop(h);

    await h.engine.fire(id, "n1", { out: ["a", "b", "c"] });

    expect(h.provider.order).toEqual(["body", "body", "body"]);
    expect(h.provider.executed.map((entry) => entry.inputs.in)).toEqual(["a", "b", "c"]);
    expect(kinds(h.events)).toEqual(["graph.run.finished"]);
  });

  test("an empty list runs the body not at all, and the run still finishes", async () => {
    const h = harness();
    h.provider.trigger("t").node("body", "action", () => ({ out: 1 }));
    const id = loop(h);

    await h.engine.fire(id, "n1", { out: [] });

    expect(h.provider.order).toEqual([]);
    expect(kinds(h.events)).toEqual(["graph.run.finished"]);
  });

  test("a value that is not a list iterates zero times rather than failing", async () => {
    const h = harness();
    h.provider.trigger("t").node("body", "action", () => ({ out: 1 }));
    const id = loop(h);

    await h.engine.fire(id, "n1", { out: "not a list" });

    expect(h.provider.order).toEqual([]);
    expect(kinds(h.events)).toEqual(["graph.run.finished"]);
  });

  test("what is wired to `done` runs once, after the loop, with the count", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("body", "action", () => ({ out: 1 }))
      .node("after", "action", () => ({ out: 1 }));
    const id = loop(h, { after: true });

    await h.engine.fire(id, "n1", { out: ["a", "b"] });

    expect(h.provider.order).toEqual(["body", "body", "after"]);
    expect(h.provider.executed[2]?.inputs.in).toBe(2);
  });

  test("each iteration starts from a clean body", async () => {
    // Without clearing, the second element would find the body already settled and skip it — which
    // is the bug this test exists to keep out rather than a hypothetical.
    const h = harness();
    const seen: unknown[] = [];
    h.provider.trigger("t").node("body", "action", (inputs) => {
      seen.push(inputs.in);
      return { out: inputs.in };
    });
    const id = loop(h);

    await h.engine.fire(id, "n1", { out: [1, 2, 3, 4] });

    expect(seen).toEqual([1, 2, 3, 4]);
  });

  test("a failure inside the body ends the whole run", async () => {
    const h = harness();
    let calls = 0;
    h.provider.trigger("t").node("body", "action", () => {
      calls += 1;
      if (calls === 2) throw new Error("the second one refused");
      return { out: 1 };
    });
    const id = loop(h, { after: true });
    h.provider.node("after", "action", () => ({ out: 1 }));

    await h.engine.fire(id, "n1", { out: ["a", "b", "c"] });

    expect(calls).toBe(2);
    expect(payloadOf(h.events, "graph.run.failed").message).toBe("the second one refused");
  });

  test("the run-size ceiling bounds the loop", async () => {
    const h = harness({ maxNodesPerRun: 3 });
    h.provider.trigger("t").node("body", "action", () => ({ out: 1 }));
    const id = loop(h);

    await h.engine.fire(id, "n1", { out: [1, 2, 3, 4, 5] });

    // Three nodes executed: the foreach itself, then two body iterations.
    expect(h.provider.order).toEqual(["body", "body"]);
    expect(payloadOf(h.events, "graph.run.failed").message).toContain("more than 3 nodes");
  });

  test("a huge list is refused before it runs at all", async () => {
    // The ceiling the run-size one cannot catch: an empty body executes nothing, so a list of a
    // million would spin without the run ever growing.
    const h = harness({ maxForeachItems: 4 });
    h.provider.trigger("t").node("body", "action", () => ({ out: 1 }));
    const id = loop(h);

    await h.engine.fire(id, "n1", { out: [1, 2, 3, 4, 5] });

    expect(h.provider.order).toEqual([]);
    expect(payloadOf(h.events, "graph.run.failed").message).toContain("over 4 items");
  });

  test("a wait inside a loop is refused, and says so", async () => {
    const h = harness();
    h.provider.trigger("t").node("body", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", FOREACH_TYPE), node("n3", WAIT_TYPE, { durationMs: 10 })],
      edges: [edge("e1", "n1", "n2", "out", "list"), edge("e2", "n2", "n3", "item")],
    });

    await h.engine.fire(id, "n1", { out: ["a"] });

    expect(payloadOf(h.events, "graph.run.failed").message).toBe(
      "A Wait cannot be used inside a For each.",
    );
    // And nothing is parked: a run that failed is gone, not left waiting on a timer.
    expect(h.store.listGraphRuns(id)).toHaveLength(0);
  });

  test("a delay paces the loop, between items and not after the last", async () => {
    const h = harness();
    h.provider.trigger("t").node("body", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", FOREACH_TYPE, { delayMs: 2000 }), node("n3", "body")],
      edges: [edge("e1", "n1", "n2", "out", "list"), edge("e2", "n2", "n3", "item")],
    });

    await h.engine.fire(id, "n1", { out: ["a", "b", "c"] });

    // Three items, two gaps. A pause after the last one would delay everything downstream of the
    // loop for no reason anybody drawing it intended.
    expect(h.slept).toEqual([2000, 2000]);
    expect(h.provider.order).toEqual(["body", "body", "body"]);
  });

  test("no delay configured means the engine never pauses at all", async () => {
    const h = harness();
    h.provider.trigger("t").node("body", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", FOREACH_TYPE), node("n3", "body")],
      edges: [edge("e1", "n1", "n2", "out", "list"), edge("e2", "n2", "n3", "item")],
    });

    await h.engine.fire(id, "n1", { out: ["a", "b", "c"] });

    expect(h.slept).toEqual([]);
  });

  test("a delay that would hold the run for too long is refused before it starts", async () => {
    // The bound is the total, because a run holds a concurrency slot for as long as it lives.
    const h = harness({ maxForeachDelayMs: 60_000 });
    h.provider.trigger("t").node("body", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", FOREACH_TYPE, { delayMs: 30_000 }), node("n3", "body")],
      edges: [edge("e1", "n1", "n2", "out", "list"), edge("e2", "n2", "n3", "item")],
    });

    await h.engine.fire(id, "n1", { out: ["a", "b", "c", "d", "e"] });

    expect(h.provider.order).toEqual([]);
    expect(h.slept).toEqual([]);
    expect(payloadOf(h.events, "graph.run.failed").message).toContain("in total between items");
  });

  test("a stop when ends the pacing too", async () => {
    const h = harness();
    h.provider.trigger("t").node("body", "action", (inputs) => ({ out: inputs.in === "a" }));
    const id = h.graph({
      nodes: [
        node("n1", "t"),
        node("n2", FOREACH_TYPE, { delayMs: 500 }),
        node("n3", "body"),
        node("n4", STOP_WHEN_TYPE),
      ],
      edges: [
        edge("e1", "n1", "n2", "out", "list"),
        edge("e2", "n2", "n3", "item"),
        edge("e3", "n3", "n4", "out", "when"),
      ],
    });

    await h.engine.fire(id, "n1", { out: ["a", "b", "c"] });

    // One item ran and the loop was called off, so there is no gap to pace at all.
    expect(h.slept).toEqual([]);
  });

  test("a nested loop runs the inner body once per pair", async () => {
    const h = harness();
    h.provider.trigger("t").node("inner", "action", (inputs) => ({ out: inputs.in }));
    const id = h.graph({
      nodes: [
        node("n1", "t"),
        node("n2", FOREACH_TYPE),
        node("n3", FOREACH_TYPE),
        node("n4", "inner"),
      ],
      edges: [
        edge("e1", "n1", "n2", "out", "list"),
        edge("e2", "n2", "n3", "item", "list"),
        edge("e3", "n3", "n4", "item"),
      ],
    });

    await h.engine.fire(id, "n1", {
      out: [
        ["a", "b"],
        ["c", "d", "e"],
      ],
    });

    expect(h.provider.executed.map((entry) => entry.inputs.in)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Collect and stop                                                                               */
/* -------------------------------------------------------------------------------------------- */

describe("collect and stop", () => {
  /** trigger -> foreach -> body -> collect, with `results` read by a node after the loop. */
  function collecting(h: Harness): string {
    return h.graph({
      nodes: [
        node("n1", "t"),
        node("n2", FOREACH_TYPE),
        node("n3", "body"),
        node("n4", COLLECT_TYPE),
        node("n5", "after"),
      ],
      edges: [
        edge("e1", "n1", "n2", "out", "list"),
        edge("e2", "n2", "n3", "item"),
        edge("e3", "n3", "n4", "out", "value"),
        edge("e4", "n2", "n5", "results"),
      ],
    });
  }

  test("results carries what each iteration collected, in order", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("body", "action", (inputs) => ({ out: `saw ${String(inputs.in)}` }))
      .node("after", "action", () => ({ out: 1 }));
    const id = collecting(h);

    await h.engine.fire(id, "n1", { out: ["a", "b"] });

    expect(h.provider.order).toEqual(["body", "body", "after"]);
    expect(h.provider.executed[2]?.inputs.in).toEqual(["saw a", "saw b"]);
  });

  test("a loop that ran zero times still produces an empty results", async () => {
    // Gating the after-the-loop branch on whether anything was collected would make "nobody was
    // online" indistinguishable from "the loop never ran".
    const h = harness();
    h.provider
      .trigger("t")
      .node("body", "action", () => ({ out: 1 }))
      .node("after", "action", () => ({ out: 1 }));
    const id = collecting(h);

    await h.engine.fire(id, "n1", { out: [] });

    expect(h.provider.order).toEqual(["after"]);
    expect(h.provider.executed[0]?.inputs.in).toEqual([]);
  });

  test("a node wired to results is after the loop, not in its body", async () => {
    // The body is what `item` reaches minus what `done` **and** `results` reach. Without `results`
    // in that subtraction the reader would be walked once per item, collecting into itself.
    const h = harness();
    h.provider
      .trigger("t")
      .node("body", "action", () => ({ out: 1 }))
      .node("after", "action", () => ({ out: 1 }));
    const id = collecting(h);

    await h.engine.fire(id, "n1", { out: ["a", "b", "c"] });

    expect(h.provider.order.filter((type) => type === "after")).toHaveLength(1);
  });

  test("stop when ends the loop after the current item finishes", async () => {
    const h = harness();
    const seen: unknown[] = [];
    h.provider
      .trigger("t")
      .node("body", "action", (inputs) => {
        seen.push(inputs.in);
        return { out: inputs.in === "b" };
      })
      // Drawn after the Stop, so its running on the stopping item is the assertion.
      .node("tail", "action", (inputs) => ({ out: inputs.in }));
    const id = h.graph({
      nodes: [
        node("n1", "t"),
        node("n2", FOREACH_TYPE),
        node("n3", "body"),
        node("n4", STOP_WHEN_TYPE),
        node("n5", "tail"),
      ],
      edges: [
        edge("e1", "n1", "n2", "out", "list"),
        edge("e2", "n2", "n3", "item"),
        edge("e3", "n3", "n4", "out", "when"),
        edge("e4", "n4", "n5", "out"),
      ],
    });

    await h.engine.fire(id, "n1", { out: ["a", "b", "c", "d"] });

    expect(seen).toEqual(["a", "b"]);
    // Two items ran, and the stopping one ran all the way to the end of its body.
    expect(h.provider.order).toEqual(["body", "tail", "body", "tail"]);
  });

  test("done counts the items that ran, not the length of the list", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("body", "action", (inputs) => ({ out: inputs.in === "b" }))
      .node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [
        node("n1", "t"),
        node("n2", FOREACH_TYPE),
        node("n3", "body"),
        node("n4", STOP_WHEN_TYPE),
        node("n5", "after"),
      ],
      edges: [
        edge("e1", "n1", "n2", "out", "list"),
        edge("e2", "n2", "n3", "item"),
        edge("e3", "n3", "n4", "out", "when"),
        edge("e4", "n2", "n5", "done"),
      ],
    });

    await h.engine.fire(id, "n1", { out: ["a", "b", "c", "d"] });

    expect(h.provider.executed.at(-1)?.inputs.in).toBe(2);
  });

  test("a collect two loops deep belongs to the inner one", async () => {
    // The scoping every language gives a `break`. The outer loop still collects the inner one's
    // results, which is what makes a list of lists expressible at all.
    const h = harness();
    h.provider
      .trigger("t")
      .node("inner", "action", (inputs) => ({ out: inputs.in }))
      .node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [
        node("n1", "t"),
        node("n2", FOREACH_TYPE),
        node("n3", FOREACH_TYPE),
        node("n4", "inner"),
        node("n5", COLLECT_TYPE),
        node("n6", COLLECT_TYPE),
        node("n7", "after"),
      ],
      edges: [
        edge("e1", "n1", "n2", "out", "list"),
        edge("e2", "n2", "n3", "item", "list"),
        edge("e3", "n3", "n4", "item"),
        // Inside the inner body: collects one item.
        edge("e4", "n4", "n5", "out", "value"),
        // Inside the outer body only: collects the inner loop's whole results.
        edge("e5", "n3", "n6", "results", "value"),
        edge("e6", "n2", "n7", "results"),
      ],
    });

    await h.engine.fire(id, "n1", {
      out: [
        ["a", "b"],
        ["c", "d", "e"],
      ],
    });

    expect(h.provider.executed.at(-1)?.inputs.in).toEqual([
      ["a", "b"],
      ["c", "d", "e"],
    ]);
  });

  test("a collect outside every loop fails the run and says so", async () => {
    const h = harness();
    h.provider.trigger("t");
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", COLLECT_TYPE)],
      edges: [edge("e1", "n1", "n2", "out", "value")],
    });

    await h.engine.fire(id, "n1", { out: 1 });

    expect(payloadOf(h.events, "graph.run.failed").message).toBe(
      "Collect has to be inside a For each.",
    );
  });

  test("the run row says which item the loop is on", async () => {
    // What the editor's readout polls. Asserted on the row rather than on a bus event, because the
    // row is what the API re-reads and an emit nobody wrote down is the bug this style prevents.
    const h = harness();
    const positions: unknown[] = [];
    let id = "";
    h.provider.trigger("t").node("body", "action", () => {
      positions.push(
        JSON.parse(h.store.listGraphRuns(id)[0]?.state ?? "{}").loops as Record<string, unknown>,
      );
      return { out: 1 };
    });
    id = h.graph({
      nodes: [node("n1", "t"), node("n2", FOREACH_TYPE), node("n3", "body")],
      edges: [edge("e1", "n1", "n2", "out", "list"), edge("e2", "n2", "n3", "item")],
    });

    await h.engine.fire(id, "n1", { out: ["a", "b", "c"] });

    expect(positions).toEqual([
      { n2: { at: 1, of: 3 } },
      { n2: { at: 2, of: 3 } },
      { n2: { at: 3, of: 3 } },
    ]);
    // And it is gone once the loop is over, so a finished run never claims to be mid-anything.
    expect(h.store.listGraphRuns(id)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Sources                                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe("source nodes", () => {
  test("a node with no inputs runs when something reachable consumes it", async () => {
    // Reachability is the right rule for a node that takes input. A value literal takes none, so
    // without this it would never run and everything downstream of it would skip.
    const h = harness();
    h.provider
      .trigger("t")
      .source("value", () => ({ out: "from the literal" }))
      .node("use", "action", (inputs) => ({ out: inputs.in }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "value"), node("n3", "use")],
      edges: [edge("e1", "n1", "n3", "out", "trigger"), edge("e2", "n2", "n3", "out", "in")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["value", "use"]);
    expect(h.provider.executed[1]?.inputs.in).toBe("from the literal");
  });

  test("an unwired optional input is still nothing to wait for", async () => {
    // The five id literals declare an `Id` port and almost never have one wired. Counting declared
    // ports rather than incoming edges would have left every graph saved before that port existed
    // dead from the literal down.
    const h = harness();
    h.provider
      .trigger("t")
      .optional("value", () => ({ out: "from the literal" }))
      .node("use", "action", (inputs) => ({ out: inputs.in }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "value"), node("n3", "use")],
      edges: [edge("e1", "n1", "n3", "out", "trigger"), edge("e2", "n2", "n3", "out", "in")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["value", "use"]);
    expect(h.provider.executed[1]?.inputs.in).toBe("from the literal");
  });

  test("a required input left unwired is not a source", async () => {
    // Nothing supplied it, so running it would be running against a value that does not exist. The
    // graph check refuses to save this; the engine declining to invent one is the same answer. Its
    // consumer waits on it and so never becomes ready either, which is what an unreachable feeder
    // has always done here.
    const h = harness();
    h.provider
      .trigger("t")
      .optional("needs", () => ({ out: 1 }), true)
      .node("use", "action", (inputs) => ({ out: inputs.in }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "needs"), node("n3", "use")],
      edges: [edge("e1", "n1", "n3", "out", "trigger"), edge("e2", "n2", "n3", "out", "in")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual([]);
  });

  test("a source nothing reachable consumes does not run", async () => {
    // One of these performs a VRChat read. Running it for a branch this fire never took would
    // spend the user's rate budget on nothing.
    const h = harness();
    h.provider
      .trigger("t")
      .source("value", () => ({ out: 1 }))
      .node("mine", "action", () => ({ out: 1 }))
      .node("theirs", "action", (inputs) => ({ out: inputs.in }));
    const id = h.graph({
      nodes: [
        node("n1", "t"),
        node("n2", "t"),
        node("n3", "mine"),
        node("n4", "theirs"),
        node("n5", "value"),
      ],
      edges: [
        edge("e1", "n1", "n3"),
        edge("e2", "n2", "n4"),
        // The source only feeds the *other* trigger's branch.
        edge("e3", "n5", "n4", "out", "extra"),
      ],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["mine"]);
  });

  test("an unfired trigger is never treated as a source", async () => {
    // A trigger has no inputs either. Treating one as a source would run the other root's branch
    // on every fire, which is the whole thing many-trigger graphs exist to avoid.
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "t"), node("n3", "after")],
      edges: [edge("e1", "n2", "n3")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual([]);
  });

  test("a source inside a loop is asked again for each item", async () => {
    // Which is what an author drawing a random number inside a `for each` means by it.
    const h = harness();
    let calls = 0;
    h.provider
      .trigger("t")
      .source("value", () => {
        calls += 1;
        return { out: calls };
      })
      .node("body", "action", (inputs) => ({ out: inputs.extra }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", FOREACH_TYPE), node("n3", "body"), node("n4", "value")],
      edges: [
        edge("e1", "n1", "n2", "out", "list"),
        edge("e2", "n2", "n3", "item"),
        edge("e3", "n4", "n3", "out", "extra"),
      ],
    });

    await h.engine.fire(id, "n1", { out: ["a", "b", "c"] });

    expect(calls).toBe(3);
    expect(h.provider.executed.filter((entry) => entry.type === "body")).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Failure                                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe("failure", () => {
  test("a throw with nothing wired to the error port ends the run and names the node", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("boom", "action", () => {
        throw new Error("the webhook refused");
      })
      .node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "boom"), node("n3", "after")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["boom"]);
    expect(kinds(h.events)).toEqual(["graph.run.failed"]);
    const payload = payloadOf(h.events, "graph.run.failed");
    expect(payload.node).toBe("n2");
    expect(payload.message).toBe("the webhook refused");
    expect(h.store.listGraphRuns(id)).toHaveLength(0);
  });

  test("an error port routes the failure onward and the run finishes", async () => {
    const h = harness();
    h.provider
      .trigger("t")
      .node("boom", "action", () => {
        throw new Error("nope");
      })
      .node("normal", "action", () => ({ out: 1 }))
      .node("tell", "action", () => ({ out: 2 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "boom"), node("n3", "normal"), node("n4", "tell")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3"), edge("e3", "n2", "n4", ERROR_PORT)],
    });

    await h.engine.fire(id, "n1", { out: null });

    // The success path is dead and skips; the error path runs with the message as its input.
    expect(h.provider.order).toEqual(["boom", "tell"]);
    expect(h.provider.executed[1]?.inputs.in).toBe("nope");
    expect(kinds(h.events)).toEqual(["graph.run.finished"]);
  });

  test("a node type that is not available fails the run with a readable reason", async () => {
    // The ordinary way to reach this is a plugin stopping between the arm and the fire.
    const h = harness();
    h.provider.trigger("t");
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "gone/away")],
      edges: [edge("e1", "n1", "n2")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(payloadOf(h.events, "graph.run.failed").message).toContain("gone/away");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Waiting                                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe("wait", () => {
  const waitGraph = (h: Harness, config: Record<string, string | number> = {}) =>
    h.graph({
      nodes: [
        node("n1", "t"),
        node("n2", WAIT_TYPE, { durationMs: 60_000, ...config }),
        node("n3", "after"),
      ],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3", "out")],
    });

  test("parks the run, and nothing downstream has happened yet", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = waitGraph(h);

    await h.engine.fire(id, "n1", { out: "carried" });

    const runs = h.store.listGraphRuns(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("waiting");
    expect(runs[0]?.wait_node).toBe("n2");
    expect(runs[0]?.resume_at).toBe(T0 + 60_000);
    expect(h.provider.order).toEqual([]);
    expect(h.events).toHaveLength(0);
  });

  test("resumes when it is due, and not before", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = waitGraph(h);
    await h.engine.fire(id, "n1", { out: "carried" });

    h.now = T0 + 59_000;
    await h.engine.resumeDue();
    expect(h.provider.order).toEqual([]);

    h.now = T0 + 60_000;
    await h.engine.resumeDue();
    expect(h.provider.order).toEqual(["after"]);
    // The wait passes its input through, so a run can carry a value across the pause.
    expect(h.provider.executed[0]?.inputs.in).toBe("carried");
    expect(h.store.listGraphRuns(id)).toHaveLength(0);
  });

  test("survives a restart: a second engine on the same database finishes the run", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = waitGraph(h);
    await h.engine.fire(id, "n1", { out: "carried" });
    await h.engine.stop();

    // Everything the first process knew is gone except the row. That is the point of the table.
    const second = h.restart();
    h.now = T0 + 60_000;
    await second.start();

    expect(h.provider.order).toEqual(["after"]);
    expect(h.store.listGraphRuns(id)).toHaveLength(0);
    await second.stop();
  });

  test("a wait missed by hours is given up when the author said to skip it", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = waitGraph(h, { onMissed: "skip" });
    await h.engine.fire(id, "n1", { out: null });

    h.now = T0 + 4 * 3_600_000;
    await h.engine.resumeDue();

    expect(h.provider.order).toEqual([]);
    expect(kinds(h.events)).toEqual(["graph.run.expired"]);
    expect(payloadOf(h.events, "graph.run.expired").node).toBe("n2");
    expect(h.store.listGraphRuns(id)).toHaveLength(0);
  });

  test("a wait missed by hours still resumes when the author said to continue", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = waitGraph(h, { onMissed: "resume" });
    await h.engine.fire(id, "n1", { out: null });

    h.now = T0 + 4 * 3_600_000;
    await h.engine.resumeDue();

    expect(h.provider.order).toEqual(["after"]);
  });

  test("a few seconds late is late, not missed", async () => {
    // A busy event loop is not a machine that was asleep, and treating the two the same would
    // expire runs on a laptop that stuttered.
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = waitGraph(h, { onMissed: "skip" });
    await h.engine.fire(id, "n1", { out: null });

    h.now = T0 + 60_000 + 5_000;
    await h.engine.resumeDue();

    expect(h.provider.order).toEqual(["after"]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Concurrency                                                                                    */
/* -------------------------------------------------------------------------------------------- */

describe("concurrency", () => {
  /** A graph that parks, so a second fire can arrive while the first run is genuinely in flight. */
  function parkingGraph(h: Harness, concurrency: string): string {
    return h.graph(
      {
        nodes: [
          node("n1", "t"),
          node("n2", WAIT_TYPE, { durationMs: 60_000 }),
          node("n3", "after"),
        ],
        edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3", "out")],
      },
      { concurrency },
    );
  }

  test("drop mode records the fire it did not honour", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = parkingGraph(h, "drop");

    await h.engine.fire(id, "n1", { out: 1 });
    await h.engine.fire(id, "n1", { out: 2 });

    expect(h.store.listGraphRuns(id)).toHaveLength(1);
    // Never silent. An automation that quietly skips is indistinguishable from a broken one.
    expect(kinds(h.events)).toEqual(["graph.run.dropped"]);
    expect(payloadOf(h.events, "graph.run.dropped").reason).toBe("busy");
  });

  test("queue mode holds the fire and starts it when the first run ends", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = parkingGraph(h, "queue");

    await h.engine.fire(id, "n1", { out: 1 });
    await h.engine.fire(id, "n1", { out: 2 });

    expect(h.store.countGraphRunsByStatus(id, "queued")).toBe(1);
    expect(h.events).toHaveLength(0);

    h.now = T0 + 60_000;
    await h.engine.resumeDue();

    // The first run finished and pulled the queued one through behind it, which parked in turn.
    expect(h.provider.order).toEqual(["after"]);
    expect(kinds(h.events)).toEqual(["graph.run.finished"]);
    expect(h.store.countGraphRunsByStatus(id, "queued")).toBe(0);
    expect(h.store.countGraphRunsByStatus(id, "waiting")).toBe(1);
  });

  test("parallel mode runs several at once, up to the cap", async () => {
    const h = harness({ maxParallelRuns: 2 });
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = parkingGraph(h, "parallel");

    await h.engine.fire(id, "n1", { out: 1 });
    await h.engine.fire(id, "n1", { out: 2 });
    await h.engine.fire(id, "n1", { out: 3 });

    expect(h.store.listGraphRuns(id)).toHaveLength(2);
    expect(kinds(h.events)).toEqual(["graph.run.dropped"]);
  });

  test("a queue that is full drops rather than growing", async () => {
    const h = harness({ maxQueuedRuns: 1 });
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = parkingGraph(h, "queue");

    await h.engine.fire(id, "n1", { out: 1 });
    await h.engine.fire(id, "n1", { out: 2 });
    await h.engine.fire(id, "n1", { out: 3 });

    expect(h.store.countGraphRunsByStatus(id, "queued")).toBe(1);
    expect(payloadOf(h.events, "graph.run.dropped").reason).toBe("queue_full");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Ceilings                                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe("ceilings", () => {
  test("the fire rate is enforced per trigger, from the definition", async () => {
    // `maxFiresPerMinute` has been a declared field since 3.10 and enforced nowhere until now.
    const h = harness();
    h.provider.trigger("t", 2).node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "after")],
      edges: [edge("e1", "n1", "n2")],
    });

    await h.engine.fire(id, "n1", { out: 1 });
    await h.engine.fire(id, "n1", { out: 2 });
    await h.engine.fire(id, "n1", { out: 3 });

    expect(h.provider.order).toEqual(["after", "after"]);
    expect(payloadOf(h.events.slice(-1), "graph.run.dropped").reason).toBe("fire_rate");

    // The window slides: a minute later the trigger is usable again.
    h.now = T0 + 61_000;
    await h.engine.fire(id, "n1", { out: 4 });
    expect(h.provider.order).toHaveLength(3);
  });

  test("a run that expands past the node ceiling fails", async () => {
    const h = harness({ maxNodesPerRun: 2 });
    h.provider.trigger("t").node("step", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "step"), node("n3", "step"), node("n4", "step")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3"), edge("e3", "n3", "n4")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["step", "step"]);
    expect(payloadOf(h.events, "graph.run.failed").message).toContain("more than 2 nodes");
  });

  test("too many runs in an hour switches the graph off, with a reason and an event", async () => {
    const h = harness({ maxRunsPerHour: 2 });
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "after")],
      edges: [edge("e1", "n1", "n2")],
    });
    await h.engine.start();

    await h.engine.fire(id, "n1", { out: 1 });
    await h.engine.fire(id, "n1", { out: 2 });
    await h.engine.fire(id, "n1", { out: 3 });

    const row = h.store.getGraph(id);
    expect(row?.enabled).toBe(0);
    expect(row?.disabled_reason).toContain("more than 2 times in an hour");
    expect(kinds(h.events)).toContain("graph.disabled");
    // Switched off means disarmed, not merely marked.
    expect(h.engine.armedCount).toBe(0);
    await h.engine.stop();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Arming and dry-run                                                                             */
/* -------------------------------------------------------------------------------------------- */

describe("arming", () => {
  test("arms trigger roots only, and a disabled graph not at all", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    h.graph({
      nodes: [node("n1", "t"), node("n2", "after")],
      edges: [edge("e1", "n1", "n2")],
    });
    h.graph({ nodes: [node("n1", "t")], edges: [] }, { id: "off", enabled: 0 });

    await h.engine.start();
    expect(h.engine.armedCount).toBe(1);
    await h.engine.stop();
    expect(h.engine.armedCount).toBe(0);
  });

  test("a trigger with an incoming edge is not a root and is not armed", async () => {
    // Whatever its definition says: nothing upstream can hand a trigger a value.
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    h.graph({
      nodes: [node("n1", "t"), node("n2", "after"), node("n3", "t")],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3")],
    });

    await h.engine.start();
    expect(h.engine.armedCount).toBe(1);
    await h.engine.stop();
  });

  test("firing through the armed trigger's own callback starts a run", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    h.graph({
      nodes: [node("n1", "t"), node("n2", "after")],
      edges: [edge("e1", "n1", "n2")],
    });
    await h.engine.start();

    const armed = [...h.provider.armed.values()][0];
    armed?.fire({ out: "from the plugin" });
    // `fire` is sync by contract, so the run is detached; one turn of the loop settles it.
    await Promise.resolve();
    await Promise.resolve();

    expect(h.provider.order).toEqual(["after"]);
    await h.engine.stop();
  });

  test("reload disarms a graph that was switched off", async () => {
    const h = harness();
    h.provider.trigger("t");
    const id = h.graph({ nodes: [node("n1", "t")], edges: [] });
    await h.engine.start();
    expect(h.engine.armedCount).toBe(1);

    h.store.setGraphEnabled(id, false);
    await h.engine.reload(id);

    expect(h.engine.armedCount).toBe(0);
    expect(h.provider.disarmed).toHaveLength(1);
    await h.engine.stop();
  });
});

describe("secrets", () => {
  test("a secret field is filled from the store and never from the document", async () => {
    // The substitution overwrites rather than filling a gap: a graph document has no business
    // carrying a token, so whatever a client wrote into that key is discarded here. The property
    // then holds at execution time regardless of what was saved.
    const store = Store.open(MEMORY);
    const bus = new EventBus();
    const provider = new FakeProvider();
    provider.trigger("t");
    provider.definitions.set("sender", {
      id: "sender",
      kind: "action",
      title: "sender",
      inputs: [{ id: "in", label: "In", type: "json" }],
      outputs: [{ id: "out", label: "out", type: "json" }],
      config: [
        { kind: "secret", id: "token", label: "Token" },
        { kind: "text", id: "url", label: "URL" },
      ],
    });
    provider.handlers.set("sender", () => ({ out: 1 }));

    const engine = new GraphEngine({
      store,
      bus,
      provider,
      sweepMs: 0,
      secrets: (graphId, nodeId, fieldId) =>
        graphId === "g1" && nodeId === "n2" && fieldId === "token" ? "s3cret" : undefined,
    });

    store.insertGraph({
      id: "g1",
      name: "g",
      description: "",
      enabled: 1,
      armed: 1,
      concurrency: "parallel",
      account_id: null,
      definition: JSON.stringify({
        nodes: [
          node("n1", "t"),
          node("n2", "sender", { token: "written by a client", url: "https://example.test" }),
        ],
        edges: [edge("e1", "n1", "n2")],
      }),
      created_at: T0,
      updated_at: T0,
    });

    await engine.fire("g1", "n1", { out: null });

    const call = provider.executed[0];
    expect(call?.config.token).toBe("s3cret");
    // Everything else in the config is untouched.
    expect(call?.config.url).toBe("https://example.test");
    store.close();
  });

  test("a secret with nothing stored arrives empty rather than as whatever was saved", async () => {
    const store = Store.open(MEMORY);
    const provider = new FakeProvider();
    provider.trigger("t");
    provider.definitions.set("sender", {
      id: "sender",
      kind: "action",
      title: "sender",
      inputs: [{ id: "in", label: "In", type: "json" }],
      outputs: [{ id: "out", label: "out", type: "json" }],
      config: [{ kind: "secret", id: "token", label: "Token" }],
    });
    provider.handlers.set("sender", () => ({ out: 1 }));
    const engine = new GraphEngine({ store, bus: new EventBus(), provider, sweepMs: 0 });

    store.insertGraph({
      id: "g1",
      name: "g",
      description: "",
      enabled: 1,
      armed: 1,
      concurrency: "parallel",
      account_id: null,
      definition: JSON.stringify({
        nodes: [node("n1", "t"), node("n2", "sender", { token: "smuggled" })],
        edges: [edge("e1", "n1", "n2")],
      }),
      created_at: T0,
      updated_at: T0,
    });

    await engine.fire("g1", "n1", { out: null });

    expect(provider.executed[0]?.config.token).toBe("");
    store.close();
  });
});

describe("dry-run", () => {
  test("an unarmed graph runs, and every node is told it is a rehearsal", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph(
      { nodes: [node("n1", "t"), node("n2", "after")], edges: [edge("e1", "n1", "n2")] },
      { armed: 0 },
    );

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.executed[0]?.context.dryRun).toBe(true);
  });

  test("arming a graph does not promote a run that is already in flight", async () => {
    // The reason `dry_run` is a column on the run rather than a read of `graphs.armed`: a run can
    // be parked for hours, and arming the graph must not make an in-flight rehearsal real.
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph(
      {
        nodes: [node("n1", "t"), node("n2", WAIT_TYPE, { durationMs: 1000 }), node("n3", "after")],
        edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3", "out")],
      },
      { armed: 0 },
    );

    await h.engine.fire(id, "n1", { out: null });
    h.store.setGraphArmed(id, true);
    h.now = T0 + 1000;
    await h.engine.resumeDue();

    expect(h.provider.executed[0]?.context.dryRun).toBe(true);
  });

  test("the acting account is the node's own, then the graph's", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "after"), node("n3", "after", { accountId: "usr_alt" })],
      edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.executed[0]?.context.accountId).toBe(ACCOUNT);
    expect(h.provider.executed[1]?.context.accountId).toBe("usr_alt");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The bugs this file did not catch                                                               */
/* -------------------------------------------------------------------------------------------- */

describe("sources, transitively", () => {
  test("a chain of sources two hops from the scope still runs", async () => {
    // `Text value -> Compose text -> Discord`, with only the last of the three reachable from the
    // trigger. The old rule looked at one node at a time and asked whether it fed the scope
    // *directly*: `Compose text` has an incoming edge so it was not a source, `Text value` fed a
    // node that was not in the scope so it was not added either, and the run finished having
    // executed nothing at all.
    const h = harness();
    h.provider
      .trigger("t")
      .source("value", () => ({ out: "hello" }))
      .node("compose", "action", (inputs) => ({ out: `${String(inputs.in)}!` }))
      .node("send", "action", (inputs) => ({ out: inputs.in }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "value"), node("n3", "compose"), node("n4", "send")],
      edges: [
        edge("e1", "n1", "n4", "out", "trigger"),
        edge("e2", "n2", "n3"),
        edge("e3", "n3", "n4", "out", "in"),
      ],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["value", "compose", "send"]);
    expect(h.provider.executed[2]?.inputs.in).toBe("hello!");
  });

  test("a chain rooted at an unfired trigger is still not a source", async () => {
    // The closure must not become a way in for the other root's branch.
    const h = harness();
    h.provider
      .trigger("t")
      .node("middle", "action", (inputs) => ({ out: inputs.in }))
      .node("send", "action", (inputs) => ({ out: inputs.in }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "t"), node("n3", "middle"), node("n4", "send")],
      edges: [
        edge("e1", "n1", "n4", "out", "trigger"),
        edge("e2", "n2", "n3"),
        edge("e3", "n3", "n4", "out", "in"),
      ],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual([]);
  });

  test("a source feeding only a nested loop belongs to the nested loop", async () => {
    // The outer body contains the inner one, so promoting the source into the outer scope ran it
    // once per outer item on top of once per inner item, and `clearScope` threw that first result
    // away unread. Two outer items of two inner items each is four asks, not six.
    const h = harness();
    let calls = 0;
    h.provider
      .trigger("t")
      .source("value", () => {
        calls += 1;
        return { out: calls };
      })
      .node("use", "action", (inputs) => ({ out: inputs.in }));
    const id = h.graph({
      nodes: [
        node("n1", "t"),
        node("outer", FOREACH_TYPE),
        node("inner", FOREACH_TYPE),
        node("n2", "value"),
        node("n3", "use"),
      ],
      edges: [
        edge("e1", "n1", "outer", "out", "list"),
        edge("e2", "outer", "inner", "item", "list"),
        edge("e3", "inner", "n3", "item", "in"),
        edge("e4", "n2", "n3", "out", "extra"),
      ],
    });

    await h.engine.fire(id, "n1", {
      out: [
        [1, 2],
        [3, 4],
      ],
    });

    expect(calls).toBe(4);
  });
});

describe("a scope that cannot drain", () => {
  test("a node blocked by something outside the scope is skipped, not left hanging", async () => {
    // `#pickNext` will not look at the dead-edge rule until every input has settled, so a node
    // waiting on the *other* trigger of a two-trigger graph was neither run nor skipped: the run
    // reported `finished` having stopped halfway, and the feed said the automation had run.
    const h = harness();
    h.provider
      .trigger("t")
      .node("both", "action", (inputs) => ({ out: inputs.in }))
      .node("after", "action", (inputs) => ({ out: inputs.in }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "t"), node("n3", "both"), node("n4", "after")],
      edges: [
        edge("e1", "n1", "n3", "out", "in"),
        edge("e2", "n2", "n3", "out", "other"),
        edge("e3", "n3", "n4"),
      ],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual([]);
    // And it really is over, rather than over-and-pretending: the run row is gone.
    expect(h.store.listGraphRuns(id)).toEqual([]);
    expect(kinds(h.events)).toContain("graph.run.finished");
  });
});

describe("what a loop leaves behind", () => {
  test("a node wired to both item and done runs once, after the loop, with the last item", async () => {
    // `foreachBodies` subtracts such a node out of the body on purpose so it runs once in the outer
    // scope. Replacing the loop's outputs with `{done, results}` alone made its `item` edge dead,
    // so the node the subtraction exists to support was silently skipped instead.
    const h = harness();
    h.provider.trigger("t").node("sum", "action", (inputs) => ({ out: inputs }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("loop", FOREACH_TYPE), node("n2", "sum")],
      edges: [
        edge("e1", "n1", "loop", "out", "list"),
        edge("e2", "loop", "n2", "item", "in"),
        edge("e3", "loop", "n2", "done", "count"),
      ],
    });

    await h.engine.fire(id, "n1", { out: ["a", "b", "c"] });

    expect(h.provider.order).toEqual(["sum"]);
    expect(h.provider.executed[0]?.inputs).toEqual({ in: "c", count: 3 });
  });

  test("an empty list produces no last item at all", async () => {
    // There is no last item, and inventing one would be worse than a dead edge.
    const h = harness();
    h.provider.trigger("t").node("sum", "action", (inputs) => ({ out: inputs }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("loop", FOREACH_TYPE), node("n2", "sum")],
      edges: [
        edge("e1", "n1", "loop", "out", "list"),
        edge("e2", "loop", "n2", "item", "in"),
        edge("e3", "loop", "n2", "done", "count"),
      ],
    });

    await h.engine.fire(id, "n1", { out: [] });

    expect(h.provider.order).toEqual([]);
  });
});

describe("ceilings that punished the wrong graph", () => {
  test("fires dropped for being busy do not count towards the runs-per-hour ceiling", async () => {
    // A `drop`-mode graph refusing two hundred fires while it executes one run is a graph obeying
    // the ceiling, and it used to be switched off for it.
    const h = harness({ maxRunsPerHour: 3 });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.provider.trigger("t").node("slow", "action", async () => {
      await held;
      return { out: 1 };
    });
    const id = h.graph(
      {
        nodes: [node("n1", "t"), node("n2", "slow")],
        edges: [edge("e1", "n1", "n2")],
      },
      { concurrency: "drop" },
    );

    const first = h.engine.fire(id, "n1", { out: null });
    for (let i = 0; i < 6; i += 1) await h.engine.fire(id, "n1", { out: null });
    release();
    await first;

    expect(h.store.getGraph(id)?.enabled).toBe(1);
    expect(kinds(h.events)).not.toContain("graph.disabled");
  });

  test("the hour window dies with the auto-disable, so re-enabling actually works", async () => {
    // Otherwise the user clears the loop, presses Enable, and the same two hundred timestamps
    // switch the graph off again before it has run once.
    const h = harness({ maxRunsPerHour: 2 });
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "after")],
      edges: [edge("e1", "n1", "n2")],
    });

    for (let i = 0; i < 3; i += 1) await h.engine.fire(id, "n1", { out: null });
    expect(h.store.getGraph(id)?.enabled).toBe(0);

    h.store.setGraphEnabled(id, true, null, h.now);
    await h.engine.reload(id);
    await h.engine.fire(id, "n1", { out: null });

    expect(h.store.getGraph(id)?.enabled).toBe(1);
  });

  test("a trigger declaring no fires of its own is held to that, not to the default", async () => {
    const h = harness();
    h.provider.trigger("t", 0).node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "after")],
      edges: [edge("e1", "n1", "n2")],
    });

    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual([]);
    expect(payloadOf(h.events, "graph.run.dropped").reason).toBe("fire_rate");
  });

  test("saving a graph does not clear the fire-rate window it is being held by", async () => {
    // Every save, enable and disable comes through `reload`, and disarming used to forget the
    // window — so pressing Save released a trigger from a ceiling it was standing at.
    const h = harness();
    h.provider.trigger("t", 1).node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("n2", "after")],
      edges: [edge("e1", "n1", "n2")],
    });
    await h.engine.start();

    await h.engine.fire(id, "n1", { out: null });
    await h.engine.reload(id);
    await h.engine.fire(id, "n1", { out: null });

    expect(h.provider.order).toEqual(["after"]);
    expect(payloadOf(h.events, "graph.run.dropped").reason).toBe("fire_rate");
  });
});

describe("what a restart finds", () => {
  test("a run left running by a crash is given up rather than occupying a slot for good", async () => {
    // `countLiveGraphRuns` counts `running`, and nothing cleared those rows: one kill at the wrong
    // moment left a `drop`-mode graph refusing every future fire with "a run is already in flight",
    // for the life of the database.
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph(
      {
        nodes: [node("n1", "t"), node("n2", "after")],
        edges: [edge("e1", "n1", "n2")],
      },
      { concurrency: "drop" },
    );
    h.store.insertGraphRun({
      id: "orphan",
      graph_id: id,
      trigger_node: "n1",
      status: "running",
      dry_run: 0,
      state: JSON.stringify({ outputs: {}, skipped: [], executed: [] }),
      started_at: h.now,
      updated_at: h.now,
    });
    expect(h.store.countLiveGraphRuns(id)).toBe(1);

    const second = h.restart();
    await second.start();

    expect(h.store.countLiveGraphRuns(id)).toBe(0);
    await second.fire(id, "n1", { out: null });
    expect(h.provider.order).toEqual(["after"]);
  });

  test("a queued fire left by a crash is started rather than stranded", async () => {
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph(
      {
        nodes: [node("n1", "t"), node("n2", "after")],
        edges: [edge("e1", "n1", "n2")],
      },
      { concurrency: "queue" },
    );
    h.store.insertGraphRun({
      id: "waiting-in-line",
      graph_id: id,
      trigger_node: "n1",
      status: "queued",
      dry_run: 0,
      state: JSON.stringify({ outputs: { n1: { out: null } }, skipped: [], executed: [] }),
      started_at: h.now,
      updated_at: h.now,
    });

    const second = h.restart();
    await second.start();

    expect(h.provider.order).toEqual(["after"]);
    expect(h.store.listGraphRuns(id)).toEqual([]);
  });
});

describe("a wait that outlived its graph", () => {
  test("a graph switched off while a run waits does not resume it", async () => {
    // The one door `fire` left open: the triggers are disarmed, but a parked row is picked up by
    // the sweep on its own time and the rest of the run went out on a graph the user had turned off.
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("w", WAIT_TYPE, { durationMs: 1000 }), node("n2", "after")],
      edges: [edge("e1", "n1", "w", "out", "in"), edge("e2", "w", "n2", "out", "in")],
    });

    await h.engine.fire(id, "n1", { out: null });
    expect(h.provider.order).toEqual([]);

    h.store.setGraphEnabled(id, false, "the user switched it off", h.now);
    h.now += 5000;
    await h.engine.resumeDue();

    expect(h.provider.order).toEqual([]);
    expect(h.store.listGraphRuns(id)).toEqual([]);
    expect(payloadOf(h.events, "graph.run.dropped").reason).toBe("unavailable");
  });

  test("a wait deleted while the run was parked gives the run up rather than resuming blind", async () => {
    // Resuming would walk a state keyed by node ids that no longer exist, and would silently ignore
    // an `onMissed: skip` set on the very node being resumed, because the policy is read off a node
    // that cannot be found.
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [
        node("n1", "t"),
        node("w", WAIT_TYPE, { durationMs: 1000, onMissed: "skip" }),
        node("n2", "after"),
      ],
      edges: [edge("e1", "n1", "w", "out", "in"), edge("e2", "w", "n2", "out", "in")],
    });

    await h.engine.fire(id, "n1", { out: null });

    const graph = h.store.getGraph(id);
    if (graph === null) throw new Error("the graph went missing");
    h.store.updateGraph(
      id,
      {
        name: graph.name,
        description: graph.description,
        concurrency: graph.concurrency,
        account_id: graph.account_id,
        definition: JSON.stringify({
          nodes: [node("n1", "t"), node("n2", "after")],
          edges: [],
        }),
      },
      h.now,
    );

    h.now += 5000;
    await h.engine.resumeDue();

    expect(h.provider.order).toEqual([]);
    expect(h.store.listGraphRuns(id)).toEqual([]);
    expect(kinds(h.events)).toContain("graph.run.failed");
  });

  test("a wait with no duration in the document waits the definition's default", async () => {
    // The daemon never applies a config default, so an imported document reaches here with no
    // `durationMs` at all. Reading that as zero parked the run in the past and continued it on the
    // very next sweep: a Wait that did not wait.
    const h = harness();
    h.provider.trigger("t").node("after", "action", () => ({ out: 1 }));
    const id = h.graph({
      nodes: [node("n1", "t"), node("w", WAIT_TYPE), node("n2", "after")],
      edges: [edge("e1", "n1", "w", "out", "in"), edge("e2", "w", "n2", "out", "in")],
    });

    await h.engine.fire(id, "n1", { out: null });
    h.now += 1000;
    await h.engine.resumeDue();
    expect(h.provider.order).toEqual([]);

    h.now += DEFAULT_WAIT_MS;
    await h.engine.resumeDue();
    expect(h.provider.order).toEqual(["after"]);
  });
});
