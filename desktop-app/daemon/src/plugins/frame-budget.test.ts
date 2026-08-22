import { describe, expect, test } from "bun:test";
import {
  FRAME_BURST,
  FRAME_REFILL_PER_SECOND,
  FRAME_REPORT_INTERVAL_MS,
  FrameBudget,
} from "./frame-budget.ts";

/** `now` is injected throughout, so none of this sleeps and none of it is time-dependent. */
const T0 = 1_700_000_000_000;

describe("the inbound frame budget", () => {
  test("a legitimate burst passes untouched", () => {
    const budget = new FrameBudget(FRAME_BURST, FRAME_REFILL_PER_SECOND, T0);
    for (let i = 0; i < FRAME_BURST; i++) {
      const verdict = budget.take(T0);
      expect([i, verdict.accept, verdict.report]).toEqual([i, true, null]);
    }
  });

  test("the frame past the burst is refused, and the host says so once", () => {
    const budget = new FrameBudget(4, 64, T0);
    for (let i = 0; i < 4; i++) budget.take(T0);

    const first = budget.take(T0);
    expect(first.accept).toBe(false);
    expect(first.report).toContain("too fast");

    // Announced once. A per-frame report would be the flood it exists to describe.
    for (let i = 0; i < 1000; i++) {
      const verdict = budget.take(T0);
      expect([verdict.accept, verdict.report]).toEqual([false, null]);
    }
    expect(budget.suppressed).toBe(1001);
  });

  test("it refills at the stated rate rather than all at once", () => {
    const budget = new FrameBudget(4, 64, T0);
    for (let i = 0; i < 5; i++) budget.take(T0);

    // 64/s means one token per ~15.6ms.
    expect(budget.take(T0 + 10).accept).toBe(false);
    expect(budget.take(T0 + 16).accept).toBe(true);
  });

  test("the total is reported when frames flow again, at most once a second", () => {
    const budget = new FrameBudget(1, 64, T0);
    budget.take(T0);
    budget.take(T0);
    budget.take(T0);

    // Inside the report interval: accepted, but the backlog is not announced again.
    const early = budget.take(T0 + 100);
    expect([early.accept, early.report]).toEqual([true, null]);

    const late = budget.take(T0 + FRAME_REPORT_INTERVAL_MS + 100);
    expect(late.accept).toBe(true);
    expect(late.report).toContain("frames were dropped");
    expect(budget.suppressed).toBe(0);
  });
});
