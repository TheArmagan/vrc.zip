import { describe, expect, test } from "vitest";
import type { GraphSummary } from "$lib/api.ts";
import { graphState, watchesFor } from "./graph-state.ts";

function graph(overrides: Partial<GraphSummary> = {}): GraphSummary {
  return {
    id: "g1",
    name: "Greet arrivals",
    description: "",
    enabled: false,
    armed: false,
    concurrency: "parallel",
    accountId: null,
    disabledReason: null,
    nodeCount: 3,
    triggerTypes: [],
    lastRunAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("what state a graph is in", () => {
  test("the four states are four different colours", () => {
    const colors = [
      graphState(graph()),
      graphState(graph({ enabled: true })),
      graphState(graph({ enabled: true, armed: true })),
      graphState(graph({ disabledReason: "hit its ceiling" })),
    ].map((state) => state.color);
    expect(new Set(colors).size).toBe(4);
  });

  test("off and armed are never the same thing", () => {
    // The pair that must not look alike at a glance: one of them sends real invites.
    expect(graphState(graph()).kind).toBe("off");
    expect(graphState(graph({ enabled: true, armed: true })).kind).toBe("armed");
  });

  test("the daemon switching a graph off beats every other state", () => {
    // Stopped is not off. The difference is whether somebody chose it, and the reason has to be on
    // the card rather than behind a hover -- that is how a graph stayed dead for a week unnoticed.
    const stopped = graphState(
      graph({ enabled: true, armed: true, disabledReason: "too many failures" }),
    );
    expect(stopped.kind).toBe("stopped");
    expect(stopped.detail).toBe("too many failures");
  });

  test("rehearsing says what rehearsing means", () => {
    const state = graphState(graph({ enabled: true }));
    expect(state.kind).toBe("rehearsing");
    expect(state.detail).not.toBe("");
  });
});

describe("what a graph watches for", () => {
  const titles = new Map([
    ["vrcz/on-friend-online", "When a friend comes online"],
    ["vrcz/on-player-join", "When someone joins your instance"],
  ]);
  const titleOf = (type: string) => titles.get(type) ?? null;

  test("resolves type ids through the catalogue the client already holds", () => {
    expect(watchesFor(["vrcz/on-friend-online"], titleOf)).toEqual(["When a friend comes online"]);
  });

  test("two of the same trigger is one phrase, not a stutter", () => {
    expect(watchesFor(["vrcz/on-player-join", "vrcz/on-player-join"], titleOf)).toEqual([
      "When someone joins your instance",
    ]);
  });

  test("an unregistered type falls back to its id rather than vanishing", () => {
    // Its plugin is stopped. A worse name than the title, and a much better one than nothing.
    expect(watchesFor(["acme/on-webhook"], titleOf)).toEqual(["on-webhook"]);
  });

  test("no triggers is an empty list, and the card draws nothing", () => {
    expect(watchesFor([], titleOf)).toEqual([]);
  });
});
