import { describe, expect, test } from "bun:test";
import { GRAPH_TRACE_STEP_LIMIT, GRAPH_TRACE_VALUE_LIMIT, type GraphTraceStep } from "@vrcz/shared";
import { pushStep, summarisePorts, summariseValue, TRUNCATED } from "./trace.ts";

function step(nodeId: string): GraphTraceStep {
  return { nodeId, status: "ok", at: 0, ms: 0 };
}

describe("summarising a value for a trace", () => {
  test("a small value survives verbatim", () => {
    // Which covers nearly everything a graph actually carries on a wire: ids, counts, flags and
    // short strings. Those are the values somebody squints at a canvas trying to read.
    expect(summariseValue("usr_abc")).toBe("usr_abc");
    expect(summariseValue(42)).toBe(42);
    expect(summariseValue(true)).toBe(true);
    expect(summariseValue({ a: 1, b: ["x"] })).toEqual({ a: 1, b: ["x"] });
  });

  test("a long string is cut, and the cut is visible", () => {
    const long = "x".repeat(GRAPH_TRACE_VALUE_LIMIT + 50);
    const summary = summariseValue(long) as Record<string, unknown>;
    // A marked object rather than a shorter string. A trace that silently showed the first 512
    // characters would be worse than no trace, because you would read it as the whole answer.
    expect(summary[TRUNCATED]).toBe(true);
    expect(summary.length).toBe(long.length);
    expect(String(summary.preview)).toHaveLength(GRAPH_TRACE_VALUE_LIMIT);
  });

  test("a big object is cut the same way", () => {
    const big = { items: Array.from({ length: 200 }, (_, i) => `item-${String(i)}`) };
    const summary = summariseValue(big) as Record<string, unknown>;
    expect(summary[TRUNCATED]).toBe(true);
  });

  test("a value JSON cannot express comes back as a description rather than throwing", () => {
    // This runs inside the settle path of a run that is otherwise finishing correctly. A circular
    // object in somebody's node output must not be able to take that down.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summariseValue(circular)).toBe("[unreadable]");
    expect(summariseValue(() => 1)).toBe("[unreadable]");
  });

  test("undefined and NaN both become something a JSON column can hold", () => {
    expect(summariseValue(undefined)).toBeNull();
    expect(summariseValue(Number.NaN)).toBe("NaN");
  });
});

describe("summarising a node's ports", () => {
  test("an undefined port is dropped rather than recorded as null", () => {
    // The engine's one gating rule is a *missing key*, so a port recorded as null would say the
    // opposite of what happened: the wire was dead, not carrying nothing.
    expect(summarisePorts({ a: 1, b: undefined })).toEqual({ a: 1 });
  });
});

describe("appending a step", () => {
  test("does nothing at all when the run is not being traced", () => {
    // The presence of the array is what every call site tests, which is what keeps an undebugged
    // run free rather than merely cheap.
    expect(() => pushStep(undefined, step("n1"))).not.toThrow();
  });

  test("keeps the first steps rather than the last ones", () => {
    const trace: GraphTraceStep[] = [];
    for (let i = 0; i < GRAPH_TRACE_STEP_LIMIT + 10; i += 1) pushStep(trace, step(`n${String(i)}`));
    expect(trace).toHaveLength(GRAPH_TRACE_STEP_LIMIT);
    // A window would keep the tail of a runaway loop and throw away the trigger that started it,
    // which is the one step that explains the rest.
    expect(trace[0]?.nodeId).toBe("n0");
  });
});
