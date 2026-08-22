import { beforeEach, describe, expect, test } from "bun:test";
import type { Envelope } from "@vrcz/plugin-api";
import { MEMORY, Store } from "../store/store.ts";
import { PluginRegistry } from "./registry.ts";
import type {
  ExitInfo,
  PluginTransport,
  TransportFactory,
  TransportHandlers,
} from "./transport.ts";

/**
 * The registry's three promises, each tested by the failure it prevents.
 *
 * A disabled plugin is never started; one plugin that cannot start does not stop the others; and
 * shutdown always completes. The last two are the ones that would otherwise be discovered in
 * production — a daemon that refuses to boot because of one bad install, and a quit that hangs on
 * one wedged plugin.
 */

const NOW = 1_706_659_200_000;

/**
 * A transport that never becomes healthy.
 *
 * The registry's job stops at "a supervisor exists and was asked to start"; whether the plugin then
 * passes its handshake is the supervisor's business and has its own 25 tests. So this fake is
 * deliberately inert — it records that it was created and answers `stop` — which keeps these tests
 * about the collection rather than re-testing the state machine underneath it.
 */
function fakeTransport(pluginId: string, handlers: TransportHandlers): PluginTransport {
  let alive = true;
  return {
    pluginId,
    get running() {
      return alive;
    },
    pid: 1234,
    send: () => true,
    stop: async (): Promise<ExitInfo> => {
      alive = false;
      const info: ExitInfo = { reason: "shutdown", code: 0, signal: null, detail: "stopped" };
      handlers.onExit(info);
      return info;
    },
    kill: () => {
      alive = false;
    },
  };
}

interface Harness {
  registry: PluginRegistry;
  store: Store;
  /** Plugin ids the factory was asked to spawn, in order. */
  spawned: string[];
}

function harness(options: { failFor?: ReadonlySet<string> } = {}): Harness {
  const store = Store.open(MEMORY);
  const spawned: string[] = [];

  const factory: TransportFactory = async (spawn, handlers) => {
    spawned.push(spawn.pluginId);
    return fakeTransport(spawn.pluginId, handlers);
  };

  const registry = new PluginRegistry({
    store,
    factory,
    spawnFor: (pluginId) =>
      options.failFor?.has(pluginId) === true
        ? null
        : {
            bundlePath: `C:/plugins/${pluginId}/hash.js`,
            smol: true,
            memoryLimitBytes: 256 * 1024 * 1024,
          },
    // Heartbeats and restarts are the supervisor's tests, not these. Pushing every timer far out
    // keeps this file about the collection rather than about timing.
    supervisor: { heartbeatIntervalMs: 3_600_000, helloTimeoutMs: 3_600_000 },
  });

  return { registry, store, spawned };
}

function install(store: Store, id: string, disabled?: { by: string; reason: string }): void {
  store.upsertPlugin({
    id,
    version: "1.0.0",
    manifest: "{}",
    bundle_hash: "a".repeat(64),
    source_kind: "path",
    source_ref: `C:/plugins/${id}`,
    installed_at: NOW,
    updated_at: NOW,
  });
  if (disabled !== undefined) store.disablePlugin(id, NOW, disabled.by, disabled.reason);
}

let h: Harness;

beforeEach(() => {
  h = harness();
});

describe("starting", () => {
  test("every enabled plugin is started", async () => {
    install(h.store, "acme.one");
    install(h.store, "acme.two");

    await h.registry.startAll();

    expect(h.spawned.sort()).toEqual(["acme.one", "acme.two"]);
    expect(h.registry.running).toHaveLength(2);
  });

  test("a disabled plugin is not started, and does not even spawn a process", async () => {
    // Checked in the registry as well as inside the supervisor. The supervisor's check stops a
    // start it is asked for; this one means a crash-looped plugin does not pay for a process spawn
    // on every single daemon boot just to be told no.
    install(h.store, "acme.one");
    install(h.store, "acme.dead", { by: "crash-loop", reason: "It kept dying." });

    await h.registry.startAll();

    expect(h.spawned).toEqual(["acme.one"]);
    expect(h.registry.get("acme.dead")).toBeNull();
  });

  test("one plugin that cannot start does not stop the others", async () => {
    // The failure this exists to prevent: a daemon that refuses to boot because of one bad install.
    // Five of six running with a visible reason for the sixth is a much better outcome.
    const bad = harness({ failFor: new Set(["acme.broken"]) });
    install(bad.store, "acme.one");
    install(bad.store, "acme.broken");
    install(bad.store, "acme.two");

    await bad.registry.startAll();

    expect(bad.spawned.sort()).toEqual(["acme.one", "acme.two"]);
    // And it says why, rather than vanishing out of the list that is supposed to explain it.
    const broken = bad.registry.statuses().find((status) => status.pluginId === "acme.broken");
    expect(broken?.disabledReason).toContain("could not find");
  });

  test("starting an uninstalled plugin is recorded, not thrown", async () => {
    await h.registry.start("acme.ghost");
    expect(h.registry.get("acme.ghost")).toBeNull();
    expect(h.spawned).toEqual([]);
  });

  test("starting twice reuses the supervisor rather than spawning a second one", async () => {
    install(h.store, "acme.one");
    await h.registry.start("acme.one");
    const first = h.registry.get("acme.one");
    await h.registry.start("acme.one");
    expect(h.registry.get("acme.one")).toBe(first);
    expect(h.registry.running).toHaveLength(1);
  });
});

describe("disabling", () => {
  test("a running plugin is disabled and does not come back", async () => {
    install(h.store, "acme.one");
    await h.registry.startAll();

    h.registry.disable("acme.one", "user", "Turned off.");

    // The durable half: the next boot must not start it again.
    expect(h.store.getPlugin("acme.one")?.disabled_at).not.toBeNull();
    const next = harness();
    install(next.store, "acme.one", { by: "user", reason: "Turned off." });
    await next.registry.startAll();
    expect(next.spawned).toEqual([]);
  });

  test("disabling a plugin that never started still writes the durable state", async () => {
    // Exactly the case when someone disables one that failed to start. Without this the button
    // does nothing and the plugin is back after a restart.
    install(h.store, "acme.one");
    h.registry.disable("acme.one", "user", "Turned off.");
    expect(h.store.getPlugin("acme.one")?.disabled_by).toBe("user");
  });

  test("disabling something uninstalled is a no-op rather than an error", () => {
    // This path may never throw: it is the one control the user is promised always works.
    expect(() => {
      h.registry.disable("acme.ghost");
    }).not.toThrow();
  });

  test("enable clears the state and starts it again", async () => {
    install(h.store, "acme.one", { by: "crash-loop", reason: "It kept dying." });
    await h.registry.startAll();
    expect(h.spawned).toEqual([]);

    await h.registry.enable("acme.one");

    expect(h.store.getPlugin("acme.one")?.disabled_at).toBeNull();
    expect(h.spawned).toEqual(["acme.one"]);
  });
});

describe("shutdown", () => {
  test("stopAll stops everything and empties the set", async () => {
    install(h.store, "acme.one");
    install(h.store, "acme.two");
    await h.registry.startAll();

    await h.registry.stopAll();

    expect(h.registry.running).toHaveLength(0);
  });

  test("a plugin that never stops cannot hold the shutdown open", async () => {
    // The promise this bounds: quitting must not hang on one wedged plugin, at exactly the moment
    // the user is trying to leave.
    const store = Store.open(MEMORY);
    const factory: TransportFactory = async (spawn, handlers) => ({
      ...fakeTransport(spawn.pluginId, handlers),
      // Never resolves, and never calls `onExit`.
      stop: () => new Promise<ExitInfo>(() => {}),
    });
    const registry = new PluginRegistry({
      store,
      factory,
      spawnFor: (pluginId) => ({
        bundlePath: `C:/plugins/${pluginId}/hash.js`,
        smol: true,
        memoryLimitBytes: 256 * 1024 * 1024,
      }),
      supervisor: { heartbeatIntervalMs: 3_600_000, helloTimeoutMs: 3_600_000 },
    });
    install(store, "acme.wedged");
    await registry.start("acme.wedged");

    const started = Date.now();
    await registry.stopAll(50);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(registry.running).toHaveLength(0);
  });
});

describe("statuses", () => {
  test("an installed plugin appears whether or not it is running", async () => {
    // Built from the installed rows rather than the supervisors, because "installed and not
    // running" is the case someone is most likely opening this page to understand.
    install(h.store, "acme.one");
    install(h.store, "acme.off", { by: "user", reason: "Turned off." });

    await h.registry.startAll();

    const ids = h.registry.statuses().map((status) => status.pluginId);
    expect(ids.sort()).toEqual(["acme.off", "acme.one"]);

    const off = h.registry.statuses().find((status) => status.pluginId === "acme.off");
    expect(off?.state).toBe("disabled");
    expect(off?.disabledBy).toBe("user");
    expect(off?.version).toBe("1.0.0");
  });
});

describe("frames the supervisor does not own", () => {
  test("they reach the registry's handler tagged with the plugin that sent them", async () => {
    const store = Store.open(MEMORY);
    let captured: TransportHandlers | null = null;
    const seen: { pluginId: string; frame: Envelope }[] = [];

    const registry = new PluginRegistry({
      store,
      factory: async (spawn, handlers) => {
        captured = handlers;
        return fakeTransport(spawn.pluginId, handlers);
      },
      spawnFor: (pluginId) => ({
        bundlePath: `C:/plugins/${pluginId}/hash.js`,
        smol: true,
        memoryLimitBytes: 256 * 1024 * 1024,
      }),
      supervisor: { heartbeatIntervalMs: 3_600_000, helloTimeoutMs: 3_600_000 },
      onPluginFrame: (pluginId, frame) => seen.push({ pluginId, frame }),
    });
    install(store, "acme.one");
    await registry.start("acme.one");

    const handlers = captured as TransportHandlers | null;
    handlers?.onFrame({ t: "credit", sub: "s1", credits: 10 });

    // Attribution is the whole point: the dispatcher has to know which grant a request came from,
    // and a frame that arrived without a plugin id attached would be a frame it cannot authorise.
    expect(seen).toEqual([
      { pluginId: "acme.one", frame: { t: "credit", sub: "s1", credits: 10 } },
    ]);
  });
});
