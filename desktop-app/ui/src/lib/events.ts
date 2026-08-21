/**
 * The bridge between a live stream frame and a feed row.
 *
 * `GET /api/events` and `GET /api/stream` describe the same events in two different shapes: the
 * store hands back rows with integer ids, the socket hands back `{ type, ts, payload }`. Screens
 * should not have to care which half of the union they are rendering, so frames are normalised
 * into the row shape here, once.
 */

import type { FeedEvent } from "./api.ts";
import type { StreamFrame } from "./stream.ts";

/**
 * A feed row plus the one thing a stored row cannot carry: the log watcher's string session id.
 * `FeedEvent.sessionId` is the store's integer row id and is null on every persisted row today.
 */
export interface LiveEvent extends FeedEvent {
  /**
   * Deprecated alias kept only so nothing reads a missing field during a refactor; `sessionId` is
   * now populated for live frames too. See `frameToEvent`.
   */
  readonly streamSessionId: string | null;
  /** True for rows that arrived over the socket rather than out of the store. */
  readonly live: boolean;
}

/**
 * Kinds the daemon's feed writer refuses to persist (`daemon/src/wiring/feed-writer.ts`). They are
 * UI state, not history. Showing them live and then losing them on reload reads as a bug, so the
 * feed drops them too and uses them only to trigger refreshes.
 */
export const EPHEMERAL_KINDS: ReadonlySet<string> = new Set([
  "account.state",
  "session.update",
  "pipeline.state",
  // Emitted once per notification backfill so the screen can refetch. It is a signal, not a row.
  "notification.synced",
  // Emitted when a live profile read corrects the presence map — a cache reconciliation, not
  // something that happened to anyone. Its whole job is to send the friends list for a refetch.
  "friend.presence",
]);

/** Synthetic ids for socket-borne rows. Negative and decreasing, so they never collide with rows. */
let nextSyntheticId = -1;

/** The wire carries the session row id as a string; the rest of the app treats it as a number. */
function toSessionId(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

export function frameToEvent(frame: StreamFrame): LiveEvent | null {
  if (frame.type === "ready" || frame.payload === null) return null;
  nextSyntheticId -= 1;
  return {
    id: nextSyntheticId,
    accountId: frame.payload.accountId,
    ts: frame.ts,
    /*
     * The frame's session id **is the store's row id**, so a live line and a stored row identify
     * the same game client the same way. This used to be hardcoded null, which is what forced the
     * game log to treat live and stored lines as two incompatible worlds and to filter to one
     * client by discarding all history. `stream.ts` stringifies the id on the way in; it is a
     * number in the database and a number here.
     */
    sessionId: toSessionId(frame.payload.sessionId),
    kind: frame.type,
    subjectId: frame.payload.subjectId,
    location: frame.payload.location,
    payload: frame.payload.data,
    streamSessionId: frame.payload.sessionId,
    live: true,
  };
}

export function rowToEvent(row: FeedEvent): LiveEvent {
  return { ...row, streamSessionId: null, live: false };
}

/** Newest first, with a stable tiebreak so a re-sort never reshuffles equal timestamps. */
export function byNewest(a: LiveEvent, b: LiveEvent): number {
  return b.ts - a.ts || b.id - a.id;
}

/**
 * Merges stored rows with whatever the socket delivered since. Live rows carry synthetic ids, so
 * de-duplication is by (kind, ts, subject) — the store writes on a 250ms batch timer, which means
 * the same event genuinely can appear on both sides during a refresh.
 */
export function mergeEvents(stored: readonly LiveEvent[], live: readonly LiveEvent[]): LiveEvent[] {
  const seen = new Set(
    stored.map((event) => `${event.kind}|${String(event.ts)}|${event.subjectId ?? ""}`),
  );
  const extra = live.filter(
    (event) => !seen.has(`${event.kind}|${String(event.ts)}|${event.subjectId ?? ""}`),
  );
  return [...extra, ...stored].sort(byNewest);
}
