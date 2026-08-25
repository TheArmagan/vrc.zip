import type { GraphTrace } from "@vrcz/shared";
import { describe, expect, test } from "vitest";
import { graphTraces, isTruncated, previewValue, TRUNCATED } from "./graph-traces.svelte.ts";

/**
 * The state class is driven directly from a plain `.test.ts`, which is fine: runes are compiler
 * syntax keyed on the filename, so what may not appear here is `$state` itself.
 *
 * `traces` is assigned rather than fetched. The network half is one `api` call with the same
 * generation-counter shape three other modules already have; what is worth testing is the reading
 * of a recording, which is where every decision on this screen actually lives.
 */

function trace(runId: string, overrides: Partial<GraphTrace> = {}): GraphTrace {
  return {
    runId,
    graphId: "g1",
    triggerNode: "n1",
    outcome: "finished",
    dryRun: false,
    failedNode: null,
    message: null,
    steps: [],
    startedAt: 0,
    finishedAt: 0,
    ...overrides,
  };
}

describe("reading a recording", () => {
  test("the newest run is what everything reads until one is picked", () => {
    graphTraces.traces = [trace("newest"), trace("older")];
    graphTraces.selectedRunId = null;
    expect(graphTraces.selected?.runId).toBe("newest");

    graphTraces.selectedRunId = "older";
    expect(graphTraces.selected?.runId).toBe("older");
  });

  test("a run that has aged out falls back to the newest rather than to nothing", () => {
    // The daemon keeps ten. Holding the id and resolving it every time means a selection that
    // scrolled off the end degrades to "the newest one", which is what somebody scrubbing through
    // a log wants — where a held copy would simply go stale and keep showing a run that is gone.
    graphTraces.traces = [trace("newest")];
    graphTraces.selectedRunId = "long-gone";
    expect(graphTraces.selected?.runId).toBe("newest");
  });

  test("a node inside a loop reports its most recent iteration", () => {
    graphTraces.traces = [
      trace("r1", {
        steps: [
          { nodeId: "body", status: "ok", at: 0, ms: 1, outputs: { out: "first" } },
          { nodeId: "body", status: "error", at: 1, ms: 1, message: "second" },
        ],
      }),
    ];
    graphTraces.selectedRunId = "r1";
    // Last wins, and it is the one worth drawing on a card: it explains where the loop stopped.
    expect(graphTraces.steps.get("body")?.status).toBe("error");
  });

  test("a port with no entry is a dead wire, not a null value", () => {
    graphTraces.traces = [
      trace("r1", {
        steps: [{ nodeId: "br", status: "ok", at: 0, ms: 0, outputs: { true: 1 } }],
      }),
    ];
    graphTraces.selectedRunId = "r1";
    expect(graphTraces.output("br", "true")).toBe(1);
    // The missing key is the runtime's one gating mechanism, so this must not collapse to null:
    // everything under that port skipped, which is a different thing from carrying nothing.
    expect(graphTraces.output("br", "false")).toBeUndefined();
    expect(graphTraces.output("nowhere", "out")).toBeUndefined();
  });

  test("stop drops everything held for the graph", () => {
    graphTraces.traces = [trace("r1")];
    graphTraces.selectedRunId = "r1";
    graphTraces.stop();
    expect(graphTraces.traces).toEqual([]);
    expect(graphTraces.selected).toBeNull();
  });
});

describe("previewing one value on a wire", () => {
  test("a dead wire says so in a word", () => {
    expect(previewValue(undefined)).toBe("nothing");
    expect(previewValue(null)).toBe("null");
  });

  test("an empty string is drawn as one rather than as blank", () => {
    // The single most common thing a test fire produces, and a blank label on a wire is
    // indistinguishable from no label at all.
    expect(previewValue("")).toBe('""');
  });

  test("a list is counted rather than spelled out", () => {
    expect(previewValue([1, 2, 3])).toBe("3 items");
    expect(previewValue(["only"])).toBe("1 item");
  });

  test("a long value is clipped with typed periods", () => {
    const clipped = previewValue("y".repeat(80), 10);
    expect(clipped).toBe(`${"y".repeat(10)}...`);
  });

  test("a value the daemon already cut reports how much was lost", () => {
    const cut = { [TRUNCATED]: true as const, preview: "abc", length: 900 };
    expect(isTruncated(cut)).toBe(true);
    expect(previewValue(cut)).toContain("900 chars");
  });
});
