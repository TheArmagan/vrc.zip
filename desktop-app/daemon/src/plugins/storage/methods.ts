/**
 * The `storage.*` method table: a plugin's own database, as eight calls.
 *
 * Every method here declares `capability: "storage"` and `scope: null`, and that pairing is the
 * point of capabilities existing at all. A plugin's private database says nothing about the user's
 * VRChat account — there is no scope that would honestly describe it — but it is still a host power
 * somebody agreed to, so it needs *something* on the gate. Before this, the gate knew only scopes,
 * and the honest options were to invent a fake scope or to check nothing.
 *
 * `cost: 0` throughout: none of these reaches VRChat, and the rate budget exists to keep a plugin
 * from spending the user's account. A local write is not that. The in-flight cap and the frame
 * budget are what bound a plugin hammering its own database, and they are transport-level.
 *
 * The one thing worth reading before adding a method here: **the parse functions are the entire
 * input validation**, because `defineGatedMethod` binds parse to handle and a handler never sees a
 * raw parameter. A key that is too long, a value that is too big, a limit that is absurd — all of
 * that is refused before a statement is prepared, not inside one.
 */

import {
  DEFAULT_RECORDS_PAGE,
  MAX_KV_KEYS_PAGE,
  MAX_RECORDS_PAGE,
  MAX_STORAGE_KEY_LENGTH,
  MAX_STORAGE_VALUE_BYTES,
  type ParseResult,
} from "@vrcz/plugin-api";
import { isJsonObject, type JsonValue } from "@vrcz/shared";
import { DispatchError } from "../dispatcher.ts";
import { defineGatedMethod, type GatedMethodTable } from "../scope-gate.ts";
import type { PluginStorage } from "./database.ts";

/** How the host reaches one plugin's storage. A function rather than a map so a plugin's database
 * is opened on first use and closed with the plugin, without this module owning the lifecycle. */
export interface StorageMethodDeps {
  readonly storageFor: (pluginId: string) => PluginStorage;
  readonly now?: () => number;
}

function fail(message: string): ParseResult<never> {
  return { ok: false, code: "E_BAD_REQUEST", message };
}

function parseKey(raw: JsonValue | undefined, field = "key"): ParseResult<string> {
  if (!isJsonObject(raw)) return fail("Expected an object of parameters.");
  const key = raw[field];
  if (typeof key !== "string" || key.length === 0) {
    return fail(`${field} must be a non-empty string.`);
  }
  if (key.length > MAX_STORAGE_KEY_LENGTH) {
    return fail(`${field} must be at most ${MAX_STORAGE_KEY_LENGTH} characters.`);
  }
  return { ok: true, value: key };
}

/**
 * Serialises a value and enforces the size cap in **bytes, not characters**.
 *
 * A JS string length undercounts anything outside the BMP, and a plugin storing emoji or CJK text
 * would otherwise be allowed a value that does not fit in a frame — a limit that holds for English
 * and fails for everyone else is worse than no limit.
 */
function parseValue(raw: JsonValue | undefined): ParseResult<string> {
  if (!isJsonObject(raw)) return fail("Expected an object of parameters.");
  if (!("value" in raw)) return fail("value is required.");
  const encoded = JSON.stringify(raw.value ?? null);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > MAX_STORAGE_VALUE_BYTES) {
    return fail(
      `value is ${bytes} bytes; the limit is ${MAX_STORAGE_VALUE_BYTES}. Split it across keys.`,
    );
  }
  return { ok: true, value: encoded };
}

function optionalString(raw: JsonValue | undefined, field: string): string {
  if (!isJsonObject(raw)) return "";
  const value = raw[field];
  return typeof value === "string" ? value : "";
}

function optionalInteger(raw: JsonValue | undefined, field: string, fallback: number): number {
  if (!isJsonObject(raw)) return fallback;
  const value = raw[field];
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(value, 1), max);
}

export function createStorageMethods(deps: StorageMethodDeps): GatedMethodTable {
  const now = deps.now ?? (() => Date.now());

  /** Refuses a write that would put the plugin over quota, with the sentence that names the fix. */
  const guardQuota = (storage: PluginStorage, incoming: number): void => {
    if (!storage.wouldExceedQuota(incoming)) return;
    const { bytes, quotaBytes } = storage.usage();
    throw new DispatchError(
      "E_QUOTA",
      `This plugin is using ${bytes} of its ${quotaBytes} byte quota. Delete records to free space; waiting will not.`,
      { data: { bytes, quotaBytes } },
    );
  };

  return {
    // -- kv -------------------------------------------------------------------------------------

    "storage.kv.get": defineGatedMethod("none", {
      scope: null,
      capability: "storage",
      cost: 0,
      parse: (raw) => parseKey(raw),
      handle: async (key, ctx) => {
        const stored = deps.storageFor(ctx.grant.pluginId).kvGet(key);
        // `null` for a missing key and `null` for a stored null are the same answer on the wire,
        // and that is deliberate: a plugin that needs to tell them apart is asking a question its
        // own key naming should answer.
        return stored === null ? null : (JSON.parse(stored) as JsonValue);
      },
    }),

    "storage.kv.set": defineGatedMethod("none", {
      scope: null,
      capability: "storage",
      cost: 0,
      parse: (raw) => {
        const key = parseKey(raw);
        if (!key.ok) return key;
        const value = parseValue(raw);
        if (!value.ok) return value;
        return { ok: true, value: { key: key.value, encoded: value.value } };
      },
      handle: async ({ key, encoded }, ctx) => {
        const storage = deps.storageFor(ctx.grant.pluginId);
        guardQuota(storage, Buffer.byteLength(encoded, "utf8") + key.length);
        storage.kvSet(key, encoded, now());
        return null;
      },
    }),

    "storage.kv.delete": defineGatedMethod("none", {
      scope: null,
      capability: "storage",
      cost: 0,
      parse: (raw) => parseKey(raw),
      handle: async (key, ctx) => ({ deleted: deps.storageFor(ctx.grant.pluginId).kvDelete(key) }),
    }),

    "storage.kv.keys": defineGatedMethod("none", {
      scope: null,
      capability: "storage",
      cost: 0,
      parse: (raw) => ({
        ok: true,
        value: {
          prefix: optionalString(raw, "prefix"),
          limit: clamp(optionalInteger(raw, "limit", MAX_KV_KEYS_PAGE), MAX_KV_KEYS_PAGE),
        },
      }),
      handle: async ({ prefix, limit }, ctx) =>
        deps.storageFor(ctx.grant.pluginId).kvKeys(prefix, limit),
    }),

    // -- records --------------------------------------------------------------------------------

    "storage.records.append": defineGatedMethod("none", {
      scope: null,
      capability: "storage",
      cost: 0,
      parse: (raw) => {
        const key = parseKey(raw);
        if (!key.ok) return key;
        const value = parseValue(raw);
        if (!value.ok) return value;
        return { ok: true, value: { key: key.value, encoded: value.value } };
      },
      handle: async ({ key, encoded }, ctx) => {
        const storage = deps.storageFor(ctx.grant.pluginId);
        guardQuota(storage, Buffer.byteLength(encoded, "utf8") + key.length);
        // The host stamps the time, never the plugin. A plugin-supplied `ts` would let a buggy one
        // write rows that no time-window query can reach, which reads as data loss.
        const ts = now();
        return { id: storage.recordsAppend(key, encoded, ts), ts };
      },
    }),

    "storage.records.query": defineGatedMethod("none", {
      scope: null,
      capability: "storage",
      cost: 0,
      parse: (raw) => ({
        ok: true,
        value: {
          prefix: optionalString(raw, "prefix"),
          since: optionalInteger(raw, "since", 0),
          until: optionalInteger(raw, "until", Number.MAX_SAFE_INTEGER),
          limit: clamp(optionalInteger(raw, "limit", DEFAULT_RECORDS_PAGE), MAX_RECORDS_PAGE),
        },
      }),
      handle: async (options, ctx) =>
        deps.storageFor(ctx.grant.pluginId).recordsQuery(options) as unknown as JsonValue,
    }),

    "storage.records.delete": defineGatedMethod("none", {
      scope: null,
      capability: "storage",
      cost: 0,
      parse: (raw): ParseResult<{ prefix: string; before: number }> => {
        // A delete with no bounds at all is almost certainly a mistake in a plugin rather than an
        // intention, so it has to be spelled: `prefix: ""` with a `before` in the future is how you
        // say "everything", and it is not what a missing parameter does.
        if (!isJsonObject(raw)) return fail("Expected an object of parameters.");
        if (!("prefix" in raw) && !("before" in raw)) {
          return fail(
            'Pass a prefix, a before, or both. To delete everything, pass prefix: "" explicitly.',
          );
        }
        return {
          ok: true,
          value: {
            prefix: optionalString(raw, "prefix"),
            before: optionalInteger(raw, "before", Number.MAX_SAFE_INTEGER),
          },
        };
      },
      handle: async (options, ctx) => ({
        deleted: deps.storageFor(ctx.grant.pluginId).recordsDelete(options),
      }),
    }),

    // -- usage ----------------------------------------------------------------------------------

    "storage.usage": defineGatedMethod("none", {
      scope: null,
      capability: "storage",
      cost: 0,
      parse: () => ({ ok: true, value: null }),
      handle: async (_params, ctx) => {
        const { bytes, quotaBytes } = deps.storageFor(ctx.grant.pluginId).usage();
        return { bytes, quotaBytes };
      },
    }),
  };
}
