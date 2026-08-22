/**
 * The published plugin runtime has to survive the install pipeline like anything else.
 *
 * `@vrcz/plugin-api`'s `definePlugin` and `ctx` ship as library code the plugin bundles rather than
 * as prelude the host injects, and the header on `runtime.ts` claims a benefit from that: it gets
 * deny-scanned and content-addressed exactly like the author's own code. That is a claim about a
 * scanner, so it is worth running the scanner.
 *
 * It is also a regression guard with teeth. The deny-scan refuses `require`, builtin imports,
 * `Function(…)`, `process.binding` and non-literal `import()`. A future convenience added to the
 * runtime — a dynamic import for an optional feature, say — would make **every plugin that imports
 * the package** uninstallable, and the failure would surface as a third-party plugin's install
 * error rather than as ours.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { denyScan, formatDenyFindings } from "./deny-scan.ts";

/**
 * Bundles the runtime the way the install pipeline bundles a plugin: browser target, nothing
 * external, so the package's own code is inlined rather than left as an import.
 */
async function bundleRuntime(specifier = "@vrcz/plugin-api/runtime"): Promise<string> {
  // Inside the workspace, not the system temp directory: `@vrcz/plugin-api` resolves through Bun's
  // workspace symlinks in `node_modules`, and a file in `%TEMP%` has no `node_modules` above it. A
  // real plugin resolves it the same way — from its own directory, with the package installed.
  const dir = mkdtempSync(join(import.meta.dir, "runtime-bundle-"));
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      [
        `import { definePlugin, getContext, PluginCallError } from "${specifier}";`,
        "definePlugin({",
        "  async activate(ctx) {",
        "    await ctx.storage.kv.set('started', Date.now());",
        "    await ctx.events.subscribe((event) => ctx.log(event.kind));",
        "    return { ready: true, id: getContext().pluginId, err: PluginCallError.name };",
        "  },",
        "});",
      ].join("\n"),
    );

    const built = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      external: [],
      minify: false,
    });
    expect(built.success).toBe(true);
    const output = built.outputs[0];
    expect(output).toBeDefined();
    return await (output as { text(): Promise<string> }).text();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the published runtime, through the install pipeline's scanner", () => {
  test("a plugin using definePlugin and ctx bundles and passes the deny-scan", async () => {
    const source = await bundleRuntime();

    // It really did inline the package rather than leave an import behind, or the scan below would
    // be scanning eight lines of the test's own entry file and proving nothing.
    expect(source).toContain("definePlugin");
    expect(source.length).toBeGreaterThan(2000);

    const result = denyScan(source);
    const detail = result.ok ? "" : formatDenyFindings(result.findings);
    expect(detail).toBe("");
    expect(result.ok).toBe(true);
  }, 30_000);

  /**
   * Why the subpath exists, pinned so nobody merges the two entries back together.
   *
   * The package root re-exports `manifest.ts`, which imports **zod**, which uses `eval`,
   * `Function(…)` and `require` internally. Bundled into a plugin with `external: []`, all of that
   * lands in the artifact and the deny-scan refuses it — correctly, since the scan cannot tell a
   * validator's `Function` from an attacker's. The practical effect before the subpath existed:
   * **no plugin importing `@vrcz/plugin-api` could be installed at all**, and the error named the
   * author's own bundle.
   *
   * If this test ever starts passing, zod is no longer reaching the bundle and the subpath may be
   * reconsidered. Until then, an author imports from `@vrcz/plugin-api/runtime`.
   */
  test("the package root is not importable from a plugin: zod trips the scan", async () => {
    const source = await bundleRuntime("@vrcz/plugin-api");
    const result = denyScan(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.findings.some((finding) => finding.rule === "eval" || finding.rule === "require"),
    ).toBe(true);
  }, 30_000);
});
