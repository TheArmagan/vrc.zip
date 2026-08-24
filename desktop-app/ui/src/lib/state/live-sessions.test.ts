/**
 * Which of the two sources answers "where is this client standing".
 *
 * `/api/sessions` and the event socket carry the same fact, and the Friends screen's "In your
 * world" section is built from it — so the window where they disagree is a window where the screen
 * groups friends under an instance you have already left. These cases pin the precedence that
 * closes it.
 */

import type { JsonValue } from "@vrcz/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { GameSession } from "../api.ts";
import type { StreamFrame } from "../stream.ts";
import { LiveSessionsState } from "./live-sessions.svelte.ts";

const OLD = "wrld_old:1~private(usr_a)";
const NEW = "wrld_new:2~private(usr_a)";

function session(overrides: Partial<GameSession> = {}): GameSession {
  return {
    id: 7,
    accountId: "usr_a",
    displayName: "Me",
    startedAt: 1_000,
    vrMode: "Desktop",
    currentLocation: OLD,
    currentWorldId: "wrld_old",
    ...overrides,
  };
}

function frame(type: string, data: JsonValue, sessionId: number | null = 7): StreamFrame {
  return {
    type,
    ts: 2_000,
    payload: {
      accountId: "usr_a",
      sessionId,
      displayName: "Me",
      subjectId: null,
      location: null,
      data,
    },
  } as StreamFrame;
}

describe("locationFor", () => {
  let live: LiveSessionsState;

  beforeEach(() => {
    live = new LiveSessionsState();
  });

  it("falls back to the REST row when the socket has seen nothing", () => {
    expect(live.locationFor(session())).toBe(OLD);
  });

  it("prefers a location the socket has observed over the REST row", () => {
    live.apply(frame("gamelog.location_join", { location: { location: NEW } }));
    expect(live.locationFor(session())).toBe(NEW);
  });

  it("keeps the REST row when the observed entry carries no location", () => {
    // A frame that creates the entry without saying anything about where the client is.
    live.apply(frame("gamelog.vr_mode", { vrMode: "VR" }));
    expect(live.locationFor(session())).toBe(OLD);
  });

  it("puts an ended client nowhere rather than at its last location", () => {
    live.apply(frame("gamelog.location_join", { location: { location: NEW } }));
    live.apply(frame("session.end", {}));
    expect(live.locationFor(session())).toBeNull();
  });

  it("does not read one client's location for another", () => {
    live.apply(frame("gamelog.location_join", { location: { location: NEW } }, 8));
    expect(live.locationFor(session())).toBe(OLD);
    expect(live.locationFor(session({ id: 8, currentLocation: null }))).toBe(NEW);
  });
});
