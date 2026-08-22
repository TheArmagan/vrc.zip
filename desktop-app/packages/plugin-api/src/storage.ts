/**
 * Plugin storage: the shapes and the limits, published so an author can read them before hitting
 * one.
 *
 * A plugin gets **its own SQLite file** in its own data directory — not a table in vrc.zip's
 * database, not a namespace inside it. That is a durability decision as much as a safety one: a
 * plugin cannot lock or corrupt the daemon's WAL, uninstall is `rm -rf` on one directory, and the
 * quota is a `stat` rather than a query. PLAN.md §"Manifest, lifecycle, storage".
 *
 * Two halves, deliberately not one:
 *
 * - **KV** — a key, a JSON value, last-write-wins. Settings, cursors, "what did I last see".
 * - **`records`** — an append-only log of `(key, ts, value)`, queried by key prefix and time window.
 *   Observations, history, anything where the second write does not replace the first.
 *
 * Both live behind the `storage` capability, which means both appear on the consent screen as one
 * plain sentence about keeping data on this computer.
 *
 * ## What the query deliberately cannot do
 *
 * `records` is queried by **key prefix, time window and limit, and nothing else**. No tag index, no
 * filtering on fields inside the stored JSON. One index covers every legal query, so there is no
 * shape of call that degrades into a table scan — and a slow plugin query is a thing the *user*
 * experiences and blames vrc.zip for. Structure your keys the way you would structure a path
 * (`seen/usr_abc`, `session/2026-08-23`) and the prefix is the index.
 *
 * ## Who deletes
 *
 * You do. The host never prunes a plugin's records on its behalf: it cannot know which of them
 * mattered. A full quota is answered by `storage.records.delete`, which is why {@link
 * PROTOCOL_ERRORS.E_QUOTA} is marked non-retryable — waiting does not help, deleting does.
 */

/** The default per-plugin quota. Measured over the plugin's whole data directory, not one file. */
export const DEFAULT_PLUGIN_QUOTA_BYTES = 50 * 1024 * 1024;

/**
 * The largest single stored value, as UTF-8 JSON.
 *
 * 256KB sits comfortably inside the 1MiB frame cap with room for the envelope around it, which
 * matters because a value has to survive the round trip in one frame in each direction. A plugin
 * with something genuinely bigger is holding a blob, and a blob belongs in chunks with keys.
 */
export const MAX_STORAGE_VALUE_BYTES = 256 * 1024;

/** Keys are identifiers, not documents. Long enough for a path-like key, short enough to index. */
export const MAX_STORAGE_KEY_LENGTH = 512;

/** Rows returned by one `storage.records.query`, when the caller names no limit and at most. */
export const DEFAULT_RECORDS_PAGE = 100;
export const MAX_RECORDS_PAGE = 1000;

/** Keys returned by one `storage.kv.keys`, same reasoning. */
export const MAX_KV_KEYS_PAGE = 1000;

/** One row of the append-only log, as it comes back from a query. */
export interface StorageRecord {
  /** Monotonic per plugin, assigned by the host. Ordering within the same millisecond. */
  readonly id: number;
  readonly key: string;
  /** Unix milliseconds, integer — assigned by the host, never by the plugin. */
  readonly ts: number;
  readonly value: unknown;
}

/** What `storage.usage` answers. Both figures are bytes on disk, not row counts. */
export interface StorageUsage {
  /** Everything in the plugin's data directory: the database and any journal beside it. */
  readonly bytes: number;
  readonly quotaBytes: number;
}
