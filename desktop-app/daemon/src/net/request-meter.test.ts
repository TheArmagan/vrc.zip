import { describe, expect, test } from "bun:test";
import { RequestMeter, WINDOW_SECONDS } from "./request-meter.ts";

/**
 * The clock is driven rather than waited on, which is the only way the ring's interesting cases are
 * reachable at all: a gap wider than the window, a wrap around the end of the buffer, and a series
 * going quiet are each a full window of real time away.
 */

function meterAt(start = 1_700_000_000_000): {
  meter: RequestMeter;
  tick: (seconds: number) => void;
} {
  let now = start;
  const meter = new RequestMeter({ now: () => now });
  return {
    meter,
    tick: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

describe("counting", () => {
  test("charges one request to the total, its account, and its grant at once", () => {
    const { meter, tick } = meterAt();
    meter.record({ accountId: "usr_a", grantId: "g1" });
    meter.record({ accountId: "usr_a", grantId: "g1" });
    meter.record({ accountId: "usr_b" });
    tick(1);

    expect(meter.currentTotal()).toBe(3);
    expect(meter.currentAccount("usr_a")).toBe(2);
    expect(meter.currentAccount("usr_b")).toBe(1);
    expect(meter.currentGrant("g1")).toBe(2);
  });

  test("an anonymous request counts against the total and no account", () => {
    // The pass-through's anonymous context has no account, and `GET /config` really is spend.
    const { meter, tick } = meterAt();
    meter.record({ accountId: null });
    tick(1);

    expect(meter.currentTotal()).toBe(1);
    expect(meter.seriesCount).toBe(1);
  });

  test("an unknown key reads as zero rather than throwing", () => {
    const { meter } = meterAt();
    expect(meter.currentAccount("nobody")).toBe(0);
    expect(meter.account("nobody").history).toHaveLength(WINDOW_SECONDS);
    expect(meter.account("nobody").peak).toBe(0);
  });
});

describe("the last complete second", () => {
  test("excludes the second in progress", () => {
    // A partial count only ever reads low, and would make a steady rate flicker with sample timing.
    const { meter, tick } = meterAt();
    meter.record({ accountId: "usr_a" });
    expect(meter.currentTotal()).toBe(0);

    tick(1);
    expect(meter.currentTotal()).toBe(1);
  });

  test("goes back to zero once the traffic stops", () => {
    const { meter, tick } = meterAt();
    meter.record({ accountId: "usr_a" });
    tick(1);
    expect(meter.currentTotal()).toBe(1);

    tick(1);
    expect(meter.currentTotal()).toBe(0);
  });
});

describe("history", () => {
  test("is oldest first and ends on the second `current` reports", () => {
    const { meter, tick } = meterAt();
    meter.record({ accountId: "usr_a" });
    meter.record({ accountId: "usr_a" });
    tick(1);
    meter.record({ accountId: "usr_a" });
    tick(1);

    const series = meter.account("usr_a");
    expect(series.history).toHaveLength(WINDOW_SECONDS);
    // Two seconds ago there were two, one second ago there was one.
    expect(series.history.at(-2)).toBe(2);
    expect(series.history.at(-1)).toBe(1);
    // The sparkline and the number beside it must never disagree.
    expect(series.current).toBe(series.history.at(-1) ?? -1);
    expect(series.peak).toBe(2);
    expect(series.total).toBe(3);
  });

  test("a gap reads as zeros, not as the previous value repeated", () => {
    const { meter, tick } = meterAt();
    meter.record({ accountId: "usr_a" });
    tick(5);

    const series = meter.account("usr_a");
    expect(series.history.slice(-4)).toEqual([0, 0, 0, 0]);
    expect(series.history.at(-5)).toBe(1);
    expect(series.current).toBe(0);
  });

  test("wraps around the end of the ring without smearing old values forward", () => {
    // The bug a ring invites: at second N + WINDOW, slot N is reused, and a buffer that is not
    // cleared on the way past reports a window-old count as current.
    const { meter, tick } = meterAt();
    meter.record({ accountId: "usr_a" });
    tick(WINDOW_SECONDS);

    const series = meter.account("usr_a");
    expect(series.total).toBe(0);
    expect(series.history.every((value) => value === 0)).toBe(true);
  });

  test("a gap wider than the window clears everything rather than looping over it", () => {
    const { meter, tick } = meterAt();
    meter.record({ accountId: "usr_a" });
    // An hour. A naive advance would step 3600 times to clear 600 slots.
    tick(3600);

    expect(meter.account("usr_a").total).toBe(0);
    expect(meter.currentAccount("usr_a")).toBe(0);
  });

  test("only the last window is kept, so an old burst falls off the end", () => {
    const { meter, tick } = meterAt();
    for (let i = 0; i < 5; i += 1) meter.record({ accountId: "usr_a" });
    tick(WINDOW_SECONDS - 1);
    expect(meter.account("usr_a").total).toBe(5);

    tick(2);
    expect(meter.account("usr_a").total).toBe(0);
  });
});

describe("pruning", () => {
  test("drops series that have been silent for the whole window", () => {
    // Apps come and go, and the set of keys is not bounded by anything the daemon controls.
    const { meter, tick } = meterAt();
    meter.record({ accountId: "usr_a", grantId: "g1" });
    expect(meter.seriesCount).toBe(3);

    tick(WINDOW_SECONDS + 1);
    expect(meter.prune()).toBe(3);
    expect(meter.seriesCount).toBe(0);
  });

  test("keeps a series that is still busy", () => {
    const { meter, tick } = meterAt();
    meter.record({ accountId: "usr_a" });
    tick(2);

    expect(meter.prune()).toBe(0);
    expect(meter.seriesCount).toBe(2);
    // Pruning must not disturb the reading it walked past.
    expect(meter.account("usr_a").total).toBe(1);
  });
});
