-- 012_graphs — Phase 4's two tables. See PLAN.md §Phase 4 and PROGRESS.md decision 206.
--
-- The split between them is the decision worth reading before touching either:
--
--   `graphs`      one row per graph, the definition as a JSON blob. Durable.
--   `graph_runs`  live state only — running, queued, or parked on a `wait`. Pruned when a run ends.
--
-- **A finished run does not live here.** Its record is an ordinary `events` row with a `graph.*`
-- kind, which is what buys run history the per-kind retention config, the feed, the enriched stream
-- and outbound webhooks without a line of new code. Keeping completed runs in this table would be a
-- second history with a second retention policy to forget about, which PLAN.md §Phase 4 warns
-- against by name. So this table is small by construction: it holds what a restart has to be able to
-- resume, and nothing else.
--
-- Why the definition is one blob rather than `graph_nodes` + `graph_edges`: the editor saves whole
-- documents, and nothing queries an individual edge. Normalising would buy a join nobody needs and
-- cost a real write path on every canvas save. The blob carries the `nodeDefinitionHash` of every
-- node type the graph uses, which is what lets a plugin update be detected as incompatible instead
-- of silently rewiring a graph the user already armed.

-- ---------------------------------------------------------------------------
-- graphs
-- ---------------------------------------------------------------------------

CREATE TABLE graphs (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',

  -- Two switches, not one, and they are not the same question.
  --
  --   `enabled`  the user wants this graph to run. Triggers are armed.
  --   `armed`    the user has lifted dry-run, so outbound actions really happen.
  --
  -- A new graph is enabled-but-not-armed: it runs, and every action logs what it *would* have done.
  -- Lifting dry-run is an explicit hold-to-confirm gesture with that log beside it as the evidence
  -- (decision 109's posture for plugins, applied to graphs). Never a timer, and never implied by
  -- pressing enable — a graph wired wrong would otherwise send real invites on its first fire.
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  armed       INTEGER NOT NULL DEFAULT 0 CHECK (armed IN (0, 1)),

  -- What happens when a trigger fires while a run of this graph is still in flight. The author's
  -- choice, because neither default is right for everyone: instance joins arrive in bursts, so
  -- serialising by fiat makes a graph lag the event stream, and dropping by fiat loses events.
  concurrency TEXT    NOT NULL DEFAULT 'parallel'
              CHECK (concurrency IN ('parallel', 'queue', 'drop')),

  -- The graph's default acting account. Nullable, and ON DELETE SET NULL rather than CASCADE: a
  -- removed account must not take the user's automations with it. Each action node may name its own
  -- account and falls back to this one; a run whose action has neither fails with a readable error
  -- rather than guessing, because `events.account_id` is nullable by design (log-derived events,
  -- unlinked sessions) and "act as whoever the event was about" has no answer for those.
  account_id  TEXT    REFERENCES accounts (id) ON DELETE SET NULL,

  -- The document: nodes, edges, positions, per-node config, and the nodeDefinitionHash of every
  -- node type used. JSON.
  definition  TEXT    NOT NULL,

  -- Set when the daemon switched this graph off itself — a ceiling was hit, and the user is owed a
  -- sentence saying which. NULL when the graph is simply not enabled. The matching `graph.disabled`
  -- event carries the same reason into the feed.
  disabled_reason TEXT,

  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_graphs_updated ON graphs (updated_at DESC);

-- ---------------------------------------------------------------------------
-- graph_runs — live state, pruned on completion
-- ---------------------------------------------------------------------------

CREATE TABLE graph_runs (
  id           TEXT    PRIMARY KEY,
  graph_id     TEXT    NOT NULL REFERENCES graphs (id) ON DELETE CASCADE,

  -- Which trigger started this run. A graph may hold several trigger roots and each fire walks only
  -- what its own trigger reaches, so the run is meaningless without knowing which one it was.
  trigger_node TEXT    NOT NULL,

  status       TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'waiting')),

  -- Whether this run is a dry run, captured at fire time rather than read from `graphs.armed` when
  -- an action executes. A run that started while the graph was in dry-run must stay a dry run even
  -- if the user arms the graph while it is parked on a `wait` — otherwise arming a graph silently
  -- makes an in-flight rehearsal real.
  dry_run      INTEGER NOT NULL CHECK (dry_run IN (0, 1)),

  -- Set only while `status = 'waiting'`: which `wait` node parked the run, and when it is due.
  wait_node    TEXT,
  resume_at    INTEGER,

  -- Everything needed to continue: the port values produced so far, which nodes are done, which are
  -- skipped, and the `foreach` frames. JSON, written at every node boundary — that is the whole
  -- reason this table exists rather than a Map in the engine.
  state        TEXT    NOT NULL,

  started_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_graph_runs_graph ON graph_runs (graph_id, started_at DESC);
CREATE INDEX ix_graph_runs_status ON graph_runs (status, started_at);
-- Partial, because the boot sweep and the resume timer both ask exactly one question: what is due?
CREATE INDEX ix_graph_runs_resume ON graph_runs (resume_at) WHERE resume_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- retention for the new kinds
-- ---------------------------------------------------------------------------

-- Resolution is exact match, then longest matching prefix, then the global '*' (see 001_init).
-- Without these three the family would inherit 90 days from '*', which is wrong in both directions:
-- run rows are the highest-volume kind the app can produce, and a note a graph wrote deliberately to
-- tell the user something is worth keeping far longer than the run that produced it.
INSERT INTO retention_config (kind, retain_days, updated_at) VALUES
  ('graph.*',            30,  0),
  ('graph.run.dropped',  7,   0),
  ('graph.note',         365, 0);
