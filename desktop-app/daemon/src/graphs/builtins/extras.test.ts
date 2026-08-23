import { describe, expect, test } from "bun:test";
import type { NodeConfigValues, PortValues } from "@vrcz/plugin-api/nodes";
import { EventBus } from "../../bus/event-bus.ts";
import type { ExecuteContext } from "../types.ts";
import { createBuiltinNodes, type GraphReads, type GraphStateStore } from "./index.ts";
import { formatTime, matchesQuery, parseClock, withinWindow } from "./operators.ts";

/**
 * The nodes added after Phase 4 closed: values, resolvers, operators, and the two that remember.
 *
 * The pure ones are asserted through their exported helpers where the logic lives, and through the
 * node where the wiring does. The resolvers get a fake `GraphReads`, which is the whole point of
 * that interface being four methods rather than a `ControlDeps`.
 */

const T0 = 1_700_000_000_000;

/** A store that remembers, without SQLite. Three lines, as the seam promised. */
function memoryState(): GraphStateStore & {
  rows: Map<string, { value: string; updatedAt: number }>;
} {
  const rows = new Map<string, { value: string; updatedAt: number }>();
  return {
    rows,
    get: (graphId, nodeId, key) => rows.get(`${graphId}\n${nodeId}\n${key}`) ?? null,
    put: (graphId, nodeId, key, value, now) => {
      rows.set(`${graphId}\n${nodeId}\n${key}`, { value, updatedAt: now });
    },
  };
}

const READS: GraphReads = {
  user: async (_accountId, userId) =>
    await Promise.resolve({
      id: userId,
      displayName: "Ada",
      status: "join me",
      statusDescription: "come say hi",
      trustLevel: "trusted",
      location: "wrld_x:12345",
      isFriend: true,
    }),
  world: async () =>
    await Promise.resolve({ name: "The Great Pug", authorName: "Xiexe", capacity: 40 }),
  instance: async () =>
    await Promise.resolve({
      worldId: "wrld_x",
      type: "public",
      region: "eu",
      userCount: 12,
      capacity: 40,
      full: false,
    }),
  avatar: async () => await Promise.resolve({ name: "Robot", authorName: "Someone" }),
  group: async () => await Promise.resolve({ name: "Movie Night", memberCount: 231 }),
  friends: async () =>
    await Promise.resolve([
      { id: "usr_a", displayName: "Ada", status: "active" },
      { id: "usr_b", displayName: "Grace", status: "offline" },
    ]),
  instancePlayers: () => ({ names: ["Ada", "Grace"], users: ["usr_a"] }),
};

function harness(options: { state?: GraphStateStore; now?: () => number } = {}) {
  const nodes = createBuiltinNodes({
    bus: new EventBus(),
    now: options.now ?? (() => T0),
    reads: READS,
    ...(options.state === undefined ? {} : { state: options.state }),
  });
  return {
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

describe("value nodes", () => {
  test("each literal has its own typed output", async () => {
    const h = harness();
    expect(await h.run("text-value", {}, { value: "hello" })).toEqual({ value: "hello" });
    expect(await h.run("number-value", {}, { value: 42 })).toEqual({ value: 42 });
    expect(await h.run("boolean-value", {}, { value: true })).toEqual({ value: true });
    expect(await h.run("user-value", {}, { value: "usr_a" })).toEqual({ value: "usr_a" });
  });

  test("a number typed as text still comes out a number", async () => {
    // Config fields arrive as strings from a form; a `number` port has to carry a number.
    const h = harness();
    expect(await h.run("number-value", {}, { value: "42" })).toEqual({ value: 42 });
    expect(await h.run("number-value", {}, { value: "nonsense" })).toEqual({ value: 0 });
  });

  test("they are sources: no inputs at all", () => {
    const h = harness();
    const definition = h.nodes.definition("vrcz/text-value");
    expect(definition?.kind).not.toBe("trigger");
    expect(definition !== null && "inputs" in definition ? definition.inputs : []).toEqual([]);
  });

  test("JSON that will not parse produces nothing rather than a broken string", async () => {
    const h = harness();
    expect(await h.run("json-value", {}, { value: '{"a":1}' })).toEqual({ value: { a: 1 } });
    expect(await h.run("json-value", {}, { value: "{ oops" })).toEqual({});
  });

  test("now answers with the clock it was given", async () => {
    const h = harness();
    expect(await h.run("now")).toEqual({ at: T0, iso: new Date(T0).toISOString() });
  });

  test("a random number stays inside its bounds, even swapped", async () => {
    const h = harness();
    for (let i = 0; i < 50; i += 1) {
      const { value } = await h.run("random-number", {}, { min: 100, max: 1 });
      expect(typeof value === "number" && value >= 1 && value <= 100).toBe(true);
    }
  });
});

describe("resolver nodes", () => {
  test("a user resolves to typed ports and the whole object", async () => {
    const h = harness();
    const result = await h.run("get-user", { user: "usr_a" });
    expect(result).toMatchObject({
      name: "Ada",
      status: "join me",
      trust: "trusted",
      location: "wrld_x:12345",
      isFriend: true,
    });
    expect(result.user).toMatchObject({ id: "usr_a" });
  });

  test("an absent location is absent, not empty", async () => {
    // An empty `instance` would flow into an invite node and produce a request about nowhere.
    const nodes = createBuiltinNodes({
      bus: new EventBus(),
      reads: { ...READS, user: async () => await Promise.resolve({ displayName: "Ada" }) },
    });
    const result = await nodes.execute(
      "vrcz/get-user",
      { user: "usr_a" },
      {},
      { graphId: "g1", runId: "r1", nodeId: "n1", dryRun: false, accountId: "usr_me" },
    );
    expect("location" in result).toBe(false);
  });

  test("world, instance, avatar and group each answer", async () => {
    const h = harness();
    expect(await h.run("get-world", { world: "wrld_x" })).toMatchObject({
      name: "The Great Pug",
      capacity: 40,
    });
    expect(await h.run("get-instance", { instance: "wrld_x:1" })).toMatchObject({
      world: "wrld_x",
      users: 12,
      full: false,
    });
    expect(await h.run("get-avatar", { avatar: "avtr_1" })).toMatchObject({ name: "Robot" });
    expect(await h.run("get-group", { group: "grp_1" })).toMatchObject({ members: 231 });
  });

  test("the friend list is a list<friend>, which foreach can walk", async () => {
    const h = harness();
    expect(await h.run("friends")).toEqual({
      friends: ["usr_a", "usr_b"],
      names: ["Ada", "Grace"],
      count: 2,
    });
  });

  test("who is here comes from the log and needs no account", async () => {
    const h = harness();
    expect(await h.run("instance-players", {}, {}, { accountId: null })).toEqual({
      names: ["Ada", "Grace"],
      users: ["usr_a"],
      count: 2,
    });
  });

  test("a graph with no account says so rather than guessing whose eyes to use", async () => {
    const h = harness();
    await expect(h.run("get-user", { user: "usr_a" }, {}, { accountId: null })).rejects.toThrow(
      /No account is set/,
    );
  });
});

describe("operator nodes", () => {
  test("maths, and division by zero produces nothing", async () => {
    const h = harness();
    expect(await h.run("math", { a: 2, b: 3 }, { op: "add" })).toEqual({ result: 5 });
    expect(await h.run("math", { a: 7, b: 2 }, { op: "sub" })).toEqual({ result: 5 });
    // Nothing rather than Infinity: a graph that sends "Infinity" to somebody is worse than one
    // that stops.
    expect(await h.run("math", { a: 1, b: 0 }, { op: "div" })).toEqual({});
    expect(await h.run("math", { a: 1 }, { op: "add", value: 41 })).toEqual({ result: 42 });
  });

  test("text operations, and a blank find replaces nothing", async () => {
    const h = harness();
    expect(await h.run("text-op", { text: "ada" }, { op: "upper" })).toEqual({ text: "ADA" });
    expect(await h.run("text-op", { text: "  x " }, { op: "trim" })).toEqual({ text: "x" });
    expect(
      await h.run("text-op", { text: "a-b" }, { op: "replace", find: "-", replace: " " }),
    ).toEqual({ text: "a b" });
    // `replaceAll("")` would insert between every character, which nobody has ever wanted.
    expect(await h.run("text-op", { text: "ab" }, { op: "replace", replace: "!" })).toEqual({
      text: "ab",
    });
  });

  test("split and join round-trip", async () => {
    const h = harness();
    expect(await h.run("split", { text: "a,b,c" }, { separator: "," })).toEqual({
      parts: ["a", "b", "c"],
    });
    expect(await h.run("join", { list: ["a", "b"] }, { separator: " and " })).toEqual({
      text: "a and b",
    });
  });

  test("a timestamp becomes something readable", () => {
    expect(formatTime(T0, "iso")).toBe(new Date(T0).toISOString());
    expect(formatTime(Number.NaN, "iso")).toBe("");
  });

  test("a clock window wraps over midnight", () => {
    // "Only between 9pm and 2am" is one evening, not an empty set — the commonest use of the node.
    expect(parseClock("21:00")).toBe(21 * 60);
    expect(parseClock("9pm")).toBeNull();
    expect(parseClock("25:00")).toBeNull();

    const at = (hour: number): number => new Date(2026, 0, 1, hour, 30).getTime();
    expect(withinWindow(at(22), 21 * 60, 2 * 60)).toBe(true);
    expect(withinWindow(at(1), 21 * 60, 2 * 60)).toBe(true);
    expect(withinWindow(at(12), 21 * 60, 2 * 60)).toBe(false);
    expect(withinWindow(at(12), 9 * 60, 17 * 60)).toBe(true);
  });

  test("an unreadable window fails closed", async () => {
    // A gate exists to hold things back, so a typo in one must not let everything through.
    const h = harness();
    expect(await h.run("time-window", { payload: "x" }, { from: "nonsense", to: "02:00" })).toEqual(
      {},
    );
  });

  test("searching a list matches text and regex, and is case-insensitive by default", () => {
    expect(matchesQuery("Ada Lovelace", "ada", "contains", false)).toBe(true);
    expect(matchesQuery("Ada Lovelace", "ada", "contains", true)).toBe(false);
    expect(matchesQuery("Ada", "^A", "regex", false)).toBe(true);
    expect(matchesQuery("Ada", "([", "regex", false)).toBe(false);
    expect(matchesQuery("Ada", "Ada", "equals", false)).toBe(true);
  });

  test("search returns the matches, the first, and how many", async () => {
    const h = harness();
    const list = [{ displayName: "Ada" }, { displayName: "Grace" }, { displayName: "Adam" }];
    const result = await h.run("find-in-list", { list, query: "ada" }, { path: "displayName" });
    expect(result.count).toBe(2);
    expect(result.first).toEqual({ displayName: "Ada" });

    // Nothing found means no `first` at all, so "and then message them" stops rather than acting
    // on nobody.
    const none = await h.run("find-in-list", { list, query: "zzz" }, { path: "displayName" });
    expect(none.count).toBe(0);
    expect("first" in none).toBe(false);
  });

  test("picking at random from an empty list produces nothing", async () => {
    const h = harness();
    expect(await h.run("random-item", { list: [] })).toEqual({});
    expect(await h.run("random-item", { list: ["only"] })).toEqual({ item: "only" });
  });
});

describe("stateful nodes", () => {
  test("a cooldown lets the first through and holds the rest back", async () => {
    let now = T0;
    const state = memoryState();
    const h = harness({ state, now: () => now });

    expect(await h.run("cooldown", { key: "usr_a" }, { windowMs: 1000 })).toEqual({ out: true });
    expect(await h.run("cooldown", { key: "usr_a" }, { windowMs: 1000 })).toEqual({});

    now = T0 + 1000;
    expect(await h.run("cooldown", { key: "usr_a" }, { windowMs: 1000 })).toEqual({ out: true });
  });

  test("it is per key, so one person being noisy does not silence another", async () => {
    const state = memoryState();
    const h = harness({ state });
    expect(await h.run("cooldown", { key: "usr_a" }, { windowMs: 1000 })).toEqual({ out: true });
    expect(await h.run("cooldown", { key: "usr_b" }, { windowMs: 1000 })).toEqual({ out: true });
    expect(await h.run("cooldown", { key: "usr_a" }, { windowMs: 1000 })).toEqual({});
  });

  test("an unwired key is one shared cooldown rather than none", async () => {
    const state = memoryState();
    const h = harness({ state });
    expect(await h.run("cooldown", {}, { windowMs: 1000 })).toEqual({ out: true });
    expect(await h.run("cooldown", {}, { windowMs: 1000 })).toEqual({});
  });

  test("a counter counts, and can start over on a window", async () => {
    let now = T0;
    const state = memoryState();
    const h = harness({ state, now: () => now });

    expect(await h.run("counter", {}, { resetAfterMs: 1000 })).toEqual({ count: 1 });
    expect(await h.run("counter", {}, { resetAfterMs: 1000 })).toEqual({ count: 2 });
    expect(await h.run("counter", { by: 5 }, { resetAfterMs: 1000 })).toEqual({ count: 7 });

    now = T0 + 1000;
    expect(await h.run("counter", {}, { resetAfterMs: 1000 })).toEqual({ count: 1 });
  });

  test("a set built with nowhere to remember offers neither node", () => {
    // Unlike a resolver, a stateful node with no store cannot even fail usefully.
    const nodes = createBuiltinNodes({ bus: new EventBus() });
    expect(nodes.has("vrcz/cooldown")).toBe(false);
    expect(nodes.has("vrcz/counter")).toBe(false);
  });
});

describe("the palette", () => {
  test("no two built-in nodes share a title", () => {
    // Two entries reading "Count" is a palette nobody can choose from — which is exactly what
    // shipped for an hour, until somebody looked at the list. The search box makes titles the
    // primary way a node is found, so a collision is a real defect rather than an untidiness.
    const nodes = createBuiltinNodes({
      bus: new EventBus(),
      reads: READS,
      state: memoryState(),
    });
    const titles = nodes.definitions().map((definition) => definition.title);
    const duplicates = titles.filter((title, index) => titles.indexOf(title) !== index);
    expect(duplicates).toEqual([]);
  });

  test("every built-in has a category, so the palette can group it", () => {
    const nodes = createBuiltinNodes({ bus: new EventBus(), reads: READS, state: memoryState() });
    for (const definition of nodes.definitions()) {
      expect(definition.category ?? "", definition.id).not.toBe("");
    }
  });
});
