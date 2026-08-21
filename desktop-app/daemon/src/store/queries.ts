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
      log_inode  = excluded.log_inode
    RETURNING id`,
  endSession: `UPDATE sessions SET ended_at = ?, exit_kind = ? WHERE id = ?`,
  updateSessionLocation: `
    UPDATE sessions SET current_location = ?, current_world_id = ? WHERE id = ?`,
  getSession: `SELECT * FROM sessions WHERE id = ?`,
  listOpenSessions: `SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC`,
  listSessions: `SELECT * FROM sessions WHERE account_id = ? ORDER BY started_at DESC LIMIT ?`,

  // -- events ---------------------------------------------------------------
  insertEvent: `
    INSERT INTO events (account_id, ts, session_id, kind, subject_id, location, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  listEvents: `
    SELECT * FROM events
    WHERE account_id = ? AND ts < ?
    ORDER BY ts DESC, id DESC
    LIMIT ?`,
  listEventsBySubject: `
    SELECT * FROM events
    WHERE subject_id = ? AND ts < ?
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
  putUserCache: `
    INSERT INTO user_cache (user_id, fetched_at, data) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`,
  getUserCache: `SELECT user_id AS id, fetched_at, data FROM user_cache WHERE user_id = ?`,
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
      account_id,
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
    GROUP BY account_id, day, kind, subject
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

  // -- meta / housekeeping --------------------------------------------------
  getMeta: `SELECT value FROM meta WHERE key = ?`,
  setMeta: `
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
} as const;
