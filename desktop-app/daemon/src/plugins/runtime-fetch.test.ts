import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { pluginRuntimePath } from "./process-transport.ts";
import {
  BUN_RUNTIME_PINS,
  BUN_RUNTIME_PINS_VERSION,
  extractSingleFile,
  fetchPluginRuntime,
  installRuntimeFromFile,
  runtimeAssetName,
  runtimeAssetUrl,
} from "./runtime-fetch.ts";

/**
 * **Nothing here touches the network.** The download path is driven against a local `Bun.serve`, the
 * same way the VRChat fixture server works, because the failures worth catching are HTTP-level —
 * a streamed body, a content-length that lies, a redirect — and a `fetch` stub hides all of them.
 *
 * The archive is built by the zip writer below rather than by shelling out, so the test has no
 * dependency on `tar.exe` and the reader is exercised against bytes this file wrote deliberately.
 */

let stateRoot: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "vrczip-runtime-"));
  env = { VRCZIP_STATE_DIR: stateRoot };
});

afterEach(() => {
  try {
    rmSync(stateRoot, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});

/* ------------------------------------------------------------------------------------------------
 * A minimal zip writer, so the reader is tested against real bytes
 * ---------------------------------------------------------------------------------------------- */

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `entries` is path-inside-the-zip → contents. `deflate` picks method 8 over method 0. */
function makeZip(entries: Record<string, Uint8Array>, deflate = true): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(entries)) {
    const nameBytes = new TextEncoder().encode(name);
    const compressed = deflate ? new Uint8Array(deflateRawSync(contents)) : contents;
    const method = deflate ? 8 : 0;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc32(contents), true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, contents.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const entry = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(10, method, true);
    entryView.setUint32(16, crc32(contents), true);
    entryView.setUint32(20, compressed.length, true);
    entryView.setUint32(24, contents.length, true);
    entryView.setUint16(28, nameBytes.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);

    chunks.push(local, compressed);
    offset += local.length + compressed.length;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, central.length, true);
  eocdView.setUint16(10, central.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let at = 0;
  for (const part of all) {
    output.set(part, at);
    at += part.length;
  }
  return output;
}

const BINARY_NAME = process.platform === "win32" ? "bun.exe" : "bun";
const FAKE_BINARY = new TextEncoder().encode("#!/bin/sh\necho pretend-bun\n");

function fixtureArchive(deflate = true): Uint8Array {
  return makeZip({ [`bun-fixture/${BINARY_NAME}`]: FAKE_BINARY }, deflate);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pinsFor(archive: Uint8Array): Record<string, string> {
  const asset = runtimeAssetName(process.platform, process.arch);
  if (asset === null) throw new Error("this platform has no Bun release, so the test cannot run");
  return { [asset]: sha256(archive) };
}

/* ------------------------------------------------------------------------------------------------
 * The zip reader
 * ---------------------------------------------------------------------------------------------- */

describe("extractSingleFile", () => {
  test("finds an entry by its base name, through a directory prefix", () => {
    expect(extractSingleFile(fixtureArchive(), BINARY_NAME)).toEqual(FAKE_BINARY);
  });

  test("reads stored entries as well as deflated ones", () => {
    expect(extractSingleFile(fixtureArchive(false), BINARY_NAME)).toEqual(FAKE_BINARY);
  });

  test("ignores every entry that is not the one asked for", () => {
    const archive = makeZip({
      "bun-fixture/LICENSE": new TextEncoder().encode("MIT"),
      [`bun-fixture/${BINARY_NAME}`]: FAKE_BINARY,
      "../../evil.exe": new TextEncoder().encode("nope"),
    });
    expect(extractSingleFile(archive, BINARY_NAME)).toEqual(FAKE_BINARY);
  });

  test("says so when the archive holds no such file", () => {
    expect(() => extractSingleFile(fixtureArchive(), "not-there")).toThrow("does not contain");
  });

  test("says so when the bytes are not a zip at all", () => {
    expect(() => extractSingleFile(new TextEncoder().encode("not a zip"), BINARY_NAME)).toThrow(
      "not a zip",
    );
  });
});

/* ------------------------------------------------------------------------------------------------
 * The download path, against a local server
 * ---------------------------------------------------------------------------------------------- */

describe("fetchPluginRuntime", () => {
  test("verifies the pin, extracts, and lands at the resolver's path", async () => {
    const archive = fixtureArchive();
    const server = Bun.serve({ port: 0, fetch: () => new Response(archive) });
    try {
      const result = await fetchPluginRuntime({
        env,
        baseUrl: server.url.origin,
        pins: pinsFor(archive),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The path the transport will look in, derived by the transport's own helper.
      expect(result.path).toBe(pluginRuntimePath(env));
      expect(result.installed).toBe(true);
      expect(new Uint8Array(readFileSync(result.path))).toEqual(FAKE_BINARY);
    } finally {
      await server.stop(true);
    }
  });

  test("a hash that does not match writes nothing at all", async () => {
    const archive = fixtureArchive();
    const server = Bun.serve({ port: 0, fetch: () => new Response(archive) });
    try {
      const asset = runtimeAssetName(process.platform, process.arch) ?? "";
      const result = await fetchPluginRuntime({
        env,
        baseUrl: server.url.origin,
        pins: { [asset]: "f".repeat(64) },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.detail).toContain("not the one this build of vrc.zip expects");
      expect(result.detail).toContain("f".repeat(64));
      expect(Bun.file(pluginRuntimePath(env)).size).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("an unpinned platform refuses rather than downloading anything", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1;
        return new Response(fixtureArchive());
      },
    });
    try {
      const result = await fetchPluginRuntime({ env, baseUrl: server.url.origin, pins: {} });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.detail).toContain("no pinned checksum");
      expect(requests).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a server error names the URL and the expected hash, so a person can do it by hand", async () => {
    const archive = fixtureArchive();
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    try {
      const result = await fetchPluginRuntime({
        env,
        baseUrl: server.url.origin,
        pins: pinsFor(archive),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.detail).toContain(server.url.origin);
      expect(result.detail).toContain(sha256(archive));
    } finally {
      await server.stop(true);
    }
  });

  test("progress is reported while the body streams", async () => {
    const archive = fixtureArchive();
    const server = Bun.serve({ port: 0, fetch: () => new Response(archive) });
    const seen: number[] = [];
    try {
      await fetchPluginRuntime({
        env,
        baseUrl: server.url.origin,
        pins: pinsFor(archive),
        onProgress: (received) => seen.push(received),
      });
      expect(seen.at(-1)).toBe(archive.length);
    } finally {
      await server.stop(true);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * Decision 111's manual escape path
 * ---------------------------------------------------------------------------------------------- */

describe("installRuntimeFromFile", () => {
  test("installs a hand-downloaded archive through the same verification", async () => {
    const archive = fixtureArchive();
    const path = join(stateRoot, "bun.zip");
    writeFileSync(path, archive);

    const result = await installRuntimeFromFile(path, { env, pins: pinsFor(archive) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Uint8Array(readFileSync(result.path))).toEqual(FAKE_BINARY);
  });

  test("refuses a hand-downloaded archive that is not the pinned one", async () => {
    const path = join(stateRoot, "bun.zip");
    writeFileSync(path, fixtureArchive());
    const asset = runtimeAssetName(process.platform, process.arch) ?? "";

    const result = await installRuntimeFromFile(path, { env, pins: { [asset]: "0".repeat(64) } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("discarded");
  });
});

describe("asset naming", () => {
  test("maps the platforms Bun publishes for, and refuses the ones it does not", () => {
    expect(runtimeAssetName("win32", "x64")).toBe("bun-windows-x64.zip");
    expect(runtimeAssetName("linux", "arm64")).toBe("bun-linux-aarch64.zip");
    expect(runtimeAssetName("darwin", "arm64")).toBe("bun-darwin-aarch64.zip");
    expect(runtimeAssetName("win32", "arm64")).toBeNull();
    expect(runtimeAssetName("aix", "x64")).toBeNull();
  });

  test("the URL carries the version tag, which is the pin's other half", () => {
    expect(runtimeAssetUrl("1.4.0", "bun-windows-x64.zip")).toBe(
      "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-x64.zip",
    );
  });
});

/**
 * The pin table itself.
 *
 * These are here because the table shipped *empty* once. Every unit test passed — they all supply
 * their own pins, which is right for exercising the download path and exactly why none of them
 * noticed — and the packaged build then refused to install any plugin at all, because it has no
 * `bun` on `PATH` to fall back to. The table is a build input, so it gets build-input tests.
 */
describe("BUN_RUNTIME_PINS", () => {
  /** Every platform the daemon will ask for, derived rather than listed, so a new one is covered. */
  const PLATFORMS: [string, string][] = [
    ["win32", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "x64"],
    ["darwin", "arm64"],
  ];

  test("covers every platform Bun publishes a release for", () => {
    const missing = PLATFORMS.map(([platform, arch]) => runtimeAssetName(platform, arch))
      .filter((asset): asset is string => asset !== null)
      .filter((asset) => BUN_RUNTIME_PINS[asset] === undefined);
    expect(missing).toEqual([]);
  });

  test("every pin is a lowercase 64-character SHA-256", () => {
    // A placeholder, a truncated paste, or an uppercased digest would each fail the comparison at
    // install time on a user's machine instead of here.
    for (const [asset, digest] of Object.entries(BUN_RUNTIME_PINS)) {
      expect(`${asset}: ${digest}`).toMatch(/^[a-z0-9.-]+\.zip: [0-9a-f]{64}$/);
    }
  });

  test("names the same Bun as `.bun-version`", async () => {
    // The table is keyed by asset name, which carries no version. This is the assertion that makes
    // bumping Bun without re-hashing a red CI run rather than a broken install.
    const pinned = (
      await Bun.file(new URL("../../../.bun-version", import.meta.url)).text()
    ).trim();
    expect(BUN_RUNTIME_PINS_VERSION).toBe(pinned);
  });

  test("refuses rather than checking a hash from a different release", async () => {
    const result = await fetchPluginRuntime({
      version: "9.9.9",
      platform: "win32",
      arch: "x64",
      env,
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.detail).toContain("9.9.9");
  });
});
