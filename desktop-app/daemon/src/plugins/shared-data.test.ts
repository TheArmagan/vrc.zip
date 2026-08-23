/**
 * The shared stores and signals, from a plugin's side of the gate.
 *
 * Driven through `createScopeGate` rather than by calling handlers, for the reason the gate exists:
 * a test that invokes a handler proves the handler works and says nothing about whether anything
 * checked the capability first.
 *
 * The assertion that matters most is not in this file's method calls at all — it is
 * `the same rows a graph sees`, which drives a plugin method and a graph node against one store and
 * expects each to read what the other wrote. Two APIs over one table that disagree about the
 * encoding would pass every other test here.
 */

import { describe, expect, test } from "bun:test";
import type { PluginGrant, RequestFrame } from "@vrcz/plugin-api";
import type { JsonValue } from "@vrcz/shared";
import { type BusEvent, EventBus } from "../bus/event-bus.ts";
import type { GraphDataStore } from "../graphs/builtins/data-store.ts";
import { createBuiltinNodes } from "../graphs/builtins/index.ts";
import { DispatchError } from "./dispatcher.ts";
import { createScopeGate } from "./scope-gate.ts";
import { createSharedDataMethods, pluginSignalOrigin } from "./shared-data.ts";

const PLUGIN = "acme.notes";
const NOW = 1_760_000_000_000;

/** The named stores, without SQLite. Keyed exactly as the real primary key is. */
function memoryData(): GraphDataStore {
  const rows = new Map<string, string>();
  const id = (store: string, collection: string, key: string) => `${store}\n${collection}\n${key}`;
  return {
    get: (store, collection, key) => {
      const value = rows.get(id(store, collection, key));
      return value === undefined ? null : { value, updatedAt: NOW };
    },
    put: (store, collection, key, value) => {
      rows.set(id(store, collection, key), value);
    },
    remove: (store, collection, key) => {
      rows.delete(id(store, collection, key));
    },
    list: (store, collection) =>
      [...rows.entries()]
        .filter(([composite]) => composite.startsWith(`${store}\n${collection}\n`))
        .map(([composite, value]) => ({ key: composite.split("\n")[2] ?? "", value })),
    count: (store, collection) =>
      [...rows.keys()].filter((composite) => composite.startsWith(`${store}\n${collection}\n`))
        .length,
    clear: (store, collection) => {
      for (const composite of [...rows.keys()]) {
        if (composite.startsWith(`${store}\n${collection}\n`)) rows.delete(composite);
      }
    },
  };
}

function grantOf(capabilities: PluginGrant["capabilities"]): PluginGrant {
  return { pluginId: PLUGIN, scopes: [], accountIds: [], capabilities, events: [] };
}

const CAPABLE = grantOf(["shared-data", "signals"]);

function req(method: string, params?: JsonValue): RequestFrame {
  return { t: "req", id: "1", method, deadline: NOW + 1000, ...(params ? { params } : {}) };
}

function harness(options: { data?: GraphDataStore } = {}) {
  const data = options.data ?? memoryData();
  const bus = new EventBus();
  const methods = createSharedDataMethods({ data, bus, now: () => NOW });
  const gate = createScopeGate(methods);

  const call = async (
    method: string,
    params?: JsonValue,
    grant: PluginGrant = CAPABLE,
  ): Promise<JsonValue> => {
    const authorized = gate.check(req(method, params), grant, NOW);
    if (!authorized.ok) throw new DispatchError(authorized.code, authorized.message);
    const result = await authorized.value.method.invoke(params, {
      grant,
      deadline: NOW + 1000,
      signal: new AbortController().signal,
    });
    if (!result.ok) throw new DispatchError(result.code, result.message);
    return result.value ?? null;
  };

  return { bus, call, data, gate };
}

/* -------------------------------------------------------------------------------------------- */

describe("the capability gate", () => {
  test("neither capability is a scope, and neither substitutes for the other", () => {
    const h = harness();
    const nothing = grantOf([]);
    const scopedOnly = grantOf([]);
    const dataOnly = grantOf(["shared-data"]);

    for (const method of h.gate.methods) {
      const verdict = h.gate.check(req(method), nothing, NOW);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("E_CAPABILITY_DENIED");
    }
    // `storage` is a different database entirely; holding it buys nothing here.
    expect(h.gate.check(req("data.get"), grantOf(["storage"]), NOW).ok).toBe(false);
    expect(h.gate.check(req("data.get"), scopedOnly, NOW).ok).toBe(false);
    // And `shared-data` does not carry `signals` along with it.
    expect(h.gate.check(req("data.get"), dataOnly, NOW).ok).toBe(true);
    expect(h.gate.check(req("signals.emit"), dataOnly, NOW).ok).toBe(false);
  });

  test("no method deletes a store", () => {
    // Removing a store removes what another graph may be mid-run over. A person's gesture, from the
    // Stores panel. Asserted as an absence because that is what it is.
    const h = harness();
    expect(h.gate.methods.some((method) => method.includes("store.delete"))).toBe(false);
    expect(h.gate.check(req("data.stores.delete"), CAPABLE, NOW).ok).toBe(false);
  });
});

describe("the stores", () => {
  test("a plain value round-trips, and a miss is null", async () => {
    const h = harness();
    expect(await h.call("data.get", { key: "greeting" })).toBe(null);
    await h.call("data.set", { key: "greeting", value: { text: "hello" } });
    expect(await h.call("data.get", { key: "greeting" })).toEqual({ text: "hello" });
    expect(await h.call("data.delete", { key: "greeting" })).toBe(true);
    expect(await h.call("data.delete", { key: "greeting" })).toBe(false);
  });

  test("naming no store lands in the same place a graph that names none lands", async () => {
    const h = harness();
    await h.call("data.set", { key: "k", value: 1 });
    expect(h.data.get("default", "", "k")).not.toBe(null);
  });

  test("the same rows a graph sees", async () => {
    // The whole feature, in one test. One store object, a plugin method on one side and a graph
    // node on the other, each reading what the other wrote.
    const data = memoryData();
    const h = harness({ data });
    const nodes = createBuiltinNodes({ bus: new EventBus(), now: () => NOW, data });
    const context = {
      graphId: "g1",
      runId: "r1",
      nodeId: "n1",
      dryRun: false,
      accountId: "usr_me",
    };

    // Plugin writes, graph reads.
    await h.call("data.set.add", { name: "welcomed", item: "usr_a" });
    expect(
      await nodes.execute("vrcz/store-set-has", { item: "usr_a" }, { name: "welcomed" }, context),
    ).toEqual({ has: true });

    // Graph writes, plugin reads.
    await nodes.execute("vrcz/store-set-add", { item: "usr_b" }, { name: "welcomed" }, context);
    expect(await h.call("data.set.items", { name: "welcomed" })).toEqual(["usr_a", "usr_b"]);
  });

  test("a set reports whether the member was new", async () => {
    const h = harness();
    expect(await h.call("data.set.add", { name: "seen", item: "usr_a" })).toBe(true);
    expect(await h.call("data.set.add", { name: "seen", item: "usr_a" })).toBe(false);
    expect(await h.call("data.set.has", { name: "seen", item: "usr_a" })).toBe(true);
    expect(await h.call("data.set.delete", { name: "seen", item: "usr_a" })).toBe(true);
    expect(await h.call("data.set.items", { name: "seen" })).toEqual([]);
  });

  test("a map's fields, and emptying it", async () => {
    const h = harness();
    await h.call("data.map.set", { name: "counts", key: "a", value: 1 });
    await h.call("data.map.set", { name: "counts", key: "b", value: 2 });
    expect(await h.call("data.map.entries", { name: "counts" })).toEqual([
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ]);
    expect(await h.call("data.map.delete", { name: "counts", key: "a" })).toBe(true);
    await h.call("data.clear", { kind: "map", name: "counts" });
    expect(await h.call("data.map.entries", { name: "counts" })).toEqual([]);
  });

  test("a capped list is a rolling log", async () => {
    const h = harness();
    for (const item of [1, 2, 3]) {
      await h.call("data.list.add", { name: "recent", item, max: 2 });
    }
    expect(await h.call("data.list.items", { name: "recent" })).toEqual([2, 3]);
    expect(await h.call("data.list.remove", { name: "recent", item: 2 })).toBe(1);
    expect(await h.call("data.list.items", { name: "recent" })).toEqual([3]);
  });

  test("a nameless collection is refused before a statement runs", async () => {
    const h = harness();
    await expect(h.call("data.map.set", { name: "", key: "a", value: 1 })).rejects.toThrow(
      /non-empty/,
    );
    await expect(h.call("data.clear", { kind: "value", name: "x" })).rejects.toThrow(/map, set/);
  });

  test("an oversized value is refused rather than stored", async () => {
    const h = harness();
    await expect(h.call("data.set", { key: "big", value: "x".repeat(70_000) })).rejects.toThrow(
      /limit is/,
    );
  });
});

describe("signals", () => {
  test("a plugin's signal is global and says which plugin sent it", async () => {
    const h = harness();
    const seen: BusEvent[] = [];
    h.bus.subscribe(
      (event) => {
        seen.push(event);
      },
      { kinds: ["graph.signal", "graph.signal.local"] },
    );

    await h.call("signals.emit", { name: "greet", value: { who: "usr_a" } });

    expect(seen).toHaveLength(1);
    // Never the local kind: `local` means "this graph only" and a plugin is not a graph.
    expect(seen[0]?.kind).toBe("graph.signal");
    expect(seen[0]?.subjectId).toBe("greet");
    expect(seen[0]?.payload).toEqual({
      name: "greet",
      // Prefixed, so a listener can tell a plugin's signal from a graph's and no plugin can claim
      // to be a graph.
      graphId: pluginSignalOrigin(PLUGIN),
      value: { who: "usr_a" },
    });
  });

  test("a graph hears what a plugin sent", async () => {
    const h = harness();
    const nodes = createBuiltinNodes({ bus: h.bus, now: () => NOW });
    const fires: Record<string, unknown>[] = [];
    await nodes.arm("vrcz/on-signal", {
      instanceId: "i1",
      graphId: "g1",
      nodeId: "trigger",
      config: { name: "greet", scope: "any" },
      fire: (outputs) => {
        fires.push(outputs);
      },
    });

    await h.call("signals.emit", { name: "greet", value: 1 });

    expect(fires).toEqual([
      { value: 1, name: "greet", graph: pluginSignalOrigin(PLUGIN), at: NOW },
    ]);
    await nodes.disarm("vrcz/on-signal", "i1");
  });

  test("a signal needs a name", async () => {
    const h = harness();
    await expect(h.call("signals.emit", { value: 1 })).rejects.toThrow(/non-empty/);
  });
});
