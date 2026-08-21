import init001 from "./001_init.sql" with { type: "text" };

/** One numbered migration. `version` must be unique, contiguous from 1, and ascending. */
export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

/**
 * Every migration, in application order. Add new ones by dropping a numbered `.sql` file next to
 * this one and appending it here — the runner applies whatever is newer than `meta.schema_version`.
 */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "001_init", sql: init001 }];
