-- 010_drop_plugin_signing — remove the two columns signing left behind.
--
-- PLAN.md §Phase 3 correction 5 cut Ed25519 signing and trust tiers from v1, and PROGRESS.md
-- decision 182 records why: with no registry there is nowhere to distribute publisher keys from, so
-- a signature checked against a key shipped in the same manifest proves only that the key signed
-- what it signed. The commit pin in `source_ref` is the provenance story, and it is the whole of it.
--
-- `trust` was NOT NULL and every row in existence holds 'unsigned', because nothing ever wrote the
-- other value — there was no verifier. `publisher_key` was always NULL for the same reason. Keeping
-- them would leave a column that reads as a decision the host makes when it never did.
--
-- ALTER TABLE ... DROP COLUMN needs SQLite 3.35+, which the bundled Bun comfortably exceeds. Neither
-- column appears in an index, a view, or a partial-index predicate (`ix_plugins_enabled` is over
-- `installed_at` with a `disabled_at` predicate), so the drop is legal rather than merely allowed.

ALTER TABLE plugins DROP COLUMN trust;
ALTER TABLE plugins DROP COLUMN publisher_key;
