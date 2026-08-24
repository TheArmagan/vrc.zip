import { describe, expect, test } from "bun:test";
import type { NodeConfigValues } from "@vrcz/plugin-api/nodes";
import { MAX_NODE_PORTS, visibleInputs } from "@vrcz/plugin-api/nodes";
import { composeJson, composeNodes } from "./compose.ts";
import { createBuiltinNodes } from "./index.ts";

const DEFINITION = composeNodes()[0]?.definition;
if (DEFINITION === undefined) throw new Error("no compose-json node");

/** The rows as they are stored: a JSON array inside a string, like every other repeatable field. */
function rows(...list: { slot: string; path: string }[]): NodeConfigValues {
  return { keys: JSON.stringify(list) };
}

describe("the Compose JSON node", () => {
  test("it is registered as a built-in under the reserved namespace", () => {
    expect(createBuiltinNodes().has("vrcz/compose-json")).toBe(true);
  });

  test("twelve json slots, inside the port ceiling", () => {
    if (DEFINITION.kind === "trigger") throw new Error("unreachable");
    expect(DEFINITION.inputs).toHaveLength(12);
    expect(DEFINITION.inputs.every((port) => port.type === "json")).toBe(true);
    // The headroom is deliberate: adding a slot later restamps the `defHash` of every saved node.
    expect(DEFINITION.inputs.length).toBeLessThanOrEqual(MAX_NODE_PORTS);
  });

  test("a fresh card has one port rather than none", () => {
    // A node whose whole point is the ports it grows would teach nothing arriving with zero.
    if (DEFINITION.kind === "trigger") throw new Error("unreachable");
    const field = DEFINITION.config?.find((entry) => entry.id === "keys");
    const config = field !== undefined && "default" in field ? { keys: field.default ?? "" } : {};
    expect(visibleInputs(DEFINITION, config)).toHaveLength(1);
  });

  test("each row puts its wired value under its key", () => {
    const out = composeJson(
      { v1: "Ada", v2: 42, v3: { nested: true } },
      rows({ slot: "v1", path: "name" }, { slot: "v2", path: "count" }, { slot: "v3", path: "at" }),
    );
    expect(out.value).toEqual({ name: "Ada", count: 42, at: { nested: true } });
  });

  test("a key is used exactly as typed, dots and all", () => {
    // Literal rather than a path into a nested object: VRChat's own payloads carry dotted names, and
    // a graph that could not produce one would be the node deciding it knew better.
    const out = composeJson({ v1: "x" }, rows({ slot: "v1", path: "user.name" }));
    expect(out.value).toEqual({ "user.name": "x" });
  });

  test("a port with nothing wired leaves its key out, rather than setting it to null", () => {
    // An absent field and a null field mean different things to VRChat's API and to a webhook.
    const out = composeJson(
      { v1: "Ada" },
      rows({ slot: "v1", path: "name" }, { slot: "v2", path: "status" }),
    );
    expect(out.value).toEqual({ name: "Ada" });
    expect(Object.hasOwn(out.value as object, "status")).toBe(false);
  });

  test("a null that was actually wired is kept, because null is a value", () => {
    const out = composeJson({ v1: null }, rows({ slot: "v1", path: "name" }));
    expect(out.value).toEqual({ name: null });
  });

  test("a blank key contributes nothing, and the row is not an error", () => {
    // The editor adds a row before there is anything to call it, so this is an ordinary state.
    const out = composeJson(
      { v1: "x", v2: "y" },
      rows({ slot: "v1", path: "  " }, { slot: "v2", path: "b" }),
    );
    expect(out.value).toEqual({ b: "y" });
  });

  test("two rows with one key keep the first", () => {
    // The rule two same-named buttons follow, and for the same reason: the box has to be typeable
    // through a state where two rows match.
    const out = composeJson(
      { v1: "first", v2: "second" },
      rows({ slot: "v1", path: "k" }, { slot: "v2", path: "k" }),
    );
    expect(out.value).toEqual({ k: "first" });
  });

  test("a slot the node does not have, and a second claim on one, are both skipped", () => {
    const out = composeJson(
      { v1: "a", v2: "b" },
      rows({ slot: "v9", path: "gone" }, { slot: "v1", path: "one" }, { slot: "v1", path: "two" }),
    );
    expect(out.value).toEqual({ one: "a" });
  });

  test("nonsense in the keys field is an empty object, not a failed run", () => {
    expect(composeJson({ v1: "a" }, { keys: "not json" }).value).toEqual({});
    expect(composeJson({ v1: "a" }, {}).value).toEqual({});
  });

  test("a key of __proto__ is a field called __proto__, not a new prototype", () => {
    // `out[key] = value` on an object literal walks into the setter on `Object.prototype` instead of
    // adding a field. The keys here are typed by a person and survive an export and an import.
    const out = composeJson({ v1: { polluted: true } }, rows({ slot: "v1", path: "__proto__" }));
    const value = out.value as Record<string, unknown>;
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
