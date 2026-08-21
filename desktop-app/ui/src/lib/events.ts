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
]);

/** Synthetic ids for socket-borne rows. Negative and decreasing, so they never collide with rows. */
let nextSyntheticId = -1;

export function frameToEvent(frame: StreamFrame): LiveEvent | null {
  if (frame.type === "ready" || frame.payload === null) return null;
  nextSyntheticId -= 1;
  return {
    id: nextSyntheticId,
    accountId: frame.payload.accountId,
    ts: frame.ts,
    sessionId: null,
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
