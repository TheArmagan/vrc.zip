import init001 from "./001_init.sql" with { type: "text" };
import userCache002 from "./002_user_cache_per_account.sql" with { type: "text" };
import grants003 from "./003_proxy_grants.sql" with { type: "text" };
import grantBudgets004 from "./004_grant_budgets.sql" with { type: "text" };
import webhooks005 from "./005_webhooks.sql" with { type: "text" };
import plugins006 from "./006_plugins.sql" with { type: "text" };
import logOffsets007 from "./007_log_offsets.sql" with { type: "text" };
import notificationsTs008 from "./008_notifications_ts.sql" with { type: "text" };
import avatarFileIds009 from "./009_avatar_file_ids.sql" with { type: "text" };
import dropPluginSigning010 from "./010_drop_plugin_signing.sql" with { type: "text" };
import pluginGrantEvents011 from "./011_plugin_grant_events.sql" with { type: "text" };
import graphs012 from "./012_graphs.sql" with { type: "text" };
import graphState013 from "./013_graph_state.sql" with { type: "text" };

/** One numbered migration. `version` must be unique, contiguous from 1, and ascending. */
export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

/**
 * Every migration, in application order. Add new ones by dropping a numbered `.sql` file next to
 * this one and appending it here — the runner applies whatever is newer than `meta.schema_version`.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "001_init", sql: init001 },
  { version: 2, name: "002_user_cache_per_account", sql: userCache002 },
  { version: 3, name: "003_proxy_grants", sql: grants003 },
  { version: 4, name: "004_grant_budgets", sql: grantBudgets004 },
  { version: 5, name: "005_webhooks", sql: webhooks005 },
  { version: 6, name: "006_plugins", sql: plugins006 },
  { version: 7, name: "007_log_offsets", sql: logOffsets007 },
  { version: 8, name: "008_notifications_ts", sql: notificationsTs008 },
  { version: 9, name: "009_avatar_file_ids", sql: avatarFileIds009 },
  { version: 10, name: "010_drop_plugin_signing", sql: dropPluginSigning010 },
  { version: 11, name: "011_plugin_grant_events", sql: pluginGrantEvents011 },
  { version: 12, name: "012_graphs", sql: graphs012 },
  { version: 13, name: "013_graph_state", sql: graphState013 },
];
