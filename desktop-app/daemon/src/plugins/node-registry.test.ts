import { describe, expect, test } from "bun:test";
import {
  type NodeDefinition,
  type PluginGrant,
  RESERVED_NODE_NAMESPACE,
  type RequestFrame,
} from "@vrcz/plugin-api";
import type { JsonValue } from "@vrcz/shared";
import { DispatchError } from "./dispatcher.ts";
import { checkEdge, createNodeMethods, NodeRegistry } from "./node-registry.ts";
import { createScopeGate } from "./scope-gate.ts";

const PLUGIN = "acme.notes";
const NOW = 1_760_000_000_000;

const GRANT: PluginGrant = {
  pluginId: PLUGIN,
  scopes: [],
  accountIds: [],
  capabilities: [],
  events: [],
};

const TRIGGER = {
  id: "note-added",
  kind: "trigger",
  title: "A note was added",
  outputs: [{ id: "user", label: "About", type: "user" }],
} as unknown as NodeDefinition;

const ACTION = {
  id: "write-note",
  kind: "action",
  title: "Write a note",
  inputs: [{ id: "who", label: "About", type: "user" }],
  outputs: [{ id: "ok", label: "Written", type: "boolean" }],
} as unknown as NodeDefinition;

function harness(declared: readonly string[] = ["note-added", "write-note"]) {
  const fired: { instanceId: string; outputs: JsonValue }[] = [];
  const nodes = new NodeRegistry({ declaredNodes: () => declared, now: () => NOW });
  const gate = createScopeGate(
    createNodeMethods({
      nodes,
      onFire: (event) => fired.push({ instanceId: event.instanceId, outputs: event.outputs }),
    }),
  );

  async function call(method: string, params?: JsonValue): Promise<JsonValue> {
    const frame: RequestFrame = {
      t: "req",
      id: "1",
      method,
      deadline: NOW + 1000,
      ...(params ? { params } : {}),
    };
    const authorized = gate.check(frame, GRANT, NOW);
    if (!authorized.ok) throw new DispatchError(authorized.code, authorized.message);
    const result = await authorized.value.method.invoke(params, {
      grant: GRANT,
      deadline: NOW + 1000,
      signal: new AbortController().signal,
    });
    if (!result.ok) throw new DispatchError(result.code, result.message);
    return result.value ?? null;
  }

  return { nodes, fired, call };
}

describe("registering", () => {
  test("a declared node registers under its qualified id", async () => {
    const h = harness();
    expect(await h.call("nodes.register", { definition: TRIGGER as unknown as JsonValue })).toEqual(
      {
        qualifiedId: "acme.notes/note-added",
      },
    );
    expect(h.nodes.get("acme.notes/note-added")?.definition.title).toBe("A note was added");
  });

  /**
   * The check `manifest.md` says the install pipeline owes and cannot do: definitions only exist
   * once the plugin runs, so the two lists can only be compared here.
   */
  test("a node the manifest never declared is refused, and says why", async () => {
    const h = harness(["something-else"]);
    await expect(
      h.call("nodes.register", { definition: TRIGGER as unknown as JsonValue }),
    ).rejects.toThrow(/contributes\.nodes/);
    expect(h.nodes.list()).toEqual([]);
  });

  test("an invalid definition is refused with the paths that are wrong", async () => {
    const h = harness(["note-added"]);
    await expect(
      h.call("nodes.register", {
        definition: { id: "note-added", kind: "trigger", title: "x", outputs: "nope" },
      }),
    ).rejects.toThrow(/outputs/);
  });

  /** The inversion, made unrepresentable rather than merely documented. */
  test("a trigger with inputs is refused", async () => {
    const h = harness(["note-added"]);
    await expect(
      h.call("nodes.register", {
        definition: { ...(TRIGGER as object), inputs: [] },
      }),
    ).rejects.toThrow(/arms, it does not run/);
  });

  test("re-registering the same id replaces it rather than duplicating", async () => {
    const h = harness();
    await h.call("nodes.register", { definition: TRIGGER as unknown as JsonValue });
    await h.call("nodes.register", {
      definition: { ...(TRIGGER as object), title: "Renamed" } as unknown as JsonValue,
    });
    expect(h.nodes.list()).toHaveLength(1);
    expect(h.nodes.get("acme.notes/note-added")?.definition.title).toBe("Renamed");
  });

  test("clearing a plugin drops its definitions", async () => {
    const h = harness();
    await h.call("nodes.register", { definition: TRIGGER as unknown as JsonValue });
    h.nodes.clear(PLUGIN);
    expect(h.nodes.list()).toEqual([]);
  });

  test("a plugin cannot claim the reserved namespace", () => {
    // A saved graph names a node type `<owner>/<id>`, so a plugin registering under `vrcz` could
    // shadow a built-in on somebody else's machine.
    const h = harness();
    expect(() => h.nodes.register(RESERVED_NODE_NAMESPACE, ACTION)).toThrow(/reserved/);
  });

  test("the host registers its own node types, exempt from the manifest check and nothing else", () => {
    // One registry for both, which is what lets the palette and the type checker ask a single
    // place. `declaredNodes` here lists none of these ids, and a built-in does not care.
    const h = harness([]);
    const entry = h.nodes.registerBuiltin(ACTION);
    expect(entry.qualifiedId).toBe(`${RESERVED_NODE_NAMESPACE}/write-note`);
    expect(h.nodes.get(entry.qualifiedId)?.definition.title).toBe("Write a note");
    expect(h.nodes.list()).toHaveLength(1);
  });

  test("a built-in and a plugin node type-check against each other", () => {
    const h = harness(["note-added"]);
    h.nodes.registerBuiltin(ACTION);
    h.nodes.register(PLUGIN, TRIGGER);
    expect(
      checkEdge(
        h.nodes,
        { nodeType: `${PLUGIN}/note-added`, portId: "user" },
        { nodeType: `${RESERVED_NODE_NAMESPACE}/write-note`, portId: "who" },
      ),
    ).toBeNull();
  });
});

describe("firing", () => {
  test("a fire reaches the runtime seam with its instance and outputs", async () => {
    const h = harness();
    await h.call("nodes.fire", { instanceId: "inst-1", outputs: { user: "usr_a" } });
    expect(h.fired).toEqual([{ instanceId: "inst-1", outputs: { user: "usr_a" } }]);
  });

  test("a fire with no instance is refused rather than guessed", async () => {
    const h = harness();
    await expect(h.call("nodes.fire", { outputs: {} })).rejects.toThrow(/instanceId/);
  });
});

describe("the type checker", () => {
  test("a legal edge passes, and the widening rule holds", async () => {
    const h = harness();
    await h.call("nodes.register", { definition: TRIGGER as unknown as JsonValue });
    await h.call("nodes.register", { definition: ACTION as unknown as JsonValue });

    expect(
      checkEdge(
        h.nodes,
        { nodeType: "acme.notes/note-added", portId: "user" },
        { nodeType: "acme.notes/write-note", portId: "who" },
      ),
    ).toBeNull();
  });

  test("an illegal edge names both types rather than saying incompatible", async () => {
    const h = harness(["note-added", "write-note"]);
    await h.call("nodes.register", { definition: TRIGGER as unknown as JsonValue });
    await h.call("nodes.register", {
      definition: {
        ...(ACTION as object),
        inputs: [{ id: "who", label: "Count", type: "number" }],
      } as unknown as JsonValue,
    });

    expect(
      checkEdge(
        h.nodes,
        { nodeType: "acme.notes/note-added", portId: "user" },
        { nodeType: "acme.notes/write-note", portId: "who" },
      ),
    ).toBe("A user cannot flow into a number.");
  });

  test("wiring into a trigger says what a trigger is, not that the port is missing", async () => {
    const h = harness();
    await h.call("nodes.register", { definition: TRIGGER as unknown as JsonValue });
    await h.call("nodes.register", { definition: ACTION as unknown as JsonValue });

    expect(
      checkEdge(
        h.nodes,
        { nodeType: "acme.notes/write-note", portId: "ok" },
        { nodeType: "acme.notes/note-added", portId: "anything" },
      ),
    ).toMatch(/starts a graph and takes no inputs/);
  });

  test("an unregistered node type is named, so a stopped plugin is diagnosable", async () => {
    const h = harness();
    expect(
      checkEdge(
        h.nodes,
        { nodeType: "acme.notes/gone", portId: "x" },
        { nodeType: "acme.notes/also-gone", portId: "y" },
      ),
    ).toBe("acme.notes/gone is not a registered node type.");
  });
});
