/**
 * "Start with Windows", which is one registry value under `HKEY_CURRENT_USER`.
 *
 * ## Why the registry and not a shortcut
 *
 * The two places Windows looks at sign-in are the Startup folder and `…\CurrentVersion\Run`. The
 * folder wants a `.lnk`, and a `.lnk` is a COM object (`IShellLink` + `IPersistFile`) — a vtable
 * walk over `bun:ffi` to write a file whose only advantage is being visible in Explorer. The `Run`
 * key is a string. Both are per-user and neither needs elevation, so the cheap one wins.
 *
 * `HKEY_CURRENT_USER` rather than `HKEY_LOCAL_MACHINE` is not a shortcut either: the machine-wide
 * key would need the daemon to be elevated to *toggle a checkbox*, and it would start vrc.zip for
 * every account on the machine, which is not what anybody ticking this means.
 *
 * ## Only from a packaged build
 *
 * From source the running executable is `bun.exe`, and an entry pointing at it would start Bun with
 * no script at every sign-in: a broken autostart that looks fine in Task Manager. So the whole
 * feature reports itself unsupported unless this is a packaged single-file build, the same way the
 * tray builds no "Hide console" item for a console it does not own.
 *
 * ## What it registers
 *
 * `"<exe>" --hidden --no-open`. Both flags are explicit rather than implied by some "I was started
 * by Windows" mode, because the alternative is a flag whose meaning changes with how the process
 * was launched. A packaged build opens a browser by default, and a tab appearing over whatever
 * somebody is doing thirty seconds after they log in is the fastest way to get this turned off
 * again; `--hidden` keeps the console out of the way, and refuses to when there is no tray icon to
 * get it back from. See `shouldStartHidden`.
 */

import { dlopen, FFIType, read, suffix } from "bun:ffi";
import { deleteValue, readString, writeString } from "./registry.ts";

const IS_WINDOWS = process.platform === "win32";

/** Where Windows looks at sign-in. Backslashes, and this is a registry path rather than a file. */
export const STARTUP_KEY_PATH = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/** The value's name is what Task Manager's Startup tab shows the user. */
export const STARTUP_VALUE_NAME = "vrc.zip";

/**
 * The command line the `Run` value holds.
 *
 * Quoted, and that is load-bearing rather than tidy: the default install path has a space in it,
 * and an unquoted `C:\Program Files\vrc.zip\vrc.zip.exe --hidden` is read by Windows as a request
 * to run `C:\Program.exe` with the rest as arguments. That is not a hypothetical — it is the
 * oldest bug in this key.
 */
export function startupCommand(execPath: string = process.execPath): string {
  return `"${execPath}" --hidden --no-open`;
}

export interface StartupSupport {
  readonly supported: boolean;
  /** Why not, in one sentence fit to show a user. Null when it is supported. */
  readonly reason: string | null;
}

/**
 * Whether this build can register itself, and why not when it cannot.
 *
 * Takes its inputs rather than reading them, so the answer is testable on any platform and so the
 * UI and the tray cannot disagree about it.
 */
export function startupSupport(
  platform: NodeJS.Platform = process.platform,
  packaged = true,
): StartupSupport {
  if (platform !== "win32") {
    return { supported: false, reason: "Starting with the machine is Windows only for now." };
  }
  if (!packaged) {
    return {
      supported: false,
      reason:
        "Only a packaged build can register itself. From source the executable is bun.exe, and an entry pointing at it would start Bun with no script.",
    };
  }
  return { supported: true, reason: null };
}

/* -------------------------------------------------------------------------------------------- */
/* Where the executable is allowed to live                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * `FOLDERID_Downloads`. Asked for by id rather than by name, and that is the entire point.
 *
 * "Does this path contain a folder called Downloads" is wrong on most of the machines this runs on:
 * the folder is `Indirilenler` on a Turkish install, `Téléchargements` on a French one, and a
 * string comparison against the English name finds neither. Windows knows where it actually is.
 */
const FOLDERID_DOWNLOADS = "374DE290-123F-4565-9164-39C4925E467B";

/** A `GUID` struct, x64: two little-endian integers, a little-endian short, then eight raw bytes. */
function guidBytes(value: string): Uint8Array {
  const hex = value.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  const view = new DataView(bytes.buffer);
  view.setUint32(0, view.getUint32(0, false), true);
  view.setUint16(4, view.getUint16(4, false), true);
  view.setUint16(6, view.getUint16(6, false), true);
  return bytes;
}

/** Walks a NUL-terminated UTF-16 string at a raw address. Used for what `SHGetKnownFolderPath` hands back. */
function readWideAt(address: number): string {
  let out = "";
  for (let index = 0; index < 32768; index += 1) {
    const unit = read.u16(address, index * 2);
    if (unit === 0) break;
    out += String.fromCharCode(unit);
  }
  return out;
}

/**
 * The user's real Downloads folder, or null if it cannot be asked for.
 *
 * `SHGetKnownFolderPath` allocates with the COM task allocator, so the result has to go back to
 * `CoTaskMemFree` — this is the one place in `os/` that owns memory Windows allocated.
 */
function downloadsFolder(): string | null {
  if (!IS_WINDOWS) return null;
  try {
    const shell32 = dlopen(`shell32.${suffix}`, {
      SHGetKnownFolderPath: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    }).symbols as unknown as {
      SHGetKnownFolderPath: (id: Uint8Array, flags: number, token: null, out: Uint8Array) => number;
    };
    const ole32 = dlopen(`ole32.${suffix}`, {
      CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void },
    }).symbols as unknown as { CoTaskMemFree: (memory: number) => void };

    const out = new Uint8Array(8);
    // S_OK is 0. Anything else, including a folder the user has redirected away, is "do not know".
    if (shell32.SHGetKnownFolderPath(guidBytes(FOLDERID_DOWNLOADS), 0, null, out) !== 0)
      return null;

    const address = Number(new DataView(out.buffer).getBigUint64(0, true));
    if (address === 0) return null;
    try {
      return readWideAt(address);
    } finally {
      ole32.CoTaskMemFree(address);
    }
  } catch {
    return null;
  }
}

/** Case-insensitive, separator-normalised "is `child` inside `parent`". */
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

export interface StartupLocation {
  /** Whether this is somewhere an autostart entry may reasonably point. */
  readonly ok: boolean;
  /** What is wrong with it, in a sentence fit to show a user. Null when it is fine. */
  readonly reason: string | null;
}

/**
 * Whether the executable is somewhere an autostart entry should be allowed to point.
 *
 * Two places are refused, and the refusal is the feature rather than a nicety.
 *
 * **Downloads.** Registering an autostart from here produces an entry that works today and is
 * broken by the first tidy-up: Storage Sense deletes downloads older than a set age by default,
 * browsers reuse the folder, and `vrc.zip (1).exe` next to `vrc.zip.exe` is the normal state of it.
 * The failure is also the worst-shaped one available — nothing happens at sign-in, with no error,
 * months after the checkbox was ticked and long after anybody would connect the two.
 *
 * **The temp directory.** The same thing but faster, and it is where a build run straight out of a
 * `.zip` by double-clicking it lands: Explorer extracts to a temp folder, so the "installed" app is
 * a file the OS will delete.
 *
 * Takes its inputs so it is testable on any platform, and so the UI and the tray get one answer.
 */
export function startupLocation(
  execPath: string = process.execPath,
  folders: { downloads?: string | null; temp?: string | null } = {},
): StartupLocation {
  const downloads = folders.downloads === undefined ? downloadsFolder() : folders.downloads;
  const temp =
    folders.temp === undefined ? (process.env.TEMP ?? process.env.TMP ?? null) : folders.temp;

  if (downloads !== null && isInside(execPath, downloads)) {
    return {
      ok: false,
      reason:
        "vrc.zip is running from your Downloads folder. Move it somewhere permanent first, such as a folder in Program Files or your user folder, then turn this on. Windows cleans downloads up on its own, and an autostart pointing at a deleted file fails silently.",
    };
  }
  if (temp !== null && temp !== "" && isInside(execPath, temp)) {
    return {
      ok: false,
      reason:
        "vrc.zip is running from a temporary folder, which is where Windows extracts a zip you opened by double-clicking it. Copy it somewhere permanent first, then turn this on.",
    };
  }
  return { ok: true, reason: null };
}

export interface StartupControl {
  readonly supported: boolean;
  readonly reason: string | null;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): StartupWriteResult;
}

/**
 * The whole feature as one object, for the two places that need it.
 *
 * A factory rather than each caller assembling the same three functions, because the tray and the
 * settings screen must not be able to disagree about whether this is available: they would disagree
 * silently, and the symptom would be a switch in one place that does nothing in the other. `app.ts`
 * hands one of these to the control API and `index.ts` hands one to the tray.
 */
export function createStartupControl(
  platform: NodeJS.Platform = process.platform,
  packaged = true,
): StartupControl {
  const support = startupSupport(platform, packaged);
  if (!support.supported) {
    return {
      supported: false,
      reason: support.reason,
      isEnabled: () => false,
      setEnabled: () => ({ ok: false, reason: support.reason }),
    };
  }
  return {
    supported: true,
    // The standing reason is where the executable lives, computed now rather than on every read:
    // the answer cannot change without the process being restarted from somewhere else.
    reason: startupLocation().reason,
    isEnabled: () => isStartupEnabled(),
    setEnabled: (enabled) => setStartupEnabled(enabled),
  };
}

/** The command currently registered, or null if there is no entry (or no registry to read). */
export function readStartupEntry(): string | null {
  return readString(STARTUP_KEY_PATH, STARTUP_VALUE_NAME);
}

/** Whether vrc.zip is registered to start with Windows. False everywhere it cannot be. */
export function isStartupEnabled(): boolean {
  return readStartupEntry() !== null;
}

export interface StartupWriteResult {
  readonly ok: boolean;
  /** Why it did not happen, in a sentence fit to show a user. Null on success. */
  readonly reason: string | null;
}

/**
 * Registers or unregisters, and says why when it will not.
 *
 * **Turning it off is never refused.** Only the enable path checks where the executable lives,
 * which matters more than it looks: somebody who ticked this and *then* moved vrc.zip into
 * Downloads must still be able to untick it, and a symmetric guard would trap them with an entry
 * they cannot remove from here.
 *
 * Deleting a value that is not there answers `ERROR_FILE_NOT_FOUND`, which is the state the caller
 * wanted, so "off" is success rather than a failure to remove nothing.
 */
export function setStartupEnabled(
  enabled: boolean,
  execPath: string = process.execPath,
): StartupWriteResult {
  if (!enabled) {
    return deleteValue(STARTUP_KEY_PATH, STARTUP_VALUE_NAME)
      ? { ok: true, reason: null }
      : { ok: false, reason: "Could not write to the registry." };
  }

  const location = startupLocation(execPath);
  if (!location.ok) return { ok: false, reason: location.reason };

  return writeString(STARTUP_KEY_PATH, STARTUP_VALUE_NAME, startupCommand(execPath))
    ? { ok: true, reason: null }
    : { ok: false, reason: "Could not write to the registry." };
}

/** The executable out of a registered command, which is the leading quoted run. Null if unparseable. */
export function startupEntryTarget(command: string): string | null {
  const match = /^"([^"]+)"/.exec(command);
  return match?.[1] ?? null;
}

/**
 * Points a *broken* entry at this executable, and reports whether it did.
 *
 * The case is ordinary rather than exotic: vrc.zip is a single file people move around, and a `Run`
 * value naming last month's folder is an autostart that silently does nothing at every sign-in.
 *
 * The condition is deliberately narrow, and the narrowness is the interesting part. An earlier
 * version repaired whenever the entry did not match the running executable, which is wrong in a way
 * that only shows up once the installer exists: somebody installs to `%LOCALAPPDATA%`, then
 * double-clicks the copy still sitting in Downloads, and that process helpfully "repairs" a working
 * entry into a broken one. So the entry is only touched when the file it names is **gone**, and
 * only replaced with somewhere an entry is allowed to point in the first place.
 */
export function repairStartupEntry(execPath: string = process.execPath): boolean {
  const current = readStartupEntry();
  if (current === null) return false;

  const registered = startupEntryTarget(current);
  // Unparseable means somebody else's hand-written command under our name. Leave it alone.
  if (registered === null) return false;
  if (registered === execPath) return false;

  // The one thing that makes a repair correct: what it points at no longer exists.
  try {
    if (Bun.file(registered).size > 0) return false;
  } catch {
    // Treat an unreadable path as missing, which is what it is from here.
  }

  if (!startupLocation(execPath).ok) return false;
  return setStartupEnabled(true, execPath).ok;
}
