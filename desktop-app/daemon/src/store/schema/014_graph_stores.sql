-- 014_graph_stores — data that outlives a run, and is shared between graphs on purpose.
--
-- `graph_state` (013) is the memory of *one node*: keyed by (graph, node, key), invisible to
-- everything else, and deleted with the graph. That is exactly right for a cooldown and exactly
-- wrong for "the people I have already welcomed", which one graph writes and another reads.
--
-- So a second shape, and the difference between the two is the whole reason both exist:
--
--   graph_state  private to a node. Nobody else can see it, nothing else can corrupt it.
--   graph_kv     a **named store**, addressed by name and shared by whoever names it.
--
-- **A store is a namespace, not a file.** The alternative — one SQLite file per store, opened on
-- demand — was considered and dropped: it is a second connection pool, a second migration story, a
-- second thing the backup has to know about, and a file path a graph could point anywhere on the
-- disk. A `store` column gets sharing, which is the actual request, and keeps every store inside the
-- database that already has WAL, retention and a backup story.
--
-- **A store is created by being written to.** `INSERT OR IGNORE` on first write, rather than a
-- create-it-first ceremony that a graph author hits at 3 AM when a node fails on a name they have
-- not registered. The Stores panel lists what exists, so a typo shows up as a store nobody meant to
-- make rather than as silence.
--
-- **Nothing here is scoped to a graph, and that is the point.** Deleting a graph does not delete
-- what it put in a store, because the next graph over may be reading it. Stores are removed from
-- the Stores panel, deliberately, by a person.

-- ---------------------------------------------------------------------------
-- graph_stores
-- ---------------------------------------------------------------------------

CREATE TABLE graph_stores (
  name        TEXT    PRIMARY KEY,
  description TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

-- The one every node's `store` field defaults to, so a graph that never thinks about stores still
-- works and still shares with the graph beside it. Timestamps are 0 rather than a migration-time
-- clock: a seeded row was not created by anybody, and a date here would claim otherwise.
INSERT INTO graph_stores (name, description, created_at, updated_at)
VALUES ('default', 'Where a node writes when nobody chose a store.', 0, 0);

-- ---------------------------------------------------------------------------
-- graph_kv
-- ---------------------------------------------------------------------------

CREATE TABLE graph_kv (
  store      TEXT    NOT NULL REFERENCES graph_stores (name) ON DELETE CASCADE,

  -- Which collection inside the store, and this column is what makes one table serve four node
  -- families instead of four tables serving one each:
  --
  --   ''            a plain value.  key = the name the author typed.
  --   'map:<name>'  a map.          key = a field in it.
  --   'set:<name>'  a set.          key = the member, canonicalised. value = the member as JSON.
  --   'list'        a list.         key = the name. value = the whole JSON array.
  --
  -- A list is one row rather than a row per index because its operations are ordered — push, remove
  -- by value, find — and a row-per-index would make every removal a renumbering. Read-modify-write
  -- is safe here for the reason it usually is not: this is one process, one thread, and no `await`
  -- between the read and the write.
  collection TEXT    NOT NULL,
  key        TEXT    NOT NULL,

  -- JSON, always — `"hello"` rather than `hello`. One column has to hold a number, a string, an
  -- object and a list, and the alternative (raw text plus a type column) means every reader agrees
  -- on the encoding or silently disagrees.
  value      TEXT    NOT NULL,

  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store, collection, key)
) STRICT;

-- For the Stores panel, which asks one question: what is in here, most recently touched first.
CREATE INDEX ix_graph_kv_recent ON graph_kv (store, updated_at DESC);
