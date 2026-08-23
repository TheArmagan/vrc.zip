import { describe, expect, test } from "bun:test";
import type { NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import type { GraphDocument, GraphEdge, GraphNode } from "@vrcz/shared";
import type { BusEvent } from "../bus/event-bus.ts";
import { EventBus } from "../bus/event-bus.ts";
import { MEMORY, Store } from "../store/store.ts";
import { GraphEngine } from "./engine.ts";
import { BRANCH_TYPE, ERROR_PORT, FOREACH_TYPE, WAIT_TYPE } from "./intrinsics.ts";
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
  readonly executed: { type: string; inputs: PortValues; context: ExecuteContext }[] = [];

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
    this.executed.push({ type, inputs, context });
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
  bus.subscribe((event) => {
    events.push(event);
  });

  const state = { now: T0 };
  const engine = makeEngine(store, bus, provider, limits, () => state.now, errors);

  return {
    store,
    bus,
    provider,
    engine,
    events,
    errors,
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
      return makeEngine(store, bus, provider, limits, () => state.now, errors);
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
): GraphEngine {
  return new GraphEngine({
    store,
    bus,
    provider,
    now,
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
