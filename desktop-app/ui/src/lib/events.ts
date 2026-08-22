/**
 * The bridge between a live stream frame and a feed row.
 *
 * `GET /api/events` and `GET /api/stream` describe the same events in two different shapes: the
 * store hands back rows with integer ids, the socket hands back `{ type, ts, payload }`. Screens
 * should not have to care which half of the union they are rendering, so frames are normalised
 * into the row shape here, once.
 */

import { isEventFrame } from "@vrcz/shared";
import type { FeedEvent } from "./api.ts";
import { subjectName } from "./format.ts";
import type { StreamFrame } from "./stream.ts";

/**
 * A feed row, plus whether it arrived live.
 *
 * It used to carry a second `streamSessionId: string` as well, because the socket's session id was
 * typed as a string while the store's was a number. They were always the same identifier; the alias
 * and its conversion are gone, and `sessionId` is populated on live rows and stored rows alike.
 */
export interface LiveEvent extends FeedEvent {
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
  // "the friend-list poll came back". It fires per account on every refresh cycle and no screen
  // has ever rendered it, so on a two-account setup it was several hundred rows a day saying
  // nothing had happened. The daemon stopped persisting it too; migration 007 deletes the
  // backlog. It stays here because a stored database from before that migration still has them.
  "friend.list_refreshed",
]);

/** Synthetic ids for socket-borne rows. Negative and decreasing, so they never collide with rows. */
let nextSyntheticId = -1;

/** The wire carries the session row id as a string; the rest of the app treats it as a number. */
export function frameToEvent(frame: StreamFrame): LiveEvent | null {
  if (!isEventFrame(frame)) return null;
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
    sessionId: frame.payload.sessionId,
    kind: frame.type,
    subjectId: frame.payload.subjectId,
    location: frame.payload.location,
    payload: frame.payload.data,
    live: true,
  };
}

export function rowToEvent(row: FeedEvent): LiveEvent {
  return { ...row, live: false };
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

// ---------------------------------------------------------------------------
// Collapsing repeats
// ---------------------------------------------------------------------------

/** One row as the list renders it: an event, plus how many identical ones it stands for. */
export interface EventGroup {
  /** The newest of the run — the one whose timestamp and payload the row shows. */
  readonly event: LiveEvent;
  /** How many events this row stands for. `1` for an ordinary row. */
  readonly repeats: number;
  /** Timestamp of the oldest event in the run. Equal to `event.ts` when `repeats` is 1. */
  readonly oldestTs: number;
}

/**
 * What makes two rows "the same thing happening again".
 *
 * Not the payload, and deliberately so: a game-log payload carries the watcher's per-run session
 * id, so two records of one line are never byte-identical. What identifies a repeat is what the
 * *reader* would call identical — same kind, same client, same subject, same place.
 */
function repeatKey(event: LiveEvent): string {
  return [
    event.kind,
    event.accountId ?? "",
    event.sessionId ?? "",
    event.subjectId ?? "",
    event.location ?? "",
    subjectName(event.payload) ?? "",
  ].join("|");
}

/** The longest span one collapsed row may cover. */
const DEFAULT_REPEAT_WINDOW_MS = 10 * 60_000;

/**
 * Collapses runs of identical adjacent events into one row carrying a count.
 *
 * The display half of deduplication. The daemon no longer *records* the same log line twice — see
 * migration 007 — but plenty of genuinely distinct events are still identical to read: a friend
 * whose connection flaps produces a dozen real `friend.online` events, and a portal that is
 * re-dropped every few seconds is a dozen real portal spawns. A list that prints each of them in
 * full is a list nobody can scan.
 *
 * Two constraints keep this honest:
 *
 *  - **Adjacent only.** A run is broken by anything that happened in between, so collapsing can
 *    never reorder the timeline or imply two events were consecutive when they were not.
 *  - **Windowed, against the whole run and not against the previous row.** Two identical events an
 *    hour apart are two things that happened, not one thing that happened twice. Comparing each
 *    event against its immediate predecessor looks equivalent and is not: it lets a run *chain*,
 *    so forty world entries two minutes apart fold into a single row covering eighty minutes. The
 *    span a row claims is therefore bounded by construction.
 *
 * Input must be sorted newest-first, which is what `mergeEvents` returns.
 */
export function collapseRepeats(
  events: readonly LiveEvent[],
  windowMs: number = DEFAULT_REPEAT_WINDOW_MS,
): EventGroup[] {
  const out: EventGroup[] = [];
  let key: string | null = null;

  for (const event of events) {
    const eventKey = repeatKey(event);
    const last = out.at(-1);
    if (last !== undefined && key === eventKey && last.event.ts - event.ts <= windowMs) {
      out[out.length - 1] = {
        event: last.event,
        repeats: last.repeats + 1,
        oldestTs: event.ts,
      };
      continue;
    }
    out.push({ event, repeats: 1, oldestTs: event.ts });
    key = eventKey;
  }

  return out;
}
