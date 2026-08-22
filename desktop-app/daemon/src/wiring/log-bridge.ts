import type { GamelogEventKind } from "@vrcz/shared";
import type { EventBus } from "../bus/event-bus.ts";
import type {
  ExitKind,
  LogSink,
  SessionEvent,
  SessionPatch,
  SessionSnapshot,
} from "../game-logs/index.ts";
import type { Store } from "../store/index.ts";

/**
 * Bridges the log watcher to the store and the EventBus.
 *
 * The watcher deliberately knows nothing about persistence — this is where its `LogSink` meets the
 * rest of the daemon. Sessions get rows so the UI can show concurrent game clients; every parsed
 * line becomes a `gamelog.*` bus event carrying its `sessionId`.
 */

/** Parser event kinds → bus kinds. Explicit, for the same reason as the pipeline map. */
const KIND: Record<string, GamelogEventKind> = {
  "world-enter": "gamelog.world_enter",
  "location-join": "gamelog.location_join",
  "player-join": "gamelog.player_join",
  "player-leave": "gamelog.player_leave",
  "portal-spawn": "gamelog.portal_spawn",
  "destination-set": "gamelog.destination_set",
  "left-room": "gamelog.left_room",
  "join-failed": "gamelog.join_failed",
  screenshot: "gamelog.screenshot",
  "app-quit": "gamelog.app_quit",
  "vr-mode": "gamelog.vr_mode",
  authenticated: "gamelog.authenticated",
};

interface EventWithSubject {
  userId?: string | null;
  worldId?: string | null;
}

function subjectOf(event: SessionEvent): string | null {
  const candidate = event as unknown as EventWithSubject;
  return candidate.userId ?? candidate.worldId ?? null;
}

/**
 * Creates the sink. Maps the watcher's string session ids onto the store's integer session rows.
 *
 * The id map is the load-bearing part: the watcher identifies sessions by a string it generates,
 * the store by an autoincrement row id, and `gamelog.*` events need the latter. A missing mapping
 * means an event silently loses its session, so the lookup failing is worth noticing rather than
 * defaulting to null.
 */
export function createLogSink(store: Store, bus: EventBus): LogSink {
  const rowIds = new Map<string, number>();

  function persist(session: SessionSnapshot): void {
    const rowId = store.startSession({
      account_id: session.accountId,
      display_name: session.displayName,
      log_path: session.logPath,
      // The watcher's `logKey` is `dev:ino`, or a path+birthtime fallback on Windows where inodes
      // are not available. The column is an integer, so only a real inode is stored; identity
      // still comes from the watcher's key, not from this column.
      log_inode: null,
      started_at: session.startedAt,
      vr_mode: session.vrMode,
      current_location: session.currentLocation,
      current_world_id: null,
    });
    rowIds.set(session.id, rowId);
  }

  return {
    sessionStart(session) {
      persist(session);
      bus.emit({
        kind: "session.start",
        accountId: session.accountId,
        ts: session.startedAt,
        sessionId: rowIds.get(session.id) ?? null,
        payload: { ...session, id: rowIds.get(session.id) ?? null },
      });
    },

    sessionUpdate(sessionId: string, patch: SessionPatch) {
      const rowId = rowIds.get(sessionId);
      if (rowId === undefined) return;

      if (patch.currentLocation !== undefined) {
        // The world id travels in the same patch. Passing a hardcoded null here left
        // `current_world_id` empty on every session ever recorded, while `current_location`
        // held a perfectly good `wrld_…` — the two disagreeing is what gave it away.
        store.updateSessionLocation(
          rowId,
          patch.currentLocation ?? null,
          patch.currentWorldId ?? null,
        );
      }

      // Retroactive attribution arrives here: the `User Authenticated:` line lands seconds into a
      // log, after events have already been emitted. The watcher re-attributes those events; this
      // writes the row so the UI stops showing the session as unlinked.
      //
      // This write was missing entirely. The comment below it claimed it happened, the bus event
      // carried the right data, and the UI reacted correctly to the stream — but nothing ever
      // reached SQLite, so `GET /api/sessions` served `accountId: null` forever and a reload put
      // the session straight back to "unlinked". Every session row in a months-old database was
      // unattributed for this one reason.
      if (
        patch.accountId !== undefined ||
        patch.displayName !== undefined ||
        patch.vrMode !== undefined
      ) {
        store.updateSessionIdentity(rowId, {
          account_id: patch.accountId ?? null,
          display_name: patch.displayName ?? null,
          vr_mode: patch.vrMode ?? null,
        });
      }

      bus.emit({
        kind: "session.update",
        accountId: patch.accountId ?? null,
        ts: Date.now(),
        sessionId: rowId,
        payload: patch,
      });
    },

    sessionEnd(sessionId: string, endedAt: number, exitKind: ExitKind) {
      const rowId = rowIds.get(sessionId);
      if (rowId !== undefined) {
        store.endSession(rowId, endedAt, exitKind);
        rowIds.delete(sessionId);
      }
      bus.emit({
        kind: "session.end",
        accountId: null,
        ts: endedAt,
        sessionId: rowId ?? null,
        payload: { exitKind },
      });
    },

    event(event: SessionEvent) {
      const kind = KIND[event.kind];
      // An unmapped parser kind is a wiring bug, not a data problem. Dropping it silently would
      // make a new marker look like it simply never fires.
      if (!kind) return;

      bus.emit({
        kind,
        accountId: event.accountId,
        ts: event.at,
        // Translated here, the one place that owns the watcher-id -> row-id mapping. A miss means
        // an event arrived before its session row existed, which is a wiring bug worth seeing as a
        // null rather than papering over.
        sessionId: rowIds.get(event.sessionId) ?? null,
        subjectId: subjectOf(event),
        payload: event,
      });
    },
  };
}
