/**
 * Phase 1.6 storage: one SQLite database, `account_id` as a column, numbered migrations embedded
 * in the bundle, and a nightly retention pass that rolls expiring events up before deleting them.
 */

export { currentVersion, latestVersion, migrate, SCHEMA_VERSION_KEY } from "./migrate.ts";
export { SQL } from "./queries.ts";
export type {
  RetentionOptions,
  RetentionPlan,
  RetentionPlanEntry,
  RetentionResult,
  RetentionRules,
  RetentionScheduler,
  SchedulerOptions,
} from "./retention.ts";
export {
  FALLBACK_RETAIN_DAYS,
  GLOBAL_DEFAULT_KIND,
  LAST_RUN_META_KEY,
  NEVER_DELETED_TABLES,
  nextRunDelay,
  planRetention,
  resolveRetainDays,
  rulesFrom,
  runRetention,
  startRetentionScheduler,
} from "./retention.ts";
export type { Migration } from "./schema/index.ts";
export { MIGRATIONS } from "./schema/index.ts";
export type { StoreOptions } from "./store.ts";
export { MEMORY, Store } from "./store.ts";
export type * from "./types.ts";
