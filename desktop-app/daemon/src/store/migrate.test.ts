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
      "log_offsets",
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

/*
 * Migration 007's two jobs, asserted on rows rather than on DDL.
 *
 * The dedupe index is the one piece of schema here that can be *subtly* wrong: an over-broad key
 * silently deletes real events, and an over-narrow one lets the replay through. Both failures look
 * like a working index from the outside, so the test drives the actual insert path.
 */
describe("007_log_offsets", () => {
  function seeded(): Database {
    const db = new Database(MEMORY);
    migrate(db);
    return db;
  }

  const INSERT = `INSERT OR IGNORE INTO events
    (account_id, ts, session_id, kind, subject_id, location, payload)
    VALUES (NULL, ?, ?, ?, ?, NULL, ?)`;

  test("a replayed gamelog line is dropped even though its payload differs", () => {
    const db = seeded();
    // The watcher stamps its own per-run session UUID into the payload, so two reads of ONE line
    // never produce identical payload text. Comparing payloads whole would miss this entirely.
    db.run(INSERT, [1000, 1, "gamelog.app_quit", null, '{"kind":"app-quit","sessionId":"run-a"}']);
    db.run(INSERT, [1000, 1, "gamelog.app_quit", null, '{"kind":"app-quit","sessionId":"run-b"}']);

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(1);
    db.close();
  });

  test("two people joining in the same second are two rows", () => {
    const db = seeded();
    db.run(INSERT, [1000, 1, "gamelog.player_join", null, '{"displayName":"Ada"}']);
    db.run(INSERT, [1000, 1, "gamelog.player_join", null, '{"displayName":"Grace"}']);

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(2);
    db.close();
  });

  test("identical pipeline events are left alone — two messages are two facts", () => {
    const db = seeded();
    db.run(INSERT, [1000, null, "friend.online", "usr_1", '{"displayName":"Ada"}']);
    db.run(INSERT, [1000, null, "friend.online", "usr_1", '{"displayName":"Ada"}']);

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(2);
    db.close();
  });

  test("log_offsets never rewinds on conflict", () => {
    const db = seeded();
    const put = `INSERT INTO log_offsets (log_key, log_path, byte_offset, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(log_key) DO UPDATE SET
        log_path = excluded.log_path,
        byte_offset = MAX(log_offsets.byte_offset, excluded.byte_offset),
        updated_at = excluded.updated_at`;
    db.run(put, ["dev:1", "/logs/a.txt", 900, 1]);
    db.run(put, ["dev:1", "/logs/a.txt", 100, 2]);

    expect(
      db.query<{ byte_offset: number }, []>("SELECT byte_offset FROM log_offsets").get()
        ?.byte_offset,
    ).toBe(900);
    db.close();
  });
});
