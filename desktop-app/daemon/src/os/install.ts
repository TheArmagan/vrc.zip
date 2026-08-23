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
 * So this is the way forward: copy the executable to `%LOCALAPPDATA%\vrc.zip`, put shortcuts where
 * Windows looks for programs, and register the autostart against the copy. Still per-user, still no
 * elevation, still nothing in the registry beyond the one `Run` value — an "install" only in the
 * sense that the file is now somewhere it will survive.
 *
 * ## Shortcuts are PowerShell, and the tray icon is not
 *
 * A `.lnk` is a COM object: `IShellLink` plus `IPersistFile`, which over `bun:ffi` means calling
 * vtable slots by index through `CFunction`. `desktop-notification.ts` already establishes the
 * alternative, and the trade that made FFI right for the tray points the other way here. The tray
 * icon needed a PowerShell host alive for the whole session, which would have doubled the app's
 * idle footprint to draw a 16px square. This runs once, when somebody clicks Install, and then the
 * process exits.
 *
 * Every path goes through the environment rather than into the script text, for the reason
 * `desktop-notification.ts` gives: PowerShell has its own quoting rules on top of the argv
 * boundary, and a folder with a quote in it would otherwise break the script or extend it.
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
import { deleteKey, writeDword, writeString } from "./registry.ts";
import { setStartupEnabled } from "./startup.ts";

const IS_WINDOWS = process.platform === "win32";

/** The folder name under `%LOCALAPPDATA%`, and the shortcut's name without its extension. */
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
  return join(local, APP_FOLDER);
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
 * The PowerShell that writes the shortcuts.
 *
 * Exported for the test, which asserts on the script rather than running it: what matters is that
 * no path is interpolated into it and that both folders are resolved by Windows rather than
 * assumed. `[Environment]::GetFolderPath` is the reason for the latter — a desktop redirected into
 * OneDrive is the common case now, and `%USERPROFILE%\Desktop` is simply the wrong folder there.
 */
export function shortcutScript(): string[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$shell=New-Object -ComObject WScript.Shell",
    "$target=$env:VRCZ_LNK_TARGET",
    "$dir=Split-Path -Parent $target",
    "function New-VrcShortcut($folder) {",
    "  $path=Join-Path $folder 'vrc.zip.lnk'",
    "  $link=$shell.CreateShortcut($path)",
    "  $link.TargetPath=$target",
    "  $link.WorkingDirectory=$dir",
    "  $link.Description='vrc.zip'",
    "  $link.Save()",
    "}",
    "if ($env:VRCZ_LNK_DESKTOP -eq '1') { New-VrcShortcut ([Environment]::GetFolderPath('Desktop')) }",
    "if ($env:VRCZ_LNK_STARTMENU -eq '1') { New-VrcShortcut ([Environment]::GetFolderPath('Programs')) }",
  ].join("; ");

  return [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-Command",
    script,
  ];
}

/** Writes the shortcuts. Best-effort: a failure here does not undo a successful copy. */
async function writeShortcuts(
  target: string,
  desktop: boolean,
  startMenu: boolean,
): Promise<boolean> {
  if (!desktop && !startMenu) return true;
  const [command, ...args] = shortcutScript();
  if (command === undefined) return false;
  try {
    const child = Bun.spawn([command, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: {
        ...process.env,
        VRCZ_LNK_TARGET: target,
        VRCZ_LNK_DESKTOP: desktop ? "1" : "0",
        VRCZ_LNK_STARTMENU: startMenu ? "1" : "0",
      },
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
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

  const shortcuts = await writeShortcuts(
    target,
    options.desktopShortcut,
    options.startMenuShortcut,
  );

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
 * The user's data is deliberately **not** touched. `%APPDATA%rc.zip` holds the credential store,
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

  const scheduled = await scheduleDirectoryRemoval(directory, execPath);
  return {
    ok: true,
    reason: scheduled
      ? null
      : `Removed vrc.zip's shortcuts and registry entries. The folder ${directory} could not be scheduled for deletion; remove it by hand.`,
    path: directory,
  };
}

/** Deletes the two shortcuts, wherever Windows says those folders actually are. */
async function removeShortcuts(): Promise<boolean> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {",
    "  $path=Join-Path $folder 'vrc.zip.lnk'",
    "  if (Test-Path $path) { Remove-Item -Force $path }",
    "}",
  ].join("; ");
  try {
    const child = Bun.spawn(
      ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
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
    Bun.spawn(["cmd", "/c", script], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      // Detached: this has to outlive us, since what it is waiting for is us exiting.
    }).unref();
    return true;
  } catch {
    return false;
  }
}
