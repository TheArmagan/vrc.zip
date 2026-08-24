import { describe, expect, test } from "bun:test";
import { FIELD_CATALOGUES } from "@vrcz/api/fields";
import type { NodeConfigValues } from "@vrcz/plugin-api/nodes";
import { parseSlotRows, visibleOutputs } from "@vrcz/plugin-api/nodes";
import { extractNodes, extractValues } from "./extract.ts";
import { createBuiltinNodes } from "./index.ts";
import type { GraphReads } from "./resolvers.ts";

const NODES = extractNodes();

function definitionOf(id: string) {
  const found = NODES.find((node) => node.definition.id === id);
  if (found === undefined) throw new Error(`no ${id} node`);
  return found.definition;
}

/** The rows as they are stored: a JSON array inside a string, like the `buttons` field. */
function rows(...list: { slot: string; path: string; list?: boolean }[]): NodeConfigValues {
  return { fields: JSON.stringify(list) };
}

describe("the extractor set", () => {
  test("six nodes: raw, and one per model with a schema behind it", () => {
    expect(NODES.map((node) => node.definition.id)).toEqual([
      "extract-raw",
      "extract-user",
      "extract-world",
      "extract-group",
      "extract-avatar",
      "extract-instance",
    ]);
  });

  test("they are registered as built-ins under the reserved namespace", () => {
    const builtins = createBuiltinNodes();
    for (const node of NODES) {
      expect(builtins.has(`vrcz/${node.definition.id}`)).toBe(true);
    }
  });

  test("fifteen slots, ten scalar and five list, inside the port ceiling", () => {
    for (const node of NODES) {
      const outputs = node.definition.outputs;
      expect(outputs).toHaveLength(15);
      expect(outputs.filter((port) => port.type === "json")).toHaveLength(10);
      expect(outputs.filter((port) => port.type === "list<json>")).toHaveLength(5);
      // `MAX_NODE_PORTS` is 16, and the headroom is deliberate: adding a slot later would restamp
      // every saved extractor's `defHash` and mark those graphs stale.
      expect(outputs.length).toBeLessThanOrEqual(16);
    }
  });

  test("each one takes one json input, and the port keeps its id, type and label", () => {
    // The port's *shape* is hashed into `defHash`, so this is the test that says a saved extractor
    // stays wired. Decision 278 added a description to the typed ones and nothing else: a
    // description is not hashed, and an id on this port is now looked up rather than ignored.
    for (const node of NODES) {
      const definition = node.definition;
      expect(definition.kind).toBe("action");
      if (definition.kind === "trigger") throw new Error("unreachable");
      expect(definition.inputs).toHaveLength(1);
      const port = definition.inputs[0];
      expect(port?.id).toBe("value");
      expect(port?.label).toBe("From");
      expect(port?.type).toBe("json");
      expect(port?.required).toBe(true);
    }
  });

  test("the typed ones say on the card that an id costs a request; raw says nothing", () => {
    for (const node of NODES) {
      const definition = node.definition;
      if (definition.kind === "trigger") throw new Error("unreachable");
      const description = definition.inputs[0]?.description ?? "";
      if (definition.id === "extract-raw") {
        expect(description).toBe("");
        continue;
      }
      expect(description).toContain("costs a request");
    }
  });

  test("every one points its variadic outputs at the field it actually declares", () => {
    for (const node of NODES) {
      const definition = node.definition;
      if (definition.kind === "trigger") throw new Error("unreachable");
      expect(definition.variadicOutputs).toBe("fields");
      expect(definition.config?.map((field) => field.id)).toEqual(["fields"]);
    }
  });

  test("raw takes typed paths; the typed ones offer their model's catalogue", () => {
    const raw = definitionOf("extract-raw");
    expect(raw.config?.[0]?.kind).toBe("paths");

    const user = definitionOf("extract-user").config?.[0];
    if (user?.kind !== "fields") throw new Error("expected a fields picker");
    expect(user.options.length).toBe(FIELD_CATALOGUES.user?.length ?? 0);
    expect(user.options.length).toBeGreaterThan(0);
    expect(user.options.some((option) => option.value === "displayName")).toBe(true);
    // The catalogue's list flag is what decides which bank of slots a row lands on.
    expect(user.options.find((option) => option.value === "tags")?.list).toBe(true);
    expect(user.options.find((option) => option.value === "displayName")?.list).toBe(false);
  });

  test("a typed node arrives with one row, so a fresh card is never portless", () => {
    for (const id of ["user", "world", "group", "avatar", "instance"]) {
      const field = definitionOf(`extract-${id}`).config?.[0];
      if (field?.kind !== "fields") throw new Error("expected a fields picker");
      const parsed = parseSlotRows(field.default);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.slot).toBe("o1");
      expect(parsed[0]?.label).toBe("Name");
      // The default has to name a field the picker actually offers, or the row opens as "not in
      // this version" on a node nobody has touched.
      expect(field.options.some((option) => option.value === parsed[0]?.path)).toBe(true);
    }
  });

  test("the default row draws exactly one port", () => {
    const definition = definitionOf("extract-user");
    const field = definition.config?.[0];
    if (field?.kind !== "fields") throw new Error("expected a fields picker");
    const shown = visibleOutputs(definition, { fields: field.default ?? "" });
    expect(shown.map((port) => [port.id, port.label])).toEqual([["o1", "Name"]]);
  });
});

describe("extractValues", () => {
  const user = {
    displayName: "Ada",
    status: "active",
    statusDescription: "",
    tags: ["system_trust_veteran", "language_eng"],
    friendKey: null,
    nested: { deep: 7 },
  };

  test("one output per claimed slot, keyed by the slot", () => {
    expect(
      extractValues(
        { value: user },
        rows({ slot: "o1", path: "displayName" }, { slot: "o2", path: "nested.deep" }),
      ),
    ).toEqual({ o1: "Ada", o2: 7 });
  });

  test("a path that finds nothing leaves its own port empty and no other", () => {
    // The per-slot rule. `Read field` gates the run when a path misses; here the miss kills only
    // the edges out of that one slot, so a graph that wanted the name still gets it.
    const out = extractValues(
      { value: user },
      rows({ slot: "o1", path: "displayName" }, { slot: "o2", path: "pronouns" }),
    );
    expect(out).toEqual({ o1: "Ada" });
    expect("o2" in out).toBe(false);
  });

  test("a value that is present but empty is still a value", () => {
    // VRChat returns `""` rather than nothing for an unset field, and an empty status message is a
    // fact about the user rather than an absence.
    expect(extractValues({ value: user }, rows({ slot: "o1", path: "statusDescription" }))).toEqual(
      {
        o1: "",
      },
    );
    expect(extractValues({ value: user }, rows({ slot: "o1", path: "friendKey" }))).toEqual({
      o1: null,
    });
  });

  test("a list row produces on its list slot", () => {
    expect(extractValues({ value: user }, rows({ slot: "l1", path: "tags", list: true }))).toEqual({
      l1: ["system_trust_veteran", "language_eng"],
    });
  });

  test("a list slot whose value is not a list produces nothing", () => {
    // The author said this field holds several of something. Handing a `For each` a single object
    // because VRChat answered with one would be the node deciding it knew better.
    expect(
      extractValues({ value: user }, rows({ slot: "l1", path: "displayName", list: true })),
    ).toEqual({});
  });

  test("the row's own list flag is ignored: the slot's declared type decides", () => {
    // A hand-edited document can disagree with itself. The slot is what an edge is wired to and
    // what the type check ran against, so the slot wins.
    expect(extractValues({ value: user }, rows({ slot: "o1", path: "tags", list: false }))).toEqual(
      {
        o1: ["system_trust_veteran", "language_eng"],
      },
    );
    expect(extractValues({ value: user }, rows({ slot: "l1", path: "tags", list: false }))).toEqual(
      {
        l1: ["system_trust_veteran", "language_eng"],
      },
    );
  });

  test("a slot this node does not have is skipped", () => {
    expect(extractValues({ value: user }, rows({ slot: "o99", path: "displayName" }))).toEqual({});
    expect(extractValues({ value: user }, rows({ slot: "", path: "displayName" }))).toEqual({});
  });

  test("the first row claiming a slot wins, matching what the editor draws", () => {
    expect(
      extractValues(
        { value: user },
        rows({ slot: "o1", path: "displayName" }, { slot: "o1", path: "status" }),
      ),
    ).toEqual({ o1: "Ada" });
  });

  test("no rows, a malformed value, and no input each produce nothing rather than throwing", () => {
    expect(extractValues({ value: user }, {})).toEqual({});
    expect(extractValues({ value: user }, { fields: "not json" })).toEqual({});
    expect(extractValues({}, rows({ slot: "o1", path: "displayName" }))).toEqual({});
  });

  test("it is pure: the same inputs answer the same way, and nothing is mutated", () => {
    const config = rows(
      { slot: "o1", path: "displayName" },
      { slot: "l1", path: "tags", list: true },
    );
    const first = extractValues({ value: user }, config);
    expect(extractValues({ value: user }, config)).toEqual(first);
    expect(user.tags).toEqual(["system_trust_veteran", "language_eng"]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Decision 278: a typed extractor handed an id looks it up                                       */
/* -------------------------------------------------------------------------------------------- */

describe("an id on the From port", () => {
  /** Every call this made, so a test can say "one request" or "none" rather than only "it worked". */
  function fakeReads() {
    const calls: string[] = [];
    const reads = {
      user: async (account: string, id: string) => {
        calls.push(`user ${account} ${id}`);
        return await Promise.resolve({ displayName: "Ada" });
      },
      world: async (account: string, id: string) => {
        calls.push(`world ${account} ${id}`);
        return await Promise.resolve({ name: "The Black Cat" });
      },
      instance: async (account: string, location: string) => {
        calls.push(`instance ${account} ${location}`);
        return await Promise.resolve({ worldId: "wrld_0ae3", userCount: 12 });
      },
      avatar: async (account: string, id: string) => {
        calls.push(`avatar ${account} ${id}`);
        return await Promise.resolve({ name: "Robot" });
      },
      group: async (account: string, id: string) => {
        calls.push(`group ${account} ${id}`);
        return await Promise.resolve({ name: "avtr.zip" });
      },
      friends: async () => await Promise.resolve([]),
      instancePlayers: () => ({ names: [], users: [] }),
    };
    return { reads, calls };
  }

  const context = {
    graphId: "g1",
    runId: "r1",
    nodeId: "n1",
    dryRun: false,
    accountId: "usr_me",
  };

  function nodeFor(id: string, reads?: GraphReads) {
    const found = extractNodes(reads).find((node) => node.definition.id === id);
    if (found?.execute === undefined) throw new Error(`no ${id} node`);
    return found.execute;
  }

  test("an instance location is looked up, which is the wire the palette invites", async () => {
    // `When someone joins your instance` hands out an `instance`, and `assignable` lets it into a
    // json port. Before decision 278 this produced nothing at all and the whole branch below it
    // skipped in silence.
    const { reads, calls } = fakeReads();
    const out = await nodeFor("extract-instance", reads)(
      { value: "wrld_0ae3:12345~region(eu)" },
      rows({ slot: "o2", path: "worldId" }),
      context,
    );
    expect(out).toEqual({ o2: "wrld_0ae3" });
    expect(calls).toEqual(["instance usr_me wrld_0ae3:12345~region(eu)"]);
  });

  test("a group id is looked up", async () => {
    const { reads, calls } = fakeReads();
    const out = await nodeFor("extract-group", reads)(
      { value: "grp_3392dcb3" },
      rows({ slot: "o1", path: "name" }),
      context,
    );
    expect(out).toEqual({ o1: "avtr.zip" });
    expect(calls).toEqual(["group usr_me grp_3392dcb3"]);
  });

  test("the other three models, each against its own prefix", async () => {
    const cases = [
      { id: "extract-user", value: "usr_ada", path: "displayName", expected: "Ada" },
      { id: "extract-world", value: "wrld_cat", path: "name", expected: "The Black Cat" },
      { id: "extract-avatar", value: "avtr_robot", path: "name", expected: "Robot" },
    ];
    for (const entry of cases) {
      const { reads, calls } = fakeReads();
      const out = await nodeFor(entry.id, reads)(
        { value: entry.value },
        rows({ slot: "o1", path: entry.path }),
        context,
      );
      expect(out).toEqual({ o1: entry.expected });
      expect(calls).toHaveLength(1);
    }
  });

  test("an object is untouched, and costs nothing", async () => {
    // The path this node was built for. A `Look up a user` already paid for the request; reading
    // its `Everything` port must not pay again.
    const { reads, calls } = fakeReads();
    const out = await nodeFor("extract-user", reads)(
      { value: { displayName: "Grace" } },
      rows({ slot: "o1", path: "displayName" }),
      context,
    );
    expect(out).toEqual({ o1: "Grace" });
    expect(calls).toEqual([]);
  });

  test("a bare world id is not an instance, and a location is not a world", async () => {
    // The colon is the whole test. Chaining two requests to get from one to the other would be the
    // node deciding which of two different questions the author meant.
    const first = fakeReads();
    expect(
      await nodeFor("extract-instance", first.reads)(
        { value: "wrld_cat" },
        rows({ slot: "o1", path: "worldId" }),
        context,
      ),
    ).toEqual({});
    expect(first.calls).toEqual([]);

    const second = fakeReads();
    expect(
      await nodeFor("extract-world", second.reads)(
        { value: "wrld_cat:12345" },
        rows({ slot: "o1", path: "name" }),
        context,
      ),
    ).toEqual({});
    expect(second.calls).toEqual([]);
  });

  test("private, traveling and offline are locations with nothing behind them", async () => {
    for (const value of ["private", "traveling", "offline", ""]) {
      const { reads, calls } = fakeReads();
      expect(
        await nodeFor("extract-instance", reads)(
          { value },
          rows({ slot: "o1", path: "worldId" }),
          context,
        ),
      ).toEqual({});
      expect(calls).toEqual([]);
    }
  });

  test("raw never resolves: it has no model to resolve against", async () => {
    const { reads, calls } = fakeReads();
    expect(
      await nodeFor("extract-raw", reads)(
        { value: "usr_ada" },
        rows({ slot: "o1", path: "displayName" }),
        context,
      ),
    ).toEqual({});
    expect(calls).toEqual([]);
  });

  test("no account is a sentence, not a silent nothing", async () => {
    const { reads } = fakeReads();
    expect(
      nodeFor("extract-group", reads)(
        { value: "grp_3392dcb3" },
        rows({ slot: "o1", path: "name" }),
        { ...context, accountId: null },
      ),
    ).rejects.toThrow(/No account is set/);
  });

  test("a daemon with no VRChat behind it falls back to the old silence", async () => {
    expect(
      await nodeFor("extract-group")(
        { value: "grp_3392dcb3" },
        rows({ slot: "o1", path: "name" }),
        context,
      ),
    ).toEqual({});
  });

  test("a failed lookup throws, so it lands on the node's error port", async () => {
    // The resolvers' rule, and the reason it is theirs: "VRChat said no" is a thing the author
    // should see on the run, and `on error` is right there for anyone who would rather handle it.
    const reads = {
      ...fakeReads().reads,
      group: async () => await Promise.reject(new Error("404")),
    };
    expect(
      nodeFor("extract-group", reads)(
        { value: "grp_3392dcb3" },
        rows({ slot: "o1", path: "name" }),
        context,
      ),
    ).rejects.toThrow("404");
  });
});
