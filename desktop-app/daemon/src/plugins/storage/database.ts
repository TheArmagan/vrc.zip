/**
 * One plugin's private SQLite database, and the quota over it.
 *
 * ## Why this is not `Store`
 *
 * The daemon's `Store` carries ten migrations, a prepared-statement cache built for its own schema,
 * and a retention engine that knows about `events` and `sessions`. A plugin file has two tables and
 * no history worth migrating. Reusing `Store` would mean a daemon migration having to reason about
 * files the daemon does not own, and a plugin's schema versioning riding on the daemon's — two
 * things that must be free to move separately. So this is a small opener with its own
 * `user_version`, and the only thing it borrows is the pragma reasoning.
 *
 * ## `auto_vacuum = FULL`, and why it is not the daemon's `INCREMENTAL`
 *
 * The quota is a `stat` on the directory, and `E_QUOTA` tells a plugin that **deleting records is
 * the fix**. That sentence is only true if a delete actually shrinks the file. Under the daemon's
 * `INCREMENTAL` it does not — the pages go on a freelist and the file stays the size it reached
 * until something runs `incremental_vacuum`. A plugin that deleted half its rows and stayed at
 * quota would be looking at an error message that lies. `FULL` costs a little on every commit and
 * makes the promise true, which is the right trade for a database whose whole point is that its
 * owner can free space in it.
 *
 * It must be set **before the first table exists**; changing it afterwards requires a `VACUUM`.
 *
 * ## No WAL, deliberately
 *
 * There is exactly one connection to this file: the daemon holds it, and the plugin reaches it only
 * by RPC. WAL buys concurrency there is no second writer to need, and it leaves `-wal` and `-shm`
 * files that the quota `stat` then has to explain. The rollback journal is transient and the
 * arithmetic stays legible.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PLUGIN_QUOTA_BYTES,
  MAX_KV_KEYS_PAGE,
  type StorageRecord,
  type StorageUsage,
} from "@vrcz/plugin-api";
import { pluginDatabasePath, pluginDataDir } from "../../paths.ts";

/** Bumped when the plugin-side schema changes. Independent of the daemon's `schema_version`. */
const PLUGIN_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS records (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  key   TEXT    NOT NULL,
  ts    INTEGER NOT NULL,
  value TEXT    NOT NULL
) STRICT;

-- Every legal query is (key prefix, time window, limit), so one index over (key, ts) covers all of
-- them. There is deliberately no second index: a query shape that would need one does not exist.
CREATE INDEX IF NOT EXISTS ix_records_key_ts ON records (key, ts DESC);
`;

export interface PluginStorageOptions {
  /** Overridden in tests and by a future per-plugin setting. Bytes, over the whole data directory. */
  readonly quotaBytes?: number;
  /** Environment carrying `VRCZIP_STATE_DIR`, so a test never touches the real state tree. */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * A plugin's database, opened lazily on first use.
 *
 * Lazily because most plugins never store anything, and a file created at install for every plugin
 * is a directory of empty databases and a quota that reads as "in use" when nothing is.
 */
export class PluginStorage {
  readonly pluginId: string;
  readonly quotaBytes: number;
  readonly #dataDir: string;
  readonly #path: string;
  #db: Database | null = null;

  constructor(pluginId: string, options: PluginStorageOptions = {}) {
    this.pluginId = pluginId;
    this.quotaBytes = options.quotaBytes ?? DEFAULT_PLUGIN_QUOTA_BYTES;
    this.#dataDir = pluginDataDir(pluginId, options.env);
    this.#path = pluginDatabasePath(pluginId, options.env);
  }

  #open(): Database {
    if (this.#db !== null) return this.#db;
    mkdirSync(this.#dataDir, { recursive: true });
    const db = new Database(this.#path, { create: true });
    // Order matters: `auto_vacuum` is a no-op once a table exists in the file.
    db.exec("PRAGMA auto_vacuum = FULL");
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${PLUGIN_SCHEMA_VERSION}`);
    this.#db = db;
    return db;
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  /**
   * Bytes on disk, summed over the directory rather than read off the database.
   *
   * A `stat` sees the journal, and it sees anything else that ends up in there — which is the
   * number that actually fills the user's disk. `page_count × page_size` would be exact about the
   * database and blind to everything beside it.
   *
   * A missing directory is zero rather than an error: a plugin that has never written anything has
   * used nothing, and that is a normal state rather than a failure.
   */
  usageBytes(): number {
    let total = 0;
    let entries: string[];
    try {
      entries = readdirSync(this.#dataDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      try {
        const stat = statSync(join(this.#dataDir, entry));
        if (stat.isFile()) total += stat.size;
      } catch {
        // Raced with our own delete, or unreadable. Not counting it is the safe direction: it
        // cannot invent quota pressure that is not there.
      }
    }
    return total;
  }

  usage(): StorageUsage {
    return { bytes: this.usageBytes(), quotaBytes: this.quotaBytes };
  }

  /**
   * Whether a write of roughly `incomingBytes` is allowed.
   *
   * Checked **before** the write, so the quota is never exceeded rather than exceeded-then-noticed.
   * The cost of that ordering is that the figure lags: a delete frees space at the next commit, and
   * a check immediately after one can still see the old size. `auto_vacuum = FULL` is what keeps
   * that window short enough not to matter.
   */
  wouldExceedQuota(incomingBytes: number): boolean {
    return this.usageBytes() + incomingBytes > this.quotaBytes;
  }

  // -- kv ---------------------------------------------------------------------------------------

  kvGet(key: string): string | null {
    const row = this.#open()
      .query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?")
      .get(key);
    return row?.value ?? null;
  }

  kvSet(key: string, value: string, now: number): void {
    this.#open()
      .query<void, [string, string, number]>(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  kvDelete(key: string): boolean {
    const db = this.#open();
    db.query<void, [string]>("DELETE FROM kv WHERE key = ?").run(key);
    // `changes` on the connection rather than a SELECT first: one statement, one answer, and no
    // window between the two in which the row could go away.
    return this.#changes(db) > 0;
  }

  kvKeys(prefix: string, limit: number): string[] {
    const capped = Math.min(Math.max(limit, 1), MAX_KV_KEYS_PAGE);
    return this.#open()
      .query<{ key: string }, [string, number]>(
        "SELECT key FROM kv WHERE key GLOB ? ORDER BY key LIMIT ?",
      )
      .all(`${globEscape(prefix)}*`, capped)
      .map((row) => row.key);
  }

  // -- records ----------------------------------------------------------------------------------

  recordsAppend(key: string, value: string, ts: number): number {
    const db = this.#open();
    db.query<void, [string, number, string]>(
      "INSERT INTO records (key, ts, value) VALUES (?, ?, ?)",
    ).run(key, ts, value);
    return Number(db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()?.id ?? 0);
  }

  recordsQuery(options: {
    prefix: string;
    since: number;
    until: number;
    limit: number;
  }): StorageRecord[] {
    return this.#open()
      .query<
        { id: number; key: string; ts: number; value: string },
        [string, number, number, number]
      >(
        `SELECT id, key, ts, value FROM records
         WHERE key GLOB ? AND ts >= ? AND ts <= ?
         ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(`${globEscape(options.prefix)}*`, options.since, options.until, options.limit)
      .map((row) => ({ id: row.id, key: row.key, ts: row.ts, value: JSON.parse(row.value) }));
  }

  recordsDelete(options: { prefix: string; before: number }): number {
    const db = this.#open();
    db.query<void, [string, number]>("DELETE FROM records WHERE key GLOB ? AND ts <= ?").run(
      `${globEscape(options.prefix)}*`,
      options.before,
    );
    return this.#changes(db);
  }

  #changes(db: Database): number {
    return Number(db.query<{ n: number }, []>("SELECT changes() AS n").get()?.n ?? 0);
  }
}

/**
 * Escapes a prefix for `GLOB`.
 *
 * `GLOB` rather than `LIKE` because it is case-sensitive and uses the index, but its wildcards are
 * `*`, `?` and `[…]`, and a plugin's key is arbitrary text. An unescaped `[` in a key would turn a
 * prefix query into a character class and quietly return the wrong rows — the kind of bug that
 * looks like data loss to whoever hits it.
 *
 * Each wildcard is wrapped in a single-character class, which is the only escape GLOB has. `]` is
 * left alone deliberately: outside a class it is already a literal, and `[]]` would open one.
 */
function globEscape(value: string): string {
  return value.replace(/[[*?]/g, (char) => `[${char}]`);
}
