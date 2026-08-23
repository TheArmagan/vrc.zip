/**
 * The small slice of `HKEY_CURRENT_USER` vrc.zip writes to, over `bun:ffi`.
 *
 * Two callers, and they are the reason this is its own file rather than a private helper in either:
 * `startup.ts` owns one value under `…\CurrentVersion\Run`, and `install.ts` owns a key under
 * `…\CurrentVersion\Uninstall` so the app appears in Installed apps. Two copies of `RegOpenKeyExW`
 * would be two places for the handle-leak bug to live.
 *
 * **`HKEY_CURRENT_USER` only, by construction.** There is no parameter for the root key, and that
 * is deliberate: everything vrc.zip does is per-user and needs no elevation, and a helper that
 * *could* address `HKEY_LOCAL_MACHINE` is a helper somebody will eventually point at it. Uninstall
 * entries under `HKCU` show up in Settings → Installed apps exactly like machine-wide ones, for the
 * user who installed them, which is the correct scope for an app that installs itself into
 * `%LOCALAPPDATA%`.
 *
 * Everything here answers rather than throws. A locked-down machine where `dlopen` fails gets a
 * daemon that reports the feature unavailable, not a startup crash.
 */

import { dlopen, FFIType, suffix } from "bun:ffi";

const IS_WINDOWS = process.platform === "win32";

/** `HKEY_CURRENT_USER`. A sentinel handle, not a real one. */
const HKEY_CURRENT_USER = 0x80000001;

const ERROR_SUCCESS = 0;
export const REG_SZ = 1;
export const REG_EXPAND_SZ = 2;
export const REG_DWORD = 4;

export const KEY_QUERY_VALUE = 0x0001;
export const KEY_SET_VALUE = 0x0002;
/** Needed to delete a subkey *through* its parent, which is how `RegDeleteKeyW` addresses it. */
export const KEY_CREATE_SUB_KEY = 0x0004;

/** Big enough for a long-path install plus flags. A stack buffer, not a budget. */
const MAX_VALUE_BYTES = 2048;

/** UTF-16LE, NUL-terminated. Every `…W` entry point wants this. */
export function wide(value: string): Uint8Array {
  const buffer = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(buffer.buffer);
  for (let index = 0; index < value.length; index += 1) {
    view.setUint16(index * 2, value.charCodeAt(index), true);
  }
  return buffer;
}

/** Reads a NUL-terminated UTF-16 run, stopping at the terminator rather than at the byte count. */
function readWide(buffer: Uint8Array, bytes: number): string {
  const view = new DataView(buffer.buffer);
  let out = "";
  for (let index = 0; index * 2 + 1 < bytes; index += 1) {
    const unit = view.getUint16(index * 2, true);
    if (unit === 0) break;
    out += String.fromCharCode(unit);
  }
  return out;
}

interface Advapi32 {
  RegOpenKeyExW: (
    key: number,
    subKey: Uint8Array,
    options: number,
    access: number,
    result: Uint8Array,
  ) => number;
  RegCreateKeyExW: (
    key: number,
    subKey: Uint8Array,
    reserved: number,
    klass: null,
    options: number,
    access: number,
    security: null,
    result: Uint8Array,
    disposition: null,
  ) => number;
  RegQueryValueExW: (
    key: bigint,
    name: Uint8Array,
    reserved: null,
    type: Uint8Array | null,
    data: Uint8Array | null,
    size: Uint8Array,
  ) => number;
  RegSetValueExW: (
    key: bigint,
    name: Uint8Array,
    reserved: number,
    type: number,
    data: Uint8Array,
    size: number,
  ) => number;
  RegDeleteValueW: (key: bigint, name: Uint8Array) => number;
  RegDeleteKeyW: (key: number, subKey: Uint8Array) => number;
  RegCloseKey: (key: bigint) => number;
}

let advapi32: Advapi32 | null = null;
let attempted = false;

function load(): Advapi32 | null {
  if (attempted) return advapi32;
  attempted = true;
  if (!IS_WINDOWS) return null;
  try {
    const lib = dlopen(`advapi32.${suffix}`, {
      RegOpenKeyExW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      RegCreateKeyExW: {
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      RegQueryValueExW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      RegSetValueExW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      RegDeleteValueW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      RegDeleteKeyW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      RegCloseKey: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    advapi32 = lib.symbols as unknown as Advapi32;
  } catch {
    advapi32 = null;
  }
  return advapi32;
}

/** Whether the registry can be reached at all. False off Windows and where `dlopen` is blocked. */
export function registryAvailable(): boolean {
  return load() !== null;
}

/**
 * Runs `body` against an open key under `HKEY_CURRENT_USER`, and always closes it.
 *
 * Null when the key would not open, which callers read as "not there" — the distinction between a
 * missing key and a refused one is not one any caller here acts on differently.
 */
export function withKey<T>(
  path: string,
  access: number,
  body: (lib: Advapi32, key: bigint) => T,
  create = false,
): T | null {
  const lib = load();
  if (lib === null) return null;

  const handle = new Uint8Array(8);
  const opened = create
    ? // `REG_OPTION_NON_VOLATILE` is 0, and the two nulls are the class and the security
      // descriptor: a key that survives a reboot with the default ACL, which is what we want.
      lib.RegCreateKeyExW(HKEY_CURRENT_USER, wide(path), 0, null, 0, access, null, handle, null)
    : lib.RegOpenKeyExW(HKEY_CURRENT_USER, wide(path), 0, access, handle);
  if (opened !== ERROR_SUCCESS) return null;

  const key = new DataView(handle.buffer).getBigUint64(0, true);
  try {
    return body(lib, key);
  } catch {
    return null;
  } finally {
    lib.RegCloseKey(key);
  }
}

/** A string value, or null when it is absent, unreadable, or not a string in the first place. */
export function readString(path: string, name: string): string | null {
  return withKey(path, KEY_QUERY_VALUE, (lib, key) => {
    const type = new Uint8Array(4);
    const data = new Uint8Array(MAX_VALUE_BYTES);
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, MAX_VALUE_BYTES, true);

    if (lib.RegQueryValueExW(key, wide(name), null, type, data, size) !== ERROR_SUCCESS)
      return null;

    // Anything that is not a string is somebody else's value under our name. Refuse to read it
    // rather than turning arbitrary bytes into text.
    const kind = new DataView(type.buffer).getUint32(0, true);
    if (kind !== REG_SZ && kind !== REG_EXPAND_SZ) return null;

    return readWide(data, new DataView(size.buffer).getUint32(0, true));
  });
}

/** Writes a `REG_SZ`. Creates the key if it is not there. */
export function writeString(path: string, name: string, value: string): boolean {
  const bytes = wide(value);
  const written = withKey(
    path,
    KEY_SET_VALUE,
    // `bytes.length` is the byte count *including* the terminator, which is what `cbData` wants for
    // a `REG_SZ`: a value written without it reads back with whatever follows it in memory.
    (lib, key) => lib.RegSetValueExW(key, wide(name), 0, REG_SZ, bytes, bytes.length),
    true,
  );
  return written === ERROR_SUCCESS;
}

/** Writes a `REG_DWORD`. Creates the key if it is not there. */
export function writeDword(path: string, name: string, value: number): boolean {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  const written = withKey(
    path,
    KEY_SET_VALUE,
    (lib, key) => lib.RegSetValueExW(key, wide(name), 0, REG_DWORD, bytes, 4),
    true,
  );
  return written === ERROR_SUCCESS;
}

/**
 * Deletes a value. Reports true when the value is gone, which includes it never having been there.
 *
 * "Already absent is success" is the right shape for every caller: they are all removing something
 * so that it is not there, and `ERROR_FILE_NOT_FOUND` is that outcome, not a failure to reach it.
 */
export function deleteValue(path: string, name: string): boolean {
  withKey(path, KEY_SET_VALUE, (lib, key) => lib.RegDeleteValueW(key, wide(name)));
  /*
   * The answer is read back rather than taken from the return code, and the open failing is not
   * treated as a failure either — a key that does not exist cannot contain the value, which is the
   * state the caller asked for.
   *
   * This is not hypothetical tidiness. `setStartupEnabled(false)` runs through here, so reporting
   * "could not write to the registry" for a value that was simply already gone would put an error
   * toast under a switch the user turned off successfully.
   */
  return readString(path, name) === null;
}

/**
 * Deletes a key, addressed through its parent because that is how `RegDeleteKeyW` works.
 *
 * Only ever used on a leaf we created ourselves. `RegDeleteKeyW` will not remove a key that still
 * has subkeys, which is a guard rather than a limitation here: if our uninstall entry has grown
 * children, something other than vrc.zip put them there and deleting them is not ours to do.
 */
export function deleteKey(parentPath: string, name: string): boolean {
  const result = withKey(parentPath, KEY_CREATE_SUB_KEY, (lib) => {
    // The parent handle is not what this takes: `RegDeleteKeyW` wants a root plus a full path.
    return lib.RegDeleteKeyW(HKEY_CURRENT_USER, wide(`${parentPath}\\${name}`));
  });
  return result === ERROR_SUCCESS;
}
