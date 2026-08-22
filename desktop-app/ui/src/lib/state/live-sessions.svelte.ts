/**
 * Everything the Live Sessions screen knows that `GET /api/sessions` cannot tell it.
 *
 * `/api/sessions` gives the authoritative list of running game clients, but only their headline:
 * account, start time, VR mode, current location. Who is standing in the instance, and what the
 * world is called, only ever arrive as `gamelog.*` frames on the socket. This class accumulates
 * those frames per client and hands the screen a merged view.
 *
 * Identity is simple, though an earlier version of this comment claimed otherwise: it said the
 * socket used the log watcher's string session id while `/api/sessions` used the store's row id,
 * with no published mapping, and correlated the two on start time within a tolerance. In fact
 * `wiring/log-bridge.ts` translates to the **store row id before emitting**, so both sides already
 * name a client the same way and the frame id only needs stringifying. Correlation is now an exact
 * lookup; the heuristic could mismatch two clients started close together, and silently found
 * nothing whenever the start times disagreed at all.
 *
 * When no frames have arrived for a client yet the screen still renders the REST row — it just
 * says the player list has not been observed rather than inventing an empty one.
 */

import { isEventFrame } from "@vrcz/shared";
import { SvelteMap } from "svelte/reactivity";
import type { GameSession } from "../api.ts";
import type { StreamFrame } from "../stream.ts";

export interface ObservedPlayer {
  readonly displayName: string;
  readonly userId: string | null;
  readonly joinedAt: number;
}

interface LogSession {
  /** The store's `sessions` row id, the same identifier `GameSession.id` carries. */
  sessionId: number;
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
  readonly #bySessionId = new SvelteMap<number, LogSession>();

  /** Sessions the socket has seen but that are not (yet) in `/api/sessions`. Diagnostic only. */
  get observedCount(): number {
    return this.#bySessionId.size;
  }

  clear(): void {
    this.#bySessionId.clear();
  }

  #ensure(sessionId: number, ts: number): LogSession {
    const existing = this.#bySessionId.get(sessionId);
    if (existing !== undefined) {
      existing.lastEventAt = Math.max(existing.lastEventAt, ts);
      return existing;
    }
    /*
     * `$state`, and it is load-bearing rather than stylistic.
     *
     * `#bySessionId` being a `SvelteMap` makes *structural* change reactive — a client appearing or
     * going away. It says nothing about the objects inside it. Almost everything this class does is
     * mutate an entry that is already in the map (`entry.players = [...]` on a player join, the
     * world name, the location), and on a plain object those writes are invisible to Svelte: the
     * screen's `$derived(liveSessions.merge(...))` never re-runs, so a live instance's roster is
     * frozen at whatever it held when the session row first appeared. Only a reload or a new
     * session refreshed it.
     */
    const created: LogSession = $state({
      sessionId,
      accountId: null,
      displayName: null,
      startedAt: null,
      vrMode: null,
      location: null,
      worldName: null,
      players: [],
      lastEventAt: ts,
      ended: false,
    });
    this.#bySessionId.set(sessionId, created);
    return created;
  }

  /** Feeds one socket frame in. Frames without a session id are ignored. */
  apply(frame: StreamFrame): void {
    if (!isEventFrame(frame)) return;
    const sessionId = frame.payload.sessionId;
    if (sessionId === null) return;

    const data = record(frame.payload.data);
    const entry = this.#ensure(sessionId, frame.ts);
    if (frame.payload.accountId !== null) entry.accountId = frame.payload.accountId;

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

  /**
   * The observed record for a REST session.
   *
   * A plain lookup now. It used to be `get(String(session.id))`, because the socket's session id
   * was typed `string` in the UI while the store's row id was a number - the same identifier in two
   * shapes, converted at the seam. One type on both sides removed the conversion and the class of
   * bug that goes with it.
   */
  #correlate(session: GameSession): LogSession | null {
    return this.#bySessionId.get(session.id) ?? null;
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
