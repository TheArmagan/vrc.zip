import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pluginDatabasePath, pluginDataDir, pluginDir, pluginsDir, stateDir } from "./paths.ts";

/**
 * The plugin paths, and the one property that matters about them.
 *
 * Everything here derives from `VRCZIP_STATE_DIR`, which is what lets a smoke test redirect the
 * entire tree — including anything a plugin writes — away from the real credential store. A plugin
 * path that escaped that override would be a plugin writing into the user's actual state directory
 * during a test, which is exactly the failure the override exists to prevent.
 */
const ROOT = join("C:", "tmp", "vrczip-test");
const ENV = { VRCZIP_STATE_DIR: ROOT } as NodeJS.ProcessEnv;

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
