import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentVersion, latestVersion, migrate, SCHEMA_VERSION_KEY } from "./migrate.ts";
import { MIGRATIONS } from "./schema/index.ts";
import { MEMORY, Store } from "./store.ts";

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

function indexNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

describe("migrate", () => {
  test("creates every table the plan calls for", () => {
    const db = new Database(MEMORY);
    migrate(db);

    expect(tableNames(db)).toEqual([
      "accounts",
      "audit_log",
      "avatar_cache",
      "avatar_history",
      "events",
      "events_daily",
      "friend_log",
      "friend_log_history",
      "grant_budgets",
      "grants",
      "meta",
      "notes",
      "notifications",
      "pairing_requests",
      "plugin_crashes",
      "plugin_dry_run_lifted",
      "plugin_grants",
      "plugins",
      "retention_config",
      "sessions",
      "user_cache",
      "webhook_deliveries",
      "webhooks",
      "world_cache",
    ]);
    db.close();
  });

  test("creates the events indexes the plan sketches", () => {
    const db = new Database(MEMORY);
    migrate(db);

    expect(indexNames(db)).toContain("ix_events_acct_ts");
    expect(indexNames(db)).toContain("ix_events_subject");
    expect(indexNames(db)).toContain("ix_events_kind_ts");
    db.close();
  });

  test("is idempotent — a second run applies nothing", () => {
    const db = new Database(MEMORY);
    const first = migrate(db);
    const tables = tableNames(db);

    const second = migrate(db);

    expect(second).toBe(first);
    expect(second).toBe(latestVersion());
    expect(tableNames(db)).toEqual(tables);
    db.close();
  });

  test("records the applied version in meta", () => {
    const db = new Database(MEMORY);
    migrate(db);

    expect(currentVersion(db)).toBe(latestVersion(MIGRATIONS));
    expect(
      db
        .query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`)
        .get(SCHEMA_VERSION_KEY)?.value,
    ).toBe(String(latestVersion(MIGRATIONS)));
    db.close();
  });

  test("reports version 0 for a never-migrated database", () => {
    const db = new Database(MEMORY);
    expect(currentVersion(db)).toBe(0);
    db.close();
  });

  test("applies only migrations newer than the recorded version", () => {
    const db = new Database(MEMORY);
    migrate(db);

    const extra = [
      ...MIGRATIONS,
      { version: 999, name: "999_test", sql: `CREATE TABLE probe (x INTEGER) STRICT;` },
    ];
    expect(migrate(db, extra)).toBe(999);
    expect(tableNames(db)).toContain("probe");

    // Re-running with the same list must not re-execute 999 (it would throw on CREATE TABLE).
    expect(migrate(db, extra)).toBe(999);
    db.close();
  });

  test("rejects an out-of-order migration list", () => {
    const db = new Database(MEMORY);
    expect(() =>
      migrate(db, [
        { version: 2, name: "b", sql: `SELECT 1;` },
        { version: 1, name: "a", sql: `SELECT 1;` },
      ]),
    ).toThrow(/out of order/);
    db.close();
  });

  test("a failing migration rolls back whole", () => {
    const db = new Database(MEMORY);
    expect(() =>
      migrate(db, [
        {
          version: 1,
          name: "bad",
          sql: `CREATE TABLE ok_table (x INTEGER) STRICT; CREATE TABLE bad_table (;`,
        },
      ]),
    ).toThrow();
    expect(tableNames(db)).not.toContain("ok_table");
    expect(currentVersion(db)).toBe(0);
    db.close();
  });

  test("Store.open migrates and applies the pragmas", () => {
    const store = Store.open(MEMORY);

    expect(store.schemaVersion).toBe(latestVersion());
    expect(store.db.query<{ foreign_keys: number }, []>(`PRAGMA foreign_keys`).get()).toEqual({
      foreign_keys: 1,
    });
    store.close();
  });

  test("a file-backed store keeps its schema across reopens", () => {
    const path = join(tmpdir(), `vrcz-store-${Bun.randomUUIDv7()}.sqlite`);
    const first = Store.open(path);
    first.upsertAccount({
      id: "usr_a",
      display_name: "A",
      added_at: 1,
      enabled: 1,
      last_seen_at: null,
    });
    first.close();

    const second = Store.open(path);
    expect(second.schemaVersion).toBe(latestVersion());
    expect(second.getAccount("usr_a")?.display_name).toBe("A");
    expect(
      second.db.query<{ journal_mode: string }, []>(`PRAGMA journal_mode`).get()?.journal_mode,
    ).toBe("wal");
    expect(second.db.query<{ auto_vacuum: number }, []>(`PRAGMA auto_vacuum`).get()).toEqual({
      auto_vacuum: 2,
    });
    second.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      Bun.file(`${path}${suffix}`)
        .delete()
        .catch(() => {});
    }
  });
});
