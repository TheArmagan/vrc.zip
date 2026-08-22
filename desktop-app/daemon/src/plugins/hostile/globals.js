/**
 * Reaches the host runtime through values it computes, so that no rule in the deny-scan has a
 * syntactic construct to match on.
 *
 * Every line here is **verified to pass the real scanner** — that is the point of the file. The scan
 * catches syntax and only syntax, and each of these is the same capability written so that there is
 * no syntax left to catch:
 *
 *  - `({}).constructor.constructor` is the `Function` constructor reached through a property chain,
 *    so the `function-constructor` rule (which matches the *identifier* `Function`) never fires. That
 *    rule is a convenience, not a gate, and this line is why.
 *  - `globalThis["pro" + "cess"]["bind" + "ing"]` is `process.binding` with the two names assembled
 *    at run time, so the `process-binding` rule's literal check never fires.
 *  - A `require` assembled from an array join is never an identifier named `require`.
 *  - `import.meta.url` is not an import.
 *  - Plain `process.env` access has no rule at all.
 *
 * So the honest question this file asks is not "does the scan stop it" — it does not, and a test
 * pretending otherwise would be worse than no test. It is **"what does stop it, once it is running"**,
 * and the answers are the prelude's scrubbing and the scrubbed environment. The plugin reports what
 * it actually found back through the host log, and the suite asserts on that report rather than on
 * the absence of an install failure.
 */

const host = globalThis.__vrczHost;

function probe(name, read) {
  try {
    return [name, String(read())];
  } catch (error) {
    return [name, `threw: ${String(error?.message || error)}`];
  }
}

function survey() {
  const findings = [
    // The Function constructor, reached without ever naming it.
    probe("function-constructor", () => typeof {}.constructor.constructor),
    // Which is only interesting if the realm it evaluates in still has anything in it.
    probe("function-constructor-reaches-fetch", () =>
      ({}).constructor.constructor("return typeof fetch")(),
    ),
    probe("function-constructor-reaches-globalthis", () =>
      ({}).constructor.constructor("return typeof globalThis")(),
    ),
    // process.binding, spelled so no literal exists to match.
    probe("computed-process-binding", () => {
      const p = globalThis[`pro${"cess"}`];
      return typeof p[`bind${"ing"}`];
    }),
    // A module loader assembled from parts.
    probe("computed-require", () => typeof globalThis[["re", "qu", "ire"].join("")]),
    // No rule covers this, and it is the one thing here that still discloses something.
    probe("import-meta-url", () => import.meta.url),
    probe("process-env-keys", () => JSON.stringify(Object.keys(globalThis.process.env))),
    // `Bun` itself cannot be removed; its members can. This asks whether the removal held.
    probe("bun-file", () => typeof globalThis.Bun.file),
    probe("bun-spawn", () => typeof globalThis.Bun.spawn),
    // `Bun.env` is non-writable, so it survives `process.env = {}`. What it says is the question.
    probe("bun-env", () => JSON.stringify(globalThis.Bun.env)),
    probe("cwd", () => globalThis.process.cwd()),
  ];
  return Object.fromEntries(findings);
}

host.log(`SURVEY ${JSON.stringify(survey())}`);

export function activate() {
  return survey();
}
