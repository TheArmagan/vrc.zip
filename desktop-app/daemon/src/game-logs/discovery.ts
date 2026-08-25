/**
 * Cross-platform discovery of the VRChat log directory.
 *
 * Every rule is probed and every hit is returned, in priority order, tagged with the rule that
 * matched. Settings shows the detected paths and lets the user override them, so "first match
 * wins" would be the wrong shape: a user with two Steam libraries, a Flatpak install, and a
 * bottle-per-account setup needs to see all of them and pick.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { nativePath } from "../paths.ts";

/** Which probe produced a candidate. Surfaced in settings so the path is explainable. */
export type LogDirRule =
  | "windows-localappdata-low"
  | "proton-steam-home"
  | "proton-flatpak"
  | "proton-steam-library"
  | "steam-deck";

export interface LogDirCandidate {
  /** Absolute, normalised path to the directory VRChat writes `output_log_*.txt` into. */
  path: string;
  rule: LogDirRule;
  /** True when the directory exists on disk right now. */
  exists: boolean;
  /**
   * Where the rule came from when it is not a fixed path — for `proton-steam-library`, the
   * `libraryfolders.vdf` library root it was derived from.
   */
  origin: string | null;
}

export interface DiscoveryEnvironment {
  /** `process.platform`. Injected so the probe table is testable on any host. */
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

export interface DiscoverOptions {
  environment?: DiscoveryEnvironment;
  /** Include probed paths that do not exist. Useful for diagnostics in settings. */
  includeMissing?: boolean;
}

/** VRChat's Steam app id — the Proton prefix lives under `compatdata/<appid>`. */
export const VRCHAT_STEAM_APP_ID = "438100";

/** Tail shared by every Proton prefix: the Windows-side LocalLow path inside the bottle. */
const PREFIX_TAIL = [
  "pfx",
  "drive_c",
  "users",
  "steamuser",
  "AppData",
  "LocalLow",
  "VRChat",
  "VRChat",
] as const;

const LOG_FILE_PREFIX = "output_log_";
const LOG_FILE_SUFFIX = ".txt";

/** True for the filenames VRChat writes its logs under. */
export function isLogFileName(name: string): boolean {
  return name.startsWith(LOG_FILE_PREFIX) && name.endsWith(LOG_FILE_SUFFIX);
}

function currentEnvironment(): DiscoveryEnvironment {
  return { platform: process.platform, env: process.env, home: homedir() };
}

function protonPrefixLogDir(libraryRoot: string): string {
  return resolve(join(libraryRoot, "steamapps", "compatdata", VRCHAT_STEAM_APP_ID, ...PREFIX_TAIL));
}

/**
 * Pulls every `"path"` value out of a `libraryfolders.vdf`. Parsed by hand rather than with a real
 * VDF parser: the file is a tiny fixed shape, and a dependency for it would not earn its keep.
 */
export function parseLibraryFolders(contents: string): string[] {
  const roots: string[] = [];
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith('"path"')) continue;
    // `"path"		"D:\\SteamLibrary"` — the value is the last quoted token on the line.
    const close = line.lastIndexOf('"');
    if (close <= 0) continue;
    const open = line.lastIndexOf('"', close - 1);
    if (open === -1) continue;
    const value = line.slice(open + 1, close).replaceAll("\\\\", "\\");
    if (value.length > 0) roots.push(value);
  }
  return roots;
}

async function readLibraryRoots(steamRoots: readonly string[]): Promise<Map<string, string>> {
  /** library root -> the `libraryfolders.vdf` it was named in. */
  const roots = new Map<string, string>();
  for (const steamRoot of steamRoots) {
    const vdfPath = join(steamRoot, "steamapps", "libraryfolders.vdf");
    let contents: string;
    try {
      contents = await readFile(vdfPath, "utf8");
    } catch {
      continue;
    }
    for (const root of parseLibraryFolders(contents)) {
      if (!roots.has(root)) roots.set(root, vdfPath);
    }
  }
  return roots;
}

function windowsCandidates(env: DiscoveryEnvironment): LogDirCandidate[] {
  const appData = env.env.APPDATA;
  if (appData === undefined || appData.length === 0) return [];
  // `%APPDATA%` is `…\AppData\Roaming`; VRChat writes into the sibling `LocalLow`.
  return [
    {
      path: resolve(join(appData, "..", "LocalLow", "VRChat", "VRChat")),
      rule: "windows-localappdata-low",
      exists: false,
      origin: null,
    },
  ];
}

async function linuxCandidates(env: DiscoveryEnvironment): Promise<LogDirCandidate[]> {
  const { home } = env;
  const flatpakSteam = join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam");
  const candidates: LogDirCandidate[] = [
    {
      path: protonPrefixLogDir(join(home, ".steam", "steam")),
      rule: "proton-steam-home",
      exists: false,
      origin: null,
    },
    {
      path: protonPrefixLogDir(join(home, ".local", "share", "Steam")),
      rule: "steam-deck",
      exists: false,
      origin: null,
    },
    {
      path: protonPrefixLogDir(flatpakSteam),
      rule: "proton-flatpak",
      exists: false,
      origin: null,
    },
  ];

  const steamRoots = [
    join(home, ".steam", "steam"),
    join(home, ".steam", "root"),
    join(home, ".local", "share", "Steam"),
    flatpakSteam,
  ];
  for (const [root, vdfPath] of await readLibraryRoots(steamRoots)) {
    candidates.push({
      path: protonPrefixLogDir(root),
      rule: "proton-steam-library",
      exists: false,
      origin: vdfPath,
    });
  }

  return candidates;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Probes every rule for the host platform and returns the candidates that exist, in priority
 * order, de-duplicated by path. Pass `includeMissing` to get the full probe table instead.
 */
export async function discoverLogDirectories(
  options: DiscoverOptions = {},
): Promise<LogDirCandidate[]> {
  const environment = options.environment ?? currentEnvironment();
  const probed =
    environment.platform === "win32"
      ? windowsCandidates(environment)
      : environment.platform === "linux"
        ? await linuxCandidates(environment)
        : // macOS has no VRChat PC client; nothing to probe.
          [];

  const seen = new Set<string>();
  const results: LogDirCandidate[] = [];
  for (const candidate of probed) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    const exists = await directoryExists(candidate.path);
    if (exists || options.includeMissing === true) results.push({ ...candidate, exists });
  }
  return results;
}

export interface LogFileEntry {
  path: string;
  name: string;
  size: number;
  /** Unix ms of the last write, per the filesystem. */
  modifiedAt: number;
}

/** Lists the `output_log_*.txt` files in one directory, newest last. Missing directory -> `[]`. */
export async function listLogFiles(directory: string): Promise<LogFileEntry[]> {
  /*
   * Normalised before anything is joined onto it.
   *
   * `entry.path` is not a private handle: it becomes the watcher's key for the file, the
   * `log_path` column on every session, and the path the UI prints on the Live sessions screen.
   * `join()` fixes the separators between the segments it is handed and leaves the ones already
   * inside `directory` alone, so an override typed as `C:/Users/you/.../VRChat` would produce
   * `C:/Users/you/.../VRChat\output_log_2026-01-01.txt` and store it that way forever.
   */
  const root = nativePath(directory);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }

  const entries: LogFileEntry[] = [];
  for (const name of names) {
    if (!isLogFileName(name)) continue;
    const path = join(root, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      entries.push({ path, name, size: info.size, modifiedAt: Math.trunc(info.mtimeMs) });
    } catch {
      // Raced with a rotation, or unreadable. Skip it; the next scan will pick it up.
    }
  }
  entries.sort((a, b) => a.modifiedAt - b.modifiedAt);
  return entries;
}
