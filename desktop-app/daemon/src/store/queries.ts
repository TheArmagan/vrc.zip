/**
 * Every SQL string the store prepares, kept here so store.ts reads as an API surface rather than
 * a wall of SQL. Bindings are positional (`?`) throughout.
 */

export const SQL = {
  // -- accounts -------------------------------------------------------------
  upsertAccount: `
    INSERT INTO accounts (id, display_name, added_at, enabled, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      enabled      = excluded.enabled,
      last_seen_at = COALESCE(excluded.last_seen_at, accounts.last_seen_at)`,
  getAccount: `SELECT * FROM accounts WHERE id = ?`,
  listAccounts: `SELECT * FROM accounts ORDER BY added_at ASC`,
  setAccountEnabled: `UPDATE accounts SET enabled = ? WHERE id = ?`,
  touchAccount: `UPDATE accounts SET last_seen_at = ? WHERE id = ?`,
  deleteAccount: `DELETE FROM accounts WHERE id = ?`,

  // -- sessions -------------------------------------------------------------
  insertSession: `
    INSERT INTO sessions
      (account_id, display_name, log_path, log_inode, started_at,
       vr_mode, current_location, current_world_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(log_path, started_at) DO UPDATE SET
      account_id = excluded.account_id,
      log_inode  = excluded.log_inode,
      -- Re-adopting a file that is still being written resumes its session rather than starting
      -- a second one. This pairs with closeOrphanedSessions: startup closes everything, and the
      -- watcher immediately reopens whichever sessions are genuinely still live.
      ended_at   = NULL,
      exit_kind  = NULL
    RETURNING id`,
  endSession: `UPDATE sessions SET ended_at = ?, exit_kind = ? WHERE id = ?`,
  /*
   * Retroactive attribution. `COALESCE(?, col)` so a patch that knows only one field cannot blank
   * the others — identity on a session only ever becomes *more* known, never less. The
   * `User Authenticated:` line lands seconds into a log, long after the row exists.
   */
  updateSessionIdentity: `
    UPDATE sessions SET
      account_id   = COALESCE(?, account_id),
      display_name = COALESCE(?, display_name),
      vr_mode      = COALESCE(?, vr_mode)
    WHERE id = ?`,
  /*
   * Closes sessions left open by a previous process. Anything still open when the database is
   * first opened cannot belong to this run, because this run has only just started. The end time
   * is the last event we actually saw on that session, falling back to its start — inventing
   * `now` would stretch a session across however long the daemon was down.
   */
  closeOrphanedSessions: `
    UPDATE sessions SET
      ended_at  = COALESCE((SELECT MAX(ts) FROM events WHERE events.session_id = sessions.id),
                           started_at),
      exit_kind = 'unknown'
    WHERE ended_at IS NULL`,
  updateSessionLocation: `
    UPDATE sessions SET current_location = ?, current_world_id = ? WHERE id = ?`,
  /*
   * `COALESCE(?, col)` for the same reason as `updateSessionIdentity`: the environment block can
   * arrive partially (a resumed file that caught only its tail), and a later partial read must not
   * blank keys an earlier one already established. The OSC port is written the same way, which is
   * also what enforces "only the first port wins" at the storage layer — OSCQuery advertises on a
   * random high port and, on some builds, first.
   */
  updateSessionEnvironment: `
    UPDATE sessions SET
      vrchat_build     = COALESCE(?, vrchat_build),
      unity_version    = COALESCE(?, unity_version),
      platform         = COALESCE(?, platform),
      store            = COALESCE(?, store),
      device_model     = COALESCE(?, device_model),
      processor_type   = COALESCE(?, processor_type),
      graphics_device  = COALESCE(?, graphics_device),
      system_memory    = COALESCE(?, system_memory),
      operating_system = COALESCE(?, operating_system),
      xr_device        = COALESCE(?, xr_device),
      osc_port         = COALESCE(osc_port, ?)
    WHERE id = ?`,
  getSession: `SELECT * FROM sessions WHERE id = ?`,
  listOpenSessions: `SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC`,
  listSessions: `SELECT * FROM sessions WHERE account_id = ? ORDER BY started_at DESC LIMIT ?`,

  // -- events ---------------------------------------------------------------
  /*
   * `OR IGNORE` pairs with the partial unique index migration 007 puts on `gamelog.%` rows.
   *
   * It is not a shrug at write errors: the index covers exactly the rows that are *derived* from an
   * append-only file and are therefore reproducible by construction, so a second copy of one is
   * always a replay and never a second fact. Everything else — a pipeline event, a notification —
   * is uncovered by that index and inserts unconditionally, which is right: two identical VRChat
   * messages a millisecond apart are two messages.
   */
  insertEvent: `
    INSERT OR IGNORE INTO events (account_id, ts, session_id, kind, subject_id, location, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  /*
   * The feed pages. Four selectors — every account, one account, one game-client session, one
   * subject — each with and without a `kind` filter, and every one of them does its own paging.
   *
   * Written out rather than assembled by a builder, on purpose: eight fixed strings can be read
   * and their index use reasoned about, where a builder's output can only be discovered at
   * runtime. They are all `ts < ? ORDER BY ts DESC, id DESC LIMIT ?` so a caller can page any of
   * them the same way, and none of them filters after the `LIMIT` — post-filtering a page in JS
   * silently returns short pages and then an empty one, which reads to the user as "the history
   * stops here".
   *
   * `listAllEvents*` deliberately has no `account_id` predicate. It is the only selector that can
   * see rows with `account_id IS NULL` — a game client signed into an account vrc.zip does not
   * manage (PLAN.md §1.7) — and those rows are precisely what the game log exists to show.
   */
  listEvents: `
    SELECT * FROM events
    WHERE account_id = ? AND ts < ?
    ORDER BY ts DESC, id DESC
    LIMIT ?`,
  listEventsOfKind: `
    SELECT * FROM events
    WHERE account_id = ? AND kind = ? AND ts < ?
    ORDER BY ts DESC, id DESC
    LIMIT ?`,
  listAllEvents: `
    SELECT * FROM events
    WHERE ts < ?
    ORDER BY ts DESC, id DESC
    LIMIT ?`,
  listAllEventsOfKind: `
    SELECT * FROM events
    WHERE kind = ? AND ts < ?
    ORDER BY ts DESC, id DESC
    LIMIT ?`,
  listEventsBySession: `
    SELECT * FROM events
    WHERE session_id = ? AND ts < ?
    ORDER BY ts DESC, id DESC
    LIMIT ?`,
  listEventsBySessionOfKind: `
    SELECT * FROM events
    WHERE session_id = ? AND kind = ? AND ts < ?
    ORDER BY ts DESC, id DESC
    LIMIT ?`,
  listEventsBySubject: `
    SELECT * FROM events
    WHERE subject_id = ? AND ts < ?
    ORDER BY ts DESC, id DESC
    LIMIT ?`,
  listEventsBySubjectOfKind: `
    SELECT * FROM events
    WHERE subject_id = ? AND kind = ? AND ts < ?
    ORDER BY ts DESC, id DESC
    LIMIT ?`,
  /*
   * Who is in one game client's instance right now, as the log knows it.
   *
   * Joins and leaves **since that session last changed instance**, oldest first, for a caller to
   * fold into a present set. The floor matters more than it looks: without it a session that has
   * been through six worlds this evening returns every name it ever saw, and folding those gives a
   * roster of people who left hours ago.
   *
   * `COALESCE(..., 0)` covers the session that has not logged an instance change at all — a client
   * that started in a world and stayed there — where every join it has is still current.
   */
  listSessionPresence: `
    SELECT kind, ts, payload FROM events
    WHERE session_id = ?
      AND kind IN ('gamelog.player_join', 'gamelog.player_leave')
      AND ts >= COALESCE(
        (SELECT MAX(ts) FROM events
         WHERE session_id = ? AND kind IN ('gamelog.location_join', 'gamelog.left_room')),
        0)
    ORDER BY ts ASC, id ASC`,
  countEventsByKind: `SELECT kind, COUNT(*) AS count FROM events GROUP BY kind ORDER BY count DESC`,
  distinctEventKinds: `SELECT DISTINCT kind FROM events`,

  // -- log offsets ----------------------------------------------------------
  getLogOffset: `SELECT * FROM log_offsets WHERE log_key = ?`,
  putLogOffset: `
    INSERT INTO log_offsets (log_key, log_path, byte_offset, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(log_key) DO UPDATE SET
      log_path    = excluded.log_path,
      -- Never moves backwards. Two watchers over one file, or a stale write racing a fresh one,
      -- would otherwise rewind the offset and replay everything between — the exact failure this
      -- table exists to prevent.
      byte_offset = MAX(log_offsets.byte_offset, excluded.byte_offset),
      updated_at  = excluded.updated_at`,
  deleteLogOffset: `DELETE FROM log_offsets WHERE log_key = ?`,

  // -- friend log -----------------------------------------------------------
  upsertFriend: `
    INSERT INTO friend_log
      (account_id, user_id, display_name, trust_level, friended_at, unfriended_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, user_id) DO UPDATE SET
      display_name  = excluded.display_name,
      trust_level   = excluded.trust_level,
      unfriended_at = excluded.unfriended_at`,
  listFriends: `
    SELECT * FROM friend_log
    WHERE account_id = ? AND unfriended_at IS NULL
    ORDER BY display_name COLLATE NOCASE ASC`,
  getFriend: `SELECT * FROM friend_log WHERE account_id = ? AND user_id = ?`,
  insertFriendHistory: `
    INSERT INTO friend_log_history
      (account_id, ts, type, user_id, display_name, previous_display_name,
       trust_level, previous_trust_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  listFriendHistory: `
    SELECT * FROM friend_log_history
    WHERE account_id = ? AND ts < ?
    ORDER BY ts DESC, id DESC
    LIMIT ?`,

  // -- caches ---------------------------------------------------------------
  /*
   * `user_cache` is keyed `(account_id, user_id)`, not `user_id` — `GET /users/{id}` answers
   * differently depending on whether the caller is a friend of the subject, so one cache row per
   * user would let whichever account fetched last decide what every other account sees. See
   * migration 002 and PLAN.md §1.3. World and avatar records carry no such per-viewer variation,
   * so those two caches stay keyed on the object id alone.
   */
  putUserCache: `
    INSERT INTO user_cache (account_id, user_id, fetched_at, data) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, user_id) DO UPDATE SET
      fetched_at = excluded.fetched_at, data = excluded.data`,
  getUserCache: `
    SELECT user_id AS id, fetched_at, data FROM user_cache
    WHERE account_id = ? AND user_id = ?`,
  /*
   * Dropped rather than patched, for the one case where vrc.zip itself moved a field VRChat owns.
   * Selecting an avatar changes `currentAvatarImageUrl` on the acting account's own record, and a
   * cached row would keep serving the old picture until its TTL ran out. Deleting is correct
   * whatever the body looked like; editing JSON in place to match what we think VRChat now says
   * would be this app inventing an answer.
   */
  deleteUserCache: `DELETE FROM user_cache WHERE account_id = ? AND user_id = ?`,
  putWorldCache: `
    INSERT INTO world_cache (world_id, fetched_at, data) VALUES (?, ?, ?)
    ON CONFLICT(world_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`,
  getWorldCache: `SELECT world_id AS id, fetched_at, data FROM world_cache WHERE world_id = ?`,
  putAvatarCache: `
    INSERT INTO avatar_cache (avatar_id, fetched_at, data) VALUES (?, ?, ?)
    ON CONFLICT(avatar_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`,
  getAvatarCache: `SELECT avatar_id AS id, fetched_at, data FROM avatar_cache WHERE avatar_id = ?`,
  // `avatar_id` may legitimately be NULL — see migration 009.
  putAvatarFileId: `
    INSERT INTO avatar_file_ids (file_id, avatar_id, resolved_at) VALUES (?, ?, ?)
    ON CONFLICT(file_id) DO UPDATE SET
      avatar_id = excluded.avatar_id, resolved_at = excluded.resolved_at`,
  getAvatarFileId: `
    SELECT file_id, avatar_id, resolved_at FROM avatar_file_ids WHERE file_id = ?`,

  // -- notes ----------------------------------------------------------------
  putNote: `
    INSERT INTO notes (account_id, user_id, note, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, user_id) DO UPDATE SET
      note = excluded.note, updated_at = excluded.updated_at`,
  getNote: `SELECT * FROM notes WHERE account_id = ? AND user_id = ?`,
  deleteNote: `DELETE FROM notes WHERE account_id = ? AND user_id = ?`,

  // -- notifications --------------------------------------------------------
  putNotification: `
    INSERT INTO notifications
      (id, account_id, ts, type, sender_user_id, sender_display_name, message, seen, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      seen = excluded.seen, message = excluded.message, data = excluded.data`,
  listNotifications: `
    SELECT * FROM notifications WHERE account_id = ? ORDER BY ts DESC LIMIT ?`,
  markNotificationSeen: `UPDATE notifications SET seen = 1 WHERE id = ?`,
  countNotificationsByType: `
    SELECT type, COUNT(*) AS count FROM notifications GROUP BY type ORDER BY count DESC`,

  // -- avatar history -------------------------------------------------------
  recordAvatarSeen: `
    INSERT INTO avatar_history (account_id, avatar_id, first_seen, last_seen, seen_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(account_id, avatar_id) DO UPDATE SET
      last_seen  = MAX(avatar_history.last_seen, excluded.last_seen),
      first_seen = MIN(avatar_history.first_seen, excluded.first_seen),
      seen_count = avatar_history.seen_count + 1`,
  listAvatarHistory: `
    SELECT * FROM avatar_history WHERE account_id = ? ORDER BY last_seen DESC LIMIT ?`,

  // -- rollup ---------------------------------------------------------------
  /**
   * Folds every `events` row of one kind older than the cutoff into `events_daily`, bucketed by
   * UTC day. `total_ms` sums `payload.duration_ms` where the payload is valid JSON carrying one.
   * Bindings: (kind, cutoffMs).
   */
  rollupExpiring: `
    INSERT INTO events_daily (account_id, day, kind, subject_id, count, total_ms)
    SELECT
      COALESCE(account_id, '') AS account_id,
      (ts / 86400000) * 86400000 AS day,
      kind,
      COALESCE(subject_id, '') AS subject,
      COUNT(*),
      COALESCE(SUM(
        CASE WHEN payload IS NOT NULL AND json_valid(payload)
             THEN CAST(COALESCE(json_extract(payload, '$.duration_ms'), 0) AS INTEGER)
             ELSE 0 END
      ), 0)
    FROM events
    WHERE kind = ? AND ts < ?
    GROUP BY COALESCE(account_id, ''), day, kind, subject
    ON CONFLICT(account_id, day, kind, subject_id) DO UPDATE SET
      count    = events_daily.count + excluded.count,
      total_ms = events_daily.total_ms + excluded.total_ms`,
  deleteExpiring: `DELETE FROM events WHERE kind = ? AND ts < ?`,
  countExpiring: `SELECT COUNT(*) AS count FROM events WHERE kind = ? AND ts < ?`,
  listEventsDaily: `
    SELECT * FROM events_daily
    WHERE account_id = ? AND day >= ? AND day <= ?
    ORDER BY day DESC, kind ASC`,

  // -- retention config -----------------------------------------------------
  listRetentionConfig: `SELECT * FROM retention_config ORDER BY kind ASC`,
  setRetentionConfig: `
    INSERT INTO retention_config (kind, retain_days, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(kind) DO UPDATE SET
      retain_days = excluded.retain_days, updated_at = excluded.updated_at`,
  deleteRetentionConfig: `DELETE FROM retention_config WHERE kind = ?`,

  // -- proxy grants (Phase 2) -----------------------------------------------
  insertGrant: `
    INSERT INTO grants
      (id, account_id, app_name, app_version, app_contact, scopes,
       token_hash, two_factor_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  /*
   * The hot path: one lookup per proxied request. Revoked grants are excluded *in SQL* rather than
   * checked afterwards, so a caller that forgets the check cannot accidentally honour a revoked
   * token — the row simply is not there.
   */
  getGrantByTokenHash: `SELECT * FROM grants WHERE token_hash = ? AND revoked_at IS NULL`,
  getGrantByTwoFactorHash: `
    SELECT * FROM grants WHERE two_factor_hash = ? AND revoked_at IS NULL`,
  getGrant: `SELECT * FROM grants WHERE id = ?`,
  /*
   * Escalation looks for an existing grant for the same app and account. Matched on the identity
   * triple rather than the raw UA string: a version bump must not silently orphan a grant and
   * raise a fresh consent sheet, and the contact is what distinguishes two apps that picked the
   * same name.
   */
  findGrantForApp: `
    SELECT * FROM grants
    WHERE account_id = ? AND app_name = ? AND app_contact = ? AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1`,
  listGrants: `SELECT * FROM grants ORDER BY created_at DESC`,
  listGrantsForAccount: `
    SELECT * FROM grants WHERE account_id = ? ORDER BY created_at DESC`,
  touchGrant: `UPDATE grants SET last_used_at = ? WHERE id = ?`,
  setGrantTwoFactorHash: `UPDATE grants SET two_factor_hash = ? WHERE id = ?`,
  revokeGrant: `UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
  revokeGrantsForAccount: `
    UPDATE grants SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`,
  revokeAllGrants: `UPDATE grants SET revoked_at = ? WHERE revoked_at IS NULL`,

  insertPairingRequest: `
    INSERT INTO pairing_requests
      (id, account_id, requested_username, app_name, app_version, app_contact, scopes,
       half_token_hash, code_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  getPairingRequest: `SELECT * FROM pairing_requests WHERE id = ?`,
  getPairingByHalfToken: `
    SELECT * FROM pairing_requests
    WHERE half_token_hash = ? AND resolved_at IS NULL AND expires_at > ?`,
  listPendingPairings: `
    SELECT * FROM pairing_requests
    WHERE resolved_at IS NULL AND expires_at > ?
    ORDER BY created_at ASC`,
  countPairingAttemptsSince: `
    SELECT COALESCE(SUM(attempts), 0) AS count FROM pairing_requests
    WHERE app_name = ? AND app_contact = ? AND created_at > ?`,
  bumpPairingAttempts: `UPDATE pairing_requests SET attempts = attempts + 1 WHERE id = ?`,
  setPairingAccount: `UPDATE pairing_requests SET account_id = ? WHERE id = ?`,
  resolvePairing: `
    UPDATE pairing_requests SET resolved_at = ?, outcome = ?, grant_id = ?
    WHERE id = ? AND resolved_at IS NULL`,
  /*
   * Housekeeping for codes nobody ever typed. Marked expired rather than deleted, so a user who
   * comes back to the UI sees what an app asked for and when, instead of an empty list.
   */
  expirePairings: `
    UPDATE pairing_requests SET resolved_at = ?, outcome = 'expired'
    WHERE resolved_at IS NULL AND expires_at <= ?`,

  insertAudit: `
    INSERT INTO audit_log
      (ts, grant_id, account_id, app_name, method, path, operation_id, scope, outcome, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  listAudit: `SELECT * FROM audit_log WHERE ts < ? ORDER BY ts DESC LIMIT ?`,
  listAuditForGrant: `
    SELECT * FROM audit_log WHERE grant_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?`,
  /*
   * What one grant has spent against one scope inside a window. The per-grant budget is measured
   * with this rather than with a counter in memory, so it survives a restart — see
   * `PassthroughGrantStore.countGrantScopeUsage`.
   *
   * `outcome = 'allowed'` is the whole correctness of it: a call refused for want of a scope, or
   * refused by this budget itself, never reached VRChat and nobody saw it. Counting refusals would
   * let an app exhaust its own allowance by being denied, and would make the budget permanent once
   * it first tripped.
   */
  finishAudit: `UPDATE audit_log SET status = ? WHERE id = ?`,
  countGrantScopeUsage: `
    SELECT COUNT(*) AS n FROM audit_log
    WHERE grant_id = ? AND scope = ? AND outcome = 'allowed' AND ts >= ?`,

  /*
   * Per-grant overrides for the risky-scope allowances — migration 004.
   *
   * A row means "this app's allowance for this scope is this number"; no row means the build's
   * default. The upsert is what makes the Connected apps page idempotent: the screen sends the
   * number it wants, not a decision about whether it is creating or editing.
   */
  setGrantBudget: `
    INSERT INTO grant_budgets (grant_id, scope, hourly_limit, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(grant_id, scope) DO UPDATE SET
      hourly_limit = excluded.hourly_limit,
      updated_at   = excluded.updated_at`,
  deleteGrantBudget: `DELETE FROM grant_budgets WHERE grant_id = ? AND scope = ?`,
  getGrantBudget: `SELECT * FROM grant_budgets WHERE grant_id = ? AND scope = ?`,
  listGrantBudgets: `SELECT * FROM grant_budgets WHERE grant_id = ? ORDER BY scope`,

  // -- webhooks (Phase 2) ----------------------------------------------------
  insertWebhook: `
    INSERT INTO webhooks (id, grant_id, url, secret_hash, kinds, account_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  getWebhook: `SELECT * FROM webhooks WHERE id = ?`,
  listWebhooks: `SELECT * FROM webhooks ORDER BY created_at DESC`,
  listWebhooksForGrant: `SELECT * FROM webhooks WHERE grant_id = ? ORDER BY created_at DESC`,
  /*
   * The dispatch set. Read once and cached in memory by the manager rather than queried per event —
   * the bus bursts forty player-join events on an instance transition, and a table scan per event is
   * not a cost the spine should pay for a feature most users have zero of.
   */
  listLiveWebhooks: `SELECT * FROM webhooks WHERE disabled_at IS NULL ORDER BY created_at ASC`,
  /*
   * Deleted, not tombstoned — the opposite call from `grants`, and deliberately so. A revoked grant
   * is evidence about access that already happened; a removed webhook is a subscription the user
   * cancelled, and leaving it in the list forever would make "remove" look broken. The cascade takes
   * its queued deliveries with it, which is the point: nothing should still be trying to reach an
   * endpoint the user just deleted.
   */
  deleteWebhook: `DELETE FROM webhooks WHERE id = ?`,
  disableWebhook: `
    UPDATE webhooks SET disabled_at = ?, disabled_reason = ?
    WHERE id = ? AND disabled_at IS NULL`,
  /*
   * A delivered send. `consecutive_dead` is zeroed rather than decremented: the counter answers "is
   * this endpoint currently broken", and one success is a complete answer to that question.
   */
  recordWebhookDelivered: `
    UPDATE webhooks SET
      consecutive_dead = 0,
      delivered_count  = delivered_count + 1,
      last_delivery_at = ?,
      last_status      = ?,
      last_error       = NULL
    WHERE id = ?`,
  /* A delivery that ran out of attempts. Failed *attempts* are not counted here — see the schema. */
  recordWebhookDead: `
    UPDATE webhooks SET
      consecutive_dead = consecutive_dead + 1,
      dead_count       = dead_count + 1,
      last_delivery_at = ?,
      last_status      = ?,
      last_error       = ?
    WHERE id = ?`,

  insertWebhookDelivery: `
    INSERT INTO webhook_deliveries
      (id, webhook_id, event_id, event_kind, payload, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  /*
   * The due scan, and the whole ordering guarantee lives in this one statement.
   *
   * The correlated subquery restricts the result to each webhook's *head of line* — its oldest
   * pending row — so a webhook can never have two deliveries in flight and can never deliver event
   * two while event one is still backing off. Enforcing that in SQL rather than in the scanner
   * means a second scanner, or a scan that overlaps the previous one, cannot break it either.
   *
   * Different webhooks are untouched by this: each contributes its own head, so one dead endpoint
   * backing off for five minutes costs the others nothing.
   */
  listDueWebhookDeliveries: `
    SELECT d.* FROM webhook_deliveries d
    WHERE d.delivered_at IS NULL AND d.dead_at IS NULL AND d.next_attempt_at <= ?
      AND d.rowid = (
        SELECT h.rowid FROM webhook_deliveries h
        WHERE h.webhook_id = d.webhook_id AND h.delivered_at IS NULL AND h.dead_at IS NULL
        ORDER BY h.rowid ASC LIMIT 1
      )
    ORDER BY d.next_attempt_at ASC, d.rowid ASC
    LIMIT ?`,
  getWebhookDelivery: `SELECT * FROM webhook_deliveries WHERE id = ?`,
  listWebhookDeliveries: `
    SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY rowid DESC LIMIT ?`,
  /* A failed attempt that will be tried again. The row stays pending; only its due time moves. */
  rescheduleWebhookDelivery: `
    UPDATE webhook_deliveries SET
      attempts = attempts + 1, next_attempt_at = ?, last_status = ?, last_error = ?
    WHERE id = ? AND delivered_at IS NULL AND dead_at IS NULL`,
  /*
   * Both terminal transitions guard on the row still being pending. Without that, a delivery raced
   * by two scanners could be counted twice against the webhook's health — and `consecutive_dead`
   * drives auto-disable, so double-counting is not a cosmetic error.
   */
  markWebhookDelivered: `
    UPDATE webhook_deliveries SET
      attempts = attempts + 1, delivered_at = ?, last_status = ?, last_error = NULL
    WHERE id = ? AND delivered_at IS NULL AND dead_at IS NULL`,
  markWebhookDeliveryDead: `
    UPDATE webhook_deliveries SET
      attempts = attempts + 1, dead_at = ?, last_status = ?, last_error = ?
    WHERE id = ? AND delivered_at IS NULL AND dead_at IS NULL`,

  /* --- webhook delivery retention (see `store/retention.ts`) ---------------
   *
   * `COALESCE(delivered_at, dead_at)` is the row's *settle* time, and the predicate keys on it
   * rather than on `created_at` for one reason: a delivery that spent ten minutes backing off before
   * it finally landed is exactly the row someone wants to look at, and dating it from when the event
   * happened would age it out earlier than the successes around it.
   *
   * A row where both columns are null is pending — mid-backoff, or waiting on the next scan — and
   * `IS NOT NULL` is what keeps it out of the delete. That is not a nicety: the queue is a table
   * precisely so a promise the daemon made survives a restart, and a prune that could reach a
   * pending row would quietly undo the whole reason for it.
   */
  /*
   * Deliveries still owed to one webhook: neither delivered nor dead, whether it is waiting on the
   * next scan or sitting out a backoff. It is the number that tells a user "your endpoint is down
   * and vrc.zip is still trying", which is different from `dead_count`, where it has given up.
   */
  countPendingWebhookDeliveries: `
    SELECT COUNT(*) AS n FROM webhook_deliveries
    WHERE webhook_id = ? AND delivered_at IS NULL AND dead_at IS NULL`,
  countSettledWebhookDeliveries: `
    SELECT COUNT(*) AS count FROM webhook_deliveries
    WHERE COALESCE(delivered_at, dead_at) IS NOT NULL
      AND COALESCE(delivered_at, dead_at) < ?`,
  deleteSettledWebhookDeliveries: `
    DELETE FROM webhook_deliveries
    WHERE COALESCE(delivered_at, dead_at) IS NOT NULL
      AND COALESCE(delivered_at, dead_at) < ?`,

  // -- meta / housekeeping --------------------------------------------------
  getMeta: `SELECT value FROM meta WHERE key = ?`,
  setMeta: `
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`,

  // -- plugins (Phase 3) ------------------------------------------------------
  insertPlugin: `
    INSERT INTO plugins
      (id, version, manifest, bundle_hash, source_kind, source_ref, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      version       = excluded.version,
      manifest      = excluded.manifest,
      bundle_hash   = excluded.bundle_hash,
      source_kind   = excluded.source_kind,
      source_ref    = excluded.source_ref,
      updated_at    = excluded.updated_at`,
  getPlugin: `SELECT * FROM plugins WHERE id = ?`,
  listPlugins: `SELECT * FROM plugins ORDER BY installed_at DESC`,
  deletePlugin: `DELETE FROM plugins WHERE id = ?`,
  /*
   * Disable and enable are separate statements rather than one with a nullable parameter, because
   * they are the two halves of the promise that disable always succeeds: the disable path touches
   * one row with no reads and no joins, which is as close to "cannot fail" as SQL gets.
   */
  disablePlugin: `
    UPDATE plugins SET disabled_at = ?, disabled_by = ?, disabled_reason = ? WHERE id = ?`,
  enablePlugin: `
    UPDATE plugins SET disabled_at = NULL, disabled_by = NULL, disabled_reason = NULL WHERE id = ?`,

  insertPluginGrant: `
    INSERT INTO plugin_grants
      (plugin_id, version, grant_hash, scopes, account_ids, capabilities, domains, events,
       granted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plugin_id, version, grant_hash) DO NOTHING`,
  /*
   * The consent lookup, and the whole point of the composite key. A version bump or a widened
   * permission set produces a hash that has never been approved, so this finds nothing and the
   * sheet is unavoidable. `revoked_at IS NULL` is in the WHERE rather than checked in code, so
   * something that forgets to check cannot honour a revoked grant.
   */
  findPluginGrant: `
    SELECT * FROM plugin_grants
    WHERE plugin_id = ? AND version = ? AND grant_hash = ? AND revoked_at IS NULL`,
  listPluginGrants: `SELECT * FROM plugin_grants WHERE plugin_id = ? ORDER BY granted_at DESC`,
  revokePluginGrants: `
    UPDATE plugin_grants SET revoked_at = ? WHERE plugin_id = ? AND revoked_at IS NULL`,

  liftPluginDryRun: `
    INSERT INTO plugin_dry_run_lifted (plugin_id, scope, lifted_at) VALUES (?, ?, ?)
    ON CONFLICT(plugin_id, scope) DO NOTHING`,
  restorePluginDryRun: `DELETE FROM plugin_dry_run_lifted WHERE plugin_id = ? AND scope = ?`,
  listPluginDryRunLifted: `SELECT scope FROM plugin_dry_run_lifted WHERE plugin_id = ?`,

  insertPluginCrash: `
    INSERT INTO plugin_crashes (plugin_id, ts, reason, detail, code, signal)
    VALUES (?, ?, ?, ?, ?, ?)`,
  /* The breaker's window. Counted rather than listed: the decision needs a number, not the rows. */
  countPluginCrashesSince: `
    SELECT COUNT(*) AS n FROM plugin_crashes WHERE plugin_id = ? AND ts >= ?`,
  listPluginCrashes: `
    SELECT * FROM plugin_crashes WHERE plugin_id = ? ORDER BY ts DESC LIMIT ?`,

  // -- graphs (Phase 4) -------------------------------------------------------
  insertGraph: `
    INSERT INTO graphs
      (id, name, description, enabled, armed, concurrency, account_id, definition,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  /*
   * The editor's save. It deliberately cannot touch `enabled`, `armed` or `disabled_reason`: those
   * three are gestures the user makes elsewhere, and a save that could flip them would mean a
   * canvas PUT could arm a graph's outbound actions without anybody holding a button.
   */
  updateGraph: `
    UPDATE graphs
    SET name = ?, description = ?, concurrency = ?, account_id = ?, definition = ?, updated_at = ?
    WHERE id = ?`,
  getGraph: `SELECT * FROM graphs WHERE id = ?`,
  listGraphs: `SELECT * FROM graphs ORDER BY updated_at DESC`,
  /* The runtime's boot query: what should have its triggers armed. */
  listEnabledGraphs: `SELECT * FROM graphs WHERE enabled = 1 ORDER BY updated_at DESC`,
  deleteGraph: `DELETE FROM graphs WHERE id = ?`,
  /*
   * Enable and disable are one statement with a nullable reason, unlike the plugin pair above: the
   * reason is the *point* here rather than an aside. The daemon disables a graph when it hits a
   * ceiling, and a row switched off with no sentence attached is the case the user cannot act on.
   */
  setGraphEnabled: `
    UPDATE graphs SET enabled = ?, disabled_reason = ?, updated_at = ? WHERE id = ?`,
  setGraphArmed: `UPDATE graphs SET armed = ?, updated_at = ? WHERE id = ?`,

  insertGraphRun: `
    INSERT INTO graph_runs
      (id, graph_id, trigger_node, status, dry_run, wait_node, resume_at, state,
       started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  getGraphRun: `SELECT * FROM graph_runs WHERE id = ?`,
  listGraphRuns: `
    SELECT * FROM graph_runs WHERE graph_id = ? ORDER BY started_at DESC LIMIT ?`,
  listGraphRunsByStatus: `
    SELECT * FROM graph_runs WHERE status = ? ORDER BY started_at LIMIT ?`,
  /*
   * Stamps a graph with the moment a run of it started, for the list on the Graphs screen.
   *
   * `MAX` rather than a plain assignment, because a queued run starts later than the one it is
   * queued behind and the engine may stamp them in either order; the column is "the most recent
   * start", not "the last one written".
   *
   * This used to be a grouped `MAX(started_at)` over `graph_runs` and could not work: that table is
   * pruned the moment a run finishes, so the scan only ever saw runs still in flight and the list
   * said "never run" about a graph that had just run. See migration 015.
   */
  stampGraphRun: `
    UPDATE graphs SET last_run_at = MAX(COALESCE(last_run_at, 0), ?) WHERE id = ?`,
  /*
   * The concurrency check, and a `waiting` run counts. A run parked on a `wait` has not finished —
   * treating it as a free slot is how a graph that waits five minutes ends up with fifty live runs
   * of itself, which is precisely the shape the ceilings exist to prevent.
   */
  countLiveGraphRuns: `
    SELECT COUNT(*) AS n FROM graph_runs
    WHERE graph_id = ? AND status IN ('queued', 'running', 'waiting')`,
  countGraphRunsByStatus: `
    SELECT COUNT(*) AS n FROM graph_runs WHERE graph_id = ? AND status = ?`,
  nextQueuedGraphRun: `
    SELECT * FROM graph_runs
    WHERE graph_id = ? AND status = 'queued' ORDER BY started_at LIMIT 1`,
  updateGraphRunState: `
    UPDATE graph_runs
    SET status = ?, state = ?, wait_node = NULL, resume_at = NULL, updated_at = ?
    WHERE id = ?`,
  /* Parking is its own statement because it is the only one that may set the two wait columns. */
  parkGraphRun: `
    UPDATE graph_runs
    SET status = 'waiting', wait_node = ?, resume_at = ?, state = ?, updated_at = ?
    WHERE id = ?`,
  /* Uses ix_graph_runs_resume. Asked on a timer and once at boot; the boot sweep passes now. */
  listDueGraphRuns: `
    SELECT * FROM graph_runs
    WHERE status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= ?
    ORDER BY resume_at LIMIT ?`,
  deleteGraphRun: `DELETE FROM graph_runs WHERE id = ?`,

  /*
   * The memory a cooldown or a counter node keeps. One value per (graph, node, key); the node that
   * wrote it is the only thing that reads it, so nothing here interprets `value`.
   */
  getGraphState: `SELECT value, updated_at FROM graph_state WHERE graph_id = ? AND node_id = ? AND key = ?`,
  putGraphState: `
    INSERT INTO graph_state (graph_id, node_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(graph_id, node_id, key) DO UPDATE SET
      value      = excluded.value,
      updated_at = excluded.updated_at`,
  clearGraphNodeState: `DELETE FROM graph_state WHERE graph_id = ? AND node_id = ?`,
  /**
   * What one graph remembers, one row per node — the question the "forget" button in the editor
   * asks. It exists so the button can appear *only* when there is something to forget: a node with
   * no rows has nothing to reset, and offering the gesture anyway teaches people it does nothing.
   */
  listGraphNodeState: `
    SELECT node_id, COUNT(*) AS n, MAX(updated_at) AS updated_at
    FROM graph_state WHERE graph_id = ?
    GROUP BY node_id ORDER BY updated_at DESC`,
  clearGraphState: `DELETE FROM graph_state WHERE graph_id = ?`,

  /*
   * Named stores (migration 014). Shared between graphs on purpose, which is the whole difference
   * from `graph_state` above.
   */
  ensureGraphStore: `
    INSERT INTO graph_stores (name, description, created_at, updated_at) VALUES (?, '', ?, ?)
    ON CONFLICT(name) DO NOTHING`,
  listGraphStores: `
    SELECT s.name, s.description, s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM graph_kv WHERE store = s.name) AS entries
    FROM graph_stores s ORDER BY s.name`,
  deleteGraphStore: `DELETE FROM graph_stores WHERE name = ?`,

  getGraphKv: `
    SELECT value, updated_at FROM graph_kv WHERE store = ? AND collection = ? AND key = ?`,
  putGraphKv: `
    INSERT INTO graph_kv (store, collection, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(store, collection, key) DO UPDATE SET
      value      = excluded.value,
      updated_at = excluded.updated_at`,
  deleteGraphKv: `DELETE FROM graph_kv WHERE store = ? AND collection = ? AND key = ?`,
  /** Every entry of one collection, oldest first — insertion order is what a set browser wants. */
  listGraphKv: `
    SELECT key, value, updated_at FROM graph_kv
    WHERE store = ? AND collection = ? ORDER BY updated_at, key`,
  countGraphKv: `SELECT COUNT(*) AS n FROM graph_kv WHERE store = ? AND collection = ?`,
  clearGraphKvCollection: `DELETE FROM graph_kv WHERE store = ? AND collection = ?`,
  /** The Stores panel: everything in one store, whatever collection it belongs to. */
  browseGraphStore: `
    SELECT collection, key, value, updated_at FROM graph_kv
    WHERE store = ? ORDER BY updated_at DESC LIMIT ?`,
} as const;

// ---------------------------------------------------------------------------
// The filtered feed page
// ---------------------------------------------------------------------------

/** What a caller can narrow a feed page by, beyond the four fixed selectors above. */
export interface EventPageFilter {
  /** Mutually exclusive; the route enforces that. */
  readonly accountId?: string | undefined;
  readonly sessionId?: number | undefined;
  readonly subjectId?: string | undefined;
  /** Exact kinds. Empty or absent means every kind. */
  readonly kinds?: readonly string[] | undefined;
  /** Dotted families (`gamelog`) — matched as a `kind` prefix, so a kind this build has never
   *  heard of still lands in the right family rather than vanishing. */
  readonly families?: readonly string[] | undefined;
  /** Case-insensitive substring over the subject, location, kind and raw payload. */
  readonly search?: string | undefined;
  readonly before: number;
  readonly limit: number;
}

/** A built statement: SQL text plus its positional bindings, in order. */
export interface BuiltQuery {
  readonly sql: string;
  readonly params: (string | number)[];
}

/** LIKE metacharacters, escaped against `\` so a search for `100%` is not a wildcard. */
function likeTerm(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Builds one feed page for a filter the eight fixed statements above cannot express.
 *
 * This is the *only* assembled SQL in this file, and the split is deliberate rather than an
 * inconsistency. The eight written-out statements stay the hot path — every unfiltered page the
 * feed and the game log fetch goes through one of them, and they can be read and their index use
 * reasoned about without running anything. A multi-kind filter or a text search cannot be one of
 * a fixed set of strings: the predicate depends on how many kinds the caller ticked. Assembling
 * *that* case here, from a closed set of clauses with every value bound rather than interpolated,
 * beats either writing out a combinatorial wall of statements or making the caller post-filter a
 * page — which returns short pages and then an empty one, and reads as "history stops here".
 *
 * `bun:sqlite` caches prepared statements by SQL text, so the handful of shapes this produces are
 * each prepared once.
 *
 * The search is a `LIKE` over the payload text and therefore a scan; `ts DESC` plus `LIMIT` keeps
 * it bounded to the newest rows the caller actually asked for rather than the whole table.
 */
export function buildEventPage(filter: EventPageFilter): BuiltQuery {
  const where: string[] = ["ts < ?"];
  const params: (string | number)[] = [filter.before];

  if (filter.accountId !== undefined) {
    where.push("account_id = ?");
    params.push(filter.accountId);
  } else if (filter.sessionId !== undefined) {
    where.push("session_id = ?");
    params.push(filter.sessionId);
  } else if (filter.subjectId !== undefined) {
    where.push("subject_id = ?");
    params.push(filter.subjectId);
  }

  /*
   * Kinds and families each narrow, and they narrow *independently* — the two clauses are ANDed.
   *
   * The alternative, ORing them into one clause, reads as the more permissive and therefore safer
   * choice and is neither. The game log scopes itself with `families=gamelog` and then offers
   * per-kind checkboxes inside that scope; ORed, ticking "player joined" widens the query back to
   * every game-log kind, and the filter appears to do nothing at all. Within a family the two are
   * an intersection in the ordinary sense: these kinds, out of that family.
   *
   * Each family is its own OR term because a *list* of families is genuinely alternatives.
   */
  const kinds = filter.kinds ?? [];
  if (kinds.length > 0) {
    where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    params.push(...kinds);
  }

  const families = filter.families ?? [];
  if (families.length > 0) {
    where.push(`(${families.map(() => "kind LIKE ? ESCAPE '\\'").join(" OR ")})`);
    for (const family of families) {
      params.push(`${family.replace(/[\\%_]/g, (char) => `\\${char}`)}.%`);
    }
  }

  if (filter.search !== undefined && filter.search !== "") {
    const term = likeTerm(filter.search);
    where.push(
      "(kind LIKE ? ESCAPE '\\' OR subject_id LIKE ? ESCAPE '\\'" +
        " OR location LIKE ? ESCAPE '\\' OR payload LIKE ? ESCAPE '\\')",
    );
    params.push(term, term, term, term);
  }

  params.push(filter.limit);
  return {
    sql: `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`,
    params,
  };
}

/** What the inbox can be narrowed by. Every field narrows; none of them widen. */
export interface NotificationPageFilter {
  readonly accountId?: string | undefined;
  /** VRChat's own `type` strings. Empty or absent means every type. */
  readonly types?: readonly string[] | undefined;
  /** `false` hides what has been read. Absent shows both. */
  readonly seen?: boolean | undefined;
  /** Case-insensitive substring over the sender, message, type and raw payload. */
  readonly search?: string | undefined;
  readonly before: number;
  readonly limit: number;
}

/**
 * One page of the inbox, newest first.
 *
 * Same cursor discipline as {@link buildEventPage}, and for the same reason: this replaced a fan-out
 * that took fifty rows per account and sorted them in JS, which is a fixed window rather than a
 * page — the fifty-first notification on a busy account could not be reached at all.
 *
 * `id` is the tiebreak because notification ids are VRChat's strings rather than an autoincrement,
 * so it orders by value rather than by insertion. That is fine for a tiebreak: it only has to be
 * *stable*, so that paging past a run of equal timestamps neither repeats nor skips a row.
 */
export function buildNotificationPage(filter: NotificationPageFilter): BuiltQuery {
  const where: string[] = ["ts < ?"];
  const params: (string | number)[] = [filter.before];

  if (filter.accountId !== undefined) {
    where.push("account_id = ?");
    params.push(filter.accountId);
  }

  const types = filter.types ?? [];
  if (types.length > 0) {
    where.push(`type IN (${types.map(() => "?").join(", ")})`);
    params.push(...types);
  }

  if (filter.seen !== undefined) {
    where.push("seen = ?");
    params.push(filter.seen ? 1 : 0);
  }

  if (filter.search !== undefined && filter.search !== "") {
    const term = likeTerm(filter.search);
    where.push(
      "(type LIKE ? ESCAPE '\\' OR sender_display_name LIKE ? ESCAPE '\\'" +
        " OR message LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')",
    );
    params.push(term, term, term, term);
  }

  params.push(filter.limit);
  return {
    sql: `SELECT * FROM notifications WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`,
    params,
  };
}
