-- 013_graph_state — the memory a few built-in nodes need between runs.
--
-- Two nodes want it and they want the same shape: "only once per person per day" has to remember
-- when it last let somebody through, and "how many joined tonight" has to remember a number. Both
-- are one value per (graph, node, key), and both are meaningless to anything else.
--
-- **Why a table rather than the plugin `records` store.** That one is per plugin, keyed by a plugin
-- id, opened as its own database file. A built-in node has no plugin, and giving the host a fake
-- plugin id to borrow the machinery would put graph state in a file the uninstall path deletes.
--
-- **Why not in `graphs.definition`.** The document is what the user edited; this is what the run
-- learned. Writing run state into the document would mean every fire dirties the thing the canvas
-- is showing, and a save from an open editor would silently roll it back.
--
-- `key` is the caller's own dimension — usually a user id, so a cooldown is per person rather than
-- per graph. Empty string is the honest key for "no dimension", which is what a node with nothing
-- wired to its key port uses; it is a real value here rather than a NULL nobody can index on.

CREATE TABLE graph_state (
  graph_id   TEXT    NOT NULL REFERENCES graphs (id) ON DELETE CASCADE,
  node_id    TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  -- Text, so one column serves a timestamp and a counter without a type per node. The node that
  -- wrote it is the only thing that reads it, so it is the only thing that has to agree on a shape.
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (graph_id, node_id, key)
) STRICT;

-- Deleting a graph takes its memory with it, by foreign key. The index is for the sweep that
-- removes a node's rows when that node is removed from the document.
CREATE INDEX ix_graph_state_node ON graph_state (graph_id, node_id);
