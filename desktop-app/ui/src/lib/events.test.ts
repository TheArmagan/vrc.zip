/**
 * `collapseRepeats` is the display half of deduplication, and the half that can lose information.
 *
 * The store-level fix (migration 007) stops the daemon *recording* one log line twice. This does
 * something different and riskier: it folds genuinely distinct events into one row because they
 * read the same. Its two safeguards are what the tests below are about — a run must be adjacent,
 * so collapsing can never imply two events were consecutive when something happened between them,
 * and a run must be recent, so two identical events an hour apart stay two rows.
 */

import { describe, expect, it } from "vitest";
import { collapseRepeats, type LiveEvent } from "./events.ts";

const T0 = 1_700_000_000_000;

function event(overrides: Partial<LiveEvent> & { id: number; ts: number }): LiveEvent {
  return {
    accountId: "acct_1",
    sessionId: 1,
    kind: "gamelog.app_quit",
    subjectId: null,
    location: null,
    payload: null,
    live: false,
    ...overrides,
  };
}

describe("collapseRepeats", () => {
  it("folds a run of identical events into one row carrying the count", () => {
    const rows = collapseRepeats([
      event({ id: 6, ts: T0 + 5 }),
      event({ id: 5, ts: T0 + 4 }),
      event({ id: 4, ts: T0 + 3 }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.repeats).toBe(3);
    // The newest of the run is the one shown, and the span it covers is kept.
    expect(rows[0]?.event.id).toBe(6);
    expect(rows[0]?.oldestTs).toBe(T0 + 3);
  });

  it("leaves an ordinary row alone", () => {
    const rows = collapseRepeats([event({ id: 1, ts: T0 })]);
    expect(rows).toEqual([{ event: event({ id: 1, ts: T0 }), repeats: 1, oldestTs: T0 }]);
  });

  it("breaks a run on anything that happened in between", () => {
    // Otherwise the count would claim three consecutive quits when a world change sat in the
    // middle of them, which is a different story about the reader's evening.
    const rows = collapseRepeats([
      event({ id: 3, ts: T0 + 3 }),
      event({ id: 2, ts: T0 + 2, kind: "gamelog.world_enter" }),
      event({ id: 1, ts: T0 + 1 }),
    ]);

    expect(rows.map((row) => row.repeats)).toEqual([1, 1, 1]);
  });

  it("does not fold across the window — two identical events far apart are two things", () => {
    const rows = collapseRepeats(
      [event({ id: 2, ts: T0 + 60_000 }), event({ id: 1, ts: T0 })],
      10_000,
    );

    expect(rows).toHaveLength(2);
  });

  it("bounds the span of one row rather than the gap between two", () => {
    /*
     * The chaining case, and the reason the window is measured against the row's own newest event.
     * Each of these is well inside the window of the one before it, so a pairwise comparison folds
     * all five into a single row claiming forty seconds — and with real data, forty world entries
     * two minutes apart into one row claiming eighty minutes.
     */
    const rows = collapseRepeats(
      [
        event({ id: 5, ts: T0 + 40_000 }),
        event({ id: 4, ts: T0 + 30_000 }),
        event({ id: 3, ts: T0 + 20_000 }),
        event({ id: 2, ts: T0 + 10_000 }),
        event({ id: 1, ts: T0 }),
      ],
      15_000,
    );

    expect(rows.map((row) => row.repeats)).toEqual([2, 2, 1]);
    for (const row of rows) expect(row.event.ts - row.oldestTs).toBeLessThanOrEqual(15_000);
  });

  it("keeps different subjects apart even when everything else matches", () => {
    // Two people leaving in the same second is the case a naive (kind, timestamp) key would
    // silently merge into "one person left, twice".
    const rows = collapseRepeats([
      event({ id: 2, ts: T0, kind: "gamelog.player_leave", subjectId: "usr_a" }),
      event({ id: 1, ts: T0, kind: "gamelog.player_leave", subjectId: "usr_b" }),
    ]);

    expect(rows).toHaveLength(2);
  });

  it("keeps different game clients apart", () => {
    // Two VRChat clients quitting at once is two clients quitting, and the game log's whole point
    // is that a session, not an account, is the unit.
    const rows = collapseRepeats([
      event({ id: 2, ts: T0, sessionId: 1 }),
      event({ id: 1, ts: T0, sessionId: 2 }),
    ]);

    expect(rows).toHaveLength(2);
  });
});
