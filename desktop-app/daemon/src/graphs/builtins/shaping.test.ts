import { describe, expect, test } from "bun:test";
import type { NodeConfigValues, PortValues } from "@vrcz/plugin-api/nodes";
import type { ExecuteContext } from "../types.ts";
import { createBuiltinNodes } from "./index.ts";
import { evaluateCompare, fillTemplate, readPath } from "./shaping.ts";

const CONTEXT: ExecuteContext = {
  graphId: "g1",
  runId: "r1",
  nodeId: "n1",
  dryRun: false,
  accountId: null,
};

const nodes = createBuiltinNodes();

async function run(
  type: string,
  inputs: PortValues,
  config: NodeConfigValues = {},
): Promise<PortValues> {
  return await nodes.execute(`vrcz/${type}`, inputs, config, CONTEXT);
}

describe("compare", () => {
  test("the string tests", () => {
    expect(evaluateCompare("eq", "Ada", "Ada")).toBe(true);
    expect(evaluateCompare("ne", "Ada", "Grace")).toBe(true);
    expect(evaluateCompare("contains", "Ada Lovelace", "Love")).toBe(true);
    expect(evaluateCompare("starts", "Ada Lovelace", "Ada")).toBe(true);
    expect(evaluateCompare("matches", "wrld_1234", "^wrld_")).toBe(true);
    expect(evaluateCompare("ends", "Ada Lovelace", "lace")).toBe(true);
    expect(evaluateCompare("ends", "Ada Lovelace", "Ada")).toBe(false);
    expect(evaluateCompare("not-contains", "Ada Lovelace", "Grace")).toBe(true);
    expect(evaluateCompare("not-contains", "Ada Lovelace", "Love")).toBe(false);
    expect(evaluateCompare("not-matches", "wrld_1234", "^usr_")).toBe(true);
    expect(evaluateCompare("not-matches", "wrld_1234", "^wrld_")).toBe(false);
  });

  test("is one of takes a list on the wire or commas in the box", () => {
    expect(evaluateCompare("in", "trusted", ["visitor", "trusted"])).toBe(true);
    expect(evaluateCompare("in", "trusted", "visitor, trusted")).toBe(true);
    // Trimmed, because the space after a comma is punctuation and not part of the word, and an
    // empty piece is dropped so a trailing comma is not a choice that matches nothing.
    expect(evaluateCompare("in", "", "a, b,")).toBe(false);
    expect(evaluateCompare("in", "known", "visitor, trusted")).toBe(false);
    expect(evaluateCompare("not-in", "known", "visitor, trusted")).toBe(true);
    // Numbers still compare as numbers, the same as `is` does.
    expect(evaluateCompare("in", 3, "1, 2, 3")).toBe(true);
    // An object is no choices at all rather than its JSON chopped on commas.
    expect(evaluateCompare("in", '{"a":1', { a: 1 })).toBe(false);
  });

  test("list includes reads the left side as the list", () => {
    expect(
      evaluateCompare("includes", ["system_trust_basic", "admin_moderator"], "admin_moderator"),
    ).toBe(true);
    expect(evaluateCompare("includes", ["system_trust_basic"], "admin_moderator")).toBe(false);
    expect(evaluateCompare("not-includes", ["system_trust_basic"], "admin_moderator")).toBe(true);
    // Not a list is not "a list without it in": both directions answer no, so a mis-wired port
    // cannot run the branch below `list does not include`.
    expect(evaluateCompare("includes", "admin_moderator", "admin_moderator")).toBe(false);
    expect(evaluateCompare("not-includes", "admin_moderator", "admin_moderator")).toBe(false);
  });

  test("empty is nothing, blank text, an empty list or an empty object", () => {
    expect(evaluateCompare("empty", "", null)).toBe(true);
    expect(evaluateCompare("empty", "   ", null)).toBe(true);
    expect(evaluateCompare("empty", null, null)).toBe(true);
    expect(evaluateCompare("empty", [], null)).toBe(true);
    expect(evaluateCompare("empty", {}, null)).toBe(true);
    // Answers, not absences. Treating these as empty is the C habit nobody wants in a graph.
    expect(evaluateCompare("empty", 0, null)).toBe(false);
    expect(evaluateCompare("empty", false, null)).toBe(false);
    expect(evaluateCompare("not-empty", "Ada", null)).toBe(true);
    expect(evaluateCompare("not-empty", "", null)).toBe(false);
  });

  test("every negative test fails closed on an unfilled term", () => {
    // The whole hazard of adding negatives: `!"".includes("")` is true, so a half-configured
    // "does not contain" would fire on every event. Each one wants a term before it says yes.
    expect(evaluateCompare("not-contains", "Ada Lovelace", "")).toBe(false);
    expect(evaluateCompare("not-matches", "Ada Lovelace", "")).toBe(false);
    expect(evaluateCompare("ends", "Ada Lovelace", "")).toBe(false);
    expect(evaluateCompare("not-in", "Ada", "")).toBe(false);
    expect(evaluateCompare("not-in", "Ada", [])).toBe(false);
    expect(evaluateCompare("not-includes", ["a"], "")).toBe(false);
  });

  test("a number that arrived as text still compares as a number", () => {
    // Config fields are strings, ports are not. Refusing "5" > 3 would make every comparison
    // against a typed-in number silently false, which is the worst possible failure here.
    expect(evaluateCompare("gt", "5", 3)).toBe(true);
    expect(evaluateCompare("lte", 3, "3")).toBe(true);
    expect(evaluateCompare("eq", 3, "3")).toBe(true);
  });

  test("equality agrees with the orderings about what a number is", () => {
    // `1.0` and ` 1` are what a config box holds after somebody types a number into it. Equality
    // used to compare them as strings and answer false while `is at least` and `is at most` both
    // answered true about the same pair, which is a graph nobody can reason about.
    expect(evaluateCompare("eq", 1, "1.0")).toBe(true);
    expect(evaluateCompare("eq", 1, " 1")).toBe(true);
    expect(evaluateCompare("ne", 1, "1.0")).toBe(false);
    // And it still declines the two loose comparisons `==` would have made.
    expect(evaluateCompare("eq", "", 0)).toBe(false);
    expect(evaluateCompare("eq", "Ada", "Grace")).toBe(false);
  });

  test("an empty term matches nothing rather than everything", () => {
    // `"".includes("")` is true, so a half-configured gate used to fire on every event and a filter
    // used to keep the whole list. An unfilled term fails closed.
    expect(evaluateCompare("contains", "Ada Lovelace", "")).toBe(false);
    expect(evaluateCompare("starts", "Ada Lovelace", "")).toBe(false);
    expect(evaluateCompare("matches", "Ada Lovelace", "")).toBe(false);
    expect(evaluateCompare("contains", "Ada Lovelace", null)).toBe(false);
  });

  test("but a boolean is not a number and never equals one", () => {
    expect(evaluateCompare("eq", true, 1)).toBe(false);
    expect(evaluateCompare("eq", false, 0)).toBe(false);
    expect(evaluateCompare("eq", true, true)).toBe(true);
  });

  test("an unorderable pair is false rather than an error", () => {
    expect(evaluateCompare("gt", "Ada", "Grace")).toBe(false);
    expect(evaluateCompare("gt", null, 3)).toBe(false);
  });

  test("a broken regex answers false instead of throwing", () => {
    // The pattern is config, so it is the author's typo, and nobody is standing there at 3 AM.
    expect(evaluateCompare("matches", "anything", "([")).toBe(false);
  });

  test("an unknown operator answers false", () => {
    expect(evaluateCompare("wat", "a", "a")).toBe(false);
  });

  test("the wired operand beats the typed one", async () => {
    expect(await run("compare", { left: "a", right: "a" }, { op: "eq", value: "b" })).toEqual({
      result: true,
    });
    expect(await run("compare", { left: "a" }, { op: "eq", value: "a" })).toEqual({ result: true });
  });
});

describe("gating", () => {
  test("only-if produces nothing when the answer is no", async () => {
    // Nothing, not `false`. An unproduced port is what stops the run; `{out: false}` would send a
    // literal false down the graph and run everything below it.
    expect(await run("gate", { value: false, payload: "x" })).toEqual({});
    expect(await run("gate", { value: true, payload: "x" })).toEqual({ out: "x" });
    expect(await run("gate", { value: true })).toEqual({ out: true });
  });

  test("and, or, not", async () => {
    expect(await run("logic", { a: true, b: false }, { op: "and" })).toEqual({ result: false });
    expect(await run("logic", { a: true, b: false }, { op: "or" })).toEqual({ result: true });
    expect(await run("not", { value: false })).toEqual({ result: true });
  });
});

describe("read field", () => {
  test("walks objects and indexes lists", () => {
    const payload = { user: { displayName: "Ada" }, tags: ["a", "b"] };
    expect(readPath(payload, "user.displayName")).toBe("Ada");
    expect(readPath(payload, "tags.1")).toBe("b");
    expect(readPath(payload, "")).toEqual(payload);
  });

  test("a path that finds nothing produces nothing, which gates the run", async () => {
    // The alternative — carrying on with `null` — sends a message addressed to nobody.
    expect(readPath({ a: 1 }, "b.c")).toBeUndefined();
    expect(await run("field", { value: { a: 1 } }, { path: "b" })).toEqual({});
    expect(await run("field", { value: { a: 1 } }, { path: "a" })).toEqual({ out: 1 });
  });

  test("an index past the end is nothing, not undefined-in-a-list", () => {
    expect(readPath({ tags: ["a"] }, "tags.7")).toBeUndefined();
    expect(readPath({ tags: ["a"] }, "tags.x")).toBeUndefined();
  });
});

describe("compose text", () => {
  test("fills the slots that are wired", () => {
    expect(fillTemplate("{a} joined {b}", { a: "Ada", b: "The Great Pug" })).toBe(
      "Ada joined The Great Pug",
    );
  });

  test("leaves an unwired slot exactly as typed", () => {
    // Rather than "undefined" or an empty gap: the author can see which wire they forgot.
    expect(fillTemplate("{a} and {c}", { a: "Ada" })).toBe("Ada and {c}");
  });

  test("doubling a brace escapes it", () => {
    expect(fillTemplate("{{a}} is literal, {a} is not", { a: "Ada" })).toBe(
      "{a} is literal, Ada is not",
    );
  });

  test("renders an object as JSON rather than as [object Object]", async () => {
    expect(await run("template", { a: { x: 1 } }, { template: "{a}" })).toEqual({
      text: '{"x":1}',
    });
  });

  test("takes twenty-six slots, so a long line does not need three of these chained", () => {
    expect(fillTemplate("{x}{y}{z}", { x: 1, y: 2, z: 3 })).toBe("123");
  });
});

describe("compose text: formatting a number", () => {
  test("fixed decimals, which is the one everybody wants", () => {
    expect(fillTemplate("{a:2f}", { a: 12.3456 })).toBe("12.35");
    expect(fillTemplate("{a:0f}", { a: 3.7 })).toBe("4");
    expect(fillTemplate("{a:f}", { a: 3.7 })).toBe("4");
    expect(fillTemplate("{a:2f}", { a: 5 })).toBe("5.00");
  });

  test("grouping on its own does not also round", () => {
    // `{a:,}` asks for separators. Truncating the fraction as well would be a second thing
    // happening that nobody asked for.
    expect(fillTemplate("{a:,}", { a: 1234567.25 })).toBe("1,234,567.25");
    expect(fillTemplate("{a:,2f}", { a: 1234567.256 })).toBe("1,234,567.26");
  });

  test("percent multiplies, so the value stays the fraction it was", () => {
    expect(fillTemplate("{a:%}", { a: 0.256 })).toBe("26%");
    expect(fillTemplate("{a:1%}", { a: 0.256 })).toBe("25.6%");
  });

  test("a forced sign shows on a gain and never on zero", () => {
    expect(fillTemplate("{a:+}", { a: 5 })).toBe("+5");
    expect(fillTemplate("{a:+}", { a: -5 })).toBe("-5");
    // `+0` reads as a bug in whatever produced it rather than as a delta of nothing.
    expect(fillTemplate("{a:+}", { a: 0 })).toBe("0");
    expect(fillTemplate("{a:+,2f}", { a: 1234.5 })).toBe("+1,234.50");
  });

  test("a numeric string formats, because JSON is full of them", () => {
    expect(fillTemplate("{a:2f}", { a: "12.3456" })).toBe("12.35");
  });

  test("a value that is not a number falls through as its plain text", () => {
    // The spec was right and the world handed over a string. Printing it beats printing NaN.
    expect(fillTemplate("{a:2f}", { a: "Ada" })).toBe("Ada");
    expect(fillTemplate("{a:2f}", { a: null })).toBe("");
  });

  test("a spec that is not one is left exactly as typed", () => {
    // The author's own text, unlike the value. A template that silently drops what it did not
    // understand is one nobody can debug.
    expect(fillTemplate("{a:zzz}", { a: 12.3456 })).toBe("{a:zzz}");
    expect(fillTemplate("{a:}", { a: 12.3456 })).toBe("{a:}");
  });

  test("the locale is fixed, not the machine's", () => {
    // A graph is a document: the line it composes must not read differently because the daemon is
    // running on a machine set to German.
    expect(fillTemplate("{a:,2f}", { a: 1234.5 })).toBe("1,234.50");
  });

  test("str quotes and escapes, which is the point of it", () => {
    // `{"name": "{a}"}` looks right and breaks on the first display name with a quote in it, at the
    // far end, in whatever service rejected the body.
    expect(fillTemplate('{"name": {a:str}}', { a: 'Ada "The Great" Lovelace' })).toBe(
      '{"name": "Ada \\"The Great\\" Lovelace"}',
    );
    expect(fillTemplate("{a:str}", { a: "line\nbreak" })).toBe('"line\\nbreak"');
  });

  test("str is the one spec that is useful on something that is not a string", () => {
    expect(fillTemplate("{a:str}", { a: { x: 1 } })).toBe('{"x":1}');
    expect(fillTemplate("{a:str}", { a: [1, "two"] })).toBe('[1,"two"]');
    // No quotes on a number: a JSON document wanted digits in that position.
    expect(fillTemplate("{a:str}", { a: 5 })).toBe("5");
    expect(fillTemplate("{a:str}", { a: true })).toBe("true");
  });

  test("a wired port carrying nothing is null, which the surrounding document can parse", () => {
    expect(fillTemplate("{a:str}", { a: null })).toBe("null");
    expect(fillTemplate("{a:str}", { a: undefined })).toBe("null");
  });

  test("an unwired slot with a spec is still left as typed", () => {
    expect(fillTemplate("{a:2f} and {b:2f}", { a: 1 })).toBe("1.00 and {b:2f}");
  });
});

describe("lists", () => {
  test("as-list turns a raw value into one, and a non-list into an empty one", async () => {
    expect(await run("as-list", { value: [1, 2] })).toEqual({ list: [1, 2] });
    expect(await run("as-list", { value: "nope" })).toEqual({ list: [] });
  });

  test("filter tests a field, or the item itself when no field is given", async () => {
    const list = [
      { name: "Ada", status: "online" },
      { name: "Grace", status: "offline" },
    ];
    expect(
      await run("list-filter", { list }, { path: "status", op: "eq", value: "online" }),
    ).toEqual({ list: [list[0]] });
    expect(await run("list-filter", { list: ["a", "b"] }, { op: "eq", value: "b" })).toEqual({
      list: ["b"],
    });
  });

  test("a filter with no term typed yet keeps nothing, not everything", async () => {
    // The half-configured state has to fail closed the same way the gate does, or the node reads as
    // working while it is doing nothing at all.
    expect(await run("list-filter", { list: ["a", "b"] }, { op: "contains" })).toEqual({
      list: [],
    });
    expect(await run("list-filter", { list: ["a", "b"] }, { op: "contains", value: "" })).toEqual({
      list: [],
    });
    expect(await run("list-filter", { list: ["ab", "b"] }, { op: "contains", value: "a" })).toEqual(
      {
        list: ["ab"],
      },
    );
  });

  test("count and first", async () => {
    expect(await run("list-count", { list: [1, 2, 3] })).toEqual({ count: 3 });
    expect(await run("list-first", { list: [1, 2] })).toEqual({ item: 1 });
    // Empty produces nothing, which gates: "the first friend here, if there is one".
    expect(await run("list-first", { list: [] })).toEqual({});
  });
});

describe("the built-in set", () => {
  test("every definition is registered under the reserved namespace", () => {
    const ids = nodes.definitions().map((definition) => definition.id);
    expect(ids).toContain("wait");
    expect(ids).toContain("foreach");
    expect(ids).toContain("compare");
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("an intrinsic has no handler, and says so rather than doing nothing", async () => {
    // Reaching this means the engine failed to intercept it, which is a bug in the engine — and a
    // silent `{}` would look like a node that ran and produced nothing.
    expect(nodes.has("vrcz/wait")).toBe(true);
    await expect(run("wait", {})).rejects.toThrow("the engine should have run it itself");
  });
});

describe("create a name", () => {
  test("a fresh one every time", async () => {
    // The property the node exists for. A counter or a timestamp would hand out a name that is
    // already on screen after a restart, or when two runs of one graph overlap.
    const first = (await run("uuid", {})).value;
    const second = (await run("uuid", {})).value;
    expect(typeof first).toBe("string");
    expect(first).not.toBe(second);
    expect(String(first)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a prefix goes in front, trimmed", async () => {
    const value = String((await run("uuid", {}, { prefix: "  invite-  " })).value);
    expect(value.startsWith("invite-")).toBe(true);
    expect(value).toHaveLength("invite-".length + 36);
  });
});
