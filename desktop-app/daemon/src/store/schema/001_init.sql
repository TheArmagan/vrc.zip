-- 001_init — the whole Phase 1.6 schema.
--
-- Conventions:
--   * every timestamp is INTEGER unix milliseconds, never ISO TEXT (range queries stay numeric).
--   * one schema for every account; `account_id` is a column, not a table-name prefix.
--   * JSON blobs live in TEXT columns and are read with SQLite's json1 functions.
--
-- Connection pragmas (journal_mode = WAL, auto_vacuum = INCREMENTAL, foreign_keys = ON) are NOT
-- set here: `journal_mode` and `auto_vacuum` cannot be changed inside a transaction and migrations
-- run inside one, and `foreign_keys` is per-connection anyway. See `applyPragmas()` in store.ts.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,
  display_name TEXT    NOT NULL,
  added_at     INTEGER NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER
) STRICT;

-- ---------------------------------------------------------------------------
-- sessions — one row per running (or historical) VRChat game client
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id       TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  display_name     TEXT,
  log_path         TEXT    NOT NULL,
  log_inode        INTEGER,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  exit_kind        TEXT,
  vr_mode          TEXT,
  current_location TEXT,
  current_world_id TEXT
) STRICT;

CREATE INDEX ix_sessions_acct_started ON sessions (account_id, started_at DESC);
CREATE UNIQUE INDEX ux_sessions_log ON sessions (log_path, started_at);

-- ---------------------------------------------------------------------------
-- events — append-only log; the feed is a view over this
-- ---------------------------------------------------------------------------

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Nullable on purpose. A VRChat client signed into an account vrc.zip does not manage is a
  -- normal state, not an error: its session stays unlinked and so do its gamelog events. NOT NULL
  -- here would force us to either drop those events or invent an account for them, and both are
  -- worse than a null. A NULL foreign key is permitted and skips the reference check.
  account_id TEXT    REFERENCES accounts (id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  session_id INTEGER REFERENCES sessions (id) ON DELETE SET NULL,
  kind       TEXT    NOT NULL,
  subject_id TEXT,
  location   TEXT,
  payload    TEXT
) STRICT;

CREATE INDEX ix_events_acct_ts ON events (account_id, ts DESC);
CREATE INDEX ix_events_subject ON events (subject_id, ts DESC);
CREATE INDEX ix_events_kind_ts ON events (kind, ts DESC);

-- ---------------------------------------------------------------------------
-- friend log (never auto-deleted)
-- ---------------------------------------------------------------------------

CREATE TABLE friend_log (
  account_id    TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id       TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  trust_level   TEXT,
  friended_at   INTEGER NOT NULL,
  unfriended_at INTEGER,
  PRIMARY KEY (account_id, user_id)
) STRICT;

CREATE INDEX ix_friend_log_user ON friend_log (user_id);

CREATE TABLE friend_log_history (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  ts                    INTEGER NOT NULL,
  type                  TEXT    NOT NULL,
  user_id               TEXT    NOT NULL,
  display_name          TEXT,
  previous_display_name TEXT,
  trust_level           TEXT,
  previous_trust_level  TEXT
) STRICT;

CREATE INDEX ix_friend_log_history_acct_ts ON friend_log_history (account_id, ts DESC);
CREATE INDEX ix_friend_log_history_user_ts ON friend_log_history (user_id, ts DESC);

-- ---------------------------------------------------------------------------
-- API caches
-- ---------------------------------------------------------------------------

CREATE TABLE user_cache (
  user_id    TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  data       TEXT    NOT NULL
) STRICT;

CREATE TABLE world_cache (
  world_id   TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  data       TEXT    NOT NULL
) STRICT;

CREATE TABLE avatar_cache (
  avatar_id  TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  data       TEXT    NOT NULL
) STRICT;

CREATE INDEX ix_world_cache_fetched ON world_cache (fetched_at);
CREATE INDEX ix_avatar_cache_fetched ON avatar_cache (fetched_at);

-- ---------------------------------------------------------------------------
-- user-authored data (never auto-deleted)
-- ---------------------------------------------------------------------------

CREATE TABLE notes (
  account_id TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL,
  note       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
) STRICT;

CREATE TABLE notifications (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  ts                  INTEGER NOT NULL,
  type                TEXT    NOT NULL,
  sender_user_id      TEXT,
  sender_display_name TEXT,
  message             TEXT,
  seen                INTEGER NOT NULL DEFAULT 0,
  data                TEXT
) STRICT;

CREATE INDEX ix_notifications_acct_ts ON notifications (account_id, ts DESC);

CREATE TABLE avatar_history (
  account_id TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  avatar_id  TEXT    NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, avatar_id)
) STRICT;

CREATE INDEX ix_avatar_history_acct_last ON avatar_history (account_id, last_seen DESC);

-- ---------------------------------------------------------------------------
-- rollup target for expired events
-- ---------------------------------------------------------------------------

-- `day` is the unix-ms timestamp of the UTC midnight opening the day, so it sorts and ranges
-- with the same arithmetic as every other timestamp. `subject_id` is '' rather than NULL so the
-- primary key stays usable (SQLite treats NULLs in a PK as distinct).
CREATE TABLE events_daily (
  -- '' stands in for "no account" here, matching subject_id below: SQLite treats NULLs in a
  -- primary key as distinct, so a nullable column would let duplicate rollup rows accumulate.
  account_id TEXT    NOT NULL DEFAULT '',
  day        INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  subject_id TEXT    NOT NULL DEFAULT '',
  count      INTEGER NOT NULL DEFAULT 0,
  total_ms   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day, kind, subject_id)
) STRICT;

CREATE INDEX ix_events_daily_acct_day ON events_daily (account_id, day DESC);
CREATE INDEX ix_events_daily_kind_day ON events_daily (kind, day DESC);

-- ---------------------------------------------------------------------------
-- retention
-- ---------------------------------------------------------------------------

-- One row per event kind. The reserved kind '*' holds the global default that every unconfigured
-- kind inherits, so a new event type added later cannot grow unbounded by omission.
CREATE TABLE retention_config (
  kind        TEXT PRIMARY KEY,
  retain_days INTEGER NOT NULL CHECK (retain_days > 0),
  updated_at  INTEGER NOT NULL
) STRICT;

-- Seeded defaults (see PLAN.md §1.6). `updated_at = 0` marks "never edited by the user".
-- A kind ending in `.*` is a prefix pattern; resolution is exact match, then longest matching
-- prefix pattern, then the global '*'.
INSERT INTO retention_config (kind, retain_days, updated_at) VALUES
  ('*',                     90,  0),
  ('gamelog.*',             90,  0),
  ('gamelog.player_join',   30,  0),
  ('gamelog.player_leave',  30,  0),
  ('friend.*',              90,  0),
  ('friend.location',       30,  0),
  ('friend.status',         180, 0),
  ('friend.bio',            180, 0),
  ('friend.avatar',         180, 0),
  ('notification.*',        365, 0);
