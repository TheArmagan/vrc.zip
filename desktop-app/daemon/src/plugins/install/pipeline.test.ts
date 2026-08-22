import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_PROTOCOL_MAJOR, type PluginManifestInput } from "@vrcz/plugin-api";
import { hashBundle, loadArtifact, pruneArtifacts, writeArtifact } from "./artifact.ts";
import { installPluginFromDirectory } from "./pipeline.ts";

/**
 * These run the real pipeline against real directories, because every step of it is a filesystem
 * step and a mocked `Bun.build` would be a test of the mock. The state tree is redirected with
 * `VRCZIP_STATE_DIR` so nothing here can touch the developer's own plugins.
 *
 * The load-path assertions are the ones to keep honest: PLAN.md's property is not "we wrote the file
 * under its hash", which is trivially true because we chose the name, but "nothing runs a file whose
 * hash does not match". So the tamper test edits the artifact on disk and asserts the *loader*
 * refuses it.
 */

let stateRoot: string;
let sourceRoot: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "vrczip-install-state-"));
  sourceRoot = mkdtempSync(join(tmpdir(), "vrczip-install-src-"));
  env = { VRCZIP_STATE_DIR: stateRoot };
});

afterEach(() => {
  for (const directory of [stateRoot, sourceRoot]) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort; a leftover temp directory is not a test failure.
    }
  }
});

/**
 * `Record<string, unknown>` rather than `Partial<PluginManifestInput>` on purpose: several of these
 * cases are manifests the *type* forbids and a person can still write, which is exactly what the
 * schema exists to catch.
 */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: PluginManifestInput = {
    id: "acme.hello",
    name: "Hello",
    version: "1.0.0",
    publisher: "Acme",
    main: "index.ts",
    // The one major this build speaks, read from the shared constant rather than written out — the
    // schema pins it, so a hard-coded 1 here would be a test that breaks on the next protocol bump.
    engines: { pluginApi: PLUGIN_API_PROTOCOL_MAJOR },
  };
  return { ...base, ...overrides };
}

/** Writes a plugin folder and returns its path. `files` is relative path → contents. */
function plugin(files: Record<string, string>, overrides: Record<string, unknown> = {}): string {
  const root = join(sourceRoot, `p-${String(Math.random()).slice(2)}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "vrcz-plugin.json"), JSON.stringify(manifest(overrides), null, 2));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

const GOOD_SOURCE = [
  "export function activate(host) {",
  "  return { deactivate() { host.log('bye'); } };",
  "}",
  "",
].join("\n");

describe("the happy path", () => {
  test("compiles, scans, content-addresses, and verifies it back off disk", async () => {
    const result = await installPluginFromDirectory(plugin({ "index.ts": GOOD_SOURCE }), { env });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifest.id).toBe("acme.hello");
    expect(result.sourceKind).toBe("local");
    expect(result.written).toBe(true);
    // The name *is* the hash. That is the whole property.
    expect(result.bundlePath).toBe(
      join(stateRoot, "plugins", "acme.hello", `${result.bundleHash}.js`),
    );
    expect(hashBundle(new Uint8Array(readFileSync(result.bundlePath)))).toBe(result.bundleHash);

    const loaded = loadArtifact("acme.hello", result.bundleHash, env);
    expect(loaded.ok).toBe(true);
  });

  test("a multi-file plugin is bundled into one artifact", async () => {
    const root = plugin({
      "index.ts":
        'import { greet } from "./greet.ts";\nexport function activate() { return greet(); }\n',
      "greet.ts": 'export function greet() { return "hi"; }\n',
    });
    const result = await installPluginFromDirectory(root, { env });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(result.bundlePath, "utf8")).toContain("hi");
  });

  test("reinstalling identical source is a no-op at the same hash", async () => {
    const root = plugin({ "index.ts": GOOD_SOURCE });
    const first = await installPluginFromDirectory(root, { env });
    const second = await installPluginFromDirectory(root, { env });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.bundleHash).toBe(first.bundleHash);
    expect(second.written).toBe(false);
  });
});

describe("what it refuses, and at which step", () => {
  test("a folder with no manifest", async () => {
    const root = join(sourceRoot, "empty");
    mkdirSync(root, { recursive: true });
    const result = await installPluginFromDirectory(root, { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("source");
    expect(result.message).toContain("vrcz-plugin.json");
  });

  test("a manifest that asks for a permission that does not exist", async () => {
    const root = plugin(
      { "index.ts": GOOD_SOURCE },
      { permissions: { capabilities: ["network"] } },
    );
    const result = await installPluginFromDirectory(root, { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("manifest");
    expect(result.manifestIssues?.length).toBeGreaterThan(0);
  });

  test("a manifest whose main file is not there", async () => {
    const root = plugin({}, { main: "missing.ts" });
    const result = await installPluginFromDirectory(root, { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("source");
    expect(result.message).toContain("missing.ts");
  });

  test("a static node: import fails the build, with the sentence an author needs", async () => {
    // The plan says Bun.build makes this a hard error. It does not — `target: "browser"` silently
    // stubs it — so the bundler's resolver plugin is what makes the promise true. See bundle.ts.
    const root = plugin({
      "index.ts":
        'import { readFileSync } from "node:fs";\nexport function activate() { readFileSync("x"); }\n',
    });
    const result = await installPluginFromDirectory(root, { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("compile");
    expect(result.message).toContain("node:fs");
    expect(result.message).toContain("not available to plugins");
  });

  test("the bare spelling of a builtin fails the same way", async () => {
    const root = plugin({
      "index.ts":
        'import { readFileSync } from "fs";\nexport function activate() { readFileSync("x"); }\n',
    });
    const result = await installPluginFromDirectory(root, { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("compile");
  });

  test('import("node:" + "fs") is constant-folded and caught at the build, not the scan', async () => {
    // Worth pinning: Bun folds a concatenation of two literals before resolving, so the hostile
    // plugin's own attack never reaches the deny-scan. That is a better failure, and it means the
    // scan's dynamic-import rule is guarding the *other* shape rather than this one.
    const root = plugin({
      "index.ts": 'export async function activate() { return await import("node:" + "fs"); }\n',
    });
    const result = await installPluginFromDirectory(root, { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("compile");
    expect(result.message).toContain("node:fs");
  });

  test("a dynamic import the bundler cannot see through is caught by the deny-scan", async () => {
    const root = plugin({
      "index.ts": [
        "export async function activate(host) {",
        "  const name = host.settings.get('module');",
        "  return await import(name);",
        "}",
        "",
      ].join("\n"),
    });
    const result = await installPluginFromDirectory(root, { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("deny-scan");
    expect(result.findings?.[0]?.rule).toBe("dynamic-import");
    expect(result.findings?.[0]?.line).toBeGreaterThan(0);
  });

  test("nothing is written when a step says no", async () => {
    const root = plugin({ "index.ts": "export function activate() { eval(globalThis.x); }\n" });
    const result = await installPluginFromDirectory(root, { env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("deny-scan");
    expect(existsSync(join(stateRoot, "plugins", "acme.hello"))).toBe(false);
  });
});

describe("the load path", () => {
  test("an artifact edited after install will not load", async () => {
    const result = await installPluginFromDirectory(plugin({ "index.ts": GOOD_SOURCE }), { env });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    writeFileSync(result.bundlePath, "export function activate() { /* swapped */ }\n");

    const loaded = loadArtifact("acme.hello", result.bundleHash, env);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.detail).toContain("has changed since it was installed");
  });

  test("a missing artifact is a plain answer, not a throw", () => {
    const loaded = loadArtifact("acme.hello", "0".repeat(64), env);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.detail).toContain("missing");
  });

  test("pruning keeps the named hash and removes the rest", () => {
    const first = writeArtifact("acme.hello", new TextEncoder().encode("one"), env);
    const second = writeArtifact("acme.hello", new TextEncoder().encode("two"), env);
    expect(pruneArtifacts("acme.hello", second.hash, env)).toBe(1);
    expect(loadArtifact("acme.hello", second.hash, env).ok).toBe(true);
    expect(loadArtifact("acme.hello", first.hash, env).ok).toBe(false);
  });
});
