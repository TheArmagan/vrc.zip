/**
 * Writing a `.lnk`, and the one property that makes toasts possible.
 *
 * ## Why this replaced a PowerShell script
 *
 * `install.ts` used to write its shortcuts through `WScript.Shell`, which is a fine way to make a
 * shortcut and cannot make *this* shortcut. A Windows toast is attributed to an
 * **AppUserModelID**, and for an app that is not packaged the only way to own one is to put it on a
 * Start menu shortcut: the shell reads `System.AppUserModel.ID` off the `.lnk`, and from then on a
 * process that sets the same id on itself is allowed to raise toasts under it, with the shortcut's
 * name and icon on them. `WScript.Shell` exposes no way to write that property — it is
 * `IPropertyStore`, which is COM, which is what a `.lnk` was all along.
 *
 * So the shortcut writer is FFI now, and there is one of it. Two writers would have meant the
 * install path and the toast path disagreeing about what a vrc.zip shortcut looks like, which is
 * the kind of drift that only shows up as "notifications say PowerShell on his machine".
 *
 * ## The shortcut the notifier writes for itself
 *
 * When vrc.zip has been installed there is already a Start menu entry and it carries the id. When it
 * has not — the ordinary case of running from source, or a downloaded executable somebody
 * double-clicked — there is nothing, and a toast would have nowhere to come from. So the notifier
 * asks for {@link ensureToastShortcut}, which writes one into a folder of our own,
 * `Start Menu\Programs\vrc.zip\`, the first time something actually wants to notify.
 *
 * A folder rather than a loose `.lnk` beside everyone else's, for two reasons: `--uninstall` can
 * remove the whole thing without matching filenames, and it keeps the entry visibly ours in a list
 * the user reads. It is written on demand rather than at startup because a daemon that never
 * notifies has no business adding itself to somebody's Start menu.
 */

import { dlopen, FFIType, ptr, read, suffix } from "bun:ffi";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  call,
  createInstance,
  guid,
  propVariantClear,
  queryInterface,
  release,
  S_OK,
  taskMemFree,
} from "./com.ts";
import { wide } from "./message-pump.ts";

const IS_WINDOWS = process.platform === "win32";

/**
 * The id every toast vrc.zip raises is attributed to.
 *
 * Constant across versions and installed-or-not: the id *is* the identity as far as the Action
 * Center is concerned, so changing it would orphan every notification already sitting in it and
 * silently reset whatever the user had configured for vrc.zip in Settings → Notifications.
 */
export const APP_USER_MODEL_ID = "vrc.zip.Desktop";

const CLSID_ShellLink = "00021401-0000-0000-C000-000000000046";
const IID_IShellLinkW = "000214F9-0000-0000-C000-000000000046";
const IID_IPersistFile = "0000010B-0000-0000-C000-000000000046";
const IID_IPropertyStore = "886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99";

/**
 * `System.AppUserModel.ID`.
 *
 * The `fmtid` and `pid` are the property's real name; `"System.AppUserModel.ID"` is a label the
 * property system can look up and this avoids needing propsys to do it.
 */
const PKEY_AppUserModel_ID = { fmtid: "9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3", pid: 5 };

/** Vtable slots. Inherited methods count, which is why none of these start at 3. */
const IShellLink = { SetDescription: 7, SetWorkingDirectory: 9, SetIconLocation: 17, SetPath: 20 };
const IPersistFile = { Load: 5, Save: 6 };
const IPropertyStore = { GetValue: 5, SetValue: 6, Commit: 7 };

/** `VT_LPWSTR`: a pointer to a NUL-terminated wide string that the callee copies. */
const VT_LPWSTR = 31;

/**
 * `PROPERTYKEY` is a `GUID` followed by a `DWORD`, so twenty bytes with nothing to align.
 *
 * Passed by reference, so an over-allocation would be harmless — but it is written out exactly
 * because getting a struct "close enough" is how the next one goes wrong.
 */
function propertyKey(fmtid: string, pid: number): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes.set(guid(fmtid), 0);
  new DataView(bytes.buffer).setUint32(16, pid, true);
  return bytes;
}

/**
 * A `PROPVARIANT` holding a string we own.
 *
 * 24 bytes on x64: `vt` at 0, three reserved words, and the union at 8. The string buffer is
 * returned alongside so the caller can keep it alive for the length of the call — a JavaScript
 * `Uint8Array` that goes out of scope while COM still holds a pointer into it is a use-after-free
 * that will not reproduce on the machine you wrote it on.
 *
 * `PropVariantClear` is deliberately never called on this. It would hand our own buffer to
 * `CoTaskMemFree`, which did not allocate it. `SetValue` copies what it is given, so there is
 * nothing to free.
 */
function stringVariant(value: string): { variant: Uint8Array; text: Uint8Array } {
  const text = wide(value);
  const variant = new Uint8Array(24);
  const view = new DataView(variant.buffer);
  view.setUint16(0, VT_LPWSTR, true);
  return { variant, text };
}

export interface ShortcutOptions {
  /** Where the `.lnk` goes. Its parent directory must already exist. */
  readonly path: string;
  /** What it points at. */
  readonly target: string;
  readonly workingDirectory?: string;
  readonly description?: string;
  /**
   * The AppUserModelID to stamp on it.
   *
   * Optional only in the type. Every shortcut vrc.zip writes gets one, because a Start menu entry
   * without it is a shortcut that cannot be notified from, and there is no reason to have both
   * kinds.
   */
  readonly appUserModelId?: string;
}

/**
 * Writes a shortcut. Returns whether it landed; never throws.
 *
 * The order is not arbitrary. The property store is written and committed *before* `IPersistFile`
 * saves, because `Save` is what serialises the whole object — a `Commit` after it writes the
 * property to an object nobody will store again.
 */
export function writeShortcut(options: ShortcutOptions): boolean {
  if (!IS_WINDOWS) return false;

  const link = createInstance(guid(CLSID_ShellLink), guid(IID_IShellLinkW));
  if (link === 0) return false;

  let store = 0;
  let file = 0;
  try {
    if (call(link, IShellLink.SetPath, [FFIType.ptr], [wide(options.target)]) !== S_OK)
      return false;
    if (options.workingDirectory !== undefined) {
      call(link, IShellLink.SetWorkingDirectory, [FFIType.ptr], [wide(options.workingDirectory)]);
    }
    if (options.description !== undefined) {
      call(link, IShellLink.SetDescription, [FFIType.ptr], [wide(options.description)]);
    }
    // The toast's icon comes from here as much as the Start menu's does: an unpackaged app's
    // notification shows the shortcut's icon, so pointing it at the executable is what stops the
    // toast being drawn with a blank square.
    call(link, IShellLink.SetIconLocation, [FFIType.ptr, FFIType.i32], [wide(options.target), 0]);

    if (options.appUserModelId !== undefined) {
      store = queryInterface(link, guid(IID_IPropertyStore));
      if (store === 0) return false;
      const key = propertyKey(PKEY_AppUserModel_ID.fmtid, PKEY_AppUserModel_ID.pid);
      const { variant, text } = stringVariant(options.appUserModelId);
      new DataView(variant.buffer).setBigUint64(8, BigInt(ptr(text)), true);
      const set = call(store, IPropertyStore.SetValue, [FFIType.ptr, FFIType.ptr], [key, variant]);
      // `text` is read by the call above; naming it here is what keeps it from being collected.
      if (set !== S_OK || text.length === 0) return false;
      if (call(store, IPropertyStore.Commit, [], []) !== S_OK) return false;
    }

    file = queryInterface(link, guid(IID_IPersistFile));
    if (file === 0) return false;
    return (
      call(file, IPersistFile.Save, [FFIType.ptr, FFIType.i32], [wide(options.path), 1]) === S_OK
    );
  } catch {
    return false;
  } finally {
    release(file);
    release(store);
    release(link);
  }
}

/**
 * Reads an existing `.lnk`'s AppUserModelID, and stamps ours on it if it has none.
 *
 * This exists because of what is actually on people's machines. A copy installed by any build
 * before the shortcut writer moved to COM has a perfectly good Start menu entry with no
 * `System.AppUserModel.ID` on it, and a toast raised against an id no shortcut carries **succeeds**:
 * `CreateToastNotifierWithId` returns `S_OK`, `Show` returns `S_OK`, and nothing appears. That is
 * the worst failure shape there is, and it was the state of the machine this was written on.
 *
 * The repair is deliberately the smallest one that works. `IPersistFile::Load` reads the whole
 * shortcut, so the target, the icon and the working directory are whatever the user's shortcut
 * already said; only the property is touched, and only when it is absent or different. Saving with a
 * null filename writes back to the file it was loaded from, so nothing has to be recomposed.
 *
 * Returns whether the shortcut can now be notified from.
 */
export function ensureShortcutAppId(path: string, appUserModelId: string): boolean {
  if (!IS_WINDOWS) return false;

  const link = createInstance(guid(CLSID_ShellLink), guid(IID_IShellLinkW));
  if (link === 0) return false;

  let file = 0;
  let store = 0;
  try {
    file = queryInterface(link, guid(IID_IPersistFile));
    if (file === 0) return false;
    // `STGM_READWRITE`. Loading read-only and then saving is a shortcut that reports success and
    // does not change.
    if (
      call(file, IPersistFile.Load, [FFIType.ptr, FFIType.u32], [wide(path), 0x0000_0002]) !== S_OK
    ) {
      return false;
    }

    store = queryInterface(link, guid(IID_IPropertyStore));
    if (store === 0) return false;
    const key = propertyKey(PKEY_AppUserModel_ID.fmtid, PKEY_AppUserModel_ID.pid);

    const existing = new Uint8Array(24);
    if (
      call(store, IPropertyStore.GetValue, [FFIType.ptr, FFIType.ptr], [key, existing]) === S_OK
    ) {
      const view = new DataView(existing.buffer);
      const address =
        view.getUint16(0, true) === VT_LPWSTR ? Number(view.getBigUint64(8, true)) : 0;
      const current = address === 0 ? "" : readWide(address);
      // This one *was* allocated by COM, so unlike the variant we build, it must be cleared.
      propVariantClear(existing);
      if (current === appUserModelId) return true;
    }

    const { variant, text } = stringVariant(appUserModelId);
    new DataView(variant.buffer).setBigUint64(8, BigInt(ptr(text)), true);
    if (call(store, IPropertyStore.SetValue, [FFIType.ptr, FFIType.ptr], [key, variant]) !== S_OK) {
      return false;
    }
    if (text.length === 0) return false;
    if (call(store, IPropertyStore.Commit, [], []) !== S_OK) return false;

    // A null filename means "the file you were loaded from", which is the whole point: nothing here
    // knows what the user's shortcut pointed at and nothing here should have to.
    return call(file, IPersistFile.Save, [FFIType.ptr, FFIType.i32], [null, 1]) === S_OK;
  } catch {
    return false;
  } finally {
    release(store);
    release(file);
    release(link);
  }
}

/** Reads a NUL-terminated wide string out of foreign memory. */
function readWide(address: number): string {
  let text = "";
  for (let offset = 0; offset < 32_768; offset += 2) {
    const unit = read.u16(address, offset);
    if (unit === 0) break;
    text += String.fromCharCode(unit);
  }
  return text;
}

/* -------------------------------------------------------------------------------------------- */
/* Where the shortcuts go                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** `FOLDERID_Desktop` and `FOLDERID_Programs` — the Start menu's per-user `Programs` folder. */
export const FOLDERID_Desktop = "B4BFCC3A-DB2C-424C-B029-7FE99A87C641";
export const FOLDERID_Programs = "A77F5D77-2E2B-44C3-A6A2-ABA601054A51";

let shell32: {
  SHGetKnownFolderPath: (id: Uint8Array, flags: number, token: null, out: Uint8Array) => number;
  SetCurrentProcessExplicitAppUserModelID: (id: Uint8Array) => number;
} | null = null;
let shellAttempted = false;

/** Opens shell32 once, for the two entry points here that are not COM. Never throws. */
function loadShell32(): void {
  if (shellAttempted || !IS_WINDOWS) return;
  shellAttempted = true;
  try {
    shell32 = dlopen(`shell32.${suffix}`, {
      SHGetKnownFolderPath: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      SetCurrentProcessExplicitAppUserModelID: { args: [FFIType.ptr], returns: FFIType.i32 },
    }).symbols as unknown as typeof shell32;
  } catch {
    shell32 = null;
  }
}

/**
 * Asks Windows where a folder actually is.
 *
 * Not `%USERPROFILE%\Desktop`, and this is the reason the PowerShell version called
 * `[Environment]::GetFolderPath`: a desktop redirected into OneDrive is the common case now, and
 * the composed path is simply the wrong folder there — a shortcut written to it goes somewhere the
 * user will never see.
 */
export function knownFolder(id: string): string | null {
  if (!IS_WINDOWS) return null;
  loadShell32();
  if (shell32 === null) return null;

  const out = new Uint8Array(8);
  try {
    if (shell32.SHGetKnownFolderPath(guid(id), 0, null, out) !== S_OK) return null;
  } catch {
    return null;
  }
  const address = Number(new DataView(out.buffer).getBigUint64(0, true));
  if (address === 0) return null;
  try {
    let text = "";
    for (let offset = 0; offset < 32_768; offset += 2) {
      const unit = read.u16(address, offset);
      if (unit === 0) break;
      text += String.fromCharCode(unit);
    }
    return text === "" ? null : text;
  } finally {
    // The path is `CoTaskMemAlloc`ed and ours to free, which is the one piece of this that leaks
    // silently if it is forgotten.
    taskMemFree(address);
  }
}

/** `…\Start Menu\Programs`, from the shell where it can answer and from `%APPDATA%` where it cannot. */
export function startMenuPrograms(env: NodeJS.ProcessEnv = process.env): string | null {
  const asked = knownFolder(FOLDERID_Programs);
  if (asked !== null) return asked;
  const roaming = env.APPDATA;
  if (roaming === undefined || roaming.trim() === "") return null;
  return join(roaming, "Microsoft", "Windows", "Start Menu", "Programs");
}

/** The folder `--uninstall` removes whole, and the `.lnk` inside it. */
export function toastShortcutPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const programs = startMenuPrograms(env);
  return programs === null ? null : join(programs, "vrc.zip", "vrc.zip.lnk");
}

/** The shortcut `install.ts` writes, which already carries the id when it exists. */
export function installedShortcutPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const programs = startMenuPrograms(env);
  return programs === null ? null : join(programs, "vrc.zip.lnk");
}

/**
 * Tells Windows which app this process *is*.
 *
 * The half of the AppUserModelID story that is easy to miss, because everything works without it
 * right up to the point where nothing appears. The shortcut declares that the id exists; this
 * declares that we are it. Without the call, `CreateToastNotifierWithId` succeeds, `Show` returns
 * `S_OK`, the platform even registers a notification handler for the id — and no toast is ever
 * delivered, with nothing anywhere saying why.
 *
 * Found by reading Windows' own notification database (`wpndatabase.db`): our handler row was
 * there, enabled, with zero notifications against it, while PowerShell's had hundreds.
 *
 * Once per process, and early: the documentation is explicit that it must happen before anything
 * else in the process talks to the shell.
 */
function claimProcessAppId(appUserModelId: string): void {
  if (!IS_WINDOWS || claimed) return;
  claimed = true;
  loadShell32();
  try {
    shell32?.SetCurrentProcessExplicitAppUserModelID(wide(appUserModelId));
  } catch {
    // An older Windows without the export. The toast then fails the honest way, by not appearing.
  }
}

let claimed = false;
let ensured: string | null | undefined;

/**
 * Makes sure *some* Start menu shortcut carries our AppUserModelID, and says which one.
 *
 * Answered once per process and then remembered, including the failure: this runs on the path a
 * notification takes, and a machine with no `%APPDATA%` should not pay for a filesystem probe per
 * toast.
 *
 * An installed copy's shortcut wins when it is there, and is *repaired* rather than rewritten: its
 * AppUserModelID is stamped on if it is missing, and everything else about it — where it points,
 * what icon it uses — is left exactly as the user's shortcut already had it. Rewriting it outright
 * would repoint it at `bun.exe` when the process asking is a dev run rather than the installed copy,
 * and adding a second entry beside it would put two `vrc.zip` rows in somebody's Start menu.
 *
 * The repair is not a nicety. Any copy installed before the writer moved to COM has a shortcut with
 * no id on it, and a toast raised against an id no shortcut carries returns `S_OK` and shows
 * nothing. See {@link ensureShortcutAppId}.
 */
export async function ensureToastShortcut(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): Promise<string | null> {
  if (ensured !== undefined) return ensured;
  claimProcessAppId(APP_USER_MODEL_ID);
  ensured = await createToastShortcut(env, execPath);
  return ensured;
}

/** Only for tests, which need each case to start from nothing. */
export function forgetToastShortcut(): void {
  ensured = undefined;
}

async function createToastShortcut(
  env: NodeJS.ProcessEnv,
  execPath: string,
): Promise<string | null> {
  if (!IS_WINDOWS) return null;

  const installed = installedShortcutPath(env);
  const own = toastShortcutPath(env);
  const target = execPath;

  if (installed !== null && (await exists(installed))) {
    if (ensureShortcutAppId(installed, APP_USER_MODEL_ID)) return installed;
    // A shortcut we could not repair — read-only, held open, on a network path — is not a reason to
    // give up: our own folder below is somewhere we are always allowed to write.
  }

  if (own === null) return null;
  try {
    await mkdir(join(own, ".."), { recursive: true });
  } catch {
    return null;
  }
  return writeShortcut({
    path: own,
    target,
    workingDirectory: join(target, ".."),
    description: "vrc.zip",
    appUserModelId: APP_USER_MODEL_ID,
  })
    ? own
    : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    return await Bun.file(path).exists();
  } catch {
    return false;
  }
}
