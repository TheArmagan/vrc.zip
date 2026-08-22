-- 007_log_offsets — stop the game log duplicating itself, and clean up what already did.
--
-- ## The bug this closes
--
-- `LogWatcher` adopted every log file it discovered at byte offset 0 (`backfill: true`) and kept
-- its read position only in memory. So every daemon start re-read every `output_log_*.txt` in the
-- VRChat log directory from the top and re-emitted every line in it as a fresh bus event, which
-- the feed writer duly appended to `events` again. The session row was *stable* across those
-- restarts — `sessions` conflicts on `(log_path, started_at)` — so the duplicates all landed on
-- the same session and were indistinguishable from the real thing.
--
-- Under `bun --watch` that is one full replay of every log per code edit. Six identical
-- "Client quit" rows is six daemon starts, not six quits.
--
-- `log_offsets` is the fix: the watcher resumes each file where it stopped. Keyed on the
-- watcher's `logKey` (`dev:ino`, or `path:birthtime` on Windows, where inodes read as 0) rather
-- than on the path, because a rotated log reuses the path and must NOT inherit the old file's
-- offset — that would skip the head of the new file, including its `User Authenticated:` line.
--
-- ## The index
--
-- The offset table fixes the cause. The unique index is the guard, so a future replay — a restored
-- database, a rotation the key check misses, a bug in the resume path — cannot put the same line
-- in twice: `insertEvent` is `INSERT OR IGNORE`, so a duplicate is dropped rather than raising.
--
-- Its key is (kind, ts, session, subject, the payload's identifying fields). The payload cannot be
-- compared whole: a gamelog payload carries the *watcher's* per-run session UUID, so two replays of
-- one line have different payload text. The `json_extract` multi-path form pulls the fields that
-- actually identify a line — who joined, which world, which file, which reason — as one JSON array,
-- and `json_valid` guards the one case where `json_extract` would raise instead of returning null.
--
-- Restricted to `gamelog.%` on purpose. Those rows are derived from an append-only file and are
-- reproducible by construction, which is exactly what makes them safe to deduplicate. A pipeline
-- event is a message VRChat sent once; two identical ones a millisecond apart are two facts.

CREATE TABLE log_offsets (
  -- The watcher's filesystem identity for the file, not its path. See above.
  log_key     TEXT    PRIMARY KEY,
  log_path    TEXT    NOT NULL,
  byte_offset INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_log_offsets_path ON log_offsets (log_path);

-- Bookkeeping kinds the feed writer refuses to persist today. Older builds wrote them, and every
-- one of those rows is a row nothing renders: a friend-list poll finishing is not something that
-- happened to anybody. Deleting them is not lossy — no screen has ever read them.
DELETE FROM events
WHERE kind IN (
  'friend.list_refreshed',
  'friend.presence',
  'notification.synced',
  'account.state',
  'session.update',
  'pipeline.state',
  'consent.pending',
  'consent.resolved'
);

-- The replays already on disk. Keep the lowest id of each identical group — the first time the
-- line was seen, which is also the row anything else may already reference.
DELETE FROM events
WHERE kind LIKE 'gamelog.%'
  AND id NOT IN (
    SELECT MIN(id) FROM events
    WHERE kind LIKE 'gamelog.%'
    GROUP BY
      kind,
      ts,
      COALESCE(session_id, -1),
      COALESCE(subject_id, ''),
      COALESCE(
        CASE WHEN json_valid(payload) THEN json_extract(
          payload,
          '$.displayName',
          '$.userId',
          '$.worldName',
          '$.path',
          '$.reason',
          '$.vrMode',
          '$.objectPath',
          '$.spawnerDisplayName',
          '$.location.location',
          '$.target.location'
        ) ELSE payload END,
        ''
      )
  );

CREATE UNIQUE INDEX ux_events_gamelog_dedupe ON events (
  kind,
  ts,
  COALESCE(session_id, -1),
  COALESCE(subject_id, ''),
  COALESCE(
    CASE WHEN json_valid(payload) THEN json_extract(
      payload,
      '$.displayName',
      '$.userId',
      '$.worldName',
      '$.path',
      '$.reason',
      '$.vrMode',
      '$.objectPath',
      '$.spawnerDisplayName',
      '$.location.location',
      '$.target.location'
    ) ELSE payload END,
    ''
  )
) WHERE kind LIKE 'gamelog.%';
