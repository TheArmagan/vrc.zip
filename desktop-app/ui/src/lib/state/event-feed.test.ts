/**
 * `matchesQuery` is the live half of a filter whose other half runs in SQLite.
 *
 * The two have to agree. A live row the browser keeps and the daemon would not is a row that
 * disappears on the next reload, and a live row the browser drops that the daemon would keep is an
 * event the reader never sees until they refresh. So these tests are written against the *same*
 * four fields the daemon's `LIKE` covers, and the family case in particular mirrors the daemon's
 * prefix match rather than a list of known kinds.
 */

import { describe, expect, it } from "vitest";
import type { LiveEvent } from "../events.ts";
import { matchesQuery } from "./event-feed.svelte.ts";

const T0 = 1_700_000_000_000;

function event(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: 1,
    accountId: "acct_1",
    sessionId: 7,
    ts: T0,
    kind: "gamelog.player_join",
    subjectId: "usr_ada",
    location: null,
    payload: { displayName: "Ada Lovelace" },
    live: true,
    ...overrides,
  };
}

describe("matchesQuery", () => {
  it("passes everything when nothing is asked for", () => {
    expect(matchesQuery(event(), {})).toBe(true);
  });

  it("narrows by account and by game client", () => {
    expect(matchesQuery(event(), { accountId: "acct_2" })).toBe(false);
    expect(matchesQuery(event(), { accountId: "acct_1" })).toBe(true);
    expect(matchesQuery(event(), { sessionId: 8 })).toBe(false);
    expect(matchesQuery(event(), { sessionId: 7 })).toBe(true);
  });

  it("matches a family by prefix, so a kind from a newer daemon still lands in it", () => {
    expect(matchesQuery(event({ kind: "gamelog.invented_later" }), { families: ["gamelog"] })).toBe(
      true,
    );
    expect(matchesQuery(event({ kind: "friend.online" }), { families: ["gamelog"] })).toBe(false);
  });

  it("intersects a kind list with a family scope, matching the daemon", () => {
    /*
     * This is the game log's shape: it scopes itself to `families: ["gamelog"]` and then offers
     * per-kind checkboxes inside that scope. If the two were alternatives, ticking "player joined"
     * would widen the query straight back to every game-log kind — the filter would visibly do
     * nothing, which is exactly the bug this pins.
     */
    const query = { kinds: ["gamelog.player_join"], families: ["gamelog"] };
    expect(matchesQuery(event({ kind: "gamelog.player_join" }), query)).toBe(true);
    expect(matchesQuery(event({ kind: "gamelog.player_leave" }), query)).toBe(false);
    expect(matchesQuery(event({ kind: "friend.online" }), query)).toBe(false);
  });

  it("treats a list of families as alternatives", () => {
    const query = { families: ["gamelog", "friend"] };
    expect(matchesQuery(event({ kind: "gamelog.player_join" }), query)).toBe(true);
    expect(matchesQuery(event({ kind: "friend.online" }), query)).toBe(true);
    expect(matchesQuery(event({ kind: "session.start" }), query)).toBe(false);
  });

  it("searches the payload, case-insensitively", () => {
    expect(matchesQuery(event(), { search: "ada lov" })).toBe(true);
    expect(matchesQuery(event(), { search: "grace" })).toBe(false);
  });

  it("searches the subject and the location too", () => {
    expect(matchesQuery(event(), { search: "usr_ada" })).toBe(true);
    expect(matchesQuery(event({ location: "wrld_pug:42" }), { search: "wrld_pug" })).toBe(true);
  });

  it("ignores a search that is only whitespace", () => {
    expect(matchesQuery(event(), { search: "   " })).toBe(true);
  });

  it("does not throw on an event with no payload", () => {
    // Several kinds carry none. The search then has only the kind, subject and location to go on.
    expect(matchesQuery(event({ payload: null, subjectId: null }), { search: "ada" })).toBe(false);
    expect(matchesQuery(event({ payload: null, subjectId: null }), { search: "gamelog" })).toBe(
      true,
    );
  });
});
