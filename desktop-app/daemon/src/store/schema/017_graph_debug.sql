-- 017_graph_debug — the third switch on a graph, and the traces it turns on.
--
-- ## Why a switch and not "always on"
--
-- A trace holds what flowed through every wire of a run. That is the whole reason it is useful and
-- the whole reason it cannot be the default: the values are user objects, API responses and friend
-- lists, and recording them for every run of every enabled graph would be a second event store with
-- none of the retention thinking that went into the first one. So `graphs.debug` gates it, per
-- graph, because a graph is the unit somebody sits down to debug.
--
-- Three things follow from the flag, all in `graphs/engine.ts`:
--
--   1. every run of the graph writes a row here,
--   2. `breakpoint` nodes actually park the run instead of being a decoration,
--   3. the editor toasts what it sees, which is a client-side reading of the same bit.
--
-- What the flag does **not** gate is `graph.node.error`. A node that threw onto its `on error` wire
-- had no record anywhere, and that is the same class of silence `graph.run.dropped` exists to break;
-- it is an ordinary event under ordinary retention whether or not anybody is debugging.
--
-- ## Why traces are not `events` rows
--
-- Every other piece of run history is, and that is decision 206 working as intended: the feed, the
-- retention config, the stream and outbound webhooks all come free. A trace is the one thing that
-- must not go there. It is large, it is per-node, and it is interesting for about as long as
-- somebody has the canvas open — putting it in `events` would bury a user's timeline under their own
-- debugging and hand a webhook subscriber a copy of every value the graph touched.
--
-- So: its own table, bounded by **count per graph** rather than by age. Ten runs is what the editor
-- shows; an eleventh pushes the oldest out at insert time, which means the table cannot grow without
-- somebody actively debugging and cannot outlive the graph it belongs to.

ALTER TABLE graphs ADD COLUMN debug INTEGER NOT NULL DEFAULT 0 CHECK (debug IN (0, 1));

CREATE TABLE graph_traces (
  -- The run's own id. A run produces exactly one trace, written once when it settles.
  run_id       TEXT    PRIMARY KEY,
  graph_id     TEXT    NOT NULL REFERENCES graphs (id) ON DELETE CASCADE,
  trigger_node TEXT    NOT NULL,

  -- No `waiting` here, unlike `graph_runs.status`: a trace is written when the run is over, and a
  -- run parked on a `wait` or a breakpoint is not over. It gets its trace when it eventually ends.
  outcome      TEXT    NOT NULL CHECK (outcome IN ('finished', 'failed')),
  dry_run      INTEGER NOT NULL CHECK (dry_run IN (0, 1)),

  -- The node the run died on and what it said. Both NULL for a run that finished.
  failed_node  TEXT,
  message      TEXT,

  -- The steps, JSON: `GraphTraceStep[]` from `@vrcz/shared`. One blob rather than a row per step
  -- for the same reason the definition is one blob — nothing queries an individual step, and the
  -- only reader wants the whole run at once.
  steps        TEXT    NOT NULL,

  started_at   INTEGER NOT NULL,
  finished_at  INTEGER NOT NULL
) STRICT;

-- The only query there is: this graph's runs, newest first. Also what the prune walks.
CREATE INDEX ix_graph_traces_graph ON graph_traces (graph_id, finished_at DESC);

-- ---------------------------------------------------------------------------
-- retention for the new kind
-- ---------------------------------------------------------------------------

-- Shorter than the family's 30 days. A handled node failure is worth saying out loud and worth
-- finding again tomorrow; it is not worth a month, because the interesting thing about it is that
-- it is *still happening*, and a week of them says that as well as a month would.
INSERT INTO retention_config (kind, retain_days, updated_at) VALUES
  ('graph.node.error', 7, 0),
  -- A pause is a thing that happened while somebody was sitting there. It has served its purpose by
  -- the time they have read it.
  ('graph.run.paused', 1, 0);
