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
  account_id: string;
  ts: number;
  session_id: number | null;
  kind: string;
  subject_id: string | null;
  location: string | null;
  payload: string | null;
};

export type NewEvent = Omit<EventRow, "id">;

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
