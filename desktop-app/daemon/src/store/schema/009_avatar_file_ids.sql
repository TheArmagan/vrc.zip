-- 009_avatar_file_ids — the image file id → avatar id mapping, so it survives a restart.
--
-- ## Why not `avatar_cache`
--
-- `avatar_cache` is keyed on `avatar_id` and holds a VRChat body under a `fetched_at` TTL, exactly
-- like `world_cache`. It is the right home for the avatar *record* and is used for that. It cannot
-- hold this mapping: the key here is a **file** id, the value is an avatar id rather than a
-- document, and "no avatar is known for this file" is a real answer that has to be storable —
-- which in `avatar_cache` would mean an avatar row with no avatar.
--
-- ## `avatar_id` is nullable on purpose
--
-- A null row is a *negative* answer with a cooldown, not a verdict. avtr.zip is a third-party index
-- that learns about new avatars over time, so "not known yet" must be re-askable; `resolved_at` is
-- what bounds how often. See `daemon/src/net/avatar-ids.ts`, which also documents what leaves the
-- machine to produce one of these rows.
--
-- Nothing here is per account. A file belongs to one avatar whoever is asking, the same argument
-- migration 002 made for leaving `world_cache` global while splitting `user_cache`.

CREATE TABLE avatar_file_ids (
  file_id     TEXT PRIMARY KEY,
  -- NULL means avtr.zip had no avatar for this file at `resolved_at`.
  avatar_id   TEXT,
  resolved_at INTEGER NOT NULL
) STRICT;

-- The negative rows are the ones that age out; the index is what makes finding them cheap.
CREATE INDEX ix_avatar_file_ids_resolved ON avatar_file_ids (resolved_at);
