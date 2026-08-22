/**
 * Fetching the plugin runtime — PROGRESS.md decision 111, and the TODO at the top of
 * `process-transport.ts` made real.
 *
 * The daemon ships as a single compiled `.exe` and a compiled Bun binary cannot be re-invoked as a
 * script host, so the runtime that executes third-party plugin code is a **real `bun`, fetched on
 * first plugin install and pinned by the SHA-256 of the release asset**. `process-transport.ts` owns
 * where it lives and how it is found ({@link pluginRuntimePath}, {@link resolvePluginRuntime}); this
 * file owns getting it there. Those helpers are imported rather than re-derived — two answers to
 * "where is the runtime" is one answer too many.
 *
 * ## The pin is the trust anchor, and there is no way around it
 *
 * Decision 111, verbatim on this point: *"A mismatch discards the download and fails hard: no
 * warning, no prompt offering to run it anyway, and never a silent fallback to a `PATH` Bun. A
 * downloaded executable that is not the one we pinned is the worst thing this app could execute."*
 * So there is no `--force`, no "trust this once", and an unpinned platform is a refusal rather than
 * a shrug. HTTPS is not the check; the hash is.
 *
 * ## The Bun pin now lives in FOUR places and they must move together
 *
 * 1. `package.json` → `packageManager`
 * 2. `package.json` → `engines.bun`
 * 3. `.bun-version`
 * 4. {@link BUN_RUNTIME_PINS} in this file — the SHA-256 of each platform's release asset
 *
 * CLAUDE.md still says three. Decision 111 already records that it is four.
 *
 * ## Unzipping, chosen rather than inherited
 *
 * The release asset is a `.zip` and Bun has no built-in unzip. Decision 111 names the two candidates
 * and asks for a deliberate choice: shelling out to `tar.exe` (bsdtar reads zip, and ships on Windows
 * 10+ and macOS — but *not* on Linux, where `tar` is GNU tar and does not), or a central-directory
 * reader over `node:zlib`. **The reader, here.** Spawning an archiver to install the thing we spawn
 * inverts the dependency, behaves differently on the three platforms, and hands a step of the trust
 * chain to whatever binary happens to answer to that name on `PATH`. The reader below is a hundred
 * lines that does the same thing identically everywhere, and it only ever extracts one known entry.
 *
 * ## The escape path
 *
 * Decision 111 promises *"a manual 'use this `bun` instead' path that verifies against the same
 * pin"*, for users who are offline, behind a proxy, or on a blocked host. That is
 * {@link installRuntimeFromFile}: point it at a `.zip` downloaded by hand and it installs it through
 * exactly the same verify-extract-rename path, refusing exactly the same mismatches. The *unverified*
 * escape — "run this bun, I know what I am doing" — already exists one layer down as
 * `ProcessTransportDeps.runtimePath`, and it is deliberately the one that does not pretend to check
 * anything.
 *
 * Expect antivirus to have opinions. Downloading an executable into `%LOCALAPPDATA%` and spawning it
 * is a textbook malware shape, and decision 111 says so rather than being surprised by it later.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { stateDir } from "../paths.ts";
import {
  PLUGIN_RUNTIME_DIR,
  pluginRuntimePath,
  resolvePluginRuntime,
} from "./process-transport.ts";

/* ------------------------------------------------------------------------------------------------
 * The pin
 * ---------------------------------------------------------------------------------------------- */

/**
 * SHA-256 of each platform's Bun release `.zip`, keyed by asset name.
 *
 * **This table is a build input, not a developer convenience.** It is the fourth home of the Bun pin
 * (see the file header), and it is what makes decision 14's claim true — that the runtime executing
 * third-party plugin code is the exact one we tested against, on every machine.
 *
 * An unpinned platform **refuses to fetch**, naming the URL and asking for the hash. That is the
 * correct failure — the alternative is running a downloaded executable nobody vouched for — but it
 * is also a *total* one: a packaged build has no `bun` on `PATH` to fall back to, so an empty table
 * means no plugin can be installed at all. It was empty until 1.4.0's hashes were taken, which is
 * exactly the shape that bug had.
 *
 * These are the five assets for **Bun 1.4.0**, verified two ways: each `.zip` was downloaded and
 * hashed, and the digests were then checked against the release's own `SHASUMS256.txt`. Both agree.
 * The two are not fully independent — same origin, same TLS — but the second catches the realistic
 * failure, which is a truncated or corrupted download rather than a compromised release.
 *
 * When the pin moves: download each asset, `sha256sum` it, and paste the hex here **in the same
 * commit** that moves `packageManager`, `engines.bun` and `.bun-version`. This is the one of the
 * four whose value cannot be checked by reading another file in the repository, so it is the one
 * that has to be done by hand rather than assumed.
 */
export const BUN_RUNTIME_PINS: Readonly<Record<string, string>> = {
  "bun-windows-x64.zip": "e6f093d39da486b20262ca8cdd5ed6a9e8bc9c2f275b78e6d3a0c5b28cc95901",
  "bun-linux-x64.zip": "2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452",
  "bun-linux-aarch64.zip": "4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e",
  "bun-darwin-x64.zip": "1d0211b8f1dc991182344687ad15e72ee86f154845a5f7fa477994cd341dd9b0",
  "bun-darwin-aarch64.zip": "c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381",
};

/**
 * The Bun release {@link BUN_RUNTIME_PINS} speaks for.
 *
 * The table is keyed by asset name alone, and an asset name says nothing about a version — so
 * without this the hashes would happily be compared against a *different* release's bytes after a
 * Bun bump, and the user would be told the download "is not the one this build expects" when the
 * truth is that nobody re-hashed anything. A test asserts this equals `.bun-version`, which turns
 * bumping the pin without re-hashing into a red CI run rather than a broken install.
 */
export const BUN_RUNTIME_PINS_VERSION = "1.4.0";

/**
 * Where releases come from.
 *
 * `bun.sh/install` is a script, not an artifact; the artifact it would fetch is this, and pinning a
 * hash only means something against the bytes we actually download. Overridable so a test never
 * touches the network — never so a user can point the pin at a different origin.
 */
export const BUN_RELEASE_BASE_URL = "https://github.com/oven-sh/bun/releases/download";

/** The release asset for a platform and architecture, or null where Bun publishes none. */
export function runtimeAssetName(platform: string, arch: string): string | null {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x64" : null;
  if (cpu === null) return null;
  if (platform === "win32") return cpu === "x64" ? "bun-windows-x64.zip" : null;
  if (platform === "linux") return `bun-linux-${cpu}.zip`;
  if (platform === "darwin") return `bun-darwin-${cpu}.zip`;
  return null;
}

/** Full download URL for a version and asset. */
export function runtimeAssetUrl(
  version: string,
  asset: string,
  baseUrl = BUN_RELEASE_BASE_URL,
): string {
  return `${baseUrl}/bun-v${version}/${asset}`;
}

/* ------------------------------------------------------------------------------------------------
 * The public surface
 * ---------------------------------------------------------------------------------------------- */

export interface RuntimeFetchDeps {
  /** Locates the state tree. `VRCZIP_STATE_DIR` redirects the runtime with everything else. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to `Bun.version` — see `process-transport.ts` for why that is the right key. */
  readonly version?: string;
  readonly baseUrl?: string;
  /** Injected so a test runs against a local `Bun.serve` fixture. CI never hits the network. */
  readonly fetch?: typeof fetch;
  readonly platform?: string;
  readonly arch?: string;
  /** Overrides {@link BUN_RUNTIME_PINS}. A test pins its fixture; nothing else should pass this. */
  readonly pins?: Readonly<Record<string, string>>;
  /** Progress, for the install UI. Bytes are `null` when the server sent no length. */
  readonly onProgress?: (received: number, total: number | null) => void;
}

export type RuntimeInstallResult =
  | {
      readonly ok: true;
      readonly path: string;
      /** False when a pinned runtime was already installed and nothing was downloaded. */
      readonly installed: boolean;
    }
  | { readonly ok: false; readonly detail: string };

/**
 * Makes sure a pinned runtime is on disk, downloading it if it is not.
 *
 * Idempotent and safe to call on every install: it asks `resolvePluginRuntime` first, so a developer
 * running from a source checkout (whose own `bun` is the same binary) never downloads anything, and
 * a second call after a successful fetch is a stat.
 */
export async function ensurePluginRuntime(
  deps: RuntimeFetchDeps = {},
): Promise<RuntimeInstallResult> {
  const existing = resolvePluginRuntime(deps.env);
  if (existing.ok) return { ok: true, path: existing.path, installed: false };
  return fetchPluginRuntime(deps);
}

/**
 * Downloads and installs the pinned runtime unconditionally.
 *
 * Split out from {@link ensurePluginRuntime} rather than hidden inside it because the two answer
 * different questions. `ensure` asks "is there a runtime", and from a source checkout the answer is
 * yes without downloading anything — which is exactly what a developer wants and exactly what makes
 * the fetch itself untestable through that door. This is the door: a test drives it against a local
 * `Bun.serve` fixture, and the "reinstall the runtime" button in the UI will call it too.
 */
export async function fetchPluginRuntime(
  deps: RuntimeFetchDeps = {},
): Promise<RuntimeInstallResult> {
  const version = deps.version ?? Bun.version;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  const asset = runtimeAssetName(platform, arch);
  if (asset === null) {
    return {
      ok: false,
      detail: `There is no Bun release for ${platform}/${arch}, so plugins cannot run on this machine.`,
    };
  }

  const pins = deps.pins ?? BUN_RUNTIME_PINS;
  const expected = pins[asset];
  const url = runtimeAssetUrl(version, asset, deps.baseUrl ?? BUN_RELEASE_BASE_URL);
  // Only when the table is the built-in one: a test passing its own pins is pinning whatever
  // version it is exercising, and has no business being held to ours.
  if (deps.pins === undefined && version !== BUN_RUNTIME_PINS_VERSION) {
    return {
      ok: false,
      detail: `This build of vrc.zip runs Bun ${version}, but its pinned plugin-runtime checksums are for Bun ${BUN_RUNTIME_PINS_VERSION}. That is a packaging mistake rather than something you can fix here.`,
    };
  }
  if (expected === undefined) {
    // Deliberately a refusal. See BUN_RUNTIME_PINS.
    return {
      ok: false,
      detail: `This build of vrc.zip has no pinned checksum for ${asset}, so it will not download a plugin runtime. Expected the SHA-256 of ${url} to be recorded at build time.`,
    };
  }

  let archive: Uint8Array;
  try {
    archive = await download(url, deps);
  } catch (error) {
    return {
      ok: false,
      detail: `The plugin runtime could not be downloaded from ${url}: ${
        error instanceof Error ? error.message : String(error)
      }. Download it yourself and point vrc.zip at the file; it must have SHA-256 ${expected}.`,
    };
  }

  return installArchive(archive, { expected, url, version, platform, env: deps.env });
}

/**
 * Decision 111's manual escape path: install a `.zip` the user downloaded themselves.
 *
 * Same verification, same extraction, same atomic rename. The only thing it skips is the network,
 * which is the only thing that was in the way.
 */
export async function installRuntimeFromFile(
  archivePath: string,
  deps: RuntimeFetchDeps = {},
): Promise<RuntimeInstallResult> {
  const version = deps.version ?? Bun.version;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  const asset = runtimeAssetName(platform, arch);
  if (asset === null) {
    return {
      ok: false,
      detail: `There is no Bun release for ${platform}/${arch}, so plugins cannot run on this machine.`,
    };
  }
  const pins = deps.pins ?? BUN_RUNTIME_PINS;
  const expected = pins[asset];
  if (expected === undefined) {
    return {
      ok: false,
      detail: `This build of vrc.zip has no pinned checksum for ${asset}, so it cannot tell whether ${archivePath} is the right runtime. It will not install one it cannot check.`,
    };
  }

  let archive: Uint8Array;
  try {
    archive = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
  } catch (error) {
    return {
      ok: false,
      detail: `${archivePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return installArchive(archive, { expected, url: archivePath, version, platform, env: deps.env });
}

/* ------------------------------------------------------------------------------------------------
 * Verify, extract, rename
 * ---------------------------------------------------------------------------------------------- */

interface InstallArchiveOptions {
  readonly expected: string;
  /** Where the bytes came from, for the error message. A URL or a path. */
  readonly url: string;
  readonly version: string;
  readonly platform: string;
  readonly env: NodeJS.ProcessEnv | undefined;
}

function installArchive(archive: Uint8Array, options: InstallArchiveOptions): RuntimeInstallResult {
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== options.expected) {
    // Nothing is written. The bytes are dropped here, before anything touches the filesystem.
    return {
      ok: false,
      detail: `The plugin runtime downloaded from ${options.url} is not the one this build of vrc.zip expects, so it was discarded. Expected SHA-256 ${options.expected}, got ${actual}.`,
    };
  }

  const binaryName = options.platform === "win32" ? "bun.exe" : "bun";
  let binary: Uint8Array;
  try {
    binary = extractSingleFile(archive, binaryName);
  } catch (error) {
    return {
      ok: false,
      detail: `The plugin runtime archive from ${options.url} could not be unpacked: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const finalPath = pluginRuntimePath(options.env, options.version);
  const finalDir = dirname(finalPath);
  const parent = join(stateDir(options.env), PLUGIN_RUNTIME_DIR);

  let staging: string;
  try {
    // 0700 on the parent as well: everything under it is an executable this app will spawn, and a
    // directory another user can write to is a directory another user chooses our runtime from.
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    staging = mkdtempSync(join(parent, ".staging-"));
    const stagedBinary = join(staging, binaryName);
    writeFileSync(stagedBinary, binary, { mode: 0o700 });
    chmodSync(stagedBinary, 0o700);
    chmodSync(staging, 0o700);
  } catch (error) {
    return {
      ok: false,
      detail: `The plugin runtime could not be written: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    // The atomic step. Two daemons racing a cold start cannot hand each other a half-written
    // executable, because nothing is ever visible at the final path until it is complete.
    renameSync(staging, finalDir);
  } catch {
    // Almost always the race itself: the other daemon got there first, and what is at the final
    // path is a complete runtime with the same pinned hash. Anything else shows up as a resolve
    // failure below rather than as a guess here.
    rmSync(staging, { recursive: true, force: true });
    const resolved = resolvePluginRuntime(options.env);
    if (!resolved.ok) {
      return {
        ok: false,
        detail: `The plugin runtime could not be moved into place at ${finalDir}.`,
      };
    }
    return { ok: true, path: resolved.path, installed: false };
  }

  return { ok: true, path: finalPath, installed: true };
}

async function download(url: string, deps: RuntimeFetchDeps): Promise<Uint8Array> {
  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`the server answered ${String(response.status)}`);
  const body = response.body;
  if (body === null) return new Uint8Array(await response.arrayBuffer());

  const lengthHeader = response.headers.get("content-length");
  const total = lengthHeader === null ? null : Number.parseInt(lengthHeader, 10);
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      received += step.value.length;
      if (received > MAX_ARCHIVE_BYTES) {
        throw new Error(`the download exceeded ${String(MAX_ARCHIVE_BYTES)} bytes`);
      }
      deps.onProgress?.(received, total !== null && Number.isFinite(total) ? total : null);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

/**
 * Ceiling on the download, in bytes.
 *
 * A Bun release zip is around 40 MB. 256 MB is generous headroom and still bounds what a redirect to
 * something else can make this process allocate — the hash check happens after the bytes are in
 * memory, so "we would have noticed" is not a defence against being handed a hundred gigabytes.
 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/* ------------------------------------------------------------------------------------------------
 * A very small zip reader
 * ---------------------------------------------------------------------------------------------- */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end-of-central-directory record is 22 bytes plus a comment of at most 65535. */
const MAX_EOCD_SEARCH = 22 + 0xffff;

/**
 * Extracts exactly one entry, chosen by its basename, from a zip archive.
 *
 * Deliberately not a general unzipper. It reads the central directory, finds the one file whose base
 * name matches, and inflates it — so a zip carrying a hundred entries, an absolute path, or a `..`
 * traversal cannot cause anything to be written anywhere, because nothing but the matched entry is
 * ever materialised and its destination is a name we chose.
 *
 * Zip64 is not handled. A Bun release is tens of megabytes and the format only reaches for Zip64
 * past 4 GB; an archive that needed it would fail the pin check long before it got here.
 */
export function extractSingleFile(archive: Uint8Array, basename: string): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);

  let eocd = -1;
  const from = Math.max(0, archive.length - MAX_EOCD_SEARCH);
  for (let index = archive.length - 22; index >= from; index -= 1) {
    if (view.getUint32(index, true) === EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) throw new Error("it is not a zip archive");

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + 46 > archive.length || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error("its directory is corrupt");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(archive.subarray(offset + 46, offset + 46 + nameLength));

    if (name.split("/").pop() === basename) {
      return inflateEntry(archive, view, localOffset, method, compressedSize, uncompressedSize);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`it does not contain a file called "${basename}"`);
}

function inflateEntry(
  archive: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
    throw new Error("its directory points at nothing");
  }
  // The local header repeats the name and extra lengths, and they are not always the central
  // directory's — the extra field in particular differs. Read them here or the data offset is wrong.
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = archive.subarray(start, start + compressedSize);

  if (method === 0) return new Uint8Array(data);
  if (method !== 8)
    throw new Error(`it uses compression method ${String(method)}, which is not deflate`);

  const inflated = new Uint8Array(inflateRawSync(data));
  if (uncompressedSize !== 0 && inflated.length !== uncompressedSize) {
    throw new Error("an entry did not unpack to the size its directory promised");
  }
  return inflated;
}
