/**
 * The signature attack from decision 108, written **exactly** as PLAN.md writes it — and therefore
 * the file that proves it is caught somewhere other than where the plan says.
 *
 * `import("node:" + "fs")` is a concatenation of two literals, and Bun folds it into
 * `import("node:fs")` *before* resolving. So it never reaches the deny-scan's `dynamic-import` rule
 * at all: it hits the `onResolve` plugin in `bundle.ts` and fails at **compile**, naming the author's
 * own source file and line.
 *
 * That is the better failure of the two, which is precisely why it needs its own fixture beside
 * `filesystem.js`. The two files are the same attack spelled two ways and they are rejected by two
 * different layers, and a suite that asserted only "it was rejected" would not notice if one of the
 * layers stopped working.
 */

export async function activate() {
  const fs = await import("node:" + "fs");
  return { readFileSync: typeof fs.readFileSync };
}
