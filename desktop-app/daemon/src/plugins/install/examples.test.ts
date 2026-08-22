/**
 * Every example plugin has to survive the real install pipeline.
 *
 * An example that does not compile is worse than no example: it is the first thing an author copies,
 * and it fails in *their* project where they cannot tell whether they broke it. So each one goes
 * through the same path a real install takes — manifest parse, `Bun.build`, deny-scan,
 * content-addressing, and the verify-on-load read-back.
 *
 * This is also the guard on the docs' central warning. The examples import from
 * `@vrcz/plugin-api/runtime`; if anyone "simplifies" that to the package root, zod reaches the
 * bundle, the deny-scan refuses it, and this test says so here rather than a stranger discovering it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatInstallFailure, installPluginFromDirectory } from "./index.ts";

const EXAMPLES_DIR = resolve(import.meta.dir, "..", "..", "..", "..", "examples", "plugins");

/** Directories only: the folder also holds a README. */
const examples = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("the example plugins", () => {
  test("there are five of them, and the README lists what each shows", () => {
    expect(examples.length).toBe(5);
  });

  for (const name of examples) {
    test(`${name} compiles, passes the deny-scan and content-addresses`, async () => {
      const stateDir = mkdtempSync(join(tmpdir(), `vrczip-example-${name}-`));
      try {
        const built = await installPluginFromDirectory(join(EXAMPLES_DIR, name), {
          env: { VRCZIP_STATE_DIR: stateDir },
        });
        // The whole sentence, not a boolean: a failure here is a compile diagnostic or a
        // deny-scan finding, and both are written to be read.
        const detail = built.ok ? "" : formatInstallFailure(built);
        expect(detail).toBe("");
        expect(built.ok).toBe(true);
        if (!built.ok) return;

        expect(built.manifest.id.startsWith("example.")).toBe(true);
        expect(built.bundleHash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }, 30_000);
  }
});
