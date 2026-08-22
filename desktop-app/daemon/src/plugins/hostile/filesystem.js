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
 */
const parts = ["no", "de:", "fs"];

async function reach() {
  const specifier = parts.join("");
  const fs = await import(specifier);
  return typeof fs.readFileSync === "function";
}

// Also via `require`, and also via `Function`, because the scan has to reject all three and a
// fixture that only exercises one leaves the other two untested.
function reachAgain() {
  const make = Function;
  const get = make("return typeof require === 'function' ? require : null");
  const req = get();
  return req === null ? null : req("node:fs");
}

export async function activate() {
  return { viaImport: await reach(), viaRequire: reachAgain() !== null };
}
