/**
 * Named stores: data that outlives a run and is shared between graphs on purpose.
 *
 * ## The one thing this file is for
 *
 * `graph_state` (the cooldown and counter nodes) is private to a node. That is right for "when did I
 * last let this person through" and useless for "the people I have already welcomed", which one
 * graph writes on join and another reads at the end of the night. A **store** is the second shape: a
 * name, and whoever names it shares it.
 *
 * See `014_graph_stores.sql` for why a store is a namespace inside the daemon's database rather than
 * a SQLite file of its own, and for how the four collection kinds share one table.
 *
 * ## Four families, one storage
 *
 *   Value  one value under a name.                  `store-value-*`
 *   Map    named fields under a name.               `store-map-*`
 *   Set    members, no duplicates, no order.        `store-set-*`
 *   List   items, in order, duplicates allowed.     `store-list-*`
 *
 * They are separate nodes rather than one node with a "kind" picker because the *ports* differ — a
 * set's `add` takes an item and a map's `set` takes a field and a value — and a node whose ports
 * followed a config field would rewrite its own hash every time somebody changed the picker.
 *
 * ## A rehearsal writes
 *
 * Dry-run is about not reaching other people, and a row in the local database reaches nobody. It has
 * to write for the same reason the cooldown node does: a rehearsal that did not record "welcomed
 * Ada" would welcome her all over again the moment the graph is armed, which makes the rehearsal a
 * test of a different graph than the one being armed. Nothing here is suppressed and nothing here
 * pretends.
 */

import { createHash } from "node:crypto";
import type {
  ExecutableNodeDefinition,
  NodeConfigValues,
  PortDefinition,
  PortValues,
} from "@vrcz/plugin-api/nodes";
import { configText, itemKey, sameItem } from "./collections.ts";
import type { BuiltinNode } from "./types.ts";

/**
 * What the store nodes need from SQLite, and nothing more.
 *
 * Narrow for the reason every other seam here is: the graph runtime has no business with the schema,
 * and a fake for a test is a `Map`. `value` is JSON text throughout — the encoding is this file's,
 * so no two callers can disagree about it.
 */
export interface GraphDataStore {
  get(store: string, collection: string, key: string): { value: string; updatedAt: number } | null;
  put(store: string, collection: string, key: string, value: string): void;
  remove(store: string, collection: string, key: string): void;
  list(store: string, collection: string): { key: string; value: string }[];
  count(store: string, collection: string): number;
  clear(store: string, collection: string): void;
}

const CATEGORY = "Stored data";

/** The store every node falls back to, so a graph that never thinks about stores still shares. */
export const DEFAULT_STORE = "default";

/* -------------------------------------------------------------------------------------------- */
/* Addressing                                                                                     */
/* -------------------------------------------------------------------------------------------- */

const STORE_FIELD = {
  kind: "text",
  id: "store",
  label: "Store",
  placeholder: DEFAULT_STORE,
  description: "Two graphs naming the same store share what is in it.",
} as const;

const NAME_FIELD = {
  kind: "text",
  id: "name",
  label: "Called",
  placeholder: "welcomed",
  required: true,
} as const;

/** Plain values live in the unnamed collection; the rest are prefixed by kind. See the migration. */
export const VALUE_COLLECTION = "";
export const LIST_COLLECTION = "list";
export function mapCollection(name: string): string {
  return `map:${name}`;
}
export function setCollection(name: string): string {
  return `set:${name}`;
}

function storeName(config: NodeConfigValues): string {
  const name = configText(config, "store");
  return name === "" ? DEFAULT_STORE : name;
}

/**
 * The key a node is addressing: the wired port when there is one, the config field otherwise.
 *
 * Both exist for the same reason `Compare` has both: most keys are a constant the author types, and
 * the interesting ones arrive from a trigger. Wired wins, because wiring something is the more
 * deliberate act.
 */
function keyOf(inputs: PortValues, config: NodeConfigValues, port = "key"): string {
  const wired = inputs[port];
  if (typeof wired === "string" && wired !== "") return capKey(wired);
  if (wired !== undefined && wired !== null) return capKey(itemKey(wired));
  return capKey(configText(config, "key"));
}

/** How long a key may be. The column takes more; this is about a row staying readable in the panel. */
const MAX_KEY_CHARS = 400;

/** Hex characters of the digest that stands in for the part of a long key that was cut off. */
const KEY_DIGEST_CHARS = 16;

/**
 * A key short enough to store, and still the key it came from.
 *
 * A plain `slice(0, 400)` made two different keys sharing a 400-character prefix into **one row**,
 * silently overwriting each other — and the keys most likely to be long are the composed ones (a
 * world id and an instance, a whole JSON item), which share prefixes by construction. The tail is
 * replaced by a digest of the whole key instead, so the truncation is visible in the panel and two
 * different keys stay two different rows. Short keys are untouched, so nothing already stored moves.
 */
function capKey(key: string): string {
  if (key.length <= MAX_KEY_CHARS) return key;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, KEY_DIGEST_CHARS);
  return `${key.slice(0, MAX_KEY_CHARS - KEY_DIGEST_CHARS - 1)}#${digest}`;
}

const KEY_INPUT = {
  id: "key",
  label: "Key",
  type: "string",
  description: "Overrides the typed key when wired.",
} as const;

const KEY_CONFIG = {
  kind: "text",
  id: "key",
  label: "Key",
  placeholder: "usr_…",
} as const;

function encode(value: unknown): string {
  return JSON.stringify(value ?? null) ?? "null";
}

/**
 * JSON back out of a row.
 *
 * A row that will not parse is treated as absent rather than thrown over. Every writer here encodes
 * with `JSON.stringify`, so the only way to get one is somebody editing the database by hand — and
 * failing a nightly automation over that is worse than skipping the value.
 */
function decode(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Definitions                                                                                    */
/* -------------------------------------------------------------------------------------------- */

function node(
  id: string,
  title: string,
  description: string,
  ports: {
    inputs?: readonly PortDefinition[];
    outputs: readonly PortDefinition[];
    config?: ExecutableNodeDefinition["config"];
  },
  body: NonNullable<ExecutableNodeDefinition["body"]>,
): ExecutableNodeDefinition {
  return {
    id,
    kind: "action",
    title,
    description,
    category: CATEGORY,
    inputs: ports.inputs ?? [],
    outputs: ports.outputs,
    config: [...(ports.config ?? []), STORE_FIELD],
    body,
  };
}

const FOUND = { id: "found", label: "Was there", type: "boolean" } as const;
const VALUE_OUT = { id: "value", label: "Value", type: "json" } as const;
const ITEMS_OUT = { id: "items", label: "Items", type: "list<json>" } as const;
const COUNT_OUT = { id: "count", label: "How many", type: "number" } as const;

const VALUE_SET = node(
  "store-value-set",
  "Save a value",
  "Writes one value into a store, under a name, until something overwrites it.",
  {
    inputs: [{ id: "value", label: "Value", type: "json", required: true }, KEY_INPUT],
    outputs: [VALUE_OUT],
    config: [KEY_CONFIG],
  },
  [
    { kind: "literal", text: "save " },
    { kind: "config", field: "key", fallback: "…" },
  ],
);

const VALUE_GET = node(
  "store-value-get",
  "Load a value",
  "Reads a value back. Produces nothing when there is none, which stops the run there.",
  { inputs: [KEY_INPUT], outputs: [VALUE_OUT, FOUND], config: [KEY_CONFIG] },
  [
    { kind: "literal", text: "load " },
    { kind: "config", field: "key", fallback: "…" },
  ],
);

const VALUE_REMOVE = node(
  "store-value-remove",
  "Forget a value",
  "Removes one value from a store.",
  { inputs: [KEY_INPUT], outputs: [{ ...FOUND, label: "Was there" }], config: [KEY_CONFIG] },
  [
    { kind: "literal", text: "forget " },
    { kind: "config", field: "key", fallback: "…" },
  ],
);

const MAP_SET = node(
  "store-map-set",
  "Map: set",
  "Writes one field of a stored map.",
  {
    inputs: [{ id: "value", label: "Value", type: "json", required: true }, KEY_INPUT],
    outputs: [VALUE_OUT, COUNT_OUT],
    config: [NAME_FIELD, KEY_CONFIG],
  },
  [
    { kind: "config", field: "name", fallback: "map" },
    { kind: "literal", text: "[" },
    { kind: "config", field: "key", fallback: "…" },
    { kind: "literal", text: "] =" },
  ],
);

const MAP_GET = node(
  "store-map-get",
  "Map: get",
  "Reads one field of a stored map. Nothing when the field is unset.",
  { inputs: [KEY_INPUT], outputs: [VALUE_OUT, FOUND], config: [NAME_FIELD, KEY_CONFIG] },
  [
    { kind: "config", field: "name", fallback: "map" },
    { kind: "literal", text: "[" },
    { kind: "config", field: "key", fallback: "…" },
    { kind: "literal", text: "]" },
  ],
);

const MAP_REMOVE = node(
  "store-map-remove",
  "Map: remove",
  "Removes one field from a stored map.",
  { inputs: [KEY_INPUT], outputs: [FOUND, COUNT_OUT], config: [NAME_FIELD, KEY_CONFIG] },
  [
    { kind: "literal", text: "remove from " },
    { kind: "config", field: "name", fallback: "map" },
  ],
);

const MAP_HAS = node(
  "store-map-has",
  "Map: has",
  "Whether a stored map has this field.",
  {
    inputs: [KEY_INPUT],
    outputs: [{ id: "has", label: "Is there", type: "boolean" }],
    config: [NAME_FIELD, KEY_CONFIG],
  },
  [
    { kind: "config", field: "name", fallback: "map" },
    { kind: "literal", text: " has?" },
  ],
);

const MAP_ENTRIES = node(
  "store-map-entries",
  "Map: everything",
  "Every field of a stored map, as two lists in the same order.",
  {
    outputs: [
      { id: "keys", label: "Keys", type: "list<string>" },
      { id: "values", label: "Values", type: "list<json>" },
      COUNT_OUT,
    ],
    config: [NAME_FIELD],
  },
  [
    { kind: "literal", text: "all of " },
    { kind: "config", field: "name", fallback: "map" },
  ],
);

const MAP_CLEAR = node(
  "store-map-clear",
  "Map: empty it",
  "Removes every field of a stored map.",
  { outputs: [{ id: "removed", label: "How many went", type: "number" }], config: [NAME_FIELD] },
  [
    { kind: "literal", text: "empty " },
    { kind: "config", field: "name", fallback: "map" },
  ],
);

const SET_ADD = node(
  "store-set-add",
  "Set: add",
  "Adds a member to a stored set. Says whether it was new, which is the useful half.",
  {
    inputs: [{ id: "item", label: "Item", type: "json", required: true }],
    outputs: [
      {
        id: "added",
        label: "Was new",
        type: "boolean",
        description: "False when it was already a member.",
      },
      COUNT_OUT,
    ],
    config: [NAME_FIELD],
  },
  [
    { kind: "literal", text: "add to " },
    { kind: "config", field: "name", fallback: "set" },
  ],
);

const SET_HAS = node(
  "store-set-has",
  "Set: has",
  "Whether something is already a member of a stored set.",
  {
    inputs: [{ id: "item", label: "Item", type: "json", required: true }],
    outputs: [{ id: "has", label: "Is there", type: "boolean" }],
    config: [NAME_FIELD],
  },
  [
    { kind: "config", field: "name", fallback: "set" },
    { kind: "literal", text: " has?" },
  ],
);

const SET_REMOVE = node(
  "store-set-remove",
  "Set: delete",
  "Removes a member from a stored set.",
  {
    inputs: [{ id: "item", label: "Item", type: "json", required: true }],
    outputs: [FOUND, COUNT_OUT],
    config: [NAME_FIELD],
  },
  [
    { kind: "literal", text: "delete from " },
    { kind: "config", field: "name", fallback: "set" },
  ],
);

const SET_ITEMS = node(
  "store-set-items",
  "Set: everything",
  "Every member of a stored set.",
  { outputs: [ITEMS_OUT, COUNT_OUT], config: [NAME_FIELD] },
  [
    { kind: "literal", text: "all of " },
    { kind: "config", field: "name", fallback: "set" },
  ],
);

const SET_CLEAR = node(
  "store-set-clear",
  "Set: empty it",
  "Removes every member of a stored set.",
  { outputs: [{ id: "removed", label: "How many went", type: "number" }], config: [NAME_FIELD] },
  [
    { kind: "literal", text: "empty " },
    { kind: "config", field: "name", fallback: "set" },
  ],
);

const LIST_ADD = node(
  "store-list-add",
  "List: add",
  "Appends an item to a stored list, optionally keeping only the most recent few.",
  {
    inputs: [{ id: "item", label: "Item", type: "json", required: true }],
    outputs: [ITEMS_OUT, COUNT_OUT],
    config: [
      NAME_FIELD,
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
        kind: "number",
        id: "max",
        label: "Keep at most",
        min: 0,
        default: 0,
        description:
          "Zero means no limit of your own, though a stored list still stops at 10,000 items. Past the limit the oldest go, which makes this a rolling log.",
      },
    ],
  },
  [
    { kind: "literal", text: "add to " },
    { kind: "config", field: "name", fallback: "list" },
  ],
);

const LIST_ITEMS = node(
  "store-list-items",
  "List: everything",
  "Every item of a stored list, in order.",
  { outputs: [ITEMS_OUT, COUNT_OUT], config: [NAME_FIELD] },
  [
    { kind: "literal", text: "all of " },
    { kind: "config", field: "name", fallback: "list" },
  ],
);

const LIST_FIND = node(
  "store-list-find",
  "List: find",
  "Searches a stored list for an item, and says where it is.",
  {
    inputs: [{ id: "item", label: "Item", type: "json", required: true }],
    outputs: [
      { id: "has", label: "Is there", type: "boolean" },
      { id: "index", label: "Position", type: "number" },
      { id: "item", label: "Item", type: "json" },
    ],
    config: [NAME_FIELD],
  },
  [
    { kind: "literal", text: "find in " },
    { kind: "config", field: "name", fallback: "list" },
  ],
);

const LIST_REMOVE = node(
  "store-list-remove",
  "List: remove",
  "Removes every copy of an item from a stored list.",
  {
    inputs: [{ id: "item", label: "Item", type: "json", required: true }],
    outputs: [{ id: "removed", label: "How many went", type: "number" }, ITEMS_OUT, COUNT_OUT],
    config: [NAME_FIELD],
  },
  [
    { kind: "literal", text: "remove from " },
    { kind: "config", field: "name", fallback: "list" },
  ],
);

const LIST_CLEAR = node(
  "store-list-clear",
  "List: empty it",
  "Removes every item of a stored list.",
  { outputs: [{ id: "removed", label: "How many went", type: "number" }], config: [NAME_FIELD] },
  [
    { kind: "literal", text: "empty " },
    { kind: "config", field: "name", fallback: "list" },
  ],
);

/* -------------------------------------------------------------------------------------------- */
/* The list helpers                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * A stored list is one row holding the whole array, so every write is read-modify-write.
 *
 * Safe here for the reason it usually is not: one process, one thread, and no `await` between the
 * read and the write below. The alternative — a row per index — makes a removal a renumbering of
 * everything after it, which is the operation this file exists to make easy.
 */
function readList(data: GraphDataStore, store: string, name: string): unknown[] {
  const decoded = decode(data.get(store, LIST_COLLECTION, name)?.value);
  return Array.isArray(decoded) ? decoded : [];
}

function writeList(data: GraphDataStore, store: string, name: string, items: unknown[]): void {
  data.put(store, LIST_COLLECTION, name, encode(items));
}

function collectionName(config: NodeConfigValues): string {
  return configText(config, "name").slice(0, 200);
}

/**
 * The ceiling on a stored list, whatever the node says.
 *
 * `Keep at most` defaults to zero, which means no limit, and a graph appending on every player join
 * then grows **one SQLite row** for as long as the daemon runs. Every append reads the whole array,
 * parses it, re-serialises it and writes it back, so the cost is quadratic in the number of appends
 * and nothing upstream notices: the ceilings in `limits.ts` count run size, fire rate and runs per
 * hour, and a thousand ordinary runs that each add one item pass all three.
 *
 * The constant lives here rather than in `limits.ts` because it is a property of this file's storage
 * shape — one row holding the whole array — and not of how often a graph may run.
 *
 * Ten thousand items is far past any list a person reads and far short of a row that hurts to
 * rewrite. Past it the oldest go, which is what the configured limit does; a rolling log is the
 * honest reading of "no limit" once a limit is unavoidable.
 */
export const MAX_STORED_LIST_ITEMS = 10_000;

function limit(config: NodeConfigValues): number {
  const raw = config.max;
  const value = typeof raw === "number" ? raw : Number(raw);
  const asked = Number.isFinite(value) && value > 0 ? Math.floor(value) : MAX_STORED_LIST_ITEMS;
  return Math.min(asked, MAX_STORED_LIST_ITEMS);
}

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export function dataStoreNodes(data: GraphDataStore): BuiltinNode[] {
  /** Every node here is addressed the same way; this is the two lines they all start with. */
  const at = (config: NodeConfigValues): { store: string; name: string } => ({
    store: storeName(config),
    name: collectionName(config),
  });

  return [
    {
      definition: VALUE_SET,
      execute: (inputs, config) => {
        const key = keyOf(inputs, config);
        if (key === "") return {};
        data.put(storeName(config), VALUE_COLLECTION, key, encode(inputs.value));
        return { value: inputs.value ?? null };
      },
    },
    {
      definition: VALUE_GET,
      execute: (inputs, config) => {
        const key = keyOf(inputs, config);
        if (key === "") return { found: false };
        const found = decode(data.get(storeName(config), VALUE_COLLECTION, key)?.value);
        // `found` always, `value` only when there is one. A miss therefore stops the branch that
        // wanted the value while leaving the branch that only asked "is it there" running — the
        // same shape `Load a value` needs to be usable as a condition.
        return found === undefined ? { found: false } : { value: found, found: true };
      },
    },
    {
      definition: VALUE_REMOVE,
      execute: (inputs, config) => {
        const key = keyOf(inputs, config);
        if (key === "") return { found: false };
        const store = storeName(config);
        const had = data.get(store, VALUE_COLLECTION, key) !== null;
        data.remove(store, VALUE_COLLECTION, key);
        return { found: had };
      },
    },

    {
      definition: MAP_SET,
      execute: (inputs, config) => {
        const { store, name } = at(config);
        const key = keyOf(inputs, config);
        if (name === "" || key === "") return {};
        data.put(store, mapCollection(name), key, encode(inputs.value));
        return { value: inputs.value ?? null, count: data.count(store, mapCollection(name)) };
      },
    },
    {
      definition: MAP_GET,
      execute: (inputs, config) => {
        const { store, name } = at(config);
        const key = keyOf(inputs, config);
        if (name === "" || key === "") return { found: false };
        const found = decode(data.get(store, mapCollection(name), key)?.value);
        return found === undefined ? { found: false } : { value: found, found: true };
      },
    },
    {
      definition: MAP_REMOVE,
      execute: (inputs, config) => {
        const { store, name } = at(config);
        const key = keyOf(inputs, config);
        // `count` too, not just `found`: a node either produces every port it declares or produces
        // nothing on purpose, and a subset leaves a wire out of `count` dead for no stated reason.
        if (name === "" || key === "") return { found: false, count: 0 };
        const collection = mapCollection(name);
        const had = data.get(store, collection, key) !== null;
        data.remove(store, collection, key);
        return { found: had, count: data.count(store, collection) };
      },
    },
    {
      definition: MAP_HAS,
      execute: (inputs, config) => {
        const { store, name } = at(config);
        const key = keyOf(inputs, config);
        if (name === "" || key === "") return { has: false };
        return { has: data.get(store, mapCollection(name), key) !== null };
      },
    },
    {
      definition: MAP_ENTRIES,
      execute: (_inputs, config) => {
        const { store, name } = at(config);
        if (name === "") return { keys: [], values: [], count: 0 };
        const rows = data.list(store, mapCollection(name));
        return {
          keys: rows.map((row) => row.key),
          values: rows.map((row) => decode(row.value) ?? null),
          count: rows.length,
        };
      },
    },
    {
      definition: MAP_CLEAR,
      execute: (_inputs, config) => {
        const { store, name } = at(config);
        if (name === "") return { removed: 0 };
        const collection = mapCollection(name);
        const removed = data.count(store, collection);
        data.clear(store, collection);
        return { removed };
      },
    },

    {
      definition: SET_ADD,
      execute: (inputs, config) => {
        const { store, name } = at(config);
        if (name === "") return {};
        const collection = setCollection(name);
        const key = capKey(itemKey(inputs.item ?? null));
        const added = data.get(store, collection, key) === null;
        // Written even when it was already a member, so the row's `updated_at` means "last seen"
        // rather than "first seen" — which is what the Stores panel orders by.
        data.put(store, collection, key, encode(inputs.item));
        return { added, count: data.count(store, collection) };
      },
    },
    {
      definition: SET_HAS,
      execute: (inputs, config) => {
        const { store, name } = at(config);
        if (name === "") return { has: false };
        const key = capKey(itemKey(inputs.item ?? null));
        return { has: data.get(store, setCollection(name), key) !== null };
      },
    },
    {
      definition: SET_REMOVE,
      execute: (inputs, config) => {
        const { store, name } = at(config);
        // Same rule as `Map: remove`: `count` is declared, so `count` is produced.
        if (name === "") return { found: false, count: 0 };
        const collection = setCollection(name);
        const key = capKey(itemKey(inputs.item ?? null));
        const had = data.get(store, collection, key) !== null;
        data.remove(store, collection, key);
        return { found: had, count: data.count(store, collection) };
      },
    },
    {
      definition: SET_ITEMS,
      execute: (_inputs, config) => {
        const { store, name } = at(config);
        if (name === "") return { items: [], count: 0 };
        const rows = data.list(store, setCollection(name));
        return { items: rows.map((row) => decode(row.value) ?? null), count: rows.length };
      },
    },
    {
      definition: SET_CLEAR,
      execute: (_inputs, config) => {
        const { store, name } = at(config);
        if (name === "") return { removed: 0 };
        const collection = setCollection(name);
        const removed = data.count(store, collection);
        data.clear(store, collection);
        return { removed };
      },
    },

    {
      definition: LIST_ADD,
      execute: (inputs, config) => {
        const { store, name } = at(config);
        if (name === "") return {};
        const items = readList(data, store, name);
        const item = inputs.item ?? null;
        const next = config.where === "start" ? [item, ...items] : [...items, item];
        const max = limit(config);
        // Trimmed from the far end, so "keep at most 50" on an append-to-end list keeps the newest
        // fifty — which is the rolling log everybody wants and nobody wants to write.
        const kept =
          max > 0 && next.length > max ? trim(next, max, config.where === "start") : next;
        writeList(data, store, name, kept);
        return { items: kept, count: kept.length };
      },
    },
    {
      definition: LIST_ITEMS,
      execute: (_inputs, config) => {
        const { store, name } = at(config);
        if (name === "") return { items: [], count: 0 };
        const items = readList(data, store, name);
        return { items, count: items.length };
      },
    },
    {
      definition: LIST_FIND,
      execute: (inputs, config) => {
        const { store, name } = at(config);
        if (name === "") return { has: false };
        const items = readList(data, store, name);
        const index = items.findIndex((entry) => sameItem(entry, inputs.item ?? null));
        return index === -1 ? { has: false } : { has: true, index, item: items[index] ?? null };
      },
    },
    {
      definition: LIST_REMOVE,
      execute: (inputs, config) => {
        const { store, name } = at(config);
        // `items` and `count` as well: an unnamed list is an empty one here, and a graph reading the
        // remaining items should see none rather than lose the branch.
        if (name === "") return { removed: 0, items: [], count: 0 };
        const items = readList(data, store, name);
        const kept = items.filter((entry) => !sameItem(entry, inputs.item ?? null));
        if (kept.length !== items.length) writeList(data, store, name, kept);
        return { removed: items.length - kept.length, items: kept, count: kept.length };
      },
    },
    {
      definition: LIST_CLEAR,
      execute: (_inputs, config) => {
        const { store, name } = at(config);
        if (name === "") return { removed: 0 };
        const removed = readList(data, store, name).length;
        data.remove(store, LIST_COLLECTION, name);
        return { removed };
      },
    },
  ];
}

/** Keeps `max` items from whichever end new ones arrive at. */
function trim(items: unknown[], max: number, fromStart: boolean): unknown[] {
  return fromStart ? items.slice(0, max) : items.slice(items.length - max);
}
