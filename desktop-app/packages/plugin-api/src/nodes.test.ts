import { describe, expect, test } from "bun:test";
import {
  assignable,
  BASE_PORT_TYPES,
  canonicalNodeDefinition,
  evaluateNodeBody,
  isPortType,
  isTriggerDefinition,
  keyRowLabel,
  listElement,
  type NodeDefinition,
  nodeDefinitionHash,
  PORT_TYPES,
  type PortType,
  parseSlotRows,
  slotRowLabel,
  validateNodeDefinition,
  visibleInputCount,
  visibleInputs,
  visibleOutputs,
} from "./nodes.ts";

describe("assignable", () => {
  test("identity holds for every port type", () => {
    for (const t of PORT_TYPES) expect(assignable(t, t)).toBe(true);
  });

  test("the three scalar widening rules hold", () => {
    expect(assignable("friend", "user")).toBe(true);
    for (const t of PORT_TYPES) expect(assignable(t, "json")).toBe(true);
    // An id is a string, because that is what a domain type has always been: `user` is a user id,
    // not a user object. Refusing this meant a conversion node in front of every raw endpoint.
    for (const t of ["friend", "user", "world", "instance", "group", "avatar"] as const) {
      expect(assignable(t, "string")).toBe(true);
    }
  });

  test("no scalar rule holds in reverse", () => {
    // A node that needs friendship must be able to refuse a stranger at edit time.
    expect(assignable("user", "friend")).toBe(false);
    // `json` into a typed port is the unchecked cast that makes the type system decorative.
    for (const t of PORT_TYPES) {
      if (t === "json") continue;
      expect(assignable("json", t)).toBe(false);
    }
    // And the half of rule 4 that matters: a string is not an id. "This port needs a person" still
    // refuses a world id at edit time, and `A user` is how you say a string really is one.
    for (const t of ["friend", "user", "world", "instance", "group", "avatar"] as const) {
      expect(assignable("string", t)).toBe(false);
    }
    // Nor does an id become a different id by way of string.
    expect(assignable("world", "user")).toBe(false);
    expect(assignable("group", "avatar")).toBe(false);
  });

  test("lists widen exactly as their elements do", () => {
    expect(assignable("list<friend>", "list<user>")).toBe(true);
    expect(assignable("list<user>", "list<friend>")).toBe(false);
    expect(assignable("list<user>", "list<json>")).toBe(true);
    expect(assignable("list<json>", "list<user>")).toBe(false);
  });

  test("a list is never a scalar, in either direction", () => {
    // The distinction the type exists to draw. `list<friend>` must not reach a `user` port on the
    // strength of the friend rule, and a single user must not satisfy a port that wants several.
    expect(assignable("list<friend>", "user")).toBe(false);
    expect(assignable("user", "list<user>")).toBe(false);
    // Except through `json`, which everything erases to — including a list.
    expect(assignable("list<user>", "json")).toBe(true);
    expect(assignable("json", "list<user>")).toBe(false);
  });

  test("nothing else widens — asserted over the whole matrix", () => {
    // The point of this test is to fail loudly the day someone adds a rule. PLAN.md: every
    // additional rule is an explanation you owe a user whose edge just got refused, so a new one is
    // a decision that gets made deliberately, not one that lands in a diff nobody read. It has now
    // done its job twice — for rule 3 (lists) and rule 4 (an id is a string) — which is why the
    // expected set is spelled out rather than derived from `assignable`: a set built from the
    // function under test proves nothing.
    const ids = ["friend", "user", "world", "instance", "group", "avatar"] as const;
    const expected = new Set([
      "friend->user",
      "list<friend>->list<user>",
      ...ids.map((type) => `${type}->string`),
      ...ids.map((type) => `list<${type}>->list<string>`),
      ...BASE_PORT_TYPES.filter((type) => type !== "json").map(
        (type) => `list<${type}>->list<json>`,
      ),
    ]);
    const surprises: string[] = [];
    for (const from of PORT_TYPES) {
      for (const to of PORT_TYPES) {
        if (from === to || to === "json") continue; // identity and the erasure rule
        if (assignable(from, to) && !expected.has(`${from}->${to}`))
          surprises.push(`${from}->${to}`);
      }
    }
    expect(surprises).toEqual([]);
  });

  test("the matrix is exactly as large as the rules say", () => {
    let accepted = 0;
    for (const from of PORT_TYPES)
      for (const to of PORT_TYPES) if (assignable(from, to)) accepted++;
    const n = PORT_TYPES.length;
    const bases = BASE_PORT_TYPES.length;
    const ids = 6; // friend, user, world, instance, group, avatar
    // identity (n) + X->json for every X but json (n-1) + friend->user (1)
    // + list<X>->list<json> for every X but json (bases-1) + list<friend>->list<user> (1)
    // + id->string for every id type (ids) + the same elementwise for lists (ids)
    expect(accepted).toBe(n + (n - 1) + 1 + (bases - 1) + 1 + ids + ids);
  });

  test("nesting is not a port type", () => {
    expect(isPortType("list<list<user>>")).toBe(false);
    expect(listElement("list<user>")).toBe("user");
    expect(listElement("user")).toBeNull();
  });
});

describe("isPortType", () => {
  test("accepts members and rejects everything else", () => {
    expect(isPortType("friend")).toBe(true);
    expect(isPortType("json")).toBe(true);
    expect(isPortType("Friend")).toBe(false);
    expect(isPortType("any")).toBe(false);
    expect(isPortType(undefined)).toBe(false);
  });
});

const trigger: NodeDefinition = {
  kind: "trigger",
  id: "friend-online",
  title: "Friend comes online",
  category: "Friends",
  config: [{ kind: "user", id: "who", label: "Only this friend" }],
  body: [
    { kind: "literal", text: "when " },
    { kind: "config", field: "who", fallback: "any friend" },
    { kind: "literal", text: " comes online" },
  ],
  outputs: [
    { id: "friend", label: "Friend", type: "friend" },
    { id: "at", label: "Time", type: "number" },
  ],
};

describe("node definition shape", () => {
  test("a trigger narrows and has no inputs to read", () => {
    expect(isTriggerDefinition(trigger)).toBe(true);
    // The type-level claim is the real one: `TriggerRegistration` has no `execute` member, so an
    // author cannot declare a trigger that executes. This asserts the runtime half.
    expect("inputs" in trigger).toBe(false);
  });
});

describe("evaluateNodeBody", () => {
  test("substitutes config and falls back when unset", () => {
    expect(evaluateNodeBody(trigger.body ?? [], { who: "usr_123" })).toBe(
      "when usr_123 comes online",
    );
    expect(evaluateNodeBody(trigger.body ?? [], {})).toBe("when any friend comes online");
  });

  test("renders a port segment by label, falling back to the id", () => {
    const template = [{ kind: "port", port: "friend" } as const];
    expect(evaluateNodeBody(template, {}, trigger.outputs)).toBe("Friend");
    expect(evaluateNodeBody(template, {})).toBe("friend");
  });
});

describe("canonicalNodeDefinition / nodeDefinitionHash", () => {
  test("is stable across key order and port order", async () => {
    const reordered: NodeDefinition = {
      outputs: [
        { type: "number", id: "at", label: "Time" },
        { label: "Friend", id: "friend", type: "friend" },
      ],
      body: trigger.body ?? [],
      config: trigger.config ?? [],
      title: trigger.title,
      id: trigger.id,
      kind: "trigger",
      category: trigger.category ?? "",
    };
    expect(canonicalNodeDefinition(reordered)).toBe(canonicalNodeDefinition(trigger));
    expect(await nodeDefinitionHash(reordered)).toBe(await nodeDefinitionHash(trigger));
  });

  test("cosmetic changes do not move the hash", async () => {
    // A typo fix in a label must not prompt every user with a saved graph to migrate.
    const retitled: NodeDefinition = {
      ...trigger,
      title: "A friend comes online",
      description: "Fires when a friend's status goes from offline to online.",
      icon: "user-check",
      body: [{ kind: "literal", text: "rewritten entirely" }],
      outputs: [
        { id: "friend", label: "The friend", type: "friend", description: "who it was" },
        { id: "at", label: "When", type: "number" },
      ],
    };
    expect(await nodeDefinitionHash(retitled)).toBe(await nodeDefinitionHash(trigger));
  });

  test("changes when a port type changes", async () => {
    const widened: NodeDefinition = {
      ...trigger,
      outputs: [
        { id: "friend", label: "Friend", type: "user" },
        { id: "at", label: "Time", type: "number" },
      ],
    };
    expect(await nodeDefinitionHash(widened)).not.toBe(await nodeDefinitionHash(trigger));
  });

  test("changes when a port is added, removed, or made required", async () => {
    const added: NodeDefinition = {
      ...trigger,
      outputs: [...trigger.outputs, { id: "world", label: "World", type: "world" }],
    };
    const removed: NodeDefinition = { ...trigger, outputs: trigger.outputs.slice(0, 1) };
    const required: NodeDefinition = {
      ...trigger,
      outputs: [
        { id: "friend", label: "Friend", type: "friend", required: true },
        { id: "at", label: "Time", type: "number" },
      ],
    };
    const base = await nodeDefinitionHash(trigger);
    for (const variant of [added, removed, required]) {
      expect(await nodeDefinitionHash(variant)).not.toBe(base);
    }
  });

  test("changes when a config field's kind changes, and when the kind of node changes", async () => {
    const retyped: NodeDefinition = {
      ...trigger,
      config: [{ kind: "text", id: "who", label: "Only this friend" }],
    };
    const asAction: NodeDefinition = {
      kind: "action",
      id: trigger.id,
      title: trigger.title,
      inputs: [],
      outputs: trigger.outputs,
      config: trigger.config ?? [],
    };
    const base = await nodeDefinitionHash(trigger);
    expect(await nodeDefinitionHash(retyped)).not.toBe(base);
    expect(await nodeDefinitionHash(asAction)).not.toBe(base);
  });

  test("an input and an output with the same id are not interchangeable", async () => {
    const a: NodeDefinition = {
      kind: "action",
      id: "n",
      title: "n",
      inputs: [{ id: "x", label: "x", type: "user" }],
      outputs: [],
    };
    const b: NodeDefinition = {
      kind: "action",
      id: "n",
      title: "n",
      inputs: [],
      outputs: [{ id: "x", label: "x", type: "user" }],
    };
    expect(await nodeDefinitionHash(a)).not.toBe(await nodeDefinitionHash(b));
  });

  test("the hash is a sha-256 hex digest", async () => {
    expect(await nodeDefinitionHash(trigger)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Compile-time: `PortType` is the tuple's element type, so a member added to PORT_TYPES without a
// matrix decision would still typecheck here — which is why the matrix test above exists at runtime.
const _member: PortType = "user";
void _member;

describe("variadic inputs", () => {
  const compose: NodeDefinition = {
    kind: "action",
    id: "compose",
    title: "Compose",
    variadicInputs: "slots",
    inputs: [
      { id: "a", label: "A", type: "json" },
      { id: "b", label: "B", type: "json" },
      { id: "c", label: "C", type: "json" },
      { id: "d", label: "D", type: "json" },
    ],
    outputs: [{ id: "text", label: "Text", type: "string" }],
    config: [{ kind: "slider", id: "slots", label: "Slots", min: 1, max: 4, default: 2 }],
  };

  test("a node with no variadic field shows every input it declares", () => {
    const plain: NodeDefinition = {
      kind: "action",
      id: "plain",
      title: "Plain",
      inputs: compose.kind === "action" ? compose.inputs : [],
      outputs: [],
    };
    expect(visibleInputCount(plain, {})).toBe(4);
  });

  test("the config decides, and the declared count is the ceiling", () => {
    expect(visibleInputCount(compose, { slots: 3 })).toBe(3);
    expect(visibleInputCount(compose, { slots: 99 })).toBe(4);
    expect(visibleInputCount(compose, { slots: 0 })).toBe(1);
  });

  test("a missing or nonsense value falls back to the field's own default", () => {
    // The config of a node created by an older build, or one hand-edited in an exported document.
    expect(visibleInputCount(compose, {})).toBe(2);
    expect(visibleInputCount(compose, { slots: "three" })).toBe(2);
  });

  test("a wired port is a floor the count cannot be dragged below", () => {
    // Hiding a port that has an edge in it would be a graph doing something with no way to see it,
    // and this editor has no undo to recover the deleted wire the other approach would cost.
    expect(visibleInputCount(compose, { slots: 1 }, 3)).toBe(3);
    expect(visibleInputCount(compose, { slots: 4 }, 2)).toBe(4);
  });

  test("a trigger has no inputs to vary", () => {
    const trigger: NodeDefinition = { kind: "trigger", id: "t", title: "t", outputs: [] };
    expect(visibleInputCount(trigger, {})).toBe(0);
    expect(visibleInputs(trigger, {})).toEqual([]);
  });

  test("the ports themselves are unchanged, which is what keeps a saved edge valid", () => {
    // Only the drawing varies. Every declared port exists, always, so an edge into `d` is legal
    // whatever the slider says -- and the hash does not depend on an instance's config.
    expect(visibleInputs(compose, { slots: 2 }).map((port) => port.id)).toEqual(["a", "b"]);
    expect(compose.kind === "action" && compose.inputs).toHaveLength(4);
  });

  describe("a stride, for a unit worth more than one port", () => {
    // The desktop notification node's shape: two fixed ports, then a label and an argument per
    // button, so a `buttons` field holding two rows draws six.
    const notify: NodeDefinition = {
      kind: "action",
      id: "notify",
      title: "Notify",
      variadicInputs: "buttons",
      variadicInputsBase: 2,
      variadicInputsStride: 2,
      inputs: [
        { id: "text", label: "Message", type: "string" },
        { id: "title", label: "Title", type: "string" },
        { id: "button1", label: "Button 1 says", type: "string" },
        { id: "button1arg", label: "Button 1 uses", type: "string" },
        { id: "button2", label: "Button 2 says", type: "string" },
        { id: "button2arg", label: "Button 2 uses", type: "string" },
      ],
      outputs: [],
      config: [{ kind: "buttons", id: "buttons", label: "Buttons", max: 2 }],
    };

    test("each row claims a pair", () => {
      expect(visibleInputCount(notify, { buttons: "[]" })).toBe(2);
      expect(visibleInputCount(notify, { buttons: '[{"id":"a"}]' })).toBe(4);
      expect(visibleInputCount(notify, { buttons: '[{"id":"a"},{"id":"b"}]' })).toBe(6);
    });

    test("the fixed ports survive a field that says nothing", () => {
      expect(visibleInputCount(notify, {})).toBe(2);
      expect(visibleInputCount(notify, { buttons: "not json" })).toBe(2);
    });

    test("the wired floor rounds up to a whole pair", () => {
      // A wire into the first button's argument must not leave the second button's label showing
      // on its own, which would read as a half-drawn button.
      expect(visibleInputCount(notify, { buttons: "[]" }, 4)).toBe(4);
      expect(visibleInputCount(notify, { buttons: "[]" }, 5)).toBe(6);
    });
  });
});

describe("slot rows", () => {
  test("a well-formed value round-trips, defaults filled in", () => {
    const rows = parseSlotRows(
      JSON.stringify([
        { slot: "o1", path: "displayName", label: "Name", list: false },
        { slot: "l1", path: "tags", list: true },
      ]),
    );
    expect(rows).toEqual([
      { slot: "o1", path: "displayName", label: "Name", list: false },
      { slot: "l1", path: "tags", label: "", list: true },
    ]);
  });

  test("anything malformed is an empty list rather than a throw", () => {
    // Every one of these is a shape a document that was exported, hand-edited and imported can hold.
    for (const value of [undefined, null, 3, "", "   ", "not json", "{}", '"a string"', "[1,2]"]) {
      expect(parseSlotRows(value)).toEqual([]);
    }
  });

  test("a row missing its slot is kept, because the editor writes one mid-edit", () => {
    const rows = parseSlotRows('[{"path":"a"}]');
    expect(rows).toEqual([{ slot: "", path: "a", label: "", list: false }]);
  });

  test("a label is the override, then the path's last segment, then the slot", () => {
    expect(slotRowLabel({ slot: "o1", path: "user.displayName", label: "Who", list: false })).toBe(
      "Who",
    );
    expect(slotRowLabel({ slot: "o1", path: "user.displayName", label: "  ", list: false })).toBe(
      "displayName",
    );
    // Brackets and a leading `$` normalise the same way `readPath` walks them.
    expect(slotRowLabel({ slot: "o1", path: "$.friends[0].id", label: "", list: false })).toBe(
      "id",
    );
    expect(slotRowLabel({ slot: "o3", path: "", label: "", list: false })).toBe("o3");
  });

  test("a key row's label is the override, the key whole, then the slot", () => {
    expect(keyRowLabel({ slot: "v1", path: "user.name", label: "Who", list: false })).toBe("Who");
    // Not `name`: a key with a dot in it is a field called `user.name`, not a route to one.
    expect(keyRowLabel({ slot: "v1", path: "user.name", label: "  ", list: false })).toBe(
      "user.name",
    );
    expect(keyRowLabel({ slot: "v2", path: "  ", label: "", list: false })).toBe("v2");
  });
});

describe("variadic outputs", () => {
  const extractor: NodeDefinition = {
    kind: "action",
    id: "extract",
    title: "Extract",
    inputs: [{ id: "value", label: "From", type: "json" }],
    outputs: [
      { id: "o1", label: "Value 1", type: "json" },
      { id: "o2", label: "Value 2", type: "json" },
      { id: "l1", label: "List 1", type: "list<json>" },
    ],
    variadicOutputs: "fields",
    config: [{ kind: "paths", id: "fields", label: "Values" }],
  };

  const rows = (...list: { slot: string; path: string; label?: string }[]): string =>
    JSON.stringify(list);

  test("a row claims its slot and names the port", () => {
    const shown = visibleOutputs(extractor, {
      fields: rows({ slot: "l1", path: "tags", label: "Tags" }, { slot: "o2", path: "status" }),
    });
    expect(shown.map((port) => [port.id, port.label, port.type])).toEqual([
      ["l1", "Tags", "list<json>"],
      ["o2", "status", "json"],
    ]);
  });

  test("no rows means no slots drawn, and no config means the same", () => {
    expect(visibleOutputs(extractor, {})).toEqual([]);
    expect(visibleOutputs(extractor, { fields: "[]" })).toEqual([]);
  });

  test("a slot the definition does not have is skipped", () => {
    // The shape an import from a build with more slots produces.
    expect(visibleOutputs(extractor, { fields: rows({ slot: "o9", path: "a" }) })).toEqual([]);
  });

  test("a second row claiming a taken slot is skipped, so a port is never drawn twice", () => {
    const shown = visibleOutputs(extractor, {
      fields: rows({ slot: "o1", path: "a" }, { slot: "o1", path: "b" }),
    });
    expect(shown.map((port) => port.id)).toEqual(["o1"]);
  });

  test("a wired slot is drawn whatever the rows say", () => {
    // The floor. An edge feeding a port that is not on the card is a graph doing something with no
    // way to see that it is.
    const shown = visibleOutputs(extractor, { fields: "[]" }, ["o2"]);
    expect(shown.map((port) => [port.id, port.label])).toEqual([["o2", "Value 2"]]);
  });

  test("a wired slot a row already claimed is not drawn twice", () => {
    const shown = visibleOutputs(extractor, { fields: rows({ slot: "o1", path: "a" }) }, ["o1"]);
    expect(shown.map((port) => port.id)).toEqual(["o1"]);
  });

  test("fixed outputs before the slots are always drawn", () => {
    const withFixed: NodeDefinition = { ...extractor, variadicOutputsBase: 1 } as NodeDefinition;
    // `o1` is now a fixed port rather than a slot, so a row cannot claim it and it never disappears.
    const shown = visibleOutputs(withFixed, { fields: rows({ slot: "o1", path: "a" }) });
    expect(shown.map((port) => port.id)).toEqual(["o1"]);
  });

  test("a node with no variadic outputs gets its declared outputs back unchanged", () => {
    // Declared without the field rather than with it set to `undefined`: `exactOptionalPropertyTypes`
    // draws that distinction, and "absent" is the state every node before the extractors was in.
    const plain: NodeDefinition = {
      kind: "action",
      id: "plain",
      title: "Plain",
      inputs: [],
      outputs: extractor.outputs,
    };
    expect(visibleOutputs(plain, {})).toEqual(plain.outputs);
    const trigger: NodeDefinition = {
      kind: "trigger",
      id: "t",
      title: "t",
      outputs: [{ id: "a", label: "A", type: "json" }],
    };
    expect(visibleOutputs(trigger, {})).toEqual(trigger.outputs);
  });

  test("the declared ports do not move, which is what keeps a saved edge valid", () => {
    // The hash covers all three whatever an instance's rows say -- same argument as the inputs.
    const before = canonicalNodeDefinition(extractor);
    expect(before).toContain("out:l1:list<json>:0,out:o1:json:0,out:o2:json:0");
  });
});

describe("variadic input slots", () => {
  const compose: NodeDefinition = {
    kind: "action",
    id: "compose-json",
    title: "Compose JSON",
    inputs: [
      { id: "v1", label: "Value 1", type: "json" },
      { id: "v2", label: "Value 2", type: "json" },
      { id: "v3", label: "Value 3", type: "json" },
    ],
    outputs: [{ id: "value", label: "Object", type: "json" }],
    variadicInputSlots: "keys",
    config: [{ kind: "keys", id: "keys", label: "Keys" }],
  };

  const rows = (...list: { slot: string; path: string; label?: string }[]): string =>
    JSON.stringify(list);

  test("a row claims its slot and the key names the port", () => {
    const shown = visibleInputs(compose, {
      keys: rows({ slot: "v2", path: "displayName" }, { slot: "v1", path: "status" }),
    });
    expect(shown.map((port) => [port.id, port.label])).toEqual([
      ["v2", "displayName"],
      ["v1", "status"],
    ]);
  });

  test("the port wears the key whole, dots included", () => {
    // The difference from an extractor's label rule, and it is deliberate: `user.name` as a *key*
    // means a field actually called that, so trimming it to `name` would name the port something
    // the object does not contain.
    const shown = visibleInputs(compose, { keys: rows({ slot: "v1", path: "user.name" }) });
    expect(shown[0]?.label).toBe("user.name");
  });

  test("no rows means no ports, and the count agrees", () => {
    expect(visibleInputs(compose, {})).toEqual([]);
    expect(visibleInputs(compose, { keys: "[]" })).toEqual([]);
    expect(visibleInputCount(compose, { keys: "[]" })).toBe(0);
  });

  test("a slot the node does not have is skipped, and so is a second claim on one", () => {
    // Both are shapes a round-tripped document holds and neither can be drawn.
    expect(visibleInputs(compose, { keys: rows({ slot: "v9", path: "a" }) })).toEqual([]);
    const twice = visibleInputs(compose, {
      keys: rows({ slot: "v1", path: "a" }, { slot: "v1", path: "b" }),
    });
    expect(twice.map((port) => port.id)).toEqual(["v1"]);
  });

  test("a wired slot is drawn whatever the rows say", () => {
    // The floor, exactly as the outputs have it: deleting the row that named a port must leave the
    // wire on screen to be dealt with rather than hide an edge that is still there.
    const shown = visibleInputs(compose, { keys: "[]" }, ["v3"]);
    expect(shown.map((port) => [port.id, port.label])).toEqual([["v3", "Value 3"]]);
    const claimed = visibleInputs(compose, { keys: rows({ slot: "v1", path: "a" }) }, ["v1"]);
    expect(claimed.map((port) => port.id)).toEqual(["v1"]);
  });

  test("fixed inputs before the slots are always drawn", () => {
    const withFixed: NodeDefinition = { ...compose, variadicInputSlotsBase: 1 } as NodeDefinition;
    // `v1` is a fixed port now, so no row can claim it and nothing can hide it.
    expect(visibleInputs(withFixed, {}).map((port) => port.id)).toEqual(["v1"]);
    expect(visibleInputs(withFixed, { keys: rows({ slot: "v1", path: "a" }) }).length).toBe(1);
  });

  test("the declared ports do not move, which is what keeps a saved edge valid", () => {
    expect(canonicalNodeDefinition(compose)).toContain("in:v1:json:0,in:v2:json:0,in:v3:json:0");
  });
});

describe("config field kinds", () => {
  const withField = (field: unknown): unknown => ({
    id: "n",
    kind: "action",
    title: "N",
    inputs: [],
    outputs: [],
    config: [field],
  });

  test("every kind the host's own nodes use is accepted from a plugin too", () => {
    /*
     * `slider` and `buttons` were missing from the accepted list until the extractors were added,
     * so a plugin declaring either was rejected while the built-ins used both freely. The built-ins
     * never pass through this validator, which is why nothing caught it.
     */
    for (const field of [
      { kind: "slider", id: "n", label: "N", min: 1, max: 4 },
      { kind: "buttons", id: "b", label: "B" },
      { kind: "fields", id: "f", label: "F", options: [{ value: "a", label: "A" }] },
      { kind: "paths", id: "p", label: "P" },
      { kind: "keys", id: "k", label: "K" },
    ]) {
      const result = validateNodeDefinition(withField(field));
      expect(result.ok).toBe(true);
    }
  });

  test("a fields picker with no catalogue is refused", () => {
    // With no options there is nothing to pick, and the row would be a `paths` field wearing the
    // wrong control.
    const result = validateNodeDefinition(withField({ kind: "fields", id: "f", label: "F" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path === "config[0].options")).toBe(true);
    }
  });
});
