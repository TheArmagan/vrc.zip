import { describe, expect, test } from "bun:test";
import { stateDir } from "../paths.ts";
import { shouldStartHidden } from "./console.ts";
import {
  compareVersions,
  installDirectory,
  installTarget,
  isInstalled,
  shortcutScript,
} from "./install.ts";
import { startupCommand, startupEntryTarget, startupLocation, startupSupport } from "./startup.ts";
import { shouldShowTray } from "./tray.ts";

/**
 * The parts of "start with Windows" that can be tested without a registry.
 *
 * Everything here takes its inputs rather than reading `process`, which is the reason it is
 * testable at all — and the reason the tray and the settings screen cannot disagree about whether
 * the feature is available, since both ask the same function the same question.
 *
 * Nothing in this file touches `HKEY_CURRENT_USER`. A test suite that writes real autostart entries
 * on the machine running it is not a test suite anybody should run twice.
 */

describe("startupCommand", () => {
  test("quotes the executable", () => {
    // Not cosmetic. `C:\Program Files\vrc.zip\vrc.zip.exe --hidden` unquoted is read by Windows as
    // a request to run `C:\Program.exe`, which is the oldest bug there is in this registry key.
    expect(startupCommand("C:\\Program Files\\vrc.zip\\vrc.zip.exe")).toBe(
      '"C:\\Program Files\\vrc.zip\\vrc.zip.exe" --hidden --no-open',
    );
  });

  test("passes both flags rather than implying them", () => {
    const command = startupCommand("C:\\app\\vrc.zip.exe");
    // `--no-open` matters more than it looks: a packaged build opens a browser by default, and a
    // tab appearing thirty seconds after sign-in is the fastest way to get this turned back off.
    expect(command).toContain("--no-open");
    expect(command).toContain("--hidden");
  });
});

describe("startupEntryTarget", () => {
  test("reads the executable back out of a registered command", () => {
    expect(startupEntryTarget('"C:\\app\\vrc.zip.exe" --hidden --no-open')).toBe(
      "C:\\app\\vrc.zip.exe",
    );
  });

  test("refuses a command it did not write", () => {
    // An unquoted or hand-edited value is somebody else's. `repairStartupEntry` leaves those alone
    // rather than guessing where they meant to point.
    expect(startupEntryTarget("C:\\app\\vrc.zip.exe --hidden")).toBe(null);
    expect(startupEntryTarget("")).toBe(null);
  });
});

describe("startupSupport", () => {
  test("is unsupported off Windows, and says so", () => {
    const support = startupSupport("darwin", true);
    expect(support.supported).toBe(false);
    expect(support.reason).not.toBe(null);
  });

  test("is unsupported from a source checkout", () => {
    // From source the executable is `bun.exe`. An entry pointing at it starts Bun with no script:
    // an autostart that looks correct in Task Manager and does nothing at all.
    const support = startupSupport("win32", false);
    expect(support.supported).toBe(false);
    expect(support.reason).toContain("bun.exe");
  });

  test("is supported from a packaged Windows build", () => {
    expect(startupSupport("win32", true)).toEqual({ supported: true, reason: null });
  });
});

describe("startupLocation", () => {
  const folders = {
    downloads: "C:\\Users\\a\\Downloads",
    temp: "C:\\Users\\a\\AppData\\Local\\Temp",
  };

  test("refuses Downloads, and explains rather than just failing", () => {
    const location = startupLocation("C:\\Users\\a\\Downloads\\vrc.zip.exe", folders);
    expect(location.ok).toBe(false);
    expect(location.reason).toContain("Downloads");
  });

  test("refuses a subfolder of Downloads too", () => {
    expect(startupLocation("C:\\Users\\a\\Downloads\\vrczip\\vrc.zip.exe", folders).ok).toBe(false);
  });

  test("refuses the temp folder, which is where a double-clicked zip lands", () => {
    const location = startupLocation(
      "C:\\Users\\a\\AppData\\Local\\Temp\\Temp1_vrc.zip\\vrc.zip.exe",
      folders,
    );
    expect(location.ok).toBe(false);
  });

  test("matches case-insensitively and across separators", () => {
    // Windows paths arrive in whatever case and whichever slash the caller happened to use, and a
    // guard that can be stepped around by typing `downloads` is not a guard.
    expect(startupLocation("c:/users/a/downloads/vrc.zip.exe", folders).ok).toBe(false);
  });

  test("allows a folder that is neither", () => {
    expect(startupLocation("C:\\Users\\a\\AppData\\Local\\vrc.zip\\vrc.zip.exe", folders)).toEqual({
      ok: true,
      reason: null,
    });
  });

  test("does not mistake a prefix for a parent", () => {
    // `Downloads2` starts with `Downloads` and is a different folder. A `startsWith` without the
    // separator would refuse it.
    expect(startupLocation("C:\\Users\\a\\Downloads2\\vrc.zip.exe", folders).ok).toBe(true);
  });
});

describe("the flags", () => {
  test("--no-tray wins over --tray, whatever the order", () => {
    // Same rule `shouldOpenBrowser` uses: a flag that turns something off should not depend on the
    // order a script happened to append them in.
    expect(shouldShowTray(["--tray", "--no-tray"], "win32")).toBe(false);
    expect(shouldShowTray(["--no-tray", "--tray"], "win32")).toBe(false);
    expect(shouldShowTray([], "win32")).toBe(true);
  });

  test("there is no tray to show off Windows", () => {
    expect(shouldShowTray(["--tray"], "linux")).toBe(false);
  });

  test("--hidden is refused when there is no tray icon to restore the window from", () => {
    // The safety property. `--hidden` is what the autostart entry passes, so honouring it with no
    // icon would mean a machine that boots into a vrc.zip with no window and no way back to it.
    expect(shouldStartHidden(["--hidden"], false)).toBe(false);
    expect(shouldStartHidden(["--hidden"], true)).toBe(true);
    expect(shouldStartHidden([], true)).toBe(false);
  });
});

describe("install paths", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } as unknown as NodeJS.ProcessEnv;

  test("installs under LOCALAPPDATA\\Programs, never beside the state tree", () => {
    /*
     * The `Programs` segment is the entire point of this assertion.
     *
     * `paths.ts` puts the state tree at `%LOCALAPPDATA%\vrc.zip`: the credential store, the SQLite
     * database, `settings.json`. The executable was installed there too at first, which made
     * `--uninstall` — which removes its own install directory with `rmdir /s /q` — a command that
     * would have deleted every account the user had ever signed in, with no prompt and no undo.
     */
    expect(installDirectory(env)).toBe("C:\\Users\\a\\AppData\\Local\\Programs\\vrc.zip");
    expect(installTarget(env)).toBe("C:\\Users\\a\\AppData\\Local\\Programs\\vrc.zip\\vrc.zip.exe");
    expect(installDirectory(env)).not.toBe(stateDir(env));
  });

  test("has nowhere to install without it", () => {
    expect(installDirectory({} as unknown as NodeJS.ProcessEnv)).toBe(null);
  });

  test("recognises the installed copy however the path is spelled", () => {
    expect(isInstalled("C:\\Users\\a\\AppData\\Local\\Programs\\vrc.zip\\vrc.zip.exe", env)).toBe(
      true,
    );
    expect(isInstalled("c:/users/a/appdata/local/programs/vrc.zip/vrc.zip.exe", env)).toBe(true);
    expect(isInstalled("C:\\Users\\a\\Downloads\\vrc.zip.exe", env)).toBe(false);
    // The state directory is not the install directory, and must never start looking like one.
    expect(isInstalled("C:\\Users\\a\\AppData\\Local\\vrc.zip\\vrc.zip.exe", env)).toBe(false);
  });
});

describe("the shortcut script", () => {
  test("does not hide the console it inherited", () => {
    /*
     * The bug this replaced: clicking Install made the daemon's console window vanish for good.
     *
     * A console process spawned from a console process inherits that console, and PowerShell
     * implements `-WindowStyle Hidden` as `ShowWindow(GetConsoleWindow(), SW_HIDE)` — on the
     * console it inherited, which is ours. Measured rather than reasoned: with the flag,
     * `IsWindowVisible` on our own console goes true to false across the spawn, and without it
     * stays true.
     *
     * The replacement is `windowsHide` at the spawn, which is `CREATE_NO_WINDOW` and can only
     * affect a window the child would have created for itself.
     */
    expect(shortcutScript()).not.toContain("-WindowStyle");
    expect(shortcutScript()).not.toContain("Hidden");
  });

  test("carries no path in its text", () => {
    // The rule `desktop-notification.ts` set: PowerShell has its own quoting on top of the argv
    // boundary, so a folder with a quote in it would break the script or extend it. Paths go
    // through the environment instead, and this asserts that nobody later inlined one.
    const script = shortcutScript().join(" ");
    expect(script).toContain("$env:VRCZ_LNK_TARGET");
    expect(script).not.toContain("C:\\");
  });

  test("asks Windows where the folders are", () => {
    // A desktop redirected into OneDrive is the common case now, and `%USERPROFILE%\Desktop` is
    // simply the wrong folder there.
    const script = shortcutScript().join(" ");
    expect(script).toContain("GetFolderPath('Desktop')");
    expect(script).toContain("GetFolderPath('Programs')");
  });
});

describe("compareVersions", () => {
  test("orders numerically, not as text", () => {
    // The reason this function exists at all. `"0.10.0" < "0.9.0"` is true as strings, so a plain
    // comparison would decide that upgrading from 0.9 to 0.10 is a downgrade and never offer it.
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.2.10", "0.2.9")).toBeGreaterThan(0);
  });

  test("equal versions are equal, with or without a leading v", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  test("a prerelease is older than the release it leads to", () => {
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
  });

  test("anything unparseable is not an update", () => {
    /*
     * Failing closed, and in the direction that matters: this decides whether to overwrite an
     * installed executable. A missed prompt costs somebody a manual update; a wrong one puts an
     * older build over a good install.
     */
    expect(compareVersions("", "1.0.0")).toBe(0);
    expect(compareVersions("not a version", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "garbage")).toBe(0);
  });
});
