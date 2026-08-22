import { describe, expect, test } from "bun:test";
import { isJsonObject, type JsonValue } from "./json.ts";

describe("isJsonObject", () => {
  test("accepts a plain object", () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject({})).toBe(true);
  });

  test("rejects null — the guard exists for exactly this", () => {
    // `typeof null === "object"`, so a naive typeof check lets null through and the caller then
    // reads a property off it. Both former copies of this function got it right; keeping the test
    // means the shared one cannot quietly regress.
    expect(isJsonObject(null)).toBe(false);
  });

  test("rejects arrays", () => {
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject([{ a: 1 }])).toBe(false);
  });

  test("rejects primitives and undefined", () => {
    const cases: (JsonValue | undefined)[] = ["", "x", 0, 1, true, false, undefined];
    for (const value of cases) expect(isJsonObject(value)).toBe(false);
  });

  test("narrows for the type checker", () => {
    const value: JsonValue = { nested: { deep: [1, "two", null] } };
    if (!isJsonObject(value)) throw new Error("unreachable");
    // Reading a key is only legal because the guard narrowed the union.
    expect(value.nested).toEqual({ deep: [1, "two", null] });
  });
});
