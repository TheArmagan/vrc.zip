/**
 * `data.*` and `signals.*`: the shared stores and the signal bus, as plugin methods.
 *
 * ## Why a plugin gets these at all
 *
 * A graph and a plugin are two ways of automating the same machine, and until now they could not
 * see each other's work. A graph could remember who it had welcomed; a plugin could remember it too,
 * in a database nothing else can open, and the two lists drifted the moment either ran alone. The
 * whole value of a *named* store is that the name is the only coordination anybody needs — so it
 * would be a strange kind of shared if the sharing stopped at the process boundary.
 *
 * These are the same rows the `store-*` nodes read and write, through the same {@link GraphDataStore}
 * seam and the same JSON encoding. Not a parallel API over the same table: one encoder, one set of
 * collection prefixes, no way for the two halves to disagree about what a stored set looks like.
 *
 * ## Two capabilities, and neither is a scope
 *
 * `shared-data` is **dangerous**, and it is the honest label: a plugin holding it can read what
 * every graph on this machine has written, including lists of people. `signals` is not — a name and
 * a value between automations says nothing about the user's account.
 *
 * Neither is a *scope*, because a scope is authority over the user's VRChat account and none of this
 * touches VRChat. That is the distinction `capabilities.ts` exists to draw, and this is the second
 * place it has earned its keep after `storage`.
 *
 * ## What a plugin cannot do
 *
 *  - **Delete a store.** Removing a store removes what other graphs are mid-run over. It is a
 *    person's gesture, from the Stores panel, and there is deliberately no method for it — same
 *    reason there is no node for it.
 *  - **Send a local signal.** `local` means "this graph only", and a plugin is not a graph; a local
 *    signal from a plugin would be heard by nobody, which is a worse answer than not offering it.
 *    A plugin's signal is global, and it says so.
 */

import type { ParseResult, PLUGIN_CAPABILITIES } from "@vrcz/plugin-api";
import { isJsonObject, type JsonValue } from "@vrcz/shared";
import type { EventBus } from "../bus/event-bus.ts";
import { itemKey, sameItem } from "../graphs/builtins/collections.ts";
import {
  DEFAULT_STORE,
  type GraphDataStore,
  LIST_COLLECTION,
  mapCollection,
  setCollection,
  VALUE_COLLECTION,
} from "../graphs/builtins/data-store.ts";
import { SIGNAL_KIND } from "../graphs/builtins/signals.ts";
import { defineGatedMethod, type GatedMethodTable } from "./scope-gate.ts";

export interface SharedDataMethodDeps {
  readonly data: GraphDataStore;
  readonly bus: EventBus;
  readonly now?: () => number;
}

/** Long enough for a user id and a sentence; short enough that a key is not a payload. */
const MAX_KEY = 400;
const MAX_NAME = 200;
/** The same ceiling `storage.*` uses, for the same reason: a value has to fit in a frame. */
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_ITEMS_PAGE = 1000;

/** A plugin's signals carry this instead of a graph id, so a listener can tell where one came from. */
export function pluginSignalOrigin(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/** The three a plugin may empty. `value` is absent on purpose — see the handler. */
type CollectionKind = "map" | "set" | "list";

function fail(message: string): ParseResult<never> {
  return { ok: false, code: "E_BAD_REQUEST", message };
}

function text(raw: JsonValue | undefined, field: string, max: number): ParseResult<string> {
  if (!isJsonObject(raw)) return fail("Expected an object of parameters.");
  const value = raw[field];
  if (typeof value !== "string" || value.length === 0) {
    return fail(`${field} must be a non-empty string.`);
  }
  if (value.length > max) return fail(`${field} must be at most ${max} characters.`);
  return { ok: true, value };
}

/**
 * The store a call names, defaulting like every node does.
 *
 * A plugin that names no store lands in `default` — the same place a graph that names no store
 * lands, which is what makes the two share without either being configured to.
 */
function storeOf(raw: JsonValue | undefined): string {
  if (!isJsonObject(raw)) return DEFAULT_STORE;
  const value = raw.store;
  return typeof value === "string" && value.trim() !== ""
    ? value.trim().slice(0, MAX_NAME)
    : DEFAULT_STORE;
}

function encodeValue(raw: JsonValue | undefined, field = "value"): ParseResult<string> {
  if (!isJsonObject(raw)) return fail("Expected an object of parameters.");
  if (!(field in raw)) return fail(`${field} is required.`);
  const encoded = JSON.stringify(raw[field] ?? null) ?? "null";
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_VALUE_BYTES) {
    return fail(`${field} is ${bytes} bytes; the limit is ${MAX_VALUE_BYTES}.`);
  }
  return { ok: true, value: encoded };
}

function decode(raw: string | undefined): JsonValue | null {
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
}

/** `{store, key}` — the shape every plain-value method parses. */
function parseValueAddress(
  raw: JsonValue | undefined,
): ParseResult<{ store: string; key: string }> {
  const key = text(raw, "key", MAX_KEY);
  if (!key.ok) return key;
  return { ok: true, value: { store: storeOf(raw), key: key.value } };
}

/** `{store, name}` — a named collection. */
function parseCollection(raw: JsonValue | undefined): ParseResult<{ store: string; name: string }> {
  const name = text(raw, "name", MAX_NAME);
  if (!name.ok) return name;
  return { ok: true, value: { store: storeOf(raw), name: name.value } };
}

/** `{store, name, key}` — a field of a named map. */
function parseField(
  raw: JsonValue | undefined,
): ParseResult<{ store: string; name: string; key: string }> {
  const collection = parseCollection(raw);
  if (!collection.ok) return collection;
  const key = text(raw, "key", MAX_KEY);
  if (!key.ok) return key;
  return { ok: true, value: { ...collection.value, key: key.value } };
}

/** `{store, name, item}` — a member of a named set or list. The item rides as decoded JSON. */
function parseItem(
  raw: JsonValue | undefined,
): ParseResult<{ store: string; name: string; item: JsonValue; encoded: string }> {
  const collection = parseCollection(raw);
  if (!collection.ok) return collection;
  const encoded = encodeValue(raw, "item");
  if (!encoded.ok) return encoded;
  const item = isJsonObject(raw) ? (raw.item ?? null) : null;
  return { ok: true, value: { ...collection.value, item, encoded: encoded.value } };
}

/** A capability, spelled once, so a typo here is a compile error rather than an open door. */
const DATA: keyof typeof PLUGIN_CAPABILITIES = "shared-data";
const SIGNALS: keyof typeof PLUGIN_CAPABILITIES = "signals";

export function createSharedDataMethods(deps: SharedDataMethodDeps): GatedMethodTable {
  const now = deps.now ?? (() => Date.now());
  const data = deps.data;

  /** Reading a stored list: one row holding the whole array. See `data-store.ts`. */
  const readList = (store: string, name: string): JsonValue[] => {
    const decoded = decode(data.get(store, LIST_COLLECTION, name)?.value);
    return Array.isArray(decoded) ? decoded : [];
  };

  return {
    // -- plain values -----------------------------------------------------------------------------

    "data.get": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      // Zero throughout: none of this reaches VRChat, and the rate budget exists to stop a plugin
      // spending the user's account. The frame budget is what bounds a plugin hammering SQLite.
      cost: 0,
      parse: parseValueAddress,
      handle: async ({ store, key }) => decode(data.get(store, VALUE_COLLECTION, key)?.value),
    }),

    "data.set": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: (raw) => {
        const address = parseValueAddress(raw);
        if (!address.ok) return address;
        const encoded = encodeValue(raw);
        if (!encoded.ok) return encoded;
        return { ok: true, value: { ...address.value, encoded: encoded.value } };
      },
      handle: async ({ store, key, encoded }) => {
        data.put(store, VALUE_COLLECTION, key, encoded);
        return null;
      },
    }),

    "data.delete": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: parseValueAddress,
      handle: async ({ store, key }) => {
        const had = data.get(store, VALUE_COLLECTION, key) !== null;
        data.remove(store, VALUE_COLLECTION, key);
        return had;
      },
    }),

    // -- maps -------------------------------------------------------------------------------------

    "data.map.get": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: parseField,
      handle: async ({ store, name, key }) =>
        decode(data.get(store, mapCollection(name), key)?.value),
    }),

    "data.map.set": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: (raw) => {
        const field = parseField(raw);
        if (!field.ok) return field;
        const encoded = encodeValue(raw);
        if (!encoded.ok) return encoded;
        return { ok: true, value: { ...field.value, encoded: encoded.value } };
      },
      handle: async ({ store, name, key, encoded }) => {
        data.put(store, mapCollection(name), key, encoded);
        return null;
      },
    }),

    "data.map.delete": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: parseField,
      handle: async ({ store, name, key }) => {
        const collection = mapCollection(name);
        const had = data.get(store, collection, key) !== null;
        data.remove(store, collection, key);
        return had;
      },
    }),

    "data.map.entries": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: parseCollection,
      handle: async ({ store, name }) =>
        data
          .list(store, mapCollection(name))
          .slice(0, MAX_ITEMS_PAGE)
          .map((row) => ({ key: row.key, value: decode(row.value) })),
    }),

    // -- sets -------------------------------------------------------------------------------------

    "data.set.add": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: parseItem,
      handle: async ({ store, name, item, encoded }) => {
        const collection = setCollection(name);
        const key = itemKey(item).slice(0, MAX_KEY);
        // The same answer the node gives, and the useful half: "was this new" is what a plugin
        // branches on to decide whether to greet somebody.
        const added = data.get(store, collection, key) === null;
        data.put(store, collection, key, encoded);
        return added;
      },
    }),

    "data.set.has": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: parseItem,
      handle: async ({ store, name, item }) =>
        data.get(store, setCollection(name), itemKey(item).slice(0, MAX_KEY)) !== null,
    }),

    "data.set.delete": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: parseItem,
      handle: async ({ store, name, item }) => {
        const collection = setCollection(name);
        const key = itemKey(item).slice(0, MAX_KEY);
        const had = data.get(store, collection, key) !== null;
        data.remove(store, collection, key);
        return had;
      },
    }),

    "data.set.items": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: parseCollection,
      handle: async ({ store, name }) =>
        data
          .list(store, setCollection(name))
          .slice(0, MAX_ITEMS_PAGE)
          .map((row) => decode(row.value)),
    }),

    // -- lists ------------------------------------------------------------------------------------

    "data.list.add": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: (raw) => {
        const item = parseItem(raw);
        if (!item.ok) return item;
        const max = isJsonObject(raw) && typeof raw.max === "number" ? Math.floor(raw.max) : 0;
        return { ok: true, value: { ...item.value, max: max > 0 ? max : 0 } };
      },
      handle: async ({ store, name, item, max }) => {
        const items = [...readList(store, name), item];
        // Trimmed from the front, so a cap makes this a rolling log of the most recent few — the
        // same behaviour `List: add` gives a graph.
        const kept = max > 0 && items.length > max ? items.slice(items.length - max) : items;
        data.put(store, LIST_COLLECTION, name, JSON.stringify(kept));
        return kept.length;
      },
    }),

    "data.list.items": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: parseCollection,
      handle: async ({ store, name }) => readList(store, name).slice(0, MAX_ITEMS_PAGE),
    }),

    "data.list.remove": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: parseItem,
      handle: async ({ store, name, item }) => {
        const items = readList(store, name);
        const kept = items.filter((entry) => !sameItem(entry, item));
        if (kept.length !== items.length)
          data.put(store, LIST_COLLECTION, name, JSON.stringify(kept));
        return items.length - kept.length;
      },
    }),

    "data.clear": defineGatedMethod("none", {
      scope: null,
      capability: DATA,
      cost: 0,
      parse: (raw): ParseResult<{ store: string; name: string; kind: CollectionKind }> => {
        const kind = isJsonObject(raw) ? raw.kind : undefined;
        if (kind !== "map" && kind !== "set" && kind !== "list") {
          return fail("kind must be one of map, set or list.");
        }
        const collection = parseCollection(raw);
        if (!collection.ok) return collection;
        return { ok: true, value: { ...collection.value, kind } };
      },
      handle: async ({ store, name, kind }) => {
        // A list is one row, the other two are a row per entry. There is no `kind: "value"` here on
        // purpose: "empty every plain value in this store" is indistinguishable from wiping the
        // store, which is a person's gesture.
        if (kind === "list") data.remove(store, LIST_COLLECTION, name);
        else data.clear(store, kind === "map" ? mapCollection(name) : setCollection(name));
        return null;
      },
    }),

    // -- signals ----------------------------------------------------------------------------------

    "signals.emit": defineGatedMethod("none", {
      scope: null,
      capability: SIGNALS,
      cost: 0,
      parse: (raw) => {
        const name = text(raw, "name", MAX_NAME);
        if (!name.ok) return name;
        const value = isJsonObject(raw) ? (raw.value ?? null) : null;
        return { ok: true, value: { name: name.value, value } };
      },
      handle: async ({ name, value }, ctx) => {
        // Global, always: `local` means "this graph only" and a plugin is not a graph. A local
        // signal from here would be heard by nobody, which is worse than not offering it.
        deps.bus.emit({
          kind: SIGNAL_KIND,
          accountId: null,
          ts: now(),
          subjectId: name,
          payload: {
            name,
            // Where a graph puts its id. Prefixed so a listener can tell a plugin's signal from a
            // graph's without a second field, and so no plugin can spoof a graph id.
            graphId: pluginSignalOrigin(ctx.grant.pluginId),
            value,
          },
        });
        return null;
      },
    }),
  };
}
