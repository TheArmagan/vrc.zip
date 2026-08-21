import { SQL } from "./queries.ts";
import type { Store } from "./store.ts";
import type { RetentionConfigRow } from "./types.ts";

/**
 * Retention.
 *
 * Only `events` is ever pruned, and only after the expiring rows have been folded into
 * `events_daily`, so the long-run shape of someone's history survives even when the individual
 * rows do not. Everything a user typed, everything that is a record rather than a stream, and the
 * user cache that keeps names resolvable are listed in {@link NEVER_DELETED_TABLES} and are not
 * touched by any code path here regardless of configuration.
 */
export const NEVER_DELETED_TABLES = [
  "friend_log",
  "friend_log_history",
  "notes",
  "avatar_history",
  "user_cache",
] as const;

/** The reserved `retention_config.kind` holding the window every unconfigured kind inherits. */
export const GLOBAL_DEFAULT_KIND = "*";

/** Used only if the `'*'` row has been deleted, so retention can never become "keep forever". */
export const FALLBACK_RETAIN_DAYS = 90;

const DAY_MS = 86_400_000;

/** kind (or `prefix.*` pattern, or `'*'`) -> retain_days. */
export type RetentionRules = ReadonlyMap<string, number>;

export type RetentionPlanEntry = {
  kind: string;
  retainDays: number;
  /** Rows with `ts < cutoff` expire. */
  cutoff: number;
  /** Rows that would be rolled up and deleted. */
  rows: number;
  /** Rows of this kind that would remain. */
  remaining: number;
};

export type RetentionPlan = {
  now: number;
  entries: RetentionPlanEntry[];
  totalRows: number;
};

export type RetentionResult = {
  now: number;
  deletedByKind: Record<string, number>;
  totalDeleted: number;
  durationMs: number;
};

export type RetentionOptions = {
  /** Treat this as "now". Tests pin it; production leaves it alone. */
  readonly now?: number;
  /**
   * Windows to apply *instead of* what is stored, keyed the same way as `retention_config`.
   * This is how Settings previews a change before the user commits to it.
   */
  readonly overrides?: Readonly<Record<string, number>>;
};

/** Builds the lookup table from `retention_config` rows plus any preview overrides. */
export function rulesFrom(
  rows: readonly RetentionConfigRow[],
  overrides?: Readonly<Record<string, number>>,
): RetentionRules {
  const rules = new Map<string, number>();
  for (const row of rows) rules.set(row.kind, row.retain_days);
  if (overrides !== undefined) {
    for (const [kind, days] of Object.entries(overrides)) rules.set(kind, days);
  }
  return rules;
}

/**
 * Resolution order: exact kind, then the longest matching `prefix.*` pattern, then the global
 * `'*'`, then {@link FALLBACK_RETAIN_DAYS}. A kind nobody configured therefore still expires —
 * an event type added in a later release cannot grow unbounded by omission.
 */
export function resolveRetainDays(rules: RetentionRules, kind: string): number {
  const exact = rules.get(kind);
  if (exact !== undefined) return exact;

  let best: number | undefined;
  let bestLength = -1;
  for (const [pattern, days] of rules) {
    if (pattern === GLOBAL_DEFAULT_KIND || !pattern.endsWith(".*")) continue;
    const prefix = pattern.slice(0, -1); // keep the dot: "gamelog.*" -> "gamelog."
    if (kind.startsWith(prefix) && prefix.length > bestLength) {
      best = days;
      bestLength = prefix.length;
    }
  }
  if (best !== undefined) return best;

  return rules.get(GLOBAL_DEFAULT_KIND) ?? FALLBACK_RETAIN_DAYS;
}

/**
 * Dry run: what a retention pass would delete right now, or what it *would* delete under a
 * proposed config. Reads only — Settings calls this to show the damage before applying it.
 */
export function planRetention(store: Store, options: RetentionOptions = {}): RetentionPlan {
  const now = options.now ?? Date.now();
  const rules = rulesFrom(store.listRetentionConfig(), options.overrides);
  const counts = new Map(store.countEventsByKind().map((row) => [row.kind, row.count]));

  const countExpiring = store.db.query<{ count: number }, [string, number]>(SQL.countExpiring);
  const entries: RetentionPlanEntry[] = [];
  let totalRows = 0;

  for (const kind of [...counts.keys()].sort()) {
    const retainDays = resolveRetainDays(rules, kind);
    const cutoff = now - retainDays * DAY_MS;
    const rows = countExpiring.get(kind, cutoff)?.count ?? 0;
    const total = counts.get(kind) ?? 0;
    entries.push({ kind, retainDays, cutoff, rows, remaining: total - rows });
    totalRows += rows;
  }

  return { now, entries, totalRows };
}

/**
 * Applies retention: for every kind, roll the expiring rows into `events_daily` **first**, then
 * delete them, then reclaim the freed pages.
 *
 * Rollup and delete for a kind share one transaction, so a crash can never delete rows whose
 * counts were not recorded. `incremental_vacuum` runs afterwards, outside any transaction.
 */
export function runRetention(store: Store, options: RetentionOptions = {}): RetentionResult {
  const startedAt = Date.now();
  const plan = planRetention(store, options);

  const rollup = store.db.query<void, [string, number]>(SQL.rollupExpiring);
  const remove = store.db.query<void, [string, number]>(SQL.deleteExpiring);

  const deletedByKind: Record<string, number> = {};
  let totalDeleted = 0;

  for (const entry of plan.entries) {
    if (entry.rows === 0) continue;
    const deleted = store.transaction(() => {
      rollup.run(entry.kind, entry.cutoff);
      return remove.run(entry.kind, entry.cutoff).changes;
    });
    deletedByKind[entry.kind] = deleted;
    totalDeleted += deleted;
  }

  if (totalDeleted > 0) store.incrementalVacuum();
  store.setMeta(LAST_RUN_META_KEY, String(plan.now));

  return {
    now: plan.now,
    deletedByKind,
    totalDeleted,
    durationMs: Date.now() - startedAt,
  };
}

/** `meta` key holding the timestamp of the last completed retention pass. */
export const LAST_RUN_META_KEY = "retention_last_run_at";

export type SchedulerOptions = {
  /** Local hour the pass aims for. Default 04:00. */
  readonly hour?: number;
  /** Maximum random delay added to the target time. Default 60 minutes. */
  readonly jitterMs?: number;
  /** Injectable for tests. */
  readonly random?: () => number;
  /** Injectable for tests. */
  readonly now?: () => number;
  /** Called with each pass's result, and with any error the pass throws. */
  readonly onResult?: (result: RetentionResult) => void;
  readonly onError?: (error: unknown) => void;
};

export type RetentionScheduler = {
  /** When the next pass is scheduled for, as unix ms. */
  readonly nextRunAt: number;
  stop(): void;
};

/**
 * Milliseconds from `now` until the next `hour`:00 local, plus up to `jitterMs`.
 *
 * The jitter matters: without it every install on the planet wakes up and hammers its disk at
 * exactly 04:00, and on a laptop that is one visible stutter at a predictable time.
 */
export function nextRunDelay(now: number, hour: number, jitterMs: number, random: number): number {
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  let delay = target.getTime() - now;
  if (delay <= 0) delay += DAY_MS;
  return delay + Math.floor(random * jitterMs);
}

/**
 * Starts the nightly pass. Each run schedules the next one, re-rolling the jitter, so the
 * schedule drifts rather than locking to a fixed offset.
 */
export function startRetentionScheduler(
  store: Store,
  options: SchedulerOptions = {},
): RetentionScheduler {
  const hour = options.hour ?? 4;
  const jitterMs = options.jitterMs ?? 60 * 60 * 1000;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextRunAt = 0;

  const schedule = (): void => {
    const delay = nextRunDelay(now(), hour, jitterMs, random());
    nextRunAt = now() + delay;
    timer = setTimeout(() => {
      try {
        const result = runRetention(store);
        options.onResult?.(result);
      } catch (error) {
        options.onError?.(error);
      }
      schedule();
    }, delay);
    timer.unref?.();
  };

  schedule();

  return {
    get nextRunAt() {
      return nextRunAt;
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
