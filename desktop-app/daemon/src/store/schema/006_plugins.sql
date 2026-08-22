-- 006_plugins — installed plugins, what the user granted them, and why one stopped running.
--
-- See PLAN.md §Phase 3. Three tables, and the shape of each is an argument.
--
-- `plugins` is the installed set. The manifest is stored **as it was at install**, verbatim, rather
-- than re-read from disk on demand: the manifest on disk is the author's file and can change under
-- us, while what the user was shown at consent is a historical fact that has to survive. The bundle
-- hash is here for the same reason it is in the filename — the artifact is content-addressed at
-- `plugins/<id>/<sha256>.js` and verified on every load, so a row whose hash no longer matches the
-- file is a tampered install and is refused rather than run.
--
-- **`disabled_at` is the auto-disable, and it lives here rather than in the supervisor's memory
-- because auto-disable that does not survive a restart is not auto-disable.** A crash-looping plugin
-- that comes back enabled after the daemon restarts is a crash loop with extra steps. `disabled_by`
-- separates "the user turned this off" from "vrc.zip turned this off because it kept dying", which
-- are different sentences to put in front of someone and different things to offer them next.
--
-- `plugin_grants` is keyed by (plugin_id, version, grant_hash) exactly as PLAN.md requires, and the
-- rows are immutable — a change is a new row, never an UPDATE. That is what makes "an update that
-- adds a scope provably re-prompts" true by construction: a version bump or a widened permission
-- set produces a key that has never been approved, so there is nothing to find and consent is
-- unavoidable. It also kills the downgrade attack, where reinstalling an older version would
-- otherwise silently reuse a broader grant that a later version had asked for.
--
-- `plugin_crashes` is the evidence behind auto-disable. Rows rather than a counter because the
-- question a user asks is "what happened", not "how many times" — and because a rolling window over
-- timestamps is the only honest way to distinguish a plugin that crashed five times in a minute
-- from one that has crashed five times since March.

-- ---------------------------------------------------------------------------
-- plugins
-- ---------------------------------------------------------------------------

CREATE TABLE plugins (
  id              TEXT PRIMARY KEY,
  version         TEXT    NOT NULL,

  -- The manifest as accepted at install, verbatim JSON. Not re-parsed from disk: see the header.
  manifest        TEXT    NOT NULL,
  -- sha256 of the built artifact, which is also its filename. Verified on every load.
  bundle_hash     TEXT    NOT NULL,

  -- 'path' | 'git'. v1 has no registry (decision 107): a plugin comes from a local directory or a
  -- git URL pinned to a commit, and `source_ref` holds that commit so what ran stays auditable.
  source_kind     TEXT    NOT NULL,
  source_ref      TEXT    NOT NULL,

  -- 'unsigned' | 'signed'. Derived at install from the detached signature, never self-declared —
  -- a plugin does not get to call itself trusted. Null-free because "we have not checked" is not a
  -- state an installed row is allowed to be in.
  trust           TEXT    NOT NULL,
  -- Ed25519 publisher key the signature verified against, when there was one.
  publisher_key   TEXT,

  installed_at    INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  -- Null while the plugin is allowed to run. Set by the user or by the crash-loop breaker.
  disabled_at     INTEGER,
  -- The supervisor's `DisableRecord["reason"]`: 'user' | 'crash-loop' | 'protocol-mismatch'.
  -- Which sentence to show, and what to offer next. Deliberately TEXT with no CHECK: a newer build
  -- may write a reason this one has never heard of, and the reader degrades to "still disabled"
  -- rather than the migration refusing a row it does not recognise.
  disabled_by     TEXT,
  -- Plain English, meant to be read by a person rather than parsed.
  disabled_reason TEXT
) STRICT;

CREATE INDEX ix_plugins_enabled ON plugins (installed_at DESC) WHERE disabled_at IS NULL;

-- ---------------------------------------------------------------------------
-- plugin_grants — immutable, keyed by (plugin, version, grant hash)
-- ---------------------------------------------------------------------------

CREATE TABLE plugin_grants (
  plugin_id   TEXT    NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  version     TEXT    NOT NULL,
  -- `grantHash` from @vrcz/plugin-api: a stable digest over exactly the consent-relevant fields.
  grant_hash  TEXT    NOT NULL,

  -- What was approved, stored as approved and never re-derived from the manifest. A registry change
  -- or a manifest edit must not be able to widen a grant the user already gave.
  scopes      TEXT    NOT NULL,
  -- JSON array of account ids the user picked. A plugin with `friends:read` must not implicitly
  -- hold it for all six accounts, so this is the answer to a question asked at consent, not a
  -- restatement of the request.
  account_ids TEXT    NOT NULL,
  capabilities TEXT   NOT NULL,
  -- Allowlisted fetch domains, exactly as shown at consent. No wildcards ever reach here.
  domains     TEXT    NOT NULL,

  granted_at  INTEGER NOT NULL,
  -- Set on revoke rather than deleting: "this plugin had this access between these two times" is
  -- the question someone asks after something goes wrong, and a deleted row cannot answer it.
  revoked_at  INTEGER,

  PRIMARY KEY (plugin_id, version, grant_hash)
) STRICT;

CREATE INDEX ix_plugin_grants_live ON plugin_grants (plugin_id, granted_at DESC) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- plugin_dry_run — which scopes are still shadowed, per plugin
-- ---------------------------------------------------------------------------
--
-- PLAN.md correction 4: outbound social actions need more than install-time consent. A new plugin's
-- `invite:send`, `moderation:write` and friend-request calls are **dry-run by default** — logged,
-- attributed, and not sent — and dry-run is lifted by an explicit gesture per plugin and per scope,
-- with the dry-run log beside it as the evidence.
--
-- A row here means "this plugin's calls under this scope are real now". Absence means shadowed,
-- which is why this is an allowlist rather than a `dry_run BOOLEAN` on the grant: the safe state is
-- the one you get by having no row, so a bug that fails to write one under-permits rather than
-- over-permits. Deliberately **not** keyed by version — the gesture is about this plugin's
-- behaviour, and re-asking after every patch release is how you teach someone to click through.
-- Adding the scope itself still re-prompts, because that changes the grant hash.

CREATE TABLE plugin_dry_run_lifted (
  plugin_id  TEXT    NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  scope      TEXT    NOT NULL,
  lifted_at  INTEGER NOT NULL,

  PRIMARY KEY (plugin_id, scope)
) STRICT;

-- ---------------------------------------------------------------------------
-- plugin_crashes — the evidence behind the crash-loop breaker
-- ---------------------------------------------------------------------------

CREATE TABLE plugin_crashes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  -- 'crashed' | 'killed' | 'spawn-failed' — `ExitReason` minus the clean shutdown, which is not a
  -- crash and must never count toward the breaker.
  reason    TEXT    NOT NULL,
  detail    TEXT    NOT NULL,
  -- Process exit code and signal, when there were any. Kept for the bug report, not for the breaker.
  code      INTEGER,
  signal    TEXT
) STRICT;

-- Not a foreign key, deliberately: uninstalling a plugin should not erase the record of why it kept
-- falling over, which is exactly what someone wants to read before deciding to reinstall it.
CREATE INDEX ix_plugin_crashes_recent ON plugin_crashes (plugin_id, ts DESC);
