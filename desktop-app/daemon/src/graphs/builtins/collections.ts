/**
 * Lists and objects as values on a wire. Nothing here touches a store, and nothing here persists.
 *
 * ## Why these are separate from the `store-*` nodes
 *
 * The two look alike and are not the same thing at all, and keeping them in different files is the
 * cheapest way to stop them being confused for each other:
 *
 *   these         a value flows in, a new value flows out. Pure. No store, no name, no trace.
 *   `store-*`     a named collection in a named store, read and written by whoever names it.
 *
 * "Add this person to the list" is one of those, and which one it is decides whether the answer
 * survives a restart. Making it a config toggle on one node would hide the only question that
 * matters.
 *
 * ## Everything is copy-on-write
 *
 * Every node here returns a **new** array or object rather than mutating its input. A node's inputs
 * are the outputs another node produced, and the engine hands the same object to every edge out of
 * that port — so mutating in place would rewrite what a sibling branch already read. The copies are
 * shallow, which is enough: nothing here reaches inside an item.
 */

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import type { BuiltinNode } from "./types.ts";

const CATEGORY = "Collections";

/**
 * Equality for "is this item in that list", and it is deliberately structural.
 *
 * A graph builds objects out of wire data, so two items that mean the same person are routinely two
 * different objects. `===` would answer "no" to every one of them and make `contains` useless on
 * exactly the values a graph has. JSON is a coarse instrument — key order matters, `undefined`
 * vanishes — but both sides of a comparison here came out of the same kind of pipe.
 */
export function sameItem(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A stable text form of a value, used as a key by `unique` and by the persisted set nodes. */
export function itemKey(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null) ?? "null";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function configText(config: NodeConfigValues, id: string): string {
  const raw = config[id];
  return typeof raw === "string"
    ? raw.trim()
    : raw === undefined || raw === null
      ? ""
      : String(raw);
}

/* -------------------------------------------------------------------------------------------- */
/* Lists                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * Four inputs, not a variable number.
 *
 * Ports are part of the definition, and the definition is hashed — a node that grew a port when you
 * wired the last one would change its own hash and mark every saved graph using it stale. Four
 * covers what people build by hand; past that, `Add to list` in a `foreach` is the shape that
 * scales, and it is the shape somebody with twenty items wanted anyway.
 *
 * An unwired input is **absent**, not null: the engine only puts a key in `inputs` for a port that
 * received a value, which is what lets this build a two-item list without two holes in it.
 */
const MAKE_LIST: NodeDefinition = {
  id: "make-list",
  kind: "action",
  title: "Make a list",
  description: "Collects up to four values into one list. Unwired inputs are left out.",
  category: CATEGORY,
  inputs: [
    { id: "a", label: "A", type: "json" },
    { id: "b", label: "B", type: "json" },
    { id: "c", label: "C", type: "json" },
    { id: "d", label: "D", type: "json" },
  ],
  outputs: [
    { id: "list", label: "List", type: "list<json>" },
    { id: "count", label: "How many", type: "number" },
  ],
  body: [{ kind: "literal", text: "a list of A B C D" }],
};

const LIST_APPEND: NodeDefinition = {
  id: "list-append",
  kind: "action",
  title: "Add to list",
  description: "A copy of the list with one more item on the end.",
  category: CATEGORY,
  inputs: [
    { id: "list", label: "List", type: "list<json>", required: true },
    { id: "item", label: "Item", type: "json", required: true },
  ],
  outputs: [
    { id: "list", label: "List", type: "list<json>" },
    { id: "count", label: "How many", type: "number" },
  ],
  config: [
    {
      kind: "select",
      id: "where",
      label: "Add to the",
      options: [
        { value: "end", label: "end" },
        { value: "start", label: "start" },
      ],
      default: "end",
    },
    {
      kind: "boolean",
      id: "unique",
      label: "Skip if already there",
      default: false,
    },
  ],
  body: [
    { kind: "literal", text: "add " },
    { kind: "port", port: "item" },
  ],
};

const LIST_REMOVE_ITEM: NodeDefinition = {
  id: "list-remove-item",
  kind: "action",
  title: "Remove from list",
  description: "A copy of the list without the items equal to this one.",
  category: CATEGORY,
  inputs: [
    { id: "list", label: "List", type: "list<json>", required: true },
    { id: "item", label: "Item", type: "json", required: true },
  ],
  outputs: [
    { id: "list", label: "List", type: "list<json>" },
    { id: "removed", label: "How many went", type: "number" },
  ],
  body: [
    { kind: "literal", text: "without " },
    { kind: "port", port: "item" },
  ],
};

const LIST_CONTAINS: NodeDefinition = {
  id: "list-contains",
  kind: "action",
  title: "List contains",
  description: "Whether an item is in the list, and where.",
  category: CATEGORY,
  inputs: [
    { id: "list", label: "List", type: "list<json>", required: true },
    { id: "item", label: "Item", type: "json", required: true },
  ],
  outputs: [
    { id: "has", label: "Is there", type: "boolean" },
    {
      id: "index",
      label: "Position",
      type: "number",
      description: "Counting from zero. Nothing at all when the item is absent.",
    },
  ],
  body: [
    { kind: "literal", text: "contains " },
    { kind: "port", port: "item" },
  ],
};

const LIST_UNIQUE: NodeDefinition = {
  id: "list-unique",
  kind: "action",
  title: "Unique items",
  description: "The list with duplicates dropped, keeping the first of each. A set, in effect.",
  category: CATEGORY,
  inputs: [{ id: "list", label: "List", type: "list<json>", required: true }],
  outputs: [
    { id: "list", label: "List", type: "list<json>" },
    { id: "count", label: "How many", type: "number" },
  ],
  body: [{ kind: "literal", text: "unique" }],
};

const LIST_SLICE: NodeDefinition = {
  id: "list-slice",
  kind: "action",
  title: "Take from list",
  description: "The first or last few items. Useful before composing a message out of a long list.",
  category: CATEGORY,
  inputs: [{ id: "list", label: "List", type: "list<json>", required: true }],
  outputs: [
    { id: "list", label: "List", type: "list<json>" },
    { id: "count", label: "How many", type: "number" },
  ],
  config: [
    {
      kind: "select",
      id: "from",
      label: "Take from the",
      options: [
        { value: "start", label: "start" },
        { value: "end", label: "end" },
      ],
      default: "start",
    },
    { kind: "number", id: "count", label: "How many", min: 1, default: 10 },
  ],
  body: [
    { kind: "literal", text: "first " },
    { kind: "config", field: "count", fallback: "10" },
  ],
};

/* -------------------------------------------------------------------------------------------- */
/* Objects                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const MAKE_OBJECT: NodeDefinition = {
  id: "make-object",
  kind: "action",
  title: "Make an object",
  description:
    "Builds an object from up to three named values. Compose JSON does any number, on ports named after the keys.",
  category: CATEGORY,
  inputs: [
    { id: "a", label: "A", type: "json" },
    { id: "b", label: "B", type: "json" },
    { id: "c", label: "C", type: "json" },
  ],
  outputs: [{ id: "object", label: "Object", type: "json" }],
  config: [
    { kind: "text", id: "keyA", label: "A is called", placeholder: "user" },
    { kind: "text", id: "keyB", label: "B is called", placeholder: "world" },
    { kind: "text", id: "keyC", label: "C is called", placeholder: "at" },
  ],
  body: [{ kind: "literal", text: "an object" }],
};

const OBJECT_SET: NodeDefinition = {
  id: "object-set",
  kind: "action",
  title: "Set a field",
  description: "A copy of the object with one field set.",
  category: CATEGORY,
  inputs: [
    { id: "object", label: "Object", type: "json", required: true },
    { id: "value", label: "Value", type: "json", required: true },
    { id: "key", label: "Field", type: "string" },
  ],
  outputs: [{ id: "object", label: "Object", type: "json" }],
  config: [
    {
      kind: "text",
      id: "key",
      label: "Field",
      placeholder: "status",
      description: "Used when nothing is wired to Field.",
    },
  ],
  body: [
    { kind: "literal", text: "set ." },
    { kind: "config", field: "key", fallback: "?" },
  ],
};

const OBJECT_REMOVE: NodeDefinition = {
  id: "object-remove",
  kind: "action",
  title: "Remove a field",
  description: "A copy of the object without one field.",
  category: CATEGORY,
  inputs: [
    { id: "object", label: "Object", type: "json", required: true },
    { id: "key", label: "Field", type: "string" },
  ],
  outputs: [{ id: "object", label: "Object", type: "json" }],
  config: [{ kind: "text", id: "key", label: "Field", placeholder: "status" }],
  body: [
    { kind: "literal", text: "drop ." },
    { kind: "config", field: "key", fallback: "?" },
  ],
};

const OBJECT_KEYS: NodeDefinition = {
  id: "object-keys",
  kind: "action",
  title: "Object fields",
  description: "The field names and their values, as two lists in the same order.",
  category: CATEGORY,
  inputs: [{ id: "object", label: "Object", type: "json", required: true }],
  outputs: [
    { id: "keys", label: "Names", type: "list<string>" },
    { id: "values", label: "Values", type: "list<json>" },
    { id: "count", label: "How many", type: "number" },
  ],
  body: [{ kind: "literal", text: "fields" }],
};

/** The field name: the wired port when there is one, the config field otherwise. */
function keyOf(inputs: PortValues, config: NodeConfigValues): string {
  const wired = inputs.key;
  if (typeof wired === "string" && wired !== "") return wired;
  return configText(config, "key");
}

function positiveInt(config: NodeConfigValues, id: string, fallback: number): number {
  const raw = config[id];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export function collectionNodes(): BuiltinNode[] {
  return [
    {
      definition: MAKE_LIST,
      execute: (inputs) => {
        // `in`, not a null check: a graph is allowed to put a literal null in a list, and dropping
        // it would make "the value that was there" and "nothing wired" the same thing.
        const list = (["a", "b", "c", "d"] as const)
          .filter((port) => port in inputs)
          .map((port) => inputs[port] ?? null);
        return { list, count: list.length };
      },
    },
    {
      definition: LIST_APPEND,
      execute: (inputs, config) => {
        const list = asArray(inputs.list);
        const item = inputs.item ?? null;
        if (config.unique === true && list.some((entry) => sameItem(entry, item))) {
          return { list: [...list], count: list.length };
        }
        const next = config.where === "start" ? [item, ...list] : [...list, item];
        return { list: next, count: next.length };
      },
    },
    {
      definition: LIST_REMOVE_ITEM,
      execute: (inputs) => {
        const list = asArray(inputs.list);
        const item = inputs.item ?? null;
        const next = list.filter((entry) => !sameItem(entry, item));
        return { list: next, removed: list.length - next.length };
      },
    },
    {
      definition: LIST_CONTAINS,
      execute: (inputs) => {
        const index = asArray(inputs.list).findIndex((entry) =>
          sameItem(entry, inputs.item ?? null),
        );
        // `has` always; `index` only when there is one. A `-1` in a number port would flow into
        // arithmetic downstream as if it meant something, and an absent port stops the branch
        // instead — which is the same rule `First item` follows for an empty list.
        return index === -1 ? { has: false } : { has: true, index };
      },
    },
    {
      definition: LIST_UNIQUE,
      execute: (inputs) => {
        const seen = new Set<string>();
        const list = asArray(inputs.list).filter((entry) => {
          const key = itemKey(entry);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return { list, count: list.length };
      },
    },
    {
      definition: LIST_SLICE,
      execute: (inputs, config) => {
        const list = asArray(inputs.list);
        const n = positiveInt(config, "count", 10);
        const next = config.from === "end" ? list.slice(-n) : list.slice(0, n);
        return { list: next, count: next.length };
      },
    },
    {
      definition: MAKE_OBJECT,
      execute: (inputs, config) => {
        const object: Record<string, unknown> = {};
        for (const [port, field] of [
          ["a", "keyA"],
          ["b", "keyB"],
          ["c", "keyC"],
        ] as const) {
          const name = configText(config, field);
          // Both halves have to be there. An unnamed value has nowhere to go, and a name with
          // nothing wired would put a hole in the object under a key that looks deliberate.
          if (name !== "" && port in inputs) object[name] = inputs[port] ?? null;
        }
        return { object };
      },
    },
    {
      definition: OBJECT_SET,
      execute: (inputs, config) => {
        const key = keyOf(inputs, config);
        if (key === "") return {};
        return { object: { ...asObject(inputs.object), [key]: inputs.value ?? null } };
      },
    },
    {
      definition: OBJECT_REMOVE,
      execute: (inputs, config) => {
        const key = keyOf(inputs, config);
        if (key === "") return {};
        const object = asObject(inputs.object);
        delete object[key];
        return { object };
      },
    },
    {
      definition: OBJECT_KEYS,
      execute: (inputs) => {
        const object = asObject(inputs.object);
        const keys = Object.keys(object);
        return { keys, values: keys.map((key) => object[key] ?? null), count: keys.length };
      },
    },
  ];
}
