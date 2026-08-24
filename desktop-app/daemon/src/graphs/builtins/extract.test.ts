import { describe, expect, test } from "bun:test";
import { FIELD_CATALOGUES } from "@vrcz/api/fields";
import type { NodeConfigValues } from "@vrcz/plugin-api/nodes";
import { parseSlotRows, visibleOutputs } from "@vrcz/plugin-api/nodes";
import { extractNodes, extractValues } from "./extract.ts";
import { createBuiltinNodes } from "./index.ts";

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

  test("each one takes a json object already in hand, not an id", () => {
    // An extractor that fetched would be a second way to spend the rate budget with no way to see
    // it on the card. `Look up a user` costs the request; this reads its `Everything` port.
    for (const node of NODES) {
      const definition = node.definition;
      expect(definition.kind).toBe("action");
      if (definition.kind === "trigger") throw new Error("unreachable");
      expect(definition.inputs).toEqual([
        { id: "value", label: "From", type: "json", required: true },
      ]);
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
