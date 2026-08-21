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
  getSession: `SELECT * FROM sessions WHERE id = ?`,
  listOpenSessions: `SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC`,
  listSessions: `SELECT * FROM sessions WHERE account_id = ? ORDER BY started_at DESC LIMIT ?`,

  // -- events ---------------------------------------------------------------
  insertEvent: `
    INSERT INTO events (account_id, ts, session_id, kind, subject_id, location, payload)
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
  countEventsByKind: `SELECT kind, COUNT(*) AS count FROM events GROUP BY kind ORDER BY count DESC`,
  distinctEventKinds: `SELECT DISTINCT kind FROM events`,

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
  putWorldCache: `
    INSERT INTO world_cache (world_id, fetched_at, data) VALUES (?, ?, ?)
    ON CONFLICT(world_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`,
  getWorldCache: `SELECT world_id AS id, fetched_at, data FROM world_cache WHERE world_id = ?`,
  putAvatarCache: `
    INSERT INTO avatar_cache (avatar_id, fetched_at, data) VALUES (?, ?, ?)
    ON CONFLICT(avatar_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`,
  getAvatarCache: `SELECT avatar_id AS id, fetched_at, data FROM avatar_cache WHERE avatar_id = ?`,

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

  // -- meta / housekeeping --------------------------------------------------
  getMeta: `SELECT value FROM meta WHERE key = ?`,
  setMeta: `
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
} as const;
