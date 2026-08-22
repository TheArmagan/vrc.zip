-- 004_grant_budgets — per-app overrides for the risky-scope hourly allowances.
--
-- PROGRESS.md decision 95: the three scopes that spend something the user cannot get back
-- (`invite:send`, `friends:write`, `groups:invite`) carry a rolling hourly allowance per grant,
-- refused with a 429 that never reaches VRChat. Those allowances shipped as constants
-- (`DEFAULT_GRANT_BUDGETS`), and a constant is the wrong shape for this: the right number for a
-- mass-invite tool the user installed on purpose is not the right number for a feed reader that
-- has no business sending invites at all.
--
-- One row per (grant, scope), and **a row means an override**. Absence is not zero and is not a
-- stored default — it means "whatever the build's default is", so raising a default in a later
-- release reaches every app that never had one set, which is the behaviour anyone would expect
-- from a number they never touched.
--
-- `hourly_limit` is allowed to be 0, and 0 is a real setting rather than a mistake: "this app may
-- never send an invite" is exactly the thing someone wants to be able to say without revoking the
-- whole grant and re-pairing. It is a NOT NULL column for that reason — nullable would give two
-- spellings of "unset" (no row, and a row holding NULL) and code would eventually disagree about
-- which one it was looking at.
--
-- `ON DELETE CASCADE` on the grant: an override is a property of the grant, not a record of it.
-- The audit log is what survives a revoke; a number that only ever gated future calls has nothing
-- to say once there are none. Note that grants are *revoked*, not deleted, so this cascade only
-- fires when the account itself is removed — at which point the grant goes too.

CREATE TABLE grant_budgets (
  grant_id     TEXT    NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  -- A scope string from the shared registry. Not constrained here: the registry is TypeScript, the
  -- set grows between releases, and a CHECK holding a copy of it would be a copy that drifts.
  scope        TEXT    NOT NULL,
  -- Calls of this scope permitted per rolling hour. 0 means "never".
  hourly_limit INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,

  PRIMARY KEY (grant_id, scope)
) STRICT;
