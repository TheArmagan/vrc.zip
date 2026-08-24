import { describe, expect, test } from "bun:test";
import type { NodeConfigValues, PortValues } from "@vrcz/plugin-api/nodes";
import { type BusEvent, EventBus } from "../../bus/event-bus.ts";
import type { ExecuteContext } from "../types.ts";
import { itemKey, sameItem } from "./collections.ts";
import {
  DEFAULT_STORE,
  type GraphDataStore,
  LIST_COLLECTION,
  MAX_STORED_LIST_ITEMS,
  mapCollection,
  setCollection,
} from "./data-store.ts";
import { createBuiltinNodes, type GraphStateStore } from "./index.ts";
import { LOCAL_SIGNAL_KIND, SIGNAL_KIND, signalKinds } from "./signals.ts";

/**
 * The three families added for shared data: collections on a wire, collections in a named store,
 * and signals between graphs.
 *
 * The interesting assertions are all about the *difference* between the two collection families —
 * one persists and is shared, one does not and is not — and about the two places the local/global
 * split in signals is enforced. A node that merely returns the right array is the easy half.
 */

const T0 = 1_700_000_000_000;

/** The named stores, without SQLite. `Map` per (store, collection, key), like the real primary key. */
function memoryData(): GraphDataStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const id = (store: string, collection: string, key: string) => `${store}\n${collection}\n${key}`;
  return {
    rows,
    get: (store, collection, key) => {
      const value = rows.get(id(store, collection, key));
      return value === undefined ? null : { value, updatedAt: T0 };
    },
    put: (store, collection, key, value) => {
      rows.set(id(store, collection, key), value);
    },
    remove: (store, collection, key) => {
      rows.delete(id(store, collection, key));
    },
    list: (store, collection) =>
      [...rows.entries()]
        .filter(([composite]) => composite.startsWith(`${store}\n${collection}\n`))
        .map(([composite, value]) => ({ key: composite.split("\n")[2] ?? "", value })),
    count: (store, collection) =>
      [...rows.keys()].filter((composite) => composite.startsWith(`${store}\n${collection}\n`))
        .length,
    clear: (store, collection) => {
      for (const composite of [...rows.keys()]) {
        if (composite.startsWith(`${store}\n${collection}\n`)) rows.delete(composite);
      }
    },
  };
}

function memoryState(): GraphStateStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    get: (graphId, nodeId, key) => {
      const value = rows.get(`${graphId}\n${nodeId}\n${key}`);
      return value === undefined ? null : { value, updatedAt: T0 };
    },
    put: (graphId, nodeId, key, value) => {
      rows.set(`${graphId}\n${nodeId}\n${key}`, value);
    },
  };
}

function harness(options: { data?: GraphDataStore; state?: GraphStateStore } = {}) {
  const bus = new EventBus();
  const nodes = createBuiltinNodes({
    bus,
    now: () => T0,
    ...(options.data === undefined ? {} : { data: options.data }),
    ...(options.state === undefined ? {} : { state: options.state }),
  });
  return {
    bus,
    nodes,
    run: (
      type: string,
      inputs: PortValues = {},
      config: NodeConfigValues = {},
      context: Partial<ExecuteContext> = {},
    ): Promise<PortValues> =>
      nodes.execute(`vrcz/${type}`, inputs, config, {
        graphId: "g1",
        runId: "r1",
        nodeId: "n1",
        dryRun: false,
        accountId: "usr_me",
        ...context,
      }),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Collections on a wire                                                                          */
/* -------------------------------------------------------------------------------------------- */

describe("collections", () => {
  test("an unwired input is left out, not filled with a hole", async () => {
    const h = harness();
    expect(await h.run("make-list", { a: "one", c: "three" })).toEqual({
      list: ["one", "three"],
      count: 2,
    });
  });

  test("a wired null is a real item", async () => {
    // The distinction the engine draws: a port with no entry never produced, a port holding null
    // produced null. Dropping the second would make "the value that was there" invisible.
    const h = harness();
    expect(await h.run("make-list", { a: null })).toEqual({ list: [null], count: 1 });
  });

  test("nothing is mutated in place", async () => {
    // Two edges out of one port hand the *same* array to two nodes. Appending in place would
    // rewrite what the sibling branch already read.
    const h = harness();
    const original = ["a"];
    const result = await h.run("list-append", { list: original, item: "b" });
    expect(result.list).toEqual(["a", "b"]);
    expect(original).toEqual(["a"]);
  });

  test("adding uniquely is a no-op when the item is already there", async () => {
    const h = harness();
    expect(await h.run("list-append", { list: ["a"], item: "a" }, { unique: true })).toEqual({
      list: ["a"],
      count: 1,
    });
    expect(await h.run("list-append", { list: ["a"], item: "a" }, {})).toEqual({
      list: ["a", "a"],
      count: 2,
    });
  });

  test("equality is structural, because a graph builds its objects fresh every run", () => {
    expect(sameItem({ id: "usr_a" }, { id: "usr_a" })).toBe(true);
    expect(sameItem("usr_a", "usr_a")).toBe(true);
    expect(sameItem(1, "1")).toBe(false);
    expect(itemKey("usr_a")).toBe("usr_a");
    expect(itemKey({ id: 1 })).toBe('{"id":1}');
  });

  test("a miss produces no position at all rather than a minus one", async () => {
    // A -1 in a `number` port flows into arithmetic downstream as if it meant something. An absent
    // port stops that branch, which is the rule every other node here follows.
    const h = harness();
    expect(await h.run("list-contains", { list: ["a"], item: "b" })).toEqual({ has: false });
    expect(await h.run("list-contains", { list: ["a", "b"], item: "b" })).toEqual({
      has: true,
      index: 1,
    });
  });

  test("unique keeps the first of each", async () => {
    const h = harness();
    expect(await h.run("list-unique", { list: ["a", "b", "a", "b"] })).toEqual({
      list: ["a", "b"],
      count: 2,
    });
  });

  test("taking from the end takes the newest", async () => {
    const h = harness();
    expect(await h.run("list-slice", { list: [1, 2, 3, 4] }, { from: "end", count: 2 })).toEqual({
      list: [3, 4],
      count: 2,
    });
  });

  test("taking none takes none", async () => {
    // The `min: 1` on the field is the editor's and the daemon never sees it, so a count of 0 is a
    // real state. It used to be read as "no number I like" and answered with the fallback of ten.
    const h = harness();
    expect(await h.run("list-slice", { list: [1, 2, 3, 4] }, { count: 0 })).toEqual({
      list: [],
      count: 0,
    });
    expect(await h.run("list-slice", { list: [1, 2, 3, 4] }, { from: "end", count: 0 })).toEqual({
      list: [],
      count: 0,
    });
  });

  test("an object needs both a name and a value to gain a field", async () => {
    const h = harness();
    expect(await h.run("make-object", { a: "usr_a", b: 1 }, { keyA: "user" })).toEqual({
      // `b` is wired but unnamed, and `keyC` names nothing. Either half alone puts a key in the
      // object that the author did not mean.
      object: { user: "usr_a" },
    });
  });

  test("a field name arrives from the wire or from the config, and wired wins", async () => {
    const h = harness();
    expect(
      await h.run("object-set", { object: { a: 1 }, value: 2, key: "b" }, { key: "c" }),
    ).toEqual({ object: { a: 1, b: 2 } });
    expect(await h.run("object-set", { object: { a: 1 }, value: 2 }, { key: "c" })).toEqual({
      object: { a: 1, c: 2 },
    });
    // No name from either place: nothing produced, which stops the branch instead of writing a
    // field called "".
    expect(await h.run("object-set", { object: { a: 1 }, value: 2 }, {})).toEqual({});
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Named stores                                                                                   */
/* -------------------------------------------------------------------------------------------- */

describe("stored data", () => {
  test("a daemon with no store does not offer the nodes at all", () => {
    // Unlike the resolvers, which stay and fail with a sentence: a `Map: set` with nowhere to write
    // would report having saved something that was never there to read back.
    const h = harness();
    expect(h.nodes.has("vrcz/store-map-set")).toBe(false);
    expect(h.nodes.has("vrcz/make-list")).toBe(true);
  });

  test("two graphs naming the same store see the same data", async () => {
    // The whole point of the feature. Same store, different graph ids.
    const data = memoryData();
    const h = harness({ data });
    await h.run("store-value-set", { value: "hello" }, { key: "greeting" }, { graphId: "one" });
    expect(await h.run("store-value-get", {}, { key: "greeting" }, { graphId: "two" })).toEqual({
      value: "hello",
      found: true,
    });
  });

  test("different stores do not", async () => {
    const data = memoryData();
    const h = harness({ data });
    await h.run("store-value-set", { value: "hello" }, { key: "greeting", store: "mine" });
    expect(await h.run("store-value-get", {}, { key: "greeting", store: "yours" })).toEqual({
      found: false,
    });
  });

  test("a miss answers the question and produces no value", async () => {
    // So `Load a value` works as a condition and as a source, without the caller choosing.
    const h = harness({ data: memoryData() });
    expect(await h.run("store-value-get", {}, { key: "nothing" })).toEqual({ found: false });
  });

  test("a rehearsal writes, because a rehearsal that forgot would repeat itself once armed", async () => {
    const data = memoryData();
    const h = harness({ data });
    await h.run("store-set-add", { item: "usr_a" }, { name: "welcomed" }, { dryRun: true });
    expect(await h.run("store-set-has", { item: "usr_a" }, { name: "welcomed" })).toEqual({
      has: true,
    });
  });

  test("a set says whether the member was new, which is the half that gates", async () => {
    const h = harness({ data: memoryData() });
    const first = await h.run("store-set-add", { item: "usr_a" }, { name: "welcomed" });
    const second = await h.run("store-set-add", { item: "usr_a" }, { name: "welcomed" });
    expect(first).toEqual({ added: true, count: 1 });
    expect(second).toEqual({ added: false, count: 1 });
  });

  test("a map's fields, and emptying it", async () => {
    const h = harness({ data: memoryData() });
    await h.run("store-map-set", { value: 1, key: "a" }, { name: "counts" });
    await h.run("store-map-set", { value: 2, key: "b" }, { name: "counts" });
    expect(await h.run("store-map-entries", {}, { name: "counts" })).toEqual({
      keys: ["a", "b"],
      values: [1, 2],
      count: 2,
    });
    expect(await h.run("store-map-clear", {}, { name: "counts" })).toEqual({ removed: 2 });
    expect(await h.run("store-map-get", {}, { name: "counts", key: "a" })).toEqual({
      found: false,
    });
  });

  test("the four families do not collide inside one store", async () => {
    // They share a table. `map:x`, `set:x` and a plain value called `x` are three different things
    // and a graph is entitled to name all three the same.
    const data = memoryData();
    const h = harness({ data });
    await h.run("store-value-set", { value: "plain" }, { key: "x" });
    await h.run("store-map-set", { value: "mapped", key: "k" }, { name: "x" });
    await h.run("store-set-add", { item: "member" }, { name: "x" });
    await h.run("store-list-add", { item: "listed" }, { name: "x" });

    expect(await h.run("store-value-get", {}, { key: "x" })).toEqual({
      value: "plain",
      found: true,
    });
    expect(await h.run("store-map-get", {}, { name: "x", key: "k" })).toEqual({
      value: "mapped",
      found: true,
    });
    expect(await h.run("store-set-items", {}, { name: "x" })).toEqual({
      items: ["member"],
      count: 1,
    });
    expect(await h.run("store-list-items", {}, { name: "x" })).toEqual({
      items: ["listed"],
      count: 1,
    });
    expect(mapCollection("x")).not.toBe(setCollection("x"));
  });

  test("a capped list is a rolling log, trimmed from the far end", async () => {
    const h = harness({ data: memoryData() });
    for (const item of [1, 2, 3, 4]) {
      await h.run("store-list-add", { item }, { name: "recent", max: 2 });
    }
    expect(await h.run("store-list-items", {}, { name: "recent" })).toEqual({
      items: [3, 4],
      count: 2,
    });
  });

  test("an uncapped list still stops growing, because the whole array is one row", async () => {
    // "Keep at most 0" means no limit of the author's, and a graph appending on every join then
    // rewrites one ever-larger row forever. None of the run-size or fire-rate ceilings sees it.
    const data = memoryData();
    const h = harness({ data });
    const seeded = Array.from({ length: MAX_STORED_LIST_ITEMS }, (_, index) => index);
    data.put(DEFAULT_STORE, LIST_COLLECTION, "log", JSON.stringify(seeded));

    const result = await h.run("store-list-add", { item: "newest" }, { name: "log", max: 0 });
    expect(result.count).toBe(MAX_STORED_LIST_ITEMS);
    const items = result.items as unknown[];
    // The oldest went, the newest stayed: the ceiling behaves like the configured limit does.
    expect(items[items.length - 1]).toBe("newest");
    expect(items[0]).toBe(1);
  });

  test("two long keys sharing a prefix are two rows", async () => {
    // Keys are capped so a row stays readable, and a plain truncation made every key with the same
    // first 400 characters the same row, each write silently overwriting the last.
    const h = harness({ data: memoryData() });
    const prefix = "usr_".padEnd(600, "x");
    await h.run("store-value-set", { value: "first" }, { key: `${prefix}a` });
    await h.run("store-value-set", { value: "second" }, { key: `${prefix}b` });
    expect(await h.run("store-value-get", {}, { key: `${prefix}a` })).toEqual({
      value: "first",
      found: true,
    });
    expect(await h.run("store-value-get", {}, { key: `${prefix}b` })).toEqual({
      value: "second",
      found: true,
    });
  });

  test("an unnamed collection still produces every port it declares", async () => {
    // A node either produces all of its outputs or none on purpose. These used to answer with a
    // strict subset, so a wire out of `count` or `items` died with nothing said.
    const h = harness({ data: memoryData() });
    expect(await h.run("store-map-remove", { key: "k" }, {})).toEqual({ found: false, count: 0 });
    expect(await h.run("store-set-remove", { item: "k" }, {})).toEqual({ found: false, count: 0 });
    expect(await h.run("store-list-remove", { item: "k" }, {})).toEqual({
      removed: 0,
      items: [],
      count: 0,
    });
  });

  test("finding, removing and emptying a stored list", async () => {
    const h = harness({ data: memoryData() });
    for (const item of ["a", "b", "a"]) {
      await h.run("store-list-add", { item }, { name: "log" });
    }
    expect(await h.run("store-list-find", { item: "b" }, { name: "log" })).toEqual({
      has: true,
      index: 1,
      item: "b",
    });
    expect(await h.run("store-list-remove", { item: "a" }, { name: "log" })).toEqual({
      removed: 2,
      items: ["b"],
      count: 1,
    });
    expect(await h.run("store-list-clear", {}, { name: "log" })).toEqual({ removed: 1 });
  });

  test("a node with no collection name does nothing rather than writing under an empty one", async () => {
    const data = memoryData();
    const h = harness({ data });
    expect(await h.run("store-map-set", { value: 1, key: "a" }, {})).toEqual({});
    expect(data.rows.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Signals                                                                                        */
/* -------------------------------------------------------------------------------------------- */

async function armed(
  h: ReturnType<typeof harness>,
  config: NodeConfigValues,
  graphId = "g1",
): Promise<{ fires: PortValues[]; disarm: () => Promise<void> }> {
  const fires: PortValues[] = [];
  const instanceId = `i-${graphId}-${JSON.stringify(config)}`;
  // Awaited: `arm` records the teardown after its handler resolves, and a `disarm` that raced it
  // would leave the subscription live — which is a bug this test would then not be testing for.
  await h.nodes.arm("vrcz/on-signal", {
    instanceId,
    graphId,
    nodeId: "trigger",
    config,
    fire: (outputs) => {
      fires.push(outputs);
    },
  });
  return {
    fires,
    disarm: async () => {
      await h.nodes.disarm("vrcz/on-signal", instanceId);
    },
  };
}

describe("signals", () => {
  test("the bus does the coarse filtering, by kind", () => {
    expect(signalKinds("local")).toEqual([LOCAL_SIGNAL_KIND]);
    expect(signalKinds("global")).toEqual([SIGNAL_KIND]);
    expect(signalKinds("any")).toEqual([LOCAL_SIGNAL_KIND, SIGNAL_KIND]);
  });

  test("a local signal reaches this graph and no other", async () => {
    const h = harness();
    const mine = await armed(h, { name: "greet", scope: "any" }, "g1");
    const theirs = await armed(h, { name: "greet", scope: "any" }, "g2");

    await h.run("emit-signal", { value: { who: "usr_a" } }, { name: "greet", scope: "local" });

    expect(mine.fires).toEqual([{ value: { who: "usr_a" }, name: "greet", graph: "g1", at: T0 }]);
    expect(theirs.fires).toEqual([]);
    await mine.disarm();
    await theirs.disarm();
  });

  test("a global signal reaches every graph", async () => {
    const h = harness();
    const mine = await armed(h, { name: "greet", scope: "any" }, "g1");
    const theirs = await armed(h, { name: "greet", scope: "any" }, "g2");

    await h.run("emit-signal", {}, { name: "greet", scope: "global" });

    expect(mine.fires).toHaveLength(1);
    expect(theirs.fires).toHaveLength(1);
    await mine.disarm();
    await theirs.disarm();
  });

  test("`other graphs only` does not hear itself", async () => {
    // Which is what makes "everybody react to this except me" expressible at all.
    const h = harness();
    const mine = await armed(h, { name: "greet", scope: "global" }, "g1");
    await h.run("emit-signal", {}, { name: "greet", scope: "global" });
    expect(mine.fires).toEqual([]);
    await mine.disarm();
  });

  test("the name has to match exactly", async () => {
    const h = harness();
    const listener = await armed(h, { name: "greet", scope: "any" });
    await h.run("emit-signal", {}, { name: "farewell", scope: "global" });
    expect(listener.fires).toEqual([]);
    await listener.disarm();
  });

  test("a global signal is a feed row and a local one is not", async () => {
    // Enforced by the kind rather than by a payload field, so the feed writer never has to open a
    // payload to decide what to persist. `graph.signal.local` is in its EPHEMERAL set.
    const h = harness();
    const seen: BusEvent[] = [];
    h.bus.subscribe(
      (event) => {
        seen.push(event);
      },
      {
        kinds: [SIGNAL_KIND, LOCAL_SIGNAL_KIND],
      },
    );
    await h.run("emit-signal", {}, { name: "a", scope: "global" });
    await h.run("emit-signal", {}, { name: "b", scope: "local" });
    expect(seen.map((event) => event.kind)).toEqual([SIGNAL_KIND, LOCAL_SIGNAL_KIND]);
    // The name rides in `subjectId` so a webhook filter can match without opening the payload.
    expect(seen.map((event) => event.subjectId)).toEqual(["a", "b"]);
  });

  test("a rehearsal says nothing on the bus", async () => {
    // A global signal can start a run in an armed neighbour, which is the one thing dry-run exists
    // to prevent.
    const h = harness();
    const listener = await armed(h, { name: "greet", scope: "any" });
    const notes: BusEvent[] = [];
    h.bus.subscribe(
      (event) => {
        notes.push(event);
      },
      { kinds: ["graph.note"] },
    );

    expect(
      await h.run("emit-signal", {}, { name: "greet", scope: "global" }, { dryRun: true }),
    ).toEqual({ sent: false });
    expect(listener.fires).toEqual([]);
    expect(notes).toHaveLength(1);
    await listener.disarm();
  });

  test("`only the first time` fires once and remembers across a restart", async () => {
    const state = memoryState();
    const h = harness({ state });
    const listener = await armed(h, { name: "boot", scope: "any", once: true });
    await h.run("emit-signal", {}, { name: "boot", scope: "local" });
    await h.run("emit-signal", {}, { name: "boot", scope: "local" });
    expect(listener.fires).toHaveLength(1);
    await listener.disarm();

    // A second daemon, the same store: still silent, because the row is what remembers.
    const restarted = harness({ state });
    const again = await armed(restarted, { name: "boot", scope: "any", once: true });
    await restarted.run("emit-signal", {}, { name: "boot", scope: "local" });
    expect(again.fires).toEqual([]);
    await again.disarm();

    // And forgetting it is what the graph page's button does.
    state.rows.clear();
    const third = harness({ state });
    const third_listener = await armed(third, { name: "boot", scope: "any", once: true });
    await third.run("emit-signal", {}, { name: "boot", scope: "local" });
    expect(third_listener.fires).toHaveLength(1);
    await third_listener.disarm();
  });

  test("without a store, `only the first time` still fires once per process", async () => {
    // The honest degradation. A "once" that silently became "every time" would be worse than both.
    const h = harness();
    const listener = await armed(h, { name: "boot", scope: "any", once: true });
    await h.run("emit-signal", {}, { name: "boot", scope: "local" });
    await h.run("emit-signal", {}, { name: "boot", scope: "local" });
    expect(listener.fires).toHaveLength(1);
    await listener.disarm();
  });

  test("disarming stops the subscription", async () => {
    const h = harness();
    const listener = await armed(h, { name: "greet", scope: "any" });
    await listener.disarm();
    await h.run("emit-signal", {}, { name: "greet", scope: "local" });
    expect(listener.fires).toEqual([]);
  });
});
