/**
 * Everything the Live Sessions screen knows that `GET /api/sessions` cannot tell it.
 *
 * `/api/sessions` gives the authoritative list of running game clients, but only their headline:
 * account, start time, VR mode, current location. Who is standing in the instance, and what the
 * world is called, only ever arrive as `gamelog.*` frames on the socket. This class accumulates
 * those frames per client and hands the screen a merged view.
 *
 * The awkward part is identity, and it is worth being explicit about rather than papering over:
 * the socket identifies a client by the log watcher's **string** session id, while `/api/sessions`
 * identifies it by the store's **integer** row id, and the daemon does not currently publish the
 * mapping between them. So the two are correlated on start time — a client's `startedAt` comes
 * from the same log header on both sides, and two VRChat clients cannot start in the same
 * millisecond. When correlation fails the screen still renders the REST row; it just says the
 * player list has not been observed yet instead of inventing an empty one.
 */

import { SvelteMap } from "svelte/reactivity";
import type { GameSession } from "../api.ts";
import type { StreamFrame } from "../stream.ts";

export interface ObservedPlayer {
  readonly displayName: string;
  readonly userId: string | null;
  readonly joinedAt: number;
}

interface LogSession {
  streamId: string;
  accountId: string | null;
  displayName: string | null;
  startedAt: number | null;
  vrMode: string | null;
  location: string | null;
  worldName: string | null;
  players: ObservedPlayer[];
  lastEventAt: number;
  ended: boolean;
}

/** A REST session joined to whatever the socket has observed about it. */
export interface MergedSession {
  readonly session: GameSession;
  readonly worldName: string | null;
  /** Null when no socket frames could be correlated to this client yet. */
  readonly players: readonly ObservedPlayer[] | null;
  readonly lastEventAt: number | null;
}

/** Correlation window for start times, in ms. Log headers are second-resolution on some builds. */
const START_TOLERANCE_MS = 2_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export class LiveSessionsState {
  /** Keyed by the log watcher's string session id. */
  readonly #byStreamId = new SvelteMap<string, LogSession>();

  /** Sessions the socket has seen but that are not (yet) in `/api/sessions`. Diagnostic only. */
  get observedCount(): number {
    return this.#byStreamId.size;
  }

  clear(): void {
    this.#byStreamId.clear();
  }

  #ensure(streamId: string, ts: number): LogSession {
    const existing = this.#byStreamId.get(streamId);
    if (existing !== undefined) {
      existing.lastEventAt = Math.max(existing.lastEventAt, ts);
      return existing;
    }
    const created: LogSession = {
      streamId,
      accountId: null,
      displayName: null,
      startedAt: null,
      vrMode: null,
      location: null,
      worldName: null,
      players: [],
      lastEventAt: ts,
      ended: false,
    };
    this.#byStreamId.set(streamId, created);
    return created;
  }

  /** Feeds one socket frame in. Frames without a session id are ignored. */
  apply(frame: StreamFrame): void {
    const streamId = frame.payload?.sessionId ?? null;
    if (streamId === null) return;

    const data = record(frame.payload?.data);
    const entry = this.#ensure(streamId, frame.ts);
    if (frame.payload?.accountId != null) entry.accountId = frame.payload.accountId;

    switch (frame.type) {
      case "session.start": {
        entry.startedAt = typeof data?.startedAt === "number" ? data.startedAt : frame.ts;
        entry.displayName = str(data, "displayName") ?? entry.displayName;
        entry.vrMode = str(data, "vrMode") ?? entry.vrMode;
        entry.location = str(data, "currentLocation") ?? entry.location;
        entry.accountId = str(data, "accountId") ?? entry.accountId;
        entry.ended = false;
        break;
      }
      case "session.update": {
        entry.displayName = str(data, "displayName") ?? entry.displayName;
        entry.vrMode = str(data, "vrMode") ?? entry.vrMode;
        entry.accountId = str(data, "accountId") ?? entry.accountId;
        if ("currentLocation" in (data ?? {})) {
          entry.location = str(data, "currentLocation");
          // A new instance means a new room. Carrying the old roster over would show ghosts.
          entry.players = [];
        }
        break;
      }
      case "session.end": {
        entry.ended = true;
        break;
      }
      case "gamelog.authenticated": {
        entry.displayName = str(data, "displayName") ?? entry.displayName;
        break;
      }
      case "gamelog.vr_mode": {
        entry.vrMode = str(data, "vrMode") ?? entry.vrMode;
        break;
      }
      case "gamelog.world_enter": {
        entry.worldName = str(data, "worldName") ?? entry.worldName;
        break;
      }
      case "gamelog.location_join": {
        const location = record(data?.location);
        entry.location = str(location, "location") ?? entry.location;
        entry.players = [];
        break;
      }
      case "gamelog.left_room": {
        entry.players = [];
        entry.worldName = null;
        break;
      }
      case "gamelog.player_join": {
        const displayName = str(data, "displayName");
        if (displayName === null) break;
        // The local player joins their own instance too; the log gives no flag for it, so the
        // roster keeps them and the screen marks whichever name matches the session's own.
        if (entry.players.some((player) => player.displayName === displayName)) break;
        entry.players = [
          ...entry.players,
          { displayName, userId: str(data, "userId"), joinedAt: frame.ts },
        ];
        break;
      }
      case "gamelog.player_leave": {
        const displayName = str(data, "displayName");
        if (displayName === null) break;
        entry.players = entry.players.filter((player) => player.displayName !== displayName);
        break;
      }
      default:
        break;
    }
  }

  /** The observed record for a REST session, correlated on start time then display name. */
  #correlate(session: GameSession): LogSession | null {
    let fallback: LogSession | null = null;
    for (const entry of this.#byStreamId.values()) {
      if (entry.ended) continue;
      if (
        entry.startedAt !== null &&
        Math.abs(entry.startedAt - session.startedAt) <= START_TOLERANCE_MS
      ) {
        return entry;
      }
      if (
        fallback === null &&
        session.displayName !== null &&
        entry.displayName === session.displayName
      ) {
        fallback = entry;
      }
    }
    return fallback;
  }

  /**
   * The socket's session id for a REST session, or null when the two could not be correlated.
   * The game log screen needs this to filter live lines by client.
   */
  streamIdFor(session: GameSession): string | null {
    return this.#correlate(session)?.streamId ?? null;
  }

  merge(sessions: readonly GameSession[]): MergedSession[] {
    return sessions.map((session) => {
      const observed = this.#correlate(session);
      if (observed === null) {
        return { session, worldName: null, players: null, lastEventAt: null };
      }
      return {
        session,
        worldName: observed.worldName,
        players: observed.players,
        lastEventAt: observed.lastEventAt,
      };
    });
  }
}

export const liveSessions = new LiveSessionsState();
