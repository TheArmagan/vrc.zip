import { beforeEach, describe, expect, test } from "bun:test";
import { MEMORY, Store } from "../store/store.ts";
import { createPluginDisableStore } from "./disable-store.ts";
import type { DisableRecord, PluginDisableStore } from "./supervisor.ts";

/**
 * The property this adapter exists for: **auto-disable outlives the process that decided it.**
 *
 * A crash-looping plugin that comes back enabled after a daemon restart is a crash loop with extra
 * steps — it crashes five more times, gets disabled again, and repeats for as long as anyone
 * restarts the daemon. So the supervisor's decision has to land somewhere a fresh supervisor reads
 * at construction, and this is that somewhere.
 */

const NOW = 1_706_659_200_000;

let store: Store;
let disable: PluginDisableStore;

beforeEach(() => {
  store = Store.open(MEMORY);
  store.upsertPlugin({
    id: "acme.hello",
    version: "1.0.0",
    manifest: "{}",
    bundle_hash: "a".repeat(64),
    source_kind: "path",
    source_ref: "C:/plugins/hello",
    trust: "unsigned",
    publisher_key: null,
    installed_at: NOW,
    updated_at: NOW,
  });
  disable = createPluginDisableStore(store);
});

const record = (overrides: Partial<DisableRecord> = {}): DisableRecord => ({
  pluginId: "acme.hello",
  reason: "crash-loop",
  detail: "It crashed 5 times in 5 minutes.",
  at: NOW,
  ...overrides,
});

describe("persisting a disable", () => {
  test("a healthy plugin has no record", () => {
    expect(disable.load("acme.hello")).toBeNull();
  });

  test("a crash-loop disable round-trips whole", () => {
    disable.save(record());

    // Read back through a fresh adapter over the same database — that is the restart this exists
    // for, and reading through the original object would prove nothing about it.
    const loaded = createPluginDisableStore(store).load("acme.hello");
    expect(loaded).toEqual(record());
  });

  test("clear brings it back", () => {
    disable.save(record());
    disable.clear("acme.hello");
    expect(disable.load("acme.hello")).toBeNull();
  });

  test("the reason survives, because it decides what the user is offered next", () => {
    // "You turned this off" and "vrc.zip turned this off because it kept dying" are different
    // sentences with different next steps, and a store that flattened them would lose that.
    disable.save(record({ reason: "user", detail: "Turned off." }));
    expect(disable.load("acme.hello")?.reason).toBe("user");

    disable.save(record({ reason: "protocol-mismatch", detail: "Needs plugin API 2." }));
    const loaded = disable.load("acme.hello");
    expect(loaded?.reason).toBe("protocol-mismatch");
    expect(loaded?.detail).toContain("plugin API 2");
  });
});

describe("what is deliberately not sticky", () => {
  test("spawn-failed stops this run and does not outlive it", () => {
    // A file locked by a virus scanner, a bundle mid-write, a disk that was briefly gone: these
    // pass. Permanently disabling a plugin because the machine was busy once would be the daemon
    // punishing the user for its own bad timing.
    disable.save(record({ reason: "spawn-failed", detail: "Could not spawn: EBUSY." }));
    expect(disable.load("acme.hello")).toBeNull();
    expect(store.getPlugin("acme.hello")?.disabled_at).toBeNull();
  });
});

describe("rows this build did not write", () => {
  test("an unrecognised reason keeps the plugin off rather than being ignored", () => {
    // A newer build may write a reason this one has never heard of. Treating it as no reason at all
    // would silently re-enable a plugin somebody else's code decided to stop, so it degrades to the
    // conservative reading: still disabled, and offering the "turn it back on" affordance.
    store.disablePlugin("acme.hello", NOW, "some-future-reason", "Something happened.");

    const loaded = disable.load("acme.hello");
    expect(loaded).not.toBeNull();
    expect(loaded?.reason).toBe("user");
    expect(loaded?.detail).toBe("Something happened.");
  });

  test("a disabled row with no reason text still loads", () => {
    store.disablePlugin("acme.hello", NOW, "crash-loop", "");
    expect(disable.load("acme.hello")?.at).toBe(NOW);
  });
});

describe("a plugin the store has never seen", () => {
  test("saving and clearing are no-ops rather than errors", () => {
    // The supervisor's in-memory state still holds for the session; there is simply no installed
    // row for a future session to read. Throwing here would put an exception on the one path that
    // is promised never to fail.
    expect(() => {
      disable.save(record({ pluginId: "acme.ghost" }));
    }).not.toThrow();
    expect(() => {
      disable.clear("acme.ghost");
    }).not.toThrow();
    expect(disable.load("acme.ghost")).toBeNull();
  });
});
