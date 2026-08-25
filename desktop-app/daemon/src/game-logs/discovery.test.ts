import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  type DiscoveryEnvironment,
  discoverLogDirectories,
  isLogFileName,
  listLogFiles,
  parseLibraryFolders,
} from "./discovery.ts";

/** Fabricates a fake home tree in tmp — no test ever touches a real VRChat install. */
function fakeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "vrcz-home-"));
  return dir;
}

const PREFIX_TAIL = join(
  "pfx",
  "drive_c",
  "users",
  "steamuser",
  "AppData",
  "LocalLow",
  "VRChat",
  "VRChat",
);

function makePrefix(libraryRoot: string): string {
  const path = join(libraryRoot, "steamapps", "compatdata", "438100", PREFIX_TAIL);
  mkdirSync(path, { recursive: true });
  return resolve(path);
}

test("parses every library root out of libraryfolders.vdf", () => {
  const vdf = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
	}
	"1"
	{
		"path"		"/mnt/games/SteamLibrary"
	}
}
`;
  expect(parseLibraryFolders(vdf)).toEqual([
    "C:\\Program Files (x86)\\Steam",
    "/mnt/games/SteamLibrary",
  ]);
  expect(parseLibraryFolders("")).toEqual([]);
});

test("windows discovery resolves LocalLow as the sibling of Roaming", async () => {
  const home = fakeHome();
  const roaming = join(home, "AppData", "Roaming");
  const expected = resolve(join(home, "AppData", "LocalLow", "VRChat", "VRChat"));
  mkdirSync(expected, { recursive: true });

  const environment: DiscoveryEnvironment = {
    platform: "win32",
    env: { APPDATA: roaming },
    home,
  };
  const found = await discoverLogDirectories({ environment });

  expect(found).toEqual([
    { path: expected, rule: "windows-localappdata-low", exists: true, origin: null },
  ]);
  rmSync(home, { recursive: true, force: true });
});

test("linux discovery returns every matching rule, not just the first", async () => {
  const home = fakeHome();
  const steamHome = makePrefix(join(home, ".steam", "steam"));
  const deck = makePrefix(join(home, ".local", "share", "Steam"));
  const flatpakRoot = join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam");
  const flatpak = makePrefix(flatpakRoot);

  // A second library on another disk, named only in libraryfolders.vdf.
  const library = join(home, "games", "SteamLibrary");
  const libraryPrefix = makePrefix(library);
  mkdirSync(join(home, ".steam", "steam", "steamapps"), { recursive: true });
  writeFileSync(
    join(home, ".steam", "steam", "steamapps", "libraryfolders.vdf"),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${library.split(sep).join("/")}"\n\t}\n}\n`,
  );

  const environment: DiscoveryEnvironment = { platform: "linux", env: {}, home };
  const found = await discoverLogDirectories({ environment });

  expect(found.map((candidate) => candidate.rule)).toEqual([
    "proton-steam-home",
    "steam-deck",
    "proton-flatpak",
    "proton-steam-library",
  ]);
  expect(found.map((candidate) => candidate.path)).toEqual([
    steamHome,
    deck,
    flatpak,
    resolve(libraryPrefix),
  ]);
  expect(found[3]?.origin).toContain("libraryfolders.vdf");
  rmSync(home, { recursive: true, force: true });
});

test("includeMissing exposes the whole probe table for the settings UI", async () => {
  const home = fakeHome();
  const environment: DiscoveryEnvironment = { platform: "linux", env: {}, home };

  expect(await discoverLogDirectories({ environment })).toEqual([]);
  const probed = await discoverLogDirectories({ environment, includeMissing: true });
  expect(probed).toHaveLength(3);
  expect(probed.every((candidate) => !candidate.exists)).toBe(true);
  rmSync(home, { recursive: true, force: true });
});

test("unsupported platforms probe nothing rather than guessing", async () => {
  const environment: DiscoveryEnvironment = { platform: "darwin", env: {}, home: "/Users/nobody" };
  expect(await discoverLogDirectories({ environment })).toEqual([]);
});

test("only VRChat's own log filenames are listed, oldest first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vrcz-list-"));
  writeFileSync(join(dir, "output_log_14-22-01.txt"), "a\n");
  writeFileSync(join(dir, "output_log_15-00-00.txt"), "bb\n");
  writeFileSync(join(dir, "notes.txt"), "no\n");
  mkdirSync(join(dir, "output_log_dir.txt"));

  const files = await listLogFiles(dir);
  expect(files.map((file) => file.name).sort()).toEqual([
    "output_log_14-22-01.txt",
    "output_log_15-00-00.txt",
  ]);
  expect(files.every((file) => Number.isInteger(file.modifiedAt))).toBe(true);

  expect(await listLogFiles(join(dir, "does-not-exist"))).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("a log file path is spelled the way the host spells paths, whatever the directory was", async () => {
  /*
   * `LogFileEntry.path` becomes `sessions.log_path` and is printed in the UI, and the directory it
   * is built from is a setting somebody typed. A pasted `C:/Users/you/…/VRChat` used to come back
   * as `C:/Users/you/…/VRChat\output_log_….txt` and be stored that way.
   */
  const dir = mkdtempSync(join(tmpdir(), "vrcz-sep-"));
  writeFileSync(join(dir, "output_log_09-00-00.txt"), "a\n");

  const awkward = `${dir.replaceAll(sep, "/")}/./`;
  const files = await listLogFiles(awkward);
  expect(files).toHaveLength(1);
  expect(files[0]?.path).toBe(resolve(dir, "output_log_09-00-00.txt"));
  if (sep === "\\") expect(files[0]?.path).not.toContain("/");

  rmSync(dir, { recursive: true, force: true });
});

test("isLogFileName matches VRChat's naming only", () => {
  expect(isLogFileName("output_log_2024-03-09_14-22-01.txt")).toBe(true);
  expect(isLogFileName("output_log.txt.bak")).toBe(false);
  expect(isLogFileName("player.log")).toBe(false);
});
