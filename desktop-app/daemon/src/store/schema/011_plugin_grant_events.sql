-- 011_plugin_grant_events — make `permissions.events` something the host can enforce.
--
-- The gap this closes, from PROGRESS.md §Gotchas: a manifest declares event patterns, `grantHash`
-- has covered them since 3.1, and the consent sheet was going to show them — but `plugin_grants`
-- had columns for scopes, accounts, capabilities and domains and none for events, and `PluginGrant`
-- had no field either. So a plugin that declared `friend.*` could subscribe to `gamelog.*` on the
-- strength of `sessions:read`. Never *more* than its scopes allow, but more than the sheet said,
-- which makes the sheet a lie told with a checkbox.
--
-- `grantHash` does not change and does not need to: `events` was already one of the hashed fields,
-- so a grant's identity already accounted for the patterns. This adds the column that stores what
-- was hashed.
--
-- DEFAULT '[]' rather than NOT NULL with no default, because rows already exist. An empty list
-- denies every event, which is the safe direction and the honest one: those grants were written
-- before anyone was asked about events, so there is no approval to infer. The one row this can
-- affect is a plugin installed through the pre-consent route, which the same step replaces.

ALTER TABLE plugin_grants ADD COLUMN events TEXT NOT NULL DEFAULT '[]';
