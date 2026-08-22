/**
 * The AST deny-scan, run over the **bundled output** at install time.
 *
 * PLAN.md §"Install-time compilation, not runtime resolution" is one sentence long and every clause
 * of it is load-bearing:
 *
 * > At install: `Bun.build` with `target: "browser"` and `external: []` (node builtins become hard
 * > build errors), then an AST deny-scan over the *bundled output* rejecting non-literal `import()`,
 * > literal `node:`/`bun:` imports, `require`, `process.binding`, `new Function`, and `eval` of
 * > non-literals. […] Attacks fail loudly at install with a message the user reads, instead of
 * > silently at 3 AM.
 *
 * ## Why the bundled output and not the sources
 *
 * Because the sources are not what runs. A plugin that imports a helper which imports a helper which
 * builds `"node:" + "fs"` has three files and one artifact, and the artifact is the only place the
 * whole program is visible at once. Scanning sources also means scanning every `node_modules`
 * dependency the author pulled in, which is both slower and easier to hide inside.
 *
 * ## Why the TypeScript compiler API
 *
 * `ts.createSourceFile` parses plain JavaScript, ships with the workspace already, and gives exact
 * offsets that convert to a line and column. A regex over the bundle would be the obvious cheap
 * alternative and it is the wrong tool twice over: it cannot tell `x.require` from `require`, and it
 * cannot tell a string containing the word `eval` from a call to it. A rejection has to name a real
 * construct at a real position, because the whole argument for this design is that the failure is
 * one **a person reads and believes**.
 *
 * ## What this does not claim
 *
 * It is not a proof of safety, and nothing here should be written as though it were. It closes the
 * *syntactic* routes out of the bundle. The runtime routes — a `globalThis` walk, a property lookup
 * assembled at run time — are closed by the prelude and by the process boundary, not by this file.
 * See {@link denyScan}'s "known gaps" note.
 */

import { builtinModules } from "node:module";
import ts from "typescript";

/** One reason an artifact was refused, written for whoever is looking at a failed install. */
export interface DenyFinding {
  /** Stable identifier for the rule, so a test can assert on the rule rather than on prose. */
  readonly rule: DenyRule;
  /** The offending construct, quoted from the source as closely as is useful. */
  readonly construct: string;
  /** 1-based, as an editor counts. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  /** One sentence, addressed to the person installing the plugin. */
  readonly message: string;
}

export type DenyRule =
  | "dynamic-import"
  | "builtin-import"
  | "require"
  | "process-binding"
  | "function-constructor"
  | "eval"
  | "parse-error";

export interface DenyScanResult {
  readonly ok: boolean;
  readonly findings: readonly DenyFinding[];
}

/**
 * Node builtins spelled without a prefix.
 *
 * Needed because a bare `"fs"` is a builtin import that the `node:` check would miss, and because
 * `Bun.build` does **not** turn either spelling into a build error the way PLAN.md assumed — see the
 * note in `bundle.ts`. The list is `node:module`'s own, so it cannot drift from the runtime.
 */
const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** True for a specifier that names a host builtin rather than a module inside the bundle's world. */
export function isBuiltinSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("node:") || specifier.startsWith("bun:") || NODE_BUILTINS.has(specifier)
  );
}

/**
 * Scans one bundled JavaScript artifact.
 *
 * `fileName` is only used for the parse and for nothing else — the findings carry positions, and the
 * caller already knows which plugin it is installing.
 *
 * ## Known gaps, stated rather than implied
 *
 * A scan over syntax catches syntax. It does **not** catch a bundle that reaches a builtin through a
 * value it computes at run time — `globalThis["pro"+"cess"]`, a walk over `Object.getOwnPropertyNames`,
 * a `constructor.constructor` chain off any object literal, or an `import.meta`-derived URL. Those are
 * real and they are somebody else's job: the prelude removes what it can from the plugin's global
 * scope, and the process boundary plus `env: {}` is what makes the rest survivable. This file exists
 * so that the *cheap* attacks fail at install with a sentence the user reads.
 */
export function denyScan(source: string, fileName = "bundle.js"): DenyScanResult {
  const file = ts.createSourceFile(
    fileName,
    source,
    { languageVersion: ts.ScriptTarget.ESNext },
    // Parent pointers, because several rules need to know what encloses an identifier — telling
    // `x.require` from `require` is exactly that question.
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );

  const findings: DenyFinding[] = [];
  const at = (node: ts.Node) => {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    return { line: line + 1, column: character + 1 };
  };
  const add = (node: ts.Node, rule: DenyRule, construct: string, message: string) => {
    findings.push({ rule, construct, message, ...at(node) });
  };

  // A file that does not parse is a file nobody can reason about, and running it anyway would mean
  // the scan's verdict depended on the parser agreeing with the runtime. It does not have to.
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;
  if (parseDiagnostics !== undefined && parseDiagnostics.length > 0) {
    const first = parseDiagnostics[0];
    const position =
      first?.start === undefined
        ? { line: 1, column: 1 }
        : (() => {
            const { line, character } = file.getLineAndCharacterOfPosition(first.start);
            return { line: line + 1, column: character + 1 };
          })();
    findings.push({
      rule: "parse-error",
      construct: "the compiled bundle",
      message: `could not be parsed as JavaScript: ${
        first === undefined
          ? "unknown parse error"
          : ts.flattenDiagnosticMessageText(first.messageText, " ")
      }. ${APP} refuses to install code it cannot read.`,
      ...position,
    });
    return { ok: false, findings };
  }

  const visit = (node: ts.Node): void => {
    checkImportLike(node, add);
    checkIdentifierRules(node, add);
    checkProcessBinding(node, add);
    checkFunctionConstructor(node, add);
    ts.forEachChild(node, visit);
  };
  visit(file);

  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return { ok: findings.length === 0, findings };
}

/** Kept short so the messages read as sentences rather than as branding. */
const APP = "vrc.zip";

type Add = (node: ts.Node, rule: DenyRule, construct: string, message: string) => void;

/** The literal text of a string-literal-like expression, or null when it is not one. */
function literalText(expression: ts.Expression | undefined): string | null {
  if (expression === undefined) return null;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  // A template with no substitutions is a literal in every sense that matters here.
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return null;
}

/**
 * `import "x"`, `export … from "x"`, and `import("x")`.
 *
 * Static imports can only ever be literal, so for those the only question is *what* they name. A
 * dynamic `import()` has a second question, and it is the more important one: an argument that is
 * not a literal is `import("node:" + "fs")`, which is the exact attack the hostile plugin performs.
 */
function checkImportLike(node: ts.Node, add: Add): void {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const specifier = literalText(node.moduleSpecifier);
    if (specifier !== null && isBuiltinSpecifier(specifier)) {
      add(
        node,
        "builtin-import",
        `import "${specifier}"`,
        `imports "${specifier}", which is part of the host runtime rather than the plugin. Plugins reach the outside world through the ${APP} plugin API, never through Node or Bun builtins.`,
      );
    }
    return;
  }

  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const argument = node.arguments[0];
    const specifier = literalText(argument);
    if (specifier === null) {
      add(
        node,
        "dynamic-import",
        "import(…)",
        `imports a module whose name is computed while the plugin runs. ${APP} has to be able to see every module a plugin loads before it agrees to run it, so the name has to be written out in full.`,
      );
      return;
    }
    if (isBuiltinSpecifier(specifier)) {
      add(
        node,
        "builtin-import",
        `import("${specifier}")`,
        `imports "${specifier}", which is part of the host runtime rather than the plugin. Plugins reach the outside world through the ${APP} plugin API, never through Node or Bun builtins.`,
      );
    }
  }
}

/**
 * `require` and `eval`, both judged on the identifier rather than on the call.
 *
 * Judging the call would miss the aliasing that makes both of them interesting: `const r = require`
 * and `const e = eval` are one line each, and indirect `eval` is a documented JavaScript feature
 * rather than an obscure trick. So any *reference* to either name is a finding, with one carve-out —
 * `eval("a literal")` is exactly as powerful as writing the literal out, and rejecting it would fail
 * bundles for no gain.
 *
 * Property positions are excluded: `x.require`, `{ require: 1 }` and `class { eval() {} }` say
 * nothing about the global. A *binding* named `require` or `eval` is deliberately still a finding —
 * a bundle that defines its own `require` is a bundle carrying a module loader, which is the thing
 * this rule exists to refuse.
 */
function checkIdentifierRules(node: ts.Node, add: Add): void {
  if (!ts.isIdentifier(node)) return;
  const name = node.text;
  if (name !== "require" && name !== "eval") return;
  if (isPropertyPosition(node)) return;

  if (name === "require") {
    add(
      node,
      "require",
      "require",
      `uses "require", the CommonJS module loader. Plugins are ES modules and everything they use is compiled into one file at install, so a plugin that still reaches for "require" is trying to load something ${APP} never saw.`,
    );
    return;
  }

  if (isEvalOfLiteral(node)) return;
  add(
    node,
    "eval",
    "eval",
    `uses "eval" on something it builds while it runs. That is a plugin that can decide what code to execute after you have already agreed to install it, so ${APP} refuses it at install instead.`,
  );
}

/** True when the identifier is a member name or a property key, not a reference to a binding. */
function isPropertyPosition(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    // `{ require: x }` names a key. `{ require }` is shorthand and *does* reference the binding, so
    // it is not excused.
    return !ts.isShorthandPropertyAssignment(parent);
  }
  return false;
}

/** `eval("…")` with exactly one string-literal argument. Nothing else counts. */
function isEvalOfLiteral(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined || !ts.isCallExpression(parent) || parent.expression !== node) {
    return false;
  }
  if (parent.arguments.length !== 1) return false;
  return literalText(parent.arguments[0]) !== null;
}

/**
 * `process.binding` and `process["binding"]`.
 *
 * The one hole in Node's own module story: it hands out raw internal bindings without going through
 * the loader at all, so a bundle that reaches it has the filesystem regardless of what the import
 * rules above said. Both spellings, because the bracket form is what someone writes when they know
 * the dotted one is being looked for.
 */
function checkProcessBinding(node: ts.Node, add: Add): void {
  let matched = false;
  if (ts.isPropertyAccessExpression(node) && node.name.text === "binding") {
    matched = isProcessReference(node.expression);
  } else if (ts.isElementAccessExpression(node)) {
    matched =
      literalText(node.argumentExpression) === "binding" && isProcessReference(node.expression);
  }
  if (!matched) return;
  add(
    node,
    "process-binding",
    "process.binding",
    `reaches for "process.binding", which hands out the host runtime's internals directly. There is no legitimate use of it in a plugin.`,
  );
}

/** `process`, or `globalThis.process`. */
function isProcessReference(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "process";
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === "process";
  if (ts.isElementAccessExpression(expression))
    return literalText(expression.argumentExpression) === "process";
  return false;
}

/**
 * `new Function(…)` and `Function(…)`.
 *
 * PLAN.md names the `new` form; the call form is the same constructor with the same power, and a
 * rule that caught only one of them would be a rule whose bypass is deleting four characters.
 * `Function.prototype` and other property reads are untouched — those are not construction.
 */
function checkFunctionConstructor(node: ts.Node, add: Add): void {
  const isNew = ts.isNewExpression(node);
  const isCall = ts.isCallExpression(node);
  if (!isNew && !isCall) return;
  const callee = node.expression;
  if (!ts.isIdentifier(callee) || callee.text !== "Function") return;
  add(
    node,
    "function-constructor",
    isNew ? "new Function(…)" : "Function(…)",
    `builds a function out of a string while it runs, which is another way of writing "eval". ${APP} has to be able to see a plugin's code before it agrees to run it.`,
  );
}

/** The findings as text, ready to put in front of a person unchanged. */
export function formatDenyFindings(findings: readonly DenyFinding[]): string {
  return findings
    .map(
      (finding) =>
        `line ${String(finding.line)}, column ${String(finding.column)}: ${finding.construct} ${finding.message}`,
    )
    .join("\n");
}
