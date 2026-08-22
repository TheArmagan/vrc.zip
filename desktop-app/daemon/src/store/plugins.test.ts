import { beforeEach, describe, expect, test } from "bun:test";
import { MEMORY, Store } from "./store.ts";
import type { NewPlugin } from "./types.ts";

/**
 * The plugin tables, and the two properties they exist to make true by construction rather than by
 * a check somebody has to remember to write.
 *
 * First: **an update that asks for more provably re-prompts.** Grants are keyed by
 * `(plugin_id, version, grant_hash)` and rows are immutable, so a version bump or a widened
 * permission set produces a key that has never been approved — there is nothing to find, and
 * consent is unavoidable. The same key kills the downgrade attack, where reinstalling an older
 * version would otherwise silently reuse a broader grant a later version had asked for.
 *
 * Second: **auto-disable survives a restart.** A crash-looping plugin that comes back enabled after
 * the daemon restarts is a crash loop with extra steps, so the disabled state is a column rather
 * than a field on the supervisor.
 */

const NOW = 1_706_659_200_000;

function plugin(overrides: Partial<NewPlugin> = {}): NewPlugin {
  return {
    id: "acme.hello",
    version: "1.0.0",
    manifest: JSON.stringify({ id: "acme.hello", version: "1.0.0" }),
    bundle_hash: "a".repeat(64),
    source_kind: "path",
    source_ref: "C:/plugins/hello",
    installed_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

let store: Store;

beforeEach(() => {
  store = Store.open(MEMORY);
  store.upsertPlugin(plugin());
});

describe("installed plugins", () => {
  test("an install round-trips, and an upgrade replaces the row in place", () => {
    expect(store.getPlugin("acme.hello")?.version).toBe("1.0.0");

    store.upsertPlugin(
      plugin({ version: "1.1.0", bundle_hash: "b".repeat(64), updated_at: NOW + 1 }),
    );

    const row = store.getPlugin("acme.hello");
    expect(row?.version).toBe("1.1.0");
    expect(row?.bundle_hash).toBe("b".repeat(64));
    // Not a second row: one plugin, one install. The *grants* are what carry the version.
    expect(store.listPlugins()).toHaveLength(1);
    // The original install time survives an upgrade — "installed in March, updated yesterday" is
    // two facts and the upgrade only knows one of them.
    expect(row?.installed_at).toBe(NOW);
  });

  test("a fresh install is enabled, and disable is durable and reversible", () => {
    expect(store.getPlugin("acme.hello")?.disabled_at).toBeNull();

    store.disablePlugin("acme.hello", NOW, "crash-loop", "It crashed five times in two minutes.");

    // Read back through a *new* query rather than a cached object: the point of the column is that
    // the state is in the database, not in whatever object the supervisor is holding.
    const disabled = store.getPlugin("acme.hello");
    expect(disabled?.disabled_at).toBe(NOW);
    expect(disabled?.disabled_by).toBe("crash-loop");
    expect(disabled?.disabled_reason).toContain("five times");

    store.enablePlugin("acme.hello");
    const enabled = store.getPlugin("acme.hello");
    expect(enabled?.disabled_at).toBeNull();
    expect(enabled?.disabled_by).toBeNull();
    expect(enabled?.disabled_reason).toBeNull();
  });

  test("disabling twice is not an error", () => {
    // The kill path may not be allowed to fail, and "already disabled" is the outcome asked for.
    store.disablePlugin("acme.hello", NOW, "user", "Turned off.");
    store.disablePlugin("acme.hello", NOW + 5, "user", "Turned off again.");
    expect(store.getPlugin("acme.hello")?.disabled_at).toBe(NOW + 5);
  });
});

describe("grants", () => {
  const GRANT = {
    plugin_id: "acme.hello",
    version: "1.0.0",
    grant_hash: "hash-narrow",
    scopes: JSON.stringify(["friends:read"]),
    account_ids: JSON.stringify(["usr_a"]),
    capabilities: JSON.stringify(["storage"]),
    domains: JSON.stringify([]),
    events: JSON.stringify(["friend.*"]),
    granted_at: NOW,
  };

  test("a grant is found only under the exact key it was approved with", () => {
    store.insertPluginGrant(GRANT);
    expect(store.findPluginGrant("acme.hello", "1.0.0", "hash-narrow")).not.toBeNull();

    // A version bump: same permissions, new key, so nothing is found and consent is unavoidable.
    expect(store.findPluginGrant("acme.hello", "1.1.0", "hash-narrow")).toBeNull();
    // A widened permission set at the same version: same story, from the other direction.
    expect(store.findPluginGrant("acme.hello", "1.0.0", "hash-wide")).toBeNull();
  });

  test("approving 1.1.0 does not retroactively approve 1.0.0", () => {
    // The downgrade attack: install a version that asks for a lot, get consent, then reinstall the
    // older one and inherit the broader grant. The composite key makes it a miss.
    store.insertPluginGrant({ ...GRANT, version: "1.1.0", grant_hash: "hash-wide" });
    expect(store.findPluginGrant("acme.hello", "1.0.0", "hash-wide")).toBeNull();
  });

  test("re-approving the same key is idempotent rather than a second grant", () => {
    store.insertPluginGrant(GRANT);
    store.insertPluginGrant({ ...GRANT, granted_at: NOW + 1000 });
    expect(store.listPluginGrants("acme.hello")).toHaveLength(1);
    // The original approval time stands: the second call approved nothing new.
    expect(store.listPluginGrants("acme.hello")[0]?.granted_at).toBe(NOW);
  });

  test("revocation is enforced in SQL, not by the caller", () => {
    store.insertPluginGrant(GRANT);
    expect(store.revokePluginGrants("acme.hello", NOW + 10)).toBe(1);

    // The lookup that every call path uses now misses, so code that forgot to check `revoked_at`
    // cannot honour a revoked grant.
    expect(store.findPluginGrant("acme.hello", "1.0.0", "hash-narrow")).toBeNull();
    // The row survives, because "it had this access between these two times" is the question
    // somebody asks after something goes wrong.
    expect(store.listPluginGrants("acme.hello")).toHaveLength(1);
    expect(store.listPluginGrants("acme.hello")[0]?.revoked_at).toBe(NOW + 10);
  });

  test("uninstalling takes the grants with it", () => {
    store.insertPluginGrant(GRANT);
    store.deletePlugin("acme.hello");
    expect(store.listPluginGrants("acme.hello")).toHaveLength(0);
  });
});

describe("dry run", () => {
  test("a scope is shadowed until it is explicitly lifted", () => {
    // Absence is the safe state, which is why this is an allowlist and not a `dry_run` flag: a bug
    // that fails to write a row under-permits rather than over-permits.
    expect(store.listPluginDryRunLifted("acme.hello")).toEqual([]);

    store.liftPluginDryRun("acme.hello", "invite:send", NOW);
    expect(store.listPluginDryRunLifted("acme.hello")).toEqual(["invite:send"]);

    // Per scope, not per plugin: lifting invites says nothing about moderation.
    expect(store.listPluginDryRunLifted("acme.hello")).not.toContain("moderation:write");

    store.restorePluginDryRun("acme.hello", "invite:send");
    expect(store.listPluginDryRunLifted("acme.hello")).toEqual([]);
  });

  test("lifting twice is idempotent", () => {
    store.liftPluginDryRun("acme.hello", "invite:send", NOW);
    store.liftPluginDryRun("acme.hello", "invite:send", NOW + 1);
    expect(store.listPluginDryRunLifted("acme.hello")).toHaveLength(1);
  });
});

describe("crashes", () => {
  const crash = (ts: number, reason = "crashed") => ({
    plugin_id: "acme.hello",
    ts,
    reason,
    detail: "exited with code 1",
    code: 1,
    signal: null,
  });

  test("the breaker's window counts recent crashes and ignores old ones", () => {
    store.insertPluginCrash(crash(NOW - 600_000));
    store.insertPluginCrash(crash(NOW - 30_000));
    store.insertPluginCrash(crash(NOW - 10_000));

    // Five crashes in two minutes and five crashes since March are different situations, and a
    // counter could not tell them apart. This is why the rows exist.
    expect(store.countPluginCrashesSince("acme.hello", NOW - 120_000)).toBe(2);
    expect(store.countPluginCrashesSince("acme.hello", NOW - 3_600_000)).toBe(3);
  });

  test("one plugin's crashes never count toward another's", () => {
    store.insertPluginCrash(crash(NOW));
    expect(store.countPluginCrashesSince("acme.other", NOW - 120_000)).toBe(0);
  });

  test("the record outlives the install", () => {
    // Deliberately not a foreign key: uninstalling should not erase why it kept falling over,
    // which is exactly what someone wants to read before deciding to reinstall it.
    store.insertPluginCrash(crash(NOW));
    store.deletePlugin("acme.hello");
    expect(store.listPluginCrashes("acme.hello")).toHaveLength(1);
  });
});
