import { describe, expect, test } from "bun:test";
import { denyScan, formatDenyFindings, isBuiltinSpecifier } from "./deny-scan.ts";

/**
 * The deny-scan is the step PLAN.md's whole argument rests on — *"attacks fail loudly at install
 * with a message the user reads"* — so these tests assert two things about every rejection, not one:
 * that it fires, and that it carries a construct and a position. A rule that rejects without saying
 * where is a rule that produces a support ticket instead of a fix.
 *
 * The false-positive cases matter as much. A scan that refuses ordinary bundles gets turned off.
 */

function rules(source: string): string[] {
  return denyScan(source).findings.map((finding) => finding.rule);
}

describe("what it rejects", () => {
  test("a dynamic import whose specifier is computed", () => {
    const result = denyScan('const m = await import("node:" + "fs");\n');
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.rule).toBe("dynamic-import");
    expect(result.findings[0]?.line).toBe(1);
    expect(result.findings[0]?.column).toBe(17);
    expect(result.findings[0]?.construct).toBe("import(…)");
  });

  test("a literal node: import, static or dynamic", () => {
    expect(rules('import { readFileSync } from "node:fs";\n')).toEqual(["builtin-import"]);
    expect(rules('await import("node:child_process");\n')).toEqual(["builtin-import"]);
    expect(rules('export { x } from "node:os";\n')).toEqual(["builtin-import"]);
  });

  test("a bun: import, and the bare spelling of a node builtin", () => {
    expect(rules('import { Database } from "bun:sqlite";\n')).toEqual(["builtin-import"]);
    // "fs" and "node:fs" are the same module, and only one of them looks like a violation.
    expect(rules('import { readFileSync } from "fs";\n')).toEqual(["builtin-import"]);
  });

  test("require, in a call and as a bare reference", () => {
    expect(rules('const fs = require("fs");\n')).toEqual(["require"]);
    // The alias is a line long, so catching only the call would catch nothing.
    expect(rules("const r = require;\n")).toEqual(["require"]);
  });

  test("process.binding, in both spellings", () => {
    expect(rules('process.binding("fs");\n')).toEqual(["process-binding"]);
    expect(rules('process["binding"]("fs");\n')).toEqual(["process-binding"]);
    expect(rules('globalThis.process.binding("fs");\n')).toEqual(["process-binding"]);
  });

  test("the Function constructor, with and without new", () => {
    expect(rules('new Function("return this")();\n')).toEqual(["function-constructor"]);
    // Dropping `new` is not a bypass.
    expect(rules('Function("return this")();\n')).toEqual(["function-constructor"]);
  });

  test("eval of anything that is not a literal", () => {
    expect(rules("eval(payload);\n")).toEqual(["eval"]);
    expect(rules('eval("a" + b);\n')).toEqual(["eval"]);
    // Indirect eval is a documented language feature, not an obscure trick.
    expect(rules("const e = eval;\n")).toEqual(["eval"]);
  });

  test("a file that does not parse is refused rather than run", () => {
    const result = denyScan("function ( { ] }\n");
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.rule).toBe("parse-error");
  });

  test("every finding names a construct and a position", () => {
    const result = denyScan(
      ["export function activate() {", "  return eval(globalThis.payload);", "}", ""].join("\n"),
    );
    const finding = result.findings[0];
    expect(finding?.line).toBe(2);
    expect(finding?.column).toBe(10);
    expect(formatDenyFindings(result.findings)).toContain("line 2, column 10");
  });
});

describe("what it lets through", () => {
  test("a plugin that only uses the plugin API", () => {
    const source = [
      "export function activate(host) {",
      '  host.on("friend.online", (event) => host.notify(event.userId));',
      "  return { deactivate() {} };",
      "}",
      "",
    ].join("\n");
    expect(denyScan(source).ok).toBe(true);
  });

  test("property names that merely spell a forbidden word", () => {
    expect(denyScan("const a = config.require;\n").ok).toBe(true);
    expect(denyScan("const a = { require: 1, eval: 2 };\n").ok).toBe(true);
    expect(denyScan("class A { eval() { return 1; } }\n").ok).toBe(true);
  });

  test("a static import of a relative module, which bundling has already resolved", () => {
    expect(denyScan('import x from "./helper.js";\n').ok).toBe(true);
  });

  test("eval of a plain string literal, which is no more than writing the string", () => {
    expect(denyScan('eval("1 + 1");\n').ok).toBe(true);
  });

  test("a shorthand property does reference the binding, so it is not excused", () => {
    expect(rules("const o = { require };\n")).toEqual(["require"]);
  });
});

describe("isBuiltinSpecifier", () => {
  test("covers both spellings and neither of the plugin's own", () => {
    expect(isBuiltinSpecifier("node:fs")).toBe(true);
    expect(isBuiltinSpecifier("bun:sqlite")).toBe(true);
    expect(isBuiltinSpecifier("fs")).toBe(true);
    expect(isBuiltinSpecifier("./fs")).toBe(false);
    expect(isBuiltinSpecifier("left-pad")).toBe(false);
  });
});
