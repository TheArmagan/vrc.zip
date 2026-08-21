-- 002_user_cache_per_account — key `user_cache` by (viewer, subject), and index the two event
-- lookups the user modal and the game log need.
--
-- Why the cache had to change: `GET /users/{id}` returns *different fields depending on who is
-- asking* — a friend sees `location`, `last_login`, `bio` where a stranger sees blanks (PLAN.md
-- §1.3, and the same note in PROGRESS.md §Gotchas). Keyed on `user_id` alone, one account's view
-- overwrites another's and the modal shows account B a location that only account A can see, or
-- (worse, because it looks like a VRChat bug) blanks out fields for the account that *is* friends.
-- The viewer is therefore part of the key, not part of the value.
--
-- Existing rows are dropped rather than migrated: nothing recorded which account fetched them, and
-- attributing them to an arbitrary account would fabricate exactly the fact this migration exists
-- to stop being wrong about. A cache re-fills itself on the next open of a profile.

CREATE TABLE user_cache_v2 (
  account_id TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL,
  data       TEXT    NOT NULL,
  PRIMARY KEY (account_id, user_id)
) STRICT;

DROP TABLE user_cache;
ALTER TABLE user_cache_v2 RENAME TO user_cache;

-- ---------------------------------------------------------------------------
-- event lookups
-- ---------------------------------------------------------------------------

-- `session_id` had a foreign key but no index, so "every event from this game client" was a full
-- table scan over the highest-volume table in the database. It is a first-class filter now.
CREATE INDEX ix_events_session_ts ON events (session_id, ts DESC);

-- The all-accounts feed orders by `ts` with no account in the predicate, which none of the
-- existing composite indexes can serve — and it must stay cheap, because it is the default view
-- *and* the only one that can see rows with `account_id IS NULL` (an unmanaged game client).
CREATE INDEX ix_events_ts ON events (ts DESC);
