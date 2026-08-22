/**
 * Reaches for the filesystem the only way that still works.
 *
 * PLAN.md is explicit that a prelude **cannot** disable the `import()` operator, so scrubbing
 * globals does not stop this: the specifier is assembled at runtime, which defeats any static
 * matcher looking for a literal `"node:fs"`, and the operator itself is syntax rather than
 * something reachable through `globalThis`.
 *
 * So this file is aimed squarely at the install-time deny-scan, which runs over the **bundled
 * output** and rejects non-literal `import()` outright rather than trying to decide where a
 * computed specifier points. A scanner that only rejected literal `node:` imports would pass this,
 * and the thing it would be passing is a plugin that can read the database holding VRChat auth
 * cookies.
 *
 * The process boundary is what stands behind the scan, and it is why "the scan has a bug" is a
 * recoverable situation rather than a total one.
 *
 * **Measured, and not what the second half of this file assumed.** Of the three routes below, the
 * scan reports exactly one finding — `dynamic-import`. The other two walk straight past it, and the
 * reasons are worth writing down because they are the same shape:
 *
 *  - `const make = Function; make("…")` is not caught. The `function-constructor` rule matches a
 *    call or `new` whose *callee identifier* is `Function`, and one assignment defeats that. The
 *    rule's own doc comment already says the `constructor.constructor` chain gets past it; a plain
 *    alias does too, which is a lower bar.
 *  - `require` is not caught either, because here it exists only inside a string the built function
 *    would evaluate — and a string is not an identifier. The `require` rule is doing the right thing
 *    by not reading inside string literals; the point is that the *route* survives.
 *
 * So this file rejects on the import and would still have compiled a bundle carrying the other two
 * if the import were removed. What stops those at run time is the prelude, which removes `Function`'s
 * usefulness by emptying the realm rather than by taking the constructor away — see `globals.js`.
 */
const parts = ["no", "de:", "fs"];

async function reach() {
  const specifier = parts.join("");
  const fs = await import(specifier);
  return typeof fs.readFileSync === "function";
}

// Also via `require`, and also via `Function` — both of which the scan does *not* catch here. See
// the header: the alias defeats the `function-constructor` rule and the string defeats the
// `require` one, and the suite asserts that only one finding comes back.
function reachAgain() {
  const make = Function;
  const get = make("return typeof require === 'function' ? require : null");
  const req = get();
  return req === null ? null : req("node:fs");
}

export async function activate() {
  return { viaImport: await reach(), viaRequire: reachAgain() !== null };
}
