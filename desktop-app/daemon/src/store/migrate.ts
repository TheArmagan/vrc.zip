import type { Database } from "bun:sqlite";
import { MIGRATIONS, type Migration } from "./schema/index.ts";

/** `meta` key holding the highest applied migration version, as a decimal string. */
export const SCHEMA_VERSION_KEY = "schema_version";

/**
 * The runner needs somewhere to record its own progress before the first migration has run, so
 * `meta` is created idempotently here as well as in 001.
 */
const META_DDL = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`;

/** Highest applied migration version, or 0 on a database that has never been migrated. */
export function currentVersion(db: Database): number {
  db.run(META_DDL);
  const row = db
    .query<{ value: string }, []>(`SELECT value FROM meta WHERE key = '${SCHEMA_VERSION_KEY}'`)
    .get();
  if (row === null) return 0;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Highest version present in a migration list. */
export function latestVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => (m.version > max ? m.version : max), 0);
}

/**
 * Applies every migration newer than the recorded version, in order, each inside its own
 * transaction together with the version bump — so a crash mid-migration leaves the database at
 * the last fully applied version rather than half-way through one.
 *
 * Idempotent: running it twice applies nothing the second time.
 *
 * @returns the version the database is at afterwards.
 */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): number {
  assertOrdered(migrations);
  let version = currentVersion(db);

  for (const migration of migrations) {
    if (migration.version <= version) continue;
    const apply = db.transaction(() => {
      db.run(migration.sql);
      db.run(
        `INSERT INTO meta (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [SCHEMA_VERSION_KEY, String(migration.version)],
      );
    });
    apply();
    version = migration.version;
  }

  return version;
}

function assertOrdered(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (migration.version <= previous) {
      throw new Error(
        `migrations are out of order: ${migration.name} (v${migration.version}) follows v${previous}`,
      );
    }
    previous = migration.version;
  }
}
