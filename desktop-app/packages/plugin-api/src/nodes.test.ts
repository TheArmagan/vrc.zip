import { describe, expect, test } from "bun:test";
import {
  assignable,
  canonicalNodeDefinition,
  evaluateNodeBody,
  isPortType,
  isTriggerDefinition,
  type NodeDefinition,
  nodeDefinitionHash,
  PORT_TYPES,
  type PortType,
} from "./nodes.ts";

describe("assignable", () => {
  test("identity holds for every port type", () => {
    for (const t of PORT_TYPES) expect(assignable(t, t)).toBe(true);
  });

  test("the two widening rules hold", () => {
    expect(assignable("friend", "user")).toBe(true);
    for (const t of PORT_TYPES) expect(assignable(t, "json")).toBe(true);
  });

  test("neither rule holds in reverse", () => {
    // A node that needs friendship must be able to refuse a stranger at edit time.
    expect(assignable("user", "friend")).toBe(false);
    // `json` into a typed port is the unchecked cast that makes the type system decorative.
    for (const t of PORT_TYPES) {
      if (t === "json") continue;
      expect(assignable("json", t)).toBe(false);
    }
  });

  test("nothing else widens — asserted over the whole matrix", () => {
    // The point of this test is to fail loudly the day someone adds a third rule. PLAN.md: every
    // additional rule is an explanation you owe a user whose edge just got refused, so a new one is
    // a decision that gets made deliberately, not one that lands in a diff nobody read.
    const expected = new Set(["friend->user"]);
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
    // identity (n) + X->json for every X except json itself (n-1) + friend->user (1)
    expect(accepted).toBe(n + (n - 1) + 1);
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
