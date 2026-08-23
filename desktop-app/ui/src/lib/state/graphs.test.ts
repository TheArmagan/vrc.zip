import type { NodeDefinition } from "@vrcz/plugin-api/nodes";
import type { GraphSummary } from "@vrcz/shared";
import { describe, expect, test } from "vitest";
import { graphs } from "./graphs.svelte.ts";

/**
 * Driving the state class from a plain `.test.ts` is fine — runes are compiler syntax keyed on the
 * filename, so what may not appear here is `$state` itself, not a class that uses it.
 */

function definition(id: string, title: string): NodeDefinition {
  return { id, kind: "action", title, inputs: [], outputs: [] };
}

function summary(id: string, name: string): GraphSummary {
  return {
    id,
    name,
    description: "",
    enabled: false,
    armed: false,
    concurrency: "parallel",
    accountId: null,
    disabledReason: null,
    nodeCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function seedTypes(owners: readonly [string, string, string][]): void {
  graphs.nodeTypes.clear();
  for (const [owner, id, title] of owners) {
    graphs.nodeTypes.set(`${owner}/${id}`, {
      qualifiedId: `${owner}/${id}`,
      owner,
      available: true,
      definition: definition(id, title),
    });
  }
}

describe("the palette", () => {
  test("groups by owner with the built-ins first", () => {
    // Two plugins both contributing a node called "Send" is a flat list where nobody can tell
    // whose is whose, which is why this groups at all.
    seedTypes([
      ["zeta.plugin", "send", "Send"],
      ["vrcz", "note", "Write to the feed"],
      ["acme.notes", "send", "Send"],
    ]);

    expect(graphs.palette.map((group) => group.owner)).toEqual([
      "vrcz",
      "acme.notes",
      "zeta.plugin",
    ]);
  });

  test("sorts a group by title rather than by id", () => {
    seedTypes([
      ["vrcz", "zzz", "Alpha"],
      ["vrcz", "aaa", "Beta"],
      ["vrcz", "mmm", "Gamma"],
    ]);
    expect(graphs.palette[0]?.types.map((type) => type.definition.title)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });
});

describe("definitions", () => {
  test("an unregistered type answers null rather than throwing", () => {
    // The ordinary case, not an error: a graph naming a stopped plugin's node draws it greyed.
    seedTypes([["vrcz", "note", "Write to the feed"]]);
    expect(graphs.definition("vrcz/note")?.title).toBe("Write to the feed");
    expect(graphs.definition("acme.gone/node")).toBeNull();
  });
});

describe("the list", () => {
  test("replace swaps a row in place rather than reordering", () => {
    graphs.graphs = [summary("a", "A"), summary("b", "B"), summary("c", "C")];
    graphs.replace({ ...summary("b", "B renamed"), enabled: true });

    expect(graphs.graphs.map((graph) => graph.id)).toEqual(["a", "b", "c"]);
    expect(graphs.graphs[1]?.name).toBe("B renamed");
    expect(graphs.graphs[1]?.enabled).toBe(true);
  });

  test("remove drops one and leaves the rest", () => {
    graphs.graphs = [summary("a", "A"), summary("b", "B")];
    graphs.remove("a");
    expect(graphs.graphs.map((graph) => graph.id)).toEqual(["b"]);
  });
});
