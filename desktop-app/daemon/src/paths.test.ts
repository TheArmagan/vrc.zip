import { describe, expect, test } from "bun:test";
import { resolve, sep } from "node:path";
import {
  gamePath,
  nativePath,
  pluginDatabasePath,
  pluginDataDir,
  pluginDir,
  pluginsDir,
  stateDir,
} from "./paths.ts";

/**
 * The plugin paths, and the one property that matters about them.
 *
 * Everything here derives from `VRCZIP_STATE_DIR`, which is what lets a smoke test redirect the
 * entire tree — including anything a plugin writes — away from the real credential store. A plugin
 * path that escaped that override would be a plugin writing into the user's actual state directory
 * during a test, which is exactly the failure the override exists to prevent.
 */
const ROOT = resolve(sep, "tmp", "vrczip-test");
const ENV = { VRCZIP_STATE_DIR: ROOT } as NodeJS.ProcessEnv;

describe("nativePath", () => {
  test("returns the host's own separator, whichever one it was given", () => {
    const mixed = `${ROOT}/one\\two/three`;
    const result = nativePath(mixed);
    expect(result).toBe(resolve(ROOT, "one\\two/three"));
    if (sep === "\\") {
      // On Windows both spellings are legal input and only one is legal output.
      expect(result).not.toContain("/");
      expect(result).toBe(`${ROOT}\\one\\two\\three`);
    } else {
      // Elsewhere a backslash is an ordinary filename character, not a separator, so it stays.
      expect(result).toBe(`${ROOT}/one\\two/three`);
    }
  });

  test("collapses traversal and drops the trailing separator", () => {
    expect(nativePath(`${ROOT}${sep}logs${sep}..${sep}logs${sep}`)).toBe(resolve(ROOT, "logs"));
  });

  test("an empty or blank path stays empty rather than becoming the working directory", () => {
    expect(nativePath("")).toBe("");
    expect(nativePath("   ")).toBe("");
  });

  test("trims the whitespace a paste brings with it", () => {
    expect(nativePath(`  ${ROOT}  `)).toBe(ROOT);
  });
});

describe("gamePath", () => {
  test("a Windows path from the game is normalised as Windows on every host", () => {
    // On Linux this names a file inside the Proton bottle. Resolving it against the daemon's own
    // working directory would produce a path that exists nowhere, so only the spelling is fixed.
    expect(gamePath("C:/Users/you/Pictures/VRChat/2026-08/shot.png")).toBe(
      "C:\\Users\\you\\Pictures\\VRChat\\2026-08\\shot.png",
    );
    expect(gamePath("C:\\Users\\you\\Pictures\\VRChat\\2026-09\\..\\2026-08\\shot.png")).toBe(
      "C:\\Users\\you\\Pictures\\VRChat\\2026-08\\shot.png",
    );
    expect(gamePath("  \\\\nas\\share\\VRChat\\shot.png  ")).toBe(
      "\\\\nas\\share\\VRChat\\shot.png",
    );
  });

  test("a POSIX path stays POSIX rather than gaining backslashes", () => {
    expect(gamePath("/home/you/Pictures/VRChat/./shot.png")).toBe(
      sep === "\\"
        ? "\\home\\you\\Pictures\\VRChat\\shot.png"
        : "/home/you/Pictures/VRChat/shot.png",
    );
  });

  test("an empty path stays empty, so a caller can tell there was nothing there", () => {
    expect(gamePath("")).toBe("");
    expect(gamePath("   ")).toBe("");
  });
});

describe("plugin paths", () => {
  test("every one of them sits under the state directory override", () => {
    expect(stateDir(ENV)).toBe(ROOT);
    for (const path of [
      pluginsDir(ENV),
      pluginDir("acme.hello", ENV),
      pluginDataDir("acme.hello", ENV),
      pluginDatabasePath("acme.hello", ENV),
    ]) {
      expect(path.startsWith(ROOT)).toBe(true);
    }
  });

  test("code and data are siblings, not nested", () => {
    // Uninstall is `rm -rf` on the code directory. If data lived inside it, keeping someone's
    // plugin data across an uninstall would be impossible rather than a decision — and the quota,
    // which is a `stat` on the data directory, would be measuring the bundle too.
    expect(pluginDataDir("acme.hello", ENV).startsWith(pluginDir("acme.hello", ENV))).toBe(false);
  });

  test("two plugins never share a directory", () => {
    expect(pluginDir("acme.hello", ENV)).not.toBe(pluginDir("acme.goodbye", ENV));
    expect(pluginDataDir("acme.hello", ENV)).not.toBe(pluginDataDir("acme.goodbye", ENV));
  });

  test("a plugin's database is inside its own data directory", () => {
    // The whole point of one file per plugin: a plugin cannot lock or corrupt the daemon's WAL.
    expect(pluginDatabasePath("acme.hello", ENV).startsWith(pluginDataDir("acme.hello", ENV))).toBe(
      true,
    );
    expect(pluginDatabasePath("acme.hello", ENV)).not.toContain("vrczip.sqlite");
  });
});
