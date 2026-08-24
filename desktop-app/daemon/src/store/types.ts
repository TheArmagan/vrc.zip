/**
 * Row and input shapes for the store.
 *
 * These are deliberately local to `daemon/src/store/` — they describe the database, not the wire
 * format. The HTTP layer maps them to whatever `@vrcz/shared` declares.
 *
 * Every timestamp is unix milliseconds. Nullable columns are `T | null`, never optional, so that
 * `exactOptionalPropertyTypes` never has to guess what a missing key means.
 */

export type AccountRow = {
  id: string;
  display_name: string;
  added_at: number;
  enabled: number;
  last_seen_at: number | null;
};

export type SessionRow = {
  id: number;
  account_id: string | null;
  display_name: string | null;
  log_path: string;
  log_inode: number | null;
  started_at: number;
  ended_at: number | null;
  exit_kind: string | null;
  vr_mode: string | null;
  current_location: string | null;
  current_world_id: string | null;
};

export type NewSession = Omit<SessionRow, "id" | "ended_at" | "exit_kind">;

export type EventRow = {
  id: number;
  /** Null for events from a game client signed into an account vrc.zip does not manage. */
  account_id: string | null;
  ts: number;
  session_id: number | null;
  kind: string;
  subject_id: string | null;
  location: string | null;
  payload: string | null;
};

export type NewEvent = Omit<EventRow, "id">;

/**
 * Where the log watcher had read to in one log file, so a restart resumes rather than replays.
 *
 * Keyed on the watcher's `logKey` — the file's filesystem identity — not on its path. A rotated
 * log reuses the path, and inheriting the old file's offset would skip the head of the new one,
 * including the `User Authenticated:` line that is the only thing linking a log to an account.
 */
export type LogOffsetRow = {
  log_key: string;
  log_path: string;
  byte_offset: number;
  updated_at: number;
};

export type FriendLogRow = {
  account_id: string;
  user_id: string;
  display_name: string;
  trust_level: string | null;
  friended_at: number;
  unfriended_at: number | null;
};

export type FriendLogHistoryRow = {
  id: number;
  account_id: string;
  ts: number;
  type: string;
  user_id: string;
  display_name: string | null;
  previous_display_name: string | null;
  trust_level: string | null;
  previous_trust_level: string | null;
};

export type NewFriendLogHistory = Omit<FriendLogHistoryRow, "id">;

export type CacheRow = {
  id: string;
  fetched_at: number;
  data: string;
};

export type NoteRow = {
  account_id: string;
  user_id: string;
  note: string;
  updated_at: number;
};

export type NotificationRow = {
  id: string;
  account_id: string;
  ts: number;
  type: string;
  sender_user_id: string | null;
  sender_display_name: string | null;
  message: string | null;
  seen: number;
  data: string | null;
};

/**
 * One image-file-id → avatar-id mapping. `avatar_id` null is a *negative* answer on a cooldown,
 * not a verdict — see migration 009 and `daemon/src/net/avatar-ids.ts`.
 */
export type AvatarFileIdRow = {
  file_id: string;
  avatar_id: string | null;
  resolved_at: number;
};

export type AvatarHistoryRow = {
  account_id: string;
  avatar_id: string;
  first_seen: number;
  last_seen: number;
  seen_count: number;
};

export type EventsDailyRow = {
  account_id: string;
  day: number;
  kind: string;
  subject_id: string;
  count: number;
  total_ms: number;
};

export type RetentionConfigRow = {
  kind: string;
  retain_days: number;
  updated_at: number;
};

/** Result of `SELECT kind, COUNT(*) FROM events GROUP BY kind`. */
export type KindCount = {
  kind: string;
  count: number;
};

/** Filter for the feed query. `before` is exclusive; omit by passing `null`. */
export type EventQuery = {
  accountId: string;
  before: number | null;
  kinds: readonly string[] | null;
  limit: number;
};

// ---------------------------------------------------------------------------
// proxy grants (Phase 2)
// ---------------------------------------------------------------------------

/**
 * One app's access to one account. `token_hash` is a hash of the issued
 * `authcookie_<uuid>_vrczip` value — the plaintext is handed to the app once and never stored.
 */
export type GrantRow = {
  id: string;
  account_id: string;
  app_name: string;
  app_version: string;
  app_contact: string;
  /** JSON array of scope strings, exactly as granted. */
  scopes: string;
  token_hash: string;
  two_factor_hash: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

export type NewGrant = Omit<GrantRow, "last_used_at" | "revoked_at">;

/** A login sitting at the consent sheet, waiting for its pairing code to be typed into the app. */
export type PairingRequestRow = {
  id: string;
  /** Null when the app asked the user to choose, or named an account not in vrc.zip yet. */
  account_id: string | null;
  requested_username: string;
  app_name: string;
  app_version: string;
  app_contact: string;
  scopes: string;
  half_token_hash: string;
  code_hash: string;
  created_at: number;
  expires_at: number;
  attempts: number;
  resolved_at: number | null;
  /** `approved` | `denied` | `expired`; null while pending. */
  outcome: string | null;
  grant_id: string | null;
};

export type NewPairingRequest = Omit<
  PairingRequestRow,
  "attempts" | "resolved_at" | "outcome" | "grant_id"
>;

/** One mutating proxy call, attributed to the app that made it. Reads are not recorded. */
export type AuditRow = {
  id: number;
  ts: number;
  grant_id: string | null;
  account_id: string | null;
  app_name: string;
  method: string;
  path: string;
  operation_id: string | null;
  scope: string | null;
  outcome: string;
  status: number | null;
};

export type NewAuditEntry = Omit<AuditRow, "id">;

// ---------------------------------------------------------------------------
// webhooks (Phase 2)
// ---------------------------------------------------------------------------

/**
 * One outbound subscription. `secret_hash` is the HMAC key — `sha256(secret)` — and the plaintext
 * `whsec_…` is handed out once at registration and never stored. See `005_webhooks.sql`.
 */
export type WebhookRow = {
  id: string;
  /** The grant that registered it, or null for a webhook the user added in the UI. */
  grant_id: string | null;
  /** Already normalised by `URL`, and already past the SSRF checks in `webhooks/url.ts`. */
  url: string;
  secret_hash: string;
  /** JSON array of kind patterns: `friend.online`, `friend.*`, or `*`. */
  kinds: string;
  /** Null means every account, including events with no account at all. */
  account_id: string | null;
  created_at: number;
  disabled_at: number | null;
  disabled_reason: string | null;
  /** Dead-lettered deliveries in a row. Reset by the first success, not decayed. */
  consecutive_dead: number;
  delivered_count: number;
  dead_count: number;
  last_delivery_at: number | null;
  last_status: number | null;
  last_error: string | null;
};

export type NewWebhook = Pick<
  WebhookRow,
  "id" | "grant_id" | "url" | "secret_hash" | "kinds" | "account_id" | "created_at"
>;

/**
 * One event on its way to one webhook. Pending while both `delivered_at` and `dead_at` are null —
 * including while `next_attempt_at` sits in the future, which is a row mid-backoff that survives a
 * restart.
 */
export type WebhookDeliveryRow = {
  id: string;
  webhook_id: string;
  /** Shared by every delivery of the same event, so a receiver can tell a fan-out from a repeat. */
  event_id: string;
  event_kind: string;
  /** The rendered JSON body. Retries re-send these exact bytes so the signature still covers them. */
  payload: string;
  attempts: number;
  next_attempt_at: number;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
  dead_at: number | null;
};

export type NewWebhookDelivery = Pick<
  WebhookDeliveryRow,
  "id" | "webhook_id" | "event_id" | "event_kind" | "payload" | "next_attempt_at" | "created_at"
>;

/**
 * One per-grant override of a risky scope's hourly allowance — migration 004.
 *
 * The presence of the row is the override. There is no "unset" value: absence means the build's
 * default, and `hourly_limit = 0` means never, which is a setting somebody may well want.
 */
export type GrantBudgetRow = {
  grant_id: string;
  scope: string;
  hourly_limit: number;
  updated_at: number;
};

// -- plugins (Phase 3) --------------------------------------------------------

/** One installed plugin. `manifest` is the JSON accepted at install, kept verbatim. */
export type PluginRow = {
  id: string;
  version: string;
  manifest: string;
  bundle_hash: string;
  source_kind: string;
  source_ref: string;
  installed_at: number;
  updated_at: number;
  disabled_at: number | null;
  disabled_by: string | null;
  disabled_reason: string | null;
};

export type NewPlugin = Omit<PluginRow, "disabled_at" | "disabled_by" | "disabled_reason">;

/**
 * One approved grant, immutable and keyed by (plugin, version, grant hash).
 *
 * A change is a new row, never an UPDATE — that is what makes "an update that adds a scope provably
 * re-prompts" hold by construction rather than by a check somebody has to remember to write.
 */
export type PluginGrantRow = {
  plugin_id: string;
  version: string;
  grant_hash: string;
  scopes: string;
  account_ids: string;
  capabilities: string;
  events: string;
  domains: string;
  granted_at: number;
  revoked_at: number | null;
};

export type NewPluginGrant = Omit<PluginGrantRow, "revoked_at">;

/** One crash, for the breaker's rolling window and for the bug report. */
export type PluginCrashRow = {
  id: number;
  plugin_id: string;
  ts: number;
  reason: string;
  detail: string;
  code: number | null;
  signal: string | null;
};

export type NewPluginCrash = Omit<PluginCrashRow, "id">;

/**
 * One graph. See `012_graphs.sql` for why the definition is a blob and why there are two switches.
 *
 * `enabled` and `armed` are both integers because SQLite has no boolean, and both are kept that way
 * up to the API boundary rather than mapped here — every other row in this file does the same, and a
 * type that silently converts is a type that disagrees with the SQL a reader has open beside it.
 */
export type GraphRow = {
  id: string;
  name: string;
  description: string;
  enabled: number;
  armed: number;
  concurrency: string;
  account_id: string | null;
  definition: string;
  disabled_reason: string | null;
  /**
   * When this graph last started a run, or null for one that never has.
   *
   * Here rather than derived from `graph_runs`, which holds only runs in flight — see migration 015.
   */
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
};

export type NewGraph = Omit<GraphRow, "disabled_reason" | "last_run_at">;

/**
 * One run that has not finished — running, waiting on a `wait` node, or queued behind another.
 *
 * There is no row here for a run that ended: history is an `events` row with a `graph.*` kind, which
 * is what gives it retention, the feed and webhooks for free. This table is the resume log.
 */
export type GraphRunRow = {
  id: string;
  graph_id: string;
  trigger_node: string;
  status: string;
  dry_run: number;
  wait_node: string | null;
  resume_at: number | null;
  state: string;
  started_at: number;
  updated_at: number;
};

export type NewGraphRun = Omit<GraphRunRow, "wait_node" | "resume_at">;

/** How much one node of a graph is remembering, for the editor's "forget" button. */
export type GraphNodeStateRow = {
  node_id: string;
  n: number;
  updated_at: number;
};

/**
 * One named store. See `014_graph_stores.sql` for why a store is a namespace rather than a file.
 *
 * `entries` is counted in the listing query rather than kept as a column: a counter maintained by
 * hand is a counter that drifts, and the count is only ever asked for by a panel a person is looking
 * at.
 */
export type GraphStoreRow = {
  name: string;
  description: string;
  entries: number;
  created_at: number;
  updated_at: number;
};

/** One entry of a known collection. `value` is JSON text; nothing but the node decodes it. */
export type GraphKvRow = {
  key: string;
  value: string;
  updated_at: number;
};

/** One entry when the collection is part of the answer, for browsing a whole store. */
export type GraphKvEntryRow = GraphKvRow & { collection: string };
