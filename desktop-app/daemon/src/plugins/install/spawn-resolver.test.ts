import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_PROTOCOL_MAJOR, type PluginManifestInput } from "@vrcz/plugin-api";
import { MEMORY, Store } from "../../store/store.ts";
import type { NewPlugin } from "../../store/types.ts";
import { writeArtifact } from "./artifact.ts";
import {
  createSpawnResolver,
  SMOL_MEMORY_LIMIT_BYTES,
  THROUGHPUT_MEMORY_LIMIT_BYTES,
} from "./spawn-resolver.ts";

/**
 * `spawnFor` is the load path, so these tests are really about one sentence in PLAN.md: *"verify the
 * hash on every load."* The tamper case is the reason the file exists — a plugin whose artifact was
 * edited after install must not start, and the refusal has to arrive as a *sentence*, because
 * `spawnFor` can only answer `null` and "could not find its files" is the wrong thing to tell
 * someone whose plugin was modified.
 */

const NOW = 1_706_659_200_000;
const BUNDLE = new TextEncoder().encode("export function activate() {}\n");

let stateRoot: string;
let env: NodeJS.ProcessEnv;
let store: Store;
let refusals: { pluginId: string; detail: string }[];

function manifestJson(performance?: "smol" | "throughput"): string {
  const manifest: PluginManifestInput = {
    id: "acme.hello",
    name: "Hello",
    version: "1.0.0",
    publisher: "Acme",
    main: "index.ts",
    engines: { pluginApi: PLUGIN_API_PROTOCOL_MAJOR },
    ...(performance === undefined ? {} : { performance }),
  };
  return JSON.stringify(manifest);
}

function row(overrides: Partial<NewPlugin> = {}): NewPlugin {
  return {
    id: "acme.hello",
    version: "1.0.0",
    manifest: manifestJson(),
    bundle_hash: "a".repeat(64),
    source_kind: "local",
    source_ref: "C:/plugins/hello",
    trust: "unsigned",
    publisher_key: null,
    installed_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "vrczip-spawnfor-"));
  env = { VRCZIP_STATE_DIR: stateRoot };
  store = Store.open(MEMORY);
  refusals = [];
});

afterEach(() => {
  store.close();
  try {
    rmSync(stateRoot, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});

function resolver() {
  return createSpawnResolver({
    store,
    env,
    onRefused: (pluginId, detail) => refusals.push({ pluginId, detail }),
  });
}

describe("createSpawnResolver", () => {
  test("resolves an installed plugin to its verified artifact", () => {
    const written = writeArtifact("acme.hello", BUNDLE, env);
    store.upsertPlugin(row({ bundle_hash: written.hash }));

    const spawn = resolver()("acme.hello");
    expect(spawn?.bundlePath).toBe(written.path);
    expect(spawn?.smol).toBe(true);
    expect(spawn?.memoryLimitBytes).toBe(SMOL_MEMORY_LIMIT_BYTES);
    expect(refusals).toEqual([]);
  });

  test('a manifest that opted into "throughput" drops --smol and gets the larger ceiling', () => {
    const written = writeArtifact("acme.hello", BUNDLE, env);
    store.upsertPlugin(row({ bundle_hash: written.hash, manifest: manifestJson("throughput") }));

    const spawn = resolver()("acme.hello");
    expect(spawn?.smol).toBe(false);
    expect(spawn?.memoryLimitBytes).toBe(THROUGHPUT_MEMORY_LIMIT_BYTES);
  });

  test("an artifact edited after install does not start, and says why", () => {
    const written = writeArtifact("acme.hello", BUNDLE, env);
    store.upsertPlugin(row({ bundle_hash: written.hash }));
    writeFileSync(written.path, "export function activate() { /* swapped */ }\n");

    expect(resolver()("acme.hello")).toBeNull();
    expect(refusals[0]?.detail).toContain("has changed since it was installed");
  });

  test("a plugin with no row, and a plugin with no file, both refuse with their own sentence", () => {
    expect(resolver()("acme.missing")).toBeNull();
    expect(refusals[0]?.detail).toContain("not installed");

    store.upsertPlugin(row());
    expect(resolver()("acme.hello")).toBeNull();
    expect(refusals[1]?.detail).toContain("missing");
  });

  test("a stored manifest that no longer parses falls back to the smaller mode", () => {
    const written = writeArtifact("acme.hello", BUNDLE, env);
    store.upsertPlugin(row({ bundle_hash: written.hash, manifest: "not json" }));

    const spawn = resolver()("acme.hello");
    expect(spawn?.smol).toBe(true);
  });
});
