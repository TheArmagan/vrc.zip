/**
 * Making vrc.zip behave like something that was installed, from a single file that was downloaded.
 *
 * ## The problem this solves
 *
 * vrc.zip ships as one executable, which is the whole appeal: no installer, no elevation, no
 * uninstall entry to go stale. It is also why the thing people actually do with it — leave it in
 * Downloads and double-click it — produces an app that cannot start with Windows, is not in the
 * Start menu, and will be deleted the first time Storage Sense runs. `os/startup.ts` refuses to
 * register an autostart from there, and refusing without offering a way forward is a dead end.
 *
 * So this is the way forward: copy the executable to `%LOCALAPPDATA%\Programs\vrc.zip`, put
 * shortcuts where Windows looks for programs, and register the autostart against the copy. Still
 * per-user, still no elevation, still nothing in the registry beyond the `Run` value and an
 * Installed apps entry — an "install" only in the sense that the file is now somewhere it survives.
 *
 * The `Programs` segment is load-bearing and has its own note on {@link APP_PARENT}: the state tree
 * is at `%LOCALAPPDATA%\vrc.zip`, and installing into it made `--uninstall` a command that deleted
 * the user's credentials.
 *
 * ## Shortcuts are COM, and they did not used to be
 *
 * They were a PowerShell script and `WScript.Shell`, which is a perfectly good way to make a
 * shortcut and cannot make the one this app needs. A Windows toast is attributed to an
 * AppUserModelID, an unpackaged app can only own one by putting it on a Start menu shortcut, and
 * `WScript.Shell` has no way to write that property. So the writer moved to `os/shortcut.ts`, over
 * FFI, and there is exactly one of it — the alternative was an install path and a notification path
 * with different ideas of what a vrc.zip shortcut is.
 *
 * Removing them is still PowerShell, and that is not an inconsistency worth fixing: deleting a file
 * needs neither COM nor a property, and `[Environment]::GetFolderPath` is the reason the removal
 * finds a desktop that has been redirected into OneDrive.
 *
 * ## Why the Start menu entry is the one that matters
 *
 * "Search for it in the Start menu and it comes up" is not a separate feature needing separate
 * work: Windows Search indexes `…\Start Menu\Programs`, so a `.lnk` there *is* the feature. The
 * desktop shortcut is the optional one.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { APP_NAME, APP_VERSION, REPOSITORY_URL } from "@vrcz/shared";
import { stateDir } from "../paths.ts";
import { startDetached } from "./detached.ts";
import { deleteKey, readString, writeDword, writeString } from "./registry.ts";
import {
  APP_USER_MODEL_ID,
  FOLDERID_Desktop,
  knownFolder,
  type ShortcutOptions,
  startMenuPrograms,
  writeShortcut,
} from "./shortcut.ts";
import { setStartupEnabled } from "./startup.ts";

const IS_WINDOWS = process.platform === "win32";

/**
 * Where the executable goes, under `%LOCALAPPDATA%`.
 *
 * **`Programs\vrc.zip`, never `vrc.zip`**, and the difference is not cosmetic: `paths.ts` already
 * puts the *state* tree at `%LOCALAPPDATA%\vrc.zip`. Installing the executable there would drop it
 * next to `secrets.enc`, the SQLite database and `settings.json` — and then `--uninstall`, which
 * removes its own install directory, would take the user's credentials, accounts and entire feed
 * with it. An uninstaller that silently destroys the data is the worst bug this file could have,
 * and it was one path separator away.
 *
 * `Programs\<app>` is also simply where per-user installs go on Windows; it is what VS Code and a
 * user-scoped Chrome do.
 */
const APP_PARENT = "Programs";
const APP_FOLDER = "vrc.zip";
const EXECUTABLE_NAME = "vrc.zip.exe";

/**
 * Where Settings → Installed apps reads its list from, per user.
 *
 * The same key `HKLM` has, under `HKCU` instead: entries here appear in Installed apps for the user
 * who created them and need no elevation to write, which is the right scope for something that
 * installed itself into that user's `%LOCALAPPDATA%`.
 */
const UNINSTALL_PARENT = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
/** Our subkey's name. Also the id somebody would use to script an uninstall. */
export const UNINSTALL_KEY_NAME = "vrc.zip";
const UNINSTALL_KEY_PATH = `${UNINSTALL_PARENT}\\${UNINSTALL_KEY_NAME}`;

/**
 * Writes the Installed apps entry.
 *
 * `UninstallString` points back at the executable with `--uninstall`, which is the whole reason that
 * flag exists: Windows offers no uninstaller of its own, it only runs the command it was given. The
 * `QuietUninstallString` is the same command because there is no interactive version to differ
 * from — nothing here asks anything, so the quiet path and the loud one are one path.
 *
 * `NoModify` and `NoRepair` grey out the two buttons Windows would otherwise offer for operations
 * this has no code for. An enabled button that does nothing is worse than an absent one.
 */
function writeUninstallEntry(target: string, directory: string, sizeBytes: number): boolean {
  const values: Array<[string, string]> = [
    ["DisplayName", APP_NAME],
    ["DisplayVersion", APP_VERSION],
    ["Publisher", APP_NAME],
    ["DisplayIcon", target],
    ["InstallLocation", directory],
    ["UninstallString", `"${target}" --uninstall`],
    ["QuietUninstallString", `"${target}" --uninstall`],
    ["URLInfoAbout", REPOSITORY_URL],
  ];
  let ok = true;
  for (const [name, value] of values) {
    if (!writeString(UNINSTALL_KEY_PATH, name, value)) ok = false;
  }
  // Installed apps shows this in kilobytes, and shows nothing at all when it is missing.
  if (!writeDword(UNINSTALL_KEY_PATH, "EstimatedSize", Math.max(1, Math.round(sizeBytes / 1024)))) {
    ok = false;
  }
  if (!writeDword(UNINSTALL_KEY_PATH, "NoModify", 1)) ok = false;
  if (!writeDword(UNINSTALL_KEY_PATH, "NoRepair", 1)) ok = false;
  return ok;
}

/**
 * Case-insensitive, separator-normalised "is `child` at or inside `parent`".
 *
 * Its own copy rather than an import from `startup.ts`, where the twin lives: that one answers "may
 * an autostart entry point here", this one guards a recursive delete. Two callers with the same
 * arithmetic and very different consequences, and a shared helper would invite a change made for
 * one of them to alter the other.
 */
function isInside(child: string, parent: string): boolean {
  if (parent === "") return false;
  const normalise = (value: string) =>
    value
      .replace(/[\\/]+/g, "\\")
      .replace(/\\$/, "")
      .toLowerCase();
  const inner = normalise(child);
  const outer = normalise(parent);
  return inner === outer || inner.startsWith(`${outer}\\`);
}

/** Removes the Installed apps entry. True when it is gone, including when it never existed. */
export function removeUninstallEntry(): boolean {
  return deleteKey(UNINSTALL_PARENT, UNINSTALL_KEY_NAME);
}

export interface InstallOptions {
  /** A shortcut on the desktop. Optional, and off is a perfectly normal choice. */
  readonly desktopShortcut: boolean;
  /**
   * A shortcut under Start menu → Programs.
   *
   * This is the one that makes vrc.zip findable by typing its name, because that folder is what
   * Windows Search indexes. Worth defaulting to on.
   */
  readonly startMenuShortcut: boolean;
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface InstallResult {
  readonly ok: boolean;
  /** Where it now lives, or null if it did not get that far. */
  readonly path: string | null;
  /** What went wrong, in a sentence fit to show a user. Null on success. */
  readonly reason: string | null;
  /** True when the executable was already in place and only the rest was done. */
  readonly alreadyInstalled: boolean;
  readonly desktopShortcut: boolean;
  readonly startMenuShortcut: boolean;
  /** Whether the autostart entry now points at the installed copy. */
  readonly startWithWindows: boolean;
}

/** Where an installed vrc.zip lives, or null when there is no `%LOCALAPPDATA%` to put it under. */
export function installDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const local = env.LOCALAPPDATA;
  if (local === undefined || local.trim() === "") return null;
  return join(local, APP_PARENT, APP_FOLDER);
}

/** The full path of the installed executable, or null. */
export function installTarget(env: NodeJS.ProcessEnv = process.env): string | null {
  const directory = installDirectory(env);
  return directory === null ? null : join(directory, EXECUTABLE_NAME);
}

/** Whether the running executable *is* the installed copy. Case-insensitive; this is Windows. */
export function isInstalled(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const target = installTarget(env);
  if (target === null) return false;
  return execPath.replace(/\//g, "\\").toLowerCase() === target.toLowerCase();
}

/**
 * Where the two shortcuts go, asked of Windows rather than composed.
 *
 * Exported for the test, which can assert the shape of the request without writing anything: what
 * matters is that both folders come from `SHGetKnownFolderPath` and that the Start menu entry
 * carries the AppUserModelID, since that property is the only thing standing between this app and
 * a toast attributed to PowerShell.
 */
export function shortcutPlan(
  target: string,
  desktop: boolean,
  startMenu: boolean,
): ShortcutOptions[] {
  const plan: ShortcutOptions[] = [];
  const common = {
    target,
    workingDirectory: join(target, ".."),
    description: APP_NAME,
    appUserModelId: APP_USER_MODEL_ID,
  };
  if (desktop) {
    const folder = knownFolder(FOLDERID_Desktop);
    if (folder !== null) plan.push({ ...common, path: join(folder, SHORTCUT_NAME) });
  }
  if (startMenu) {
    const folder = startMenuPrograms();
    if (folder !== null) plan.push({ ...common, path: join(folder, SHORTCUT_NAME) });
  }
  return plan;
}

const SHORTCUT_NAME = "vrc.zip.lnk";

/**
 * Writes the shortcuts. Best-effort: a failure here does not undo a successful copy.
 *
 * The `.lnk` on the desktop gets the AppUserModelID too, which does nothing on its own — only the
 * Start menu is read for it. It is written anyway so the two files are the same file in two places,
 * rather than one of them being subtly special in a way a future reader has to discover.
 */
function writeShortcuts(target: string, desktop: boolean, startMenu: boolean): boolean {
  const plan = shortcutPlan(target, desktop, startMenu);
  if (plan.length === 0) return !desktop && !startMenu;
  let ok = true;
  for (const shortcut of plan) {
    if (!writeShortcut(shortcut)) ok = false;
  }
  return ok;
}

/**
 * Copies this executable to `%LOCALAPPDATA%\vrc.zip`, writes the requested shortcuts, and registers
 * the copy to start with Windows.
 *
 * The order matters on the failure paths. The copy comes first, because everything after it points
 * at the copy and there is no sense writing a shortcut to a file that is not there. The autostart
 * comes last and against the *installed* path rather than `process.execPath`, which is the entire
 * point of the exercise: the entry has to outlive the download it was clicked from.
 *
 * The running process is left where it is, still serving. Relaunching from the new copy would mean
 * handing over a bound port and an open SQLite file to a process that cannot take either until this
 * one has let go, which is a race for no benefit — the installed copy is what starts next time, and
 * next time is the case this exists for.
 */
export async function installLocally(options: InstallOptions): Promise<InstallResult> {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;

  const failure = (reason: string): InstallResult => ({
    ok: false,
    path: null,
    reason,
    alreadyInstalled: false,
    desktopShortcut: false,
    startMenuShortcut: false,
    startWithWindows: false,
  });

  if (!IS_WINDOWS) return failure("Installing to a permanent location is Windows only for now.");

  const directory = installDirectory(env);
  const target = installTarget(env);
  if (directory === null || target === null) {
    return failure("Windows did not report a LOCALAPPDATA folder to install into.");
  }

  const alreadyInstalled = isInstalled(execPath, env);

  if (!alreadyInstalled) {
    try {
      await mkdir(directory, { recursive: true });
      await Bun.write(target, Bun.file(execPath));
    } catch (error) {
      /*
       * The interesting failure is `EBUSY`, and it has an ordinary cause: an installed copy that is
       * already running, because the user started that one too. Windows will not let a running
       * image be overwritten, and there is nothing to do about it from here except say so.
       */
      const busy = String(error).includes("EBUSY");
      return failure(
        busy
          ? "An installed copy of vrc.zip is already running. Close it and try again."
          : `Could not copy vrc.zip into ${directory}.`,
      );
    }
  }

  const shortcuts = writeShortcuts(target, options.desktopShortcut, options.startMenuShortcut);

  // Installed apps, so there is a supported way *out* of this. Written after the copy because it
  // names the copy, and not treated as fatal: an app that installed but is missing from that list
  // is still usable and can still be removed with `--uninstall`.
  let size = 0;
  try {
    size = Bun.file(target).size;
  } catch {
    // A size we cannot read costs the entry its "how big is it" column, and nothing else.
  }
  const listed = writeUninstallEntry(target, directory, size);

  const startup = setStartupEnabled(true, target);

  return {
    ok: true,
    path: target,
    // Reported rather than fatal, and separately for each half: a copy that landed and a shortcut
    // that did not is a mostly-successful install, and telling the user it failed outright would
    // send them to do again the part that worked.
    reason: shortcuts
      ? listed
        ? startup.reason
        : "vrc.zip was installed, but it could not be added to the Installed apps list."
      : "vrc.zip was installed, but its shortcuts could not be created.",
    alreadyInstalled,
    desktopShortcut: shortcuts && options.desktopShortcut,
    startMenuShortcut: shortcuts && options.startMenuShortcut,
    startWithWindows: startup.ok,
  };
}

export interface UninstallResult {
  readonly ok: boolean;
  /** What is left behind and why, in a sentence fit to show a user. Null when nothing is. */
  readonly reason: string | null;
  /** Where the files were, so the caller can say it. */
  readonly path: string | null;
}

/**
 * The `--uninstall` side: everything `installLocally` wrote, in the reverse order it wrote it.
 *
 * Order is the whole design here, because this runs *as* the file it is deleting.
 *
 * The registry entries and the shortcuts go first and synchronously, since those are what make
 * vrc.zip look installed and none of them can fail in a way worth stopping for. The executable is
 * last and cannot be deleted by this process at all — Windows holds a running image open, and no
 * amount of retrying inside the process that *is* the image will change that.
 *
 * So the directory removal is handed to a batch file in `%TEMP%` that waits for this process to
 * exit, retries the delete for half a minute, and then deletes itself. That is the standard shape
 * of a self-uninstaller and there is no better one available: the alternative is leaving the folder
 * for the user to find, which is exactly the untidiness an uninstall entry exists to avoid.
 *
 * The user's data is deliberately **not** touched. `%APPDATA%\vrc.zip` holds the credential store,
 * the database and `settings.json`, and an uninstall that silently deletes a signed-in account's
 * secrets is one nobody can safely try. Removing the app is not the same as saying the data was a
 * mistake.
 */
export async function uninstallLocally(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): Promise<UninstallResult> {
  if (!IS_WINDOWS) return { ok: false, reason: "Uninstalling is Windows only.", path: null };

  const directory = installDirectory(env);

  // Both are safe to run whether or not this is the installed copy: each reports "already absent"
  // as success, so uninstalling from a stray copy still clears the machine of the entries.
  setStartupEnabled(false);
  removeUninstallEntry();
  await removeShortcuts();

  if (directory === null) {
    return { ok: true, reason: null, path: null };
  }

  /*
   * The guard that must never be removed.
   *
   * What follows hands a directory to `rmdir /s /q`, and the directory is computed. The state tree
   * lives under the same `%LOCALAPPDATA%` root, so a wrong constant here is not a wrong path — it is
   * the user's credential store, their database and every account they have signed in, deleted with
   * no prompt and no undo. This check makes that outcome impossible rather than merely unlikely, and
   * it is cheap enough that there is no argument for leaving it out.
   */
  if (isInside(stateDir(env), directory) || isInside(directory, stateDir(env))) {
    return {
      ok: false,
      reason: `Refusing to remove ${directory}: it holds vrc.zip's accounts and settings. This is a bug — please report it.`,
      path: directory,
    };
  }

  const scheduled = await scheduleDirectoryRemoval(directory, execPath);
  return {
    ok: true,
    reason: scheduled
      ? null
      : `Removed vrc.zip's shortcuts and registry entries. The folder ${directory} could not be scheduled for deletion; remove it by hand.`,
    path: directory,
  };
}

/**
 * Deletes the shortcuts, wherever Windows says those folders actually are.
 *
 * Three of them, not two: the notifier writes a `Start Menu\Programs\vrc.zip\` folder of its own
 * when there is no installed shortcut to hang an AppUserModelID off, and an uninstall that leaves
 * behind a Start menu entry pointing at a deleted executable is exactly the untidiness the uninstall
 * entry exists to avoid. Removing a folder we created whole is why it is a folder.
 */
async function removeShortcuts(): Promise<boolean> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {",
    "  $path=Join-Path $folder 'vrc.zip.lnk'",
    "  if (Test-Path $path) { Remove-Item -Force $path }",
    "}",
    "$own=Join-Path ([Environment]::GetFolderPath('Programs')) 'vrc.zip'",
    "if (Test-Path $own) { Remove-Item -Recurse -Force $own }",
  ].join("; ");
  try {
    const child = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      windowsHide: true,
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Writes and launches the batch file that removes the install directory once we are gone.
 *
 * A file rather than a `cmd /c "…"` argument, and that is not a style choice: `cmd` re-parses its
 * own command line by rules that are not the argv rules everything else uses, and a path with a
 * space in it — which `%LOCALAPPDATA%` has on any machine whose user name has one — is exactly what
 * that re-parsing gets wrong. A path can never contain a `"`, so a quoted path inside a script file
 * is unambiguous in a way the same string on a command line is not.
 *
 * Detached, so it outlives the process it is waiting for.
 */
async function scheduleDirectoryRemoval(directory: string, execPath: string): Promise<boolean> {
  const temp = process.env.TEMP ?? process.env.TMP;
  if (temp === undefined || temp === "") return false;

  const script = join(temp, `vrczip-uninstall-${String(process.pid)}.cmd`);
  const body = [
    "@echo off",
    // Thirty attempts a second apart. A daemon flushing SQLite on the way out takes a moment, and
    // the delete simply fails while the image is still mapped.
    "for /l %%i in (1,1,30) do (",
    `  if not exist "${execPath}" goto gone`,
    `  rmdir /s /q "${directory}" >nul 2>&1`,
    `  if not exist "${execPath}" goto gone`,
    "  timeout /t 1 /nobreak >nul",
    ")",
    ":gone",
    `rmdir /s /q "${directory}" >nul 2>&1`,
    // The script removes itself last, so nothing is left in %TEMP% either.
    'del /f /q "%~f0" >nul 2>&1',
    "",
    // CRLF, because `cmd` is the one interpreter left that genuinely minds.
  ].join("\r\n");

  try {
    await Bun.write(script, body);
    /*
     * Detached, and it has to be `startDetached` rather than `Bun.spawn`.
     *
     * What this script waits for is *us exiting* — and a Bun subprocess is killed when its parent
     * exits, so the version of this that used `Bun.spawn().unref()` was a script that got as far as
     * its first `timeout` and was then taken down by the very event it was waiting for. The folder
     * was never removed and nothing said so, because the uninstall had already reported success and
     * the process that would have noticed was gone.
     */
    return startDetached({ path: "cmd.exe", args: ["/c", script] }) !== null;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Updating an installed copy                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * The version of the installed copy, from the Installed apps entry we wrote when we installed it.
 *
 * The registry rather than the executable's own file version resource, for a plain reason: the
 * packaging step does not stamp one, so there is nothing there to read. `DisplayVersion` is written
 * by `writeUninstallEntry` and is also what Settings shows the user, so reading it back means the
 * update prompt and Installed apps can never disagree about which version is installed.
 *
 * Null when nothing is installed, or when it was installed by a build old enough not to have
 * written the entry.
 */
export function installedVersion(): string | null {
  const value = readString(UNINSTALL_KEY_PATH, "DisplayVersion");
  return value === null || value.trim() === "" ? null : value.trim();
}

/**
 * Whether an installed executable is actually on disk, whatever the registry believes.
 *
 * Synchronous, using the same `size > 0` idiom `repairStartupEntry` uses, because both callers are
 * predicates that decide which of two prompts to show and neither wants to be async for it.
 *
 * The two can genuinely disagree: somebody who deletes `%LOCALAPPDATA%\Programs\vrc.zip` by hand
 * leaves the Installed apps entry behind, and an "update the installed copy" offer for a copy that
 * is not there would be describing the wrong thing. The registry says what was installed; this says
 * what still is.
 */
export function installExists(env: NodeJS.ProcessEnv = process.env): boolean {
  const target = installTarget(env);
  if (target === null) return false;
  try {
    return Bun.file(target).size > 0;
  } catch {
    return false;
  }
}

/**
 * Orders two versions the way semver does, enough for the one question asked of it.
 *
 * Returns a negative number when `a` is older, positive when newer, zero when they are the same
 * release. Numeric parts compare as numbers, so `0.10.0` is correctly newer than `0.9.0` — a string
 * comparison gets that backwards, which is the whole reason this is not a `<`.
 *
 * A prerelease sorts *below* the release it leads to: `1.0.0-beta.1` is older than `1.0.0`. Only
 * the presence of a prerelease is weighed, not its contents beyond a plain comparison, because the
 * caller uses this for one decision — "is the copy in my hand newer than the one on disk" — and a
 * full precedence implementation would be more machinery than that question can justify.
 *
 * Anything unparseable sorts as equal, which makes an unreadable version *not* an update. Failing
 * closed is the right direction: the cost of a missed prompt is that somebody updates by hand, and
 * the cost of a wrong one is overwriting a good install with an older build.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
    if (match === null) return null;
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
      prerelease: match[4] ?? null,
    };
  };

  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return 0;

  for (let index = 0; index < 3; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }

  if (left.prerelease === right.prerelease) return 0;
  // Same numbers, and exactly one of them is a prerelease: that one is the older.
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export interface UpdateResult {
  readonly ok: boolean;
  /** What was installed before, if we could tell. */
  readonly from: string | null;
  readonly to: string;
  readonly path: string | null;
  /** Why it did not happen, in a sentence fit to show a user. Null on success. */
  readonly reason: string | null;
  /**
   * The failure was `EBUSY`: the installed copy is running and Windows will not let its image be
   * overwritten.
   *
   * Separate from `reason` because it is the one failure with a way forward — closing that process
   * and copying again — and a caller must not have to match on the wording of a sentence written
   * for a human to tell it apart from a disk that is full.
   */
  readonly busy: boolean;
}

/**
 * Replaces the installed executable with this one, and nothing else.
 *
 * Deliberately **not** `installLocally`. That function registers the autostart entry and writes the
 * shortcuts, which is right for an install and wrong for an update: somebody who turned "start with
 * Windows" off would have it turned back on by updating, and somebody who deleted the desktop
 * shortcut would find it back. An update should change the version and leave every decision the
 * user has made about the app alone.
 *
 * What it does touch is the Installed apps entry, because `DisplayVersion` is now wrong — an
 * updated app still listed at its old version is a small lie that `installedVersion` would then
 * read back and act on.
 */
export async function updateInstalledCopy(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateResult> {
  const from = installedVersion();
  const to = APP_VERSION;

  const directory = installDirectory(env);
  const target = installTarget(env);
  if (directory === null || target === null) {
    return {
      ok: false,
      from,
      to,
      path: null,
      reason: "There is no installed copy to update.",
      busy: false,
    };
  }

  try {
    await mkdir(directory, { recursive: true });
    await Bun.write(target, Bun.file(execPath));
  } catch (error) {
    /*
     * `EBUSY` means the installed copy is running. That is a likelier state here than it is during
     * a first install — the whole reason there is an older copy is that somebody has been using it.
     *
     * Reported rather than acted on. The caller is the one that knows whether it is early enough in
     * its own startup to close that process and try again (`stopRunningCopies`), or whether it is
     * already serving and the honest answer is a sentence.
     */
    const busy = String(error).includes("EBUSY");
    return {
      ok: false,
      from,
      to,
      path: target,
      reason: busy
        ? "The installed copy of vrc.zip is running and could not be closed."
        : `Could not replace ${target}.`,
      busy,
    };
  }

  let size = 0;
  try {
    size = Bun.file(target).size;
  } catch {
    // Costs the Installed apps entry its size column and nothing else.
  }
  const listed = writeUninstallEntry(target, directory, size);

  return {
    ok: true,
    from,
    to,
    path: target,
    reason: listed ? null : "Updated, but the Installed apps entry could not be refreshed.",
    busy: false,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Handing over to the copy we just wrote                                                         */
/* -------------------------------------------------------------------------------------------- */

/** `vrc.zip`, the process name Windows knows the executable by: the file name without `.exe`. */
const PROCESS_NAME = EXECUTABLE_NAME.replace(/\.exe$/i, "");

/** How long to wait for a killed copy to actually be gone, in seconds. */
const STOP_TIMEOUT_SECONDS = 15;

/**
 * The script that closes running copies of the *installed* executable.
 *
 * Exported for the test, in the same spirit as {@link shortcutPlan}: this is the one thing here
 * that terminates somebody's process, and what it matches on is worth asserting without running it.
 *
 * Three conditions, and dropping any one of them is a bug with a name:
 *
 * - **`$_.Path -ieq $target`** — the *full path*, not the process name. Somebody may well be running
 *   another vrc.zip from Downloads, or from a checkout; those are not in the way of this copy and
 *   are not ours to close. This is also why it is not `taskkill /im vrc.zip.exe`, which would take
 *   every one of them, this process included.
 * - **`$_.Id -ne <pid>`** — never ourselves. Currently redundant, since a process whose path equals
 *   the install target would not be updating it, but it costs one comparison to make that a fact
 *   rather than an inference from the caller's guard.
 * - **`$_.Path`** truthy — `Get-Process` leaves `Path` empty for a process it cannot open, and
 *   `$null -ieq $target` is false, so an unreadable process is skipped rather than matched.
 *
 * `Stop-Process -Force` is a kill, and it is worth being plain about the cost: the copy being closed
 * does not get to flush its queued feed rows or close SQLite tidily. That is the trade the update
 * makes — WAL means the database survives it, and the alternative is refusing to update whenever the
 * app somebody is updating happens to be open, which is nearly always.
 */
export function stopScript(target: string, pid: number): string {
  // A path can hold an apostrophe (`C:\Users\O'Brien\…`), and doubling it is how a single-quoted
  // PowerShell string escapes one. A path can never hold the surrounding quote in any other way,
  // which is what makes a literal string safe here at all.
  const quoted = target.replace(/'/g, "''");
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$target='${quoted}'`,
    `$found=@(Get-Process -Name '${PROCESS_NAME}' | Where-Object { $_.Id -ne ${String(pid)} -and $_.Path -and $_.Path -ieq $target })`,
    "$found | Stop-Process -Force",
    // The wait is the point. Windows releases the image lock when the process is gone, not when the
    // kill is asked for, and copying over it a millisecond later is how this fails intermittently.
    `$found | Wait-Process -Timeout ${String(STOP_TIMEOUT_SECONDS)}`,
    "Write-Output $found.Count",
  ].join("; ");
}

export interface StopResult {
  /** How many processes were killed. Zero is a perfectly ordinary answer. */
  readonly stopped: number;
  /** False when the script could not be run at all. */
  readonly ok: boolean;
}

/**
 * Kills whatever is running the installed executable, and waits for it to be gone.
 *
 * PowerShell rather than FFI, matching `removeShortcuts` above: enumerating processes, filtering
 * them by image path and waiting on their handles is four Win32 calls and a snapshot loop, against
 * one line of a language that is already on every Windows machine. The FFI in `shortcut.ts` and
 * `registry.ts` is there because those needed something PowerShell genuinely could not do.
 *
 * Only ever called on the `EBUSY` path, so the second or so PowerShell costs to start is paid on
 * the rare run that is about to replace an executable anyway, and never on an ordinary one.
 */
export async function stopRunningCopies(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): Promise<StopResult> {
  const target = installTarget(env);
  if (!IS_WINDOWS || target === null) return { stopped: 0, ok: false };

  try {
    const child = Bun.spawn(
      ["powershell", "-NoProfile", "-NonInteractive", "-Command", stopScript(target, pid)],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true },
    );
    const output = await new Response(child.stdout).text();
    const code = await child.exited;
    const count = Number.parseInt(output.trim().split(/\s+/).pop() ?? "", 10);
    return { stopped: Number.isNaN(count) ? 0 : count, ok: code === 0 };
  } catch {
    return { stopped: 0, ok: false };
  }
}

/**
 * Starts the installed copy and lets go of it, passing this run's arguments along.
 *
 * The arguments carry over because the run being replaced is the run the user asked for: a
 * `--hidden` autostart that came back with a visible console window, or a `--no-open` run that
 * opened a browser tab, would both read as the update having broken something.
 *
 * `unref`, and the caller exits immediately afterwards. The child is a GUI-subsystem executable that
 * claims a console of its own, so it does not need ours — which is just as well, since ours is about
 * to close with us.
 */
export function startInstalledCopy(
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const target = installTarget(env);
  const directory = installDirectory(env);
  if (target === null || directory === null) return false;
  return startExecutable(target, args, directory);
}

/**
 * Starts a vrc.zip and lets go of it. The successor half of every handover in this app.
 *
 * **Not `Bun.spawn`, and that is the whole point of `os/detached.ts`.** Bun kills its subprocesses
 * when the parent exits, `unref()` and all, so the obvious version of this function spawned a
 * successor that was dead before it finished starting — every caller here exits immediately
 * afterwards, which is precisely the case that does not survive. Measured, not inferred; the note
 * on `startDetached` has the experiment.
 */
export function startExecutable(path: string, args: readonly string[], directory: string): boolean {
  if (!IS_WINDOWS) return false;
  return startDetached({ path, args, directory }) !== null;
}

/**
 * Rewrites the version the Installed apps entry shows, after something replaced the file it names.
 *
 * Does nothing unless there is an installed copy on disk, which is the check that keeps a portable
 * run from claiming an install it does not have. `updateInstalledCopy` writes the whole entry
 * itself and does not need this; the self-updater does, because the file it replaced was the
 * installed one *in place*, so nothing else would notice the number had changed.
 */
export function noteInstalledVersion(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const target = installTarget(env);
  if (!IS_WINDOWS || target === null || !installExists(env)) return false;
  const ok = writeString(UNINSTALL_KEY_PATH, "DisplayVersion", version);
  try {
    const size = Bun.file(target).size;
    if (size > 0) writeDword(UNINSTALL_KEY_PATH, "EstimatedSize", Math.round(size / 1024));
  } catch {
    // Costs the entry its size column and nothing else.
  }
  return ok;
}
