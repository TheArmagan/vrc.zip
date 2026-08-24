-- 015_graph_last_run — when a graph last started a run, kept on the graph itself.
--
-- ## Why the run table could not answer this
--
-- `graph_runs` is live state and nothing else: the engine deletes a run's row the moment it finishes
-- or fails (`#settle`), which is what migration 012 means by "pruned on completion". So the grouped
-- `MAX(started_at)` scan the Graphs list used could only ever see runs that were still in flight —
-- and a graph is almost never mid-run at the moment somebody opens the screen. Every row said
-- "never run", including graphs that had just run in front of the user.
--
-- A column on `graphs` is the fix rather than keeping finished runs around. Run history is
-- deliberately not stored: a run row carries the whole port state as JSON, the feed already records
-- `graph.run.finished` and `graph.run.failed` under retention, and the list only ever wanted one
-- timestamp. One integer per graph is the smallest thing that answers the question.
--
-- Nullable, and null still means never. A graph that has run and a graph that ran at the epoch are
-- different sentences, which a `DEFAULT 0` would have collapsed.

ALTER TABLE graphs ADD COLUMN last_run_at INTEGER;

-- Whatever the old scan could still see, which is any run in flight right now. Better than leaving
-- every existing row null, and wrong for nobody: a run in flight did start.
UPDATE graphs
SET last_run_at = (SELECT MAX(started_at) FROM graph_runs WHERE graph_runs.graph_id = graphs.id)
WHERE EXISTS (SELECT 1 FROM graph_runs WHERE graph_runs.graph_id = graphs.id);
