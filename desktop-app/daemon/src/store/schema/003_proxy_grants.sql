-- 003_proxy_grants — the Phase 2 proxy's own state: grants, pending consent, and the audit log.
--
-- See PLAN.md §Phase 2. Three tables, and the reasoning for each shape is worth writing down
-- because two of them are security boundaries.
--
-- `grants` holds one row per (app, account) pair — an app that logs into three accounts gets three
-- rows, exactly as it would hold three real VRChat sessions. Revoking one kills that app's access
-- to that one account and touches nothing else.
--
-- **The token is stored hashed, never in plaintext.** The issued cookie is
-- `authcookie_<uuid>_vrczip` and the uuid is the secret itself, so a readable `grants` table would
-- be a table of live bearer credentials. Lookup hashes the presented value and selects on
-- `token_hash`, which is O(1) through the unique index and never needs the original. `id` is a
-- separate, non-secret handle so the UI, the audit log, and revocation can name a grant without
-- ever handling its token.
--
-- `pairing_requests` is the consent channel from §"Pending consent": a login with no grant gets
-- VRChat's real pre-2FA response and a 6-digit code appears in the vrc.zip UI. Typing that code
-- into the app *is* the consent gesture, so this row is a capability and its token is hashed for
-- the same reason.
--
-- `account_id` is nullable on both: the app may name an account vrc.zip does not manage yet, or use
-- the reserved "let the user choose" username, and in both cases the request is real before an
-- account exists to point it at.

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

CREATE TABLE grants (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

  -- The app's identity, parsed out of its User-Agent. VRChat already mandates the shape, so every
  -- well-behaved client already sends one; this triple is the consent subject shown to the user.
  app_name              TEXT    NOT NULL,
  app_version           TEXT    NOT NULL,
  app_contact           TEXT    NOT NULL,

  -- JSON array of scope strings from the shared registry. Stored as granted, never re-derived:
  -- a later registry change must not silently widen or narrow a grant the user already approved.
  scopes                TEXT    NOT NULL,

  token_hash            TEXT    NOT NULL,
  -- The proxy's own `twoFactorAuth` value, so device-trust round-trips look normal to the client.
  -- Null until the app completes a pairing.
  two_factor_hash       TEXT,

  created_at            INTEGER NOT NULL,
  last_used_at          INTEGER,
  -- Set on revoke rather than deleting the row: the audit log references it, and "this app had
  -- access between these two times" is exactly the question a user asks after something goes wrong.
  revoked_at            INTEGER
) STRICT;

CREATE UNIQUE INDEX ux_grants_token ON grants (token_hash);
CREATE UNIQUE INDEX ux_grants_two_factor ON grants (two_factor_hash) WHERE two_factor_hash IS NOT NULL;
CREATE INDEX ix_grants_account ON grants (account_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- pairing_requests — a login waiting on consent
-- ---------------------------------------------------------------------------

CREATE TABLE pairing_requests (
  id                 TEXT PRIMARY KEY,
  -- Null when the app used the reserved "let the user choose" username, or named an account that
  -- is not in vrc.zip yet. The consent sheet resolves it; the app learns which it got from the
  -- returned CurrentUser.
  account_id         TEXT REFERENCES accounts (id) ON DELETE CASCADE,
  requested_username TEXT    NOT NULL,

  app_name           TEXT    NOT NULL,
  app_version        TEXT    NOT NULL,
  app_contact        TEXT    NOT NULL,
  scopes             TEXT    NOT NULL,

  -- The half-authenticated `auth` cookie handed back with `{"requiresTwoFactorAuth":[...]}`, and
  -- the code the user reads off the sheet. Both hashed: either one alone completes the pairing.
  half_token_hash    TEXT    NOT NULL,
  code_hash          TEXT    NOT NULL,

  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  -- Wrong codes are counted, not just rejected: a code is six digits and an app can retry.
  attempts           INTEGER NOT NULL DEFAULT 0,

  resolved_at        INTEGER,
  -- 'approved' | 'denied' | 'expired'. Null while pending.
  outcome            TEXT,
  -- The grant this became, once approved.
  grant_id           TEXT REFERENCES grants (id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX ux_pairing_half_token ON pairing_requests (half_token_hash);
CREATE INDEX ix_pairing_pending ON pairing_requests (expires_at) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- audit_log — every mutating call, attributed to the app that made it
-- ---------------------------------------------------------------------------
--
-- PLAN.md §"Known tension to accept knowingly": the proxy is the part of this system that most
-- resembles "acting on behalf of another user", so it gets an audit log. Reads are not recorded —
-- the volume would bury the rows that matter, and a read is not the thing anyone needs evidence of.
--
-- `grant_id` is nullable and deliberately not a foreign key: a denied call may have no grant at
-- all, and a revoked grant must not take its own history with it.

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  grant_id     TEXT,
  account_id   TEXT,
  app_name     TEXT    NOT NULL,
  method       TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  operation_id TEXT,
  scope        TEXT,
  -- 'allowed' | 'denied_scope' | 'hard_denied' | 'denied_revoked' | 'rate_limited' | 'blocked_egress'
  outcome      TEXT    NOT NULL,
  status       INTEGER
) STRICT;

CREATE INDEX ix_audit_ts ON audit_log (ts DESC);
CREATE INDEX ix_audit_grant_ts ON audit_log (grant_id, ts DESC);
