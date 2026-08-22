/**
 * Storage, tested through the same gate a plugin calls it through.
 *
 * The database half is exercised directly, because a `stat`-based quota and a `GLOB` prefix are
 * both things that can be subtly wrong while looking right. The method half is driven through
 * `createScopeGate` rather than by calling handlers, for the reason the gate exists: a test that
 * invokes a handler proves the handler works and says nothing about whether anything checks the
 * capability first.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_STORAGE_VALUE_BYTES, type PluginGrant, type RequestFrame } from "@vrcz/plugin-api";
import type { JsonValue } from "@vrcz/shared";
import { pluginDataDir } from "../../paths.ts";
import { DispatchError } from "../dispatcher.ts";
import { createScopeGate } from "../scope-gate.ts";
import { PluginStorage } from "./database.ts";
import { createStorageMethods } from "./methods.ts";

const PLUGIN = "acme.notes";
const NOW = 1_760_000_000_000;

let stateDir: string;
let env: NodeJS.ProcessEnv;
let storage: PluginStorage;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "vrczip-storage-"));
  env = { VRCZIP_STATE_DIR: stateDir };
  storage = new PluginStorage(PLUGIN, { env });
});

afterEach(() => {
  storage.close();
  rmSync(stateDir, { recursive: true, force: true });
});

function grantOf(capabilities: PluginGrant["capabilities"] = ["storage"]): PluginGrant {
  return { pluginId: PLUGIN, scopes: [], accountIds: [], capabilities, events: [] };
}

function req(method: string, params?: JsonValue): RequestFrame {
  return { t: "req", id: "1", method, deadline: NOW + 1000, ...(params ? { params } : {}) };
}

function gate() {
  return createScopeGate(createStorageMethods({ storageFor: () => storage, now: () => NOW }));
}

/** Runs a call the whole way through the gate, as the dispatcher would. */
async function call(method: string, params?: JsonValue, grant = grantOf()): Promise<JsonValue> {
  const authorized = gate().check(req(method, params), grant, NOW);
  if (!authorized.ok) throw new DispatchError(authorized.code, authorized.message);
  const result = await authorized.value.method.invoke(params, {
    grant,
    deadline: NOW + 1000,
    signal: new AbortController().signal,
  });
  if (!result.ok) throw new DispatchError(result.code, result.message);
  return result.value ?? null;
}

describe("the capability gate", () => {
  test("a grant without the storage capability cannot reach any storage method", async () => {
    const withoutStorage = grantOf([]);
    for (const method of gate().methods) {
      const verdict = gate().check(req(method), withoutStorage, NOW);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("E_CAPABILITY_DENIED");
    }
  });

  test("a capability is not a scope: an unrelated scope does not substitute for one", async () => {
    const scopedButNotCapable: PluginGrant = {
      pluginId: PLUGIN,
      scopes: ["friends:read"],
      accountIds: [],
      capabilities: [],
      events: ["*"],
    };
    const verdict = gate().check(req("storage.kv.get", { key: "a" }), scopedButNotCapable, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("E_CAPABILITY_DENIED");
  });

  test("with the capability, the same call goes through", async () => {
    await call("storage.kv.set", { key: "a", value: { n: 1 } });
    expect(await call("storage.kv.get", { key: "a" })).toEqual({ n: 1 });
  });
});

describe("kv", () => {
  test("a missing key answers null rather than failing", async () => {
    expect(await call("storage.kv.get", { key: "nope" })).toBeNull();
  });

  test("set overwrites, delete reports whether anything went", async () => {
    await call("storage.kv.set", { key: "a", value: 1 });
    await call("storage.kv.set", { key: "a", value: 2 });
    expect(await call("storage.kv.get", { key: "a" })).toBe(2);
    expect(await call("storage.kv.delete", { key: "a" })).toEqual({ deleted: true });
    expect(await call("storage.kv.delete", { key: "a" })).toEqual({ deleted: false });
  });

  test("keys filters by prefix", async () => {
    await call("storage.kv.set", { key: "seen/a", value: 1 });
    await call("storage.kv.set", { key: "seen/b", value: 1 });
    await call("storage.kv.set", { key: "other", value: 1 });
    expect(await call("storage.kv.keys", { prefix: "seen/" })).toEqual(["seen/a", "seen/b"]);
  });

  /**
   * `GLOB` treats `[`, `*` and `?` as syntax, and a plugin's key is arbitrary text. Unescaped, a
   * key containing `[ab]` turns a prefix query into a character class and returns the wrong rows —
   * which reads as data loss to whoever hits it.
   */
  test("a key containing GLOB syntax is matched literally", async () => {
    await call("storage.kv.set", { key: "w[ab]/one", value: 1 });
    await call("storage.kv.set", { key: "wa/two", value: 1 });
    expect(await call("storage.kv.keys", { prefix: "w[ab]/" })).toEqual(["w[ab]/one"]);

    await call("storage.kv.set", { key: "star*/x", value: 1 });
    await call("storage.kv.set", { key: "starZZ/y", value: 1 });
    expect(await call("storage.kv.keys", { prefix: "star*/" })).toEqual(["star*/x"]);
  });
});

describe("records", () => {
  test("append stamps the host's own time, and query reads newest first", async () => {
    const first = (await call("storage.records.append", { key: "log/a", value: 1 })) as {
      id: number;
      ts: number;
    };
    await call("storage.records.append", { key: "log/b", value: 2 });
    expect(first.ts).toBe(NOW);

    const rows = (await call("storage.records.query", { prefix: "log/" })) as { value: number }[];
    expect(rows.map((row) => row.value)).toEqual([2, 1]);
  });

  test("a plugin cannot stamp its own ts, so no row can hide outside a time window", async () => {
    await call("storage.records.append", { key: "log/a", value: 1, ts: 1 });
    const rows = (await call("storage.records.query", {
      prefix: "log/",
      since: NOW,
      until: NOW,
    })) as unknown[];
    expect(rows).toHaveLength(1);
  });

  test("delete needs a bound spelled out, and empty prefix is how you say everything", async () => {
    await call("storage.records.append", { key: "log/a", value: 1 });
    await expect(call("storage.records.delete", {})).rejects.toThrow(/prefix/);
    expect(await call("storage.records.delete", { prefix: "" })).toEqual({ deleted: 1 });
  });
});

describe("the quota", () => {
  test("a write that would cross it is refused before it lands, with E_QUOTA", async () => {
    const tiny = new PluginStorage(PLUGIN, { env, quotaBytes: 1 });
    const gateTiny = createScopeGate(
      createStorageMethods({ storageFor: () => tiny, now: () => NOW }),
    );
    const authorized = gateTiny.check(
      req("storage.kv.set", { key: "a", value: "x" }),
      grantOf(),
      NOW,
    );
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;

    await expect(
      authorized.value.method.invoke(
        { key: "a", value: "x" },
        { grant: grantOf(), deadline: NOW + 1000, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "E_QUOTA" });

    // Refused *before* it landed, which is the half a post-write check would get wrong.
    expect(tiny.kvGet("a")).toBeNull();
    tiny.close();
  });

  test("usage counts everything in the directory, not just the database", async () => {
    await call("storage.kv.set", { key: "a", value: "x" });
    const before = (await call("storage.usage")) as { bytes: number };
    writeFileSync(join(pluginDataDir(PLUGIN, env), "stray.txt"), "x".repeat(4096));
    const after = (await call("storage.usage")) as { bytes: number };
    expect(after.bytes - before.bytes).toBeGreaterThanOrEqual(4096);
  });

  test("deleting records frees quota, which is what E_QUOTA tells a plugin to do", async () => {
    const value = "x".repeat(64 * 1024);
    for (let i = 0; i < 8; i++) {
      await call("storage.records.append", { key: `log/${i}`, value });
    }
    const full = storage.usageBytes();
    await call("storage.records.delete", { prefix: "" });
    // `auto_vacuum = FULL` is what makes this true. Under the daemon's INCREMENTAL the file would
    // stay exactly as large and the error message would be a lie.
    expect(storage.usageBytes()).toBeLessThan(full);
  });
});

describe("value limits", () => {
  test("the cap is bytes, not characters, so multi-byte text is not silently over", async () => {
    // Just under in characters, well over in UTF-8 bytes. A length check would let this through.
    const emoji = "😀".repeat(MAX_STORAGE_VALUE_BYTES / 4);
    await expect(call("storage.kv.set", { key: "a", value: emoji })).rejects.toThrow(/bytes/);
  });

  test("an oversized value never reaches the database", async () => {
    const huge = "x".repeat(MAX_STORAGE_VALUE_BYTES + 1);
    await expect(call("storage.kv.set", { key: "a", value: huge })).rejects.toThrow();
    expect(storage.kvGet("a")).toBeNull();
  });
});
