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
    triggerTypes: [],
    lastRunAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function seedTypes(owners: readonly (readonly [string, string, string, string?])[]): void {
  graphs.nodeTypes.clear();
  for (const [owner, id, title, category] of owners) {
    graphs.nodeTypes.set(`${owner}/${id}`, {
      qualifiedId: `${owner}/${id}`,
      owner,
      available: true,
      definition: { ...definition(id, title), ...(category === undefined ? {} : { category }) },
    });
  }
}

describe("the palette", () => {
  test("groups built-ins by category, in working order", () => {
    // Owner was the first grouping and it stopped working the moment the built-in set passed three
    // hundred: everything vrc.zip ships has one owner, so the palette was one enormous group.
    seedTypes([
      ["vrcz", "note", "Write to the feed", "Send"],
      ["vrcz", "on-event", "When something happens", "Triggers"],
      ["vrcz", "api-get-user", "Get user (API)", "API: users"],
      ["vrcz", "gate", "Only if", "Logic"],
    ]);

    expect(graphs.palette.map((group) => group.owner)).toEqual([
      "Triggers",
      "Logic",
      "Send",
      // The generated API groups come after everything an ordinary graph is built from.
      "API: users",
    ]);
  });

  test("a plugin's nodes group under the plugin, and under its own categories", () => {
    // `category` always meant "groups the node in the editor's palette"; the palette simply was
    // not reading it for plugin nodes. The owner stays in the key whatever the plugin calls its
    // group — "Reading" with no owner attached would read as a feature of vrc.zip.
    seedTypes([
      ["vrcz", "note", "Write to the feed", "Send"],
      ["acme.notes", "read", "Read a note", "Reading"],
      ["acme.notes", "write", "Write a note", "Writing"],
      ["zeta.plugin", "send", "Send"],
    ]);

    expect(graphs.palette.map((group) => group.owner)).toEqual([
      "Send",
      "acme.notes — Reading",
      "acme.notes — Writing",
      "zeta.plugin (plugin)",
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
