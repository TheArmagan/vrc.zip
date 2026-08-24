/**
 * The small amount of COM that `bun:ffi` does not give you.
 *
 * Two things in `os/` need to talk to COM objects: the `.lnk` writer (`IShellLinkW`,
 * `IPersistFile`, `IPropertyStore`) and the toast notifier (WinRT, which is COM with a different
 * accent). Neither needs a framework. What they both need is the same three primitives, and having
 * one copy of them means one place where a vtable index or a GUID layout can be wrong.
 *
 * **A COM interface pointer is a pointer to a pointer to an array of function pointers.** Slot 0 is
 * `QueryInterface`, 1 is `AddRef`, 2 is `Release`, and everything an interface declares follows in
 * declaration order — including everything it inherits, which is why `IPropertyStore::SetValue` is
 * slot 6 and not slot 3. Get that index wrong and you do not get an error: you call a different
 * function with the wrong arguments, on the ABI's terms.
 *
 * ## The apartment
 *
 * `ensureApartment()` initialises this thread as an STA, once, and nothing ever calls
 * `CoUninitialize`. That is deliberate on both counts.
 *
 * STA rather than MTA because of what the notifier does with it: a WinRT toast's `Activated` handler
 * is a call *back* into this process, and an STA delivers those by sending window messages to the
 * apartment's hidden window — which our own message loop is already pumping. In an MTA the same call
 * arrives on an RPC pool thread, which for a JavaScript runtime means executing JS off the thread
 * that owns the heap. `os/message-pump.ts` is the other half of this decision.
 *
 * And no `CoUninitialize` because the apartment outlives every caller: tearing it down while a live
 * toast still holds an interface pointer is a crash, and the process exiting does the same cleanup
 * for free.
 */

import { CFunction, dlopen, FFIType, type Pointer, read, suffix } from "bun:ffi";

const IS_WINDOWS = process.platform === "win32";

/** `S_OK`. Every call below reports success as zero, and `S_FALSE` (1) as "already done". */
export const S_OK = 0;
export const S_FALSE = 1;
/** `CLSCTX_INPROC_SERVER`. */
export const CLSCTX_INPROC_SERVER = 1;
/** `COINIT_APARTMENTTHREADED`. See the note above on why this and not `COINIT_MULTITHREADED`. */
const COINIT_APARTMENTTHREADED = 0x2;
/** `RPC_E_CHANGED_MODE`: this thread is already in an apartment of the other kind. */
const RPC_E_CHANGED_MODE = -2147417850;

interface ComLibs {
  readonly ole32: {
    CoInitializeEx: (reserved: null, flags: number) => number;
    CoCreateInstance: (
      clsid: Uint8Array,
      outer: null,
      context: number,
      iid: Uint8Array,
      out: Uint8Array,
    ) => number;
    CoTaskMemFree: (memory: number | bigint) => void;
  };
}

let libs: ComLibs | null = null;
let attempted = false;

/** Opens ole32 once, and never throws. A machine where this fails simply has no COM to offer. */
export function comLibs(): ComLibs | null {
  if (attempted) return libs;
  attempted = true;
  if (!IS_WINDOWS) return null;
  try {
    const ole32 = dlopen(`ole32.${suffix}`, {
      CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CoCreateInstance: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void },
    });
    libs = { ole32: ole32.symbols as unknown as ComLibs["ole32"] };
  } catch {
    libs = null;
  }
  return libs;
}

let apartment: boolean | null = null;

/**
 * Puts this thread in a single-threaded apartment. Idempotent, and answers whether there is one.
 *
 * `S_FALSE` means it was already initialised with the same model, which is a success. Even
 * `RPC_E_CHANGED_MODE` is treated as one: it says the thread is already in an apartment, just not
 * the kind we asked for, and calls still work — what would not work is a callback expecting our
 * message loop, which the notifier finds out about the honest way, by not receiving one.
 */
export function ensureApartment(): boolean {
  if (apartment !== null) return apartment;
  const lib = comLibs();
  if (lib === null) {
    apartment = false;
    return false;
  }
  try {
    const result = lib.ole32.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
    apartment = result === S_OK || result === S_FALSE || result === RPC_E_CHANGED_MODE;
  } catch {
    apartment = false;
  }
  return apartment;
}

/* -------------------------------------------------------------------------------------------- */
/* GUIDs                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * A `GUID` struct from its written form.
 *
 * The layout catches people out: the first three groups are little-endian integers and the last two
 * are a plain run of bytes in the order they are written. So `{00021401-…}` is `01 14 02 00` on the
 * wire, and the trailing `C000000000000046` is not reversed at all.
 */
export function guid(text: string): Uint8Array {
  const clean = text.replace(/[{}-]/g, "");
  if (clean.length !== 32) throw new Error(`not a GUID: ${text}`);
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Number.parseInt(clean.slice(0, 8), 16), true);
  view.setUint16(4, Number.parseInt(clean.slice(8, 12), 16), true);
  view.setUint16(6, Number.parseInt(clean.slice(12, 16), 16), true);
  for (let index = 0; index < 8; index += 1) {
    bytes[8 + index] = Number.parseInt(clean.slice(16 + index * 2, 18 + index * 2), 16);
  }
  return bytes;
}

/* -------------------------------------------------------------------------------------------- */
/* Calling an interface                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * The function pointer in slot `index` of `object`'s vtable.
 *
 * Typed as `Pointer` — `bun:ffi`'s branded number — because `CFunction` will not take a plain one,
 * and the brand is the whole point: an address that came from arithmetic somewhere else is exactly
 * the mistake it exists to catch.
 */
function slot(object: number, index: number): Pointer {
  const vtable = read.ptr(object, 0);
  return read.ptr(vtable, index * 8) as Pointer;
}

/**
 * Calls a vtable slot, with the `this` pointer prepended for you.
 *
 * Returns the `HRESULT` as a signed number, because that is what almost every COM method returns and
 * the few that do not (`AddRef`, `Release`) return a count nobody here reads. The `CFunction` is
 * built and closed per call: this is not a hot path — a toast is a dozen calls — and caching one per
 * slot would mean caching per *object*, since two objects of different types share slot numbers.
 */
export function call(
  object: number,
  index: number,
  args: readonly FFIType[],
  values: readonly (number | bigint | Uint8Array | null)[],
): number {
  const fn = CFunction({
    ptr: slot(object, index),
    args: [FFIType.ptr, ...args],
    returns: FFIType.i32,
  }) as unknown as {
    (...rest: unknown[]): number | bigint;
    close?: () => void;
  };
  try {
    return Number(fn(object, ...values));
  } finally {
    fn.close?.();
  }
}

/** `IUnknown::Release`. Safe to hand a zero, which is what a failed creation leaves behind. */
export function release(object: number): void {
  if (object === 0) return;
  try {
    call(object, 2, [], []);
  } catch {
    // Releasing on a teardown path. Nothing above this cares.
  }
}

/** `IUnknown::QueryInterface`. Returns the new pointer, or 0. */
export function queryInterface(object: number, iid: Uint8Array): number {
  const out = new Uint8Array(8);
  if (call(object, 0, [FFIType.ptr, FFIType.ptr], [iid, out]) !== S_OK) return 0;
  return Number(new DataView(out.buffer).getBigUint64(0, true));
}

/** `CoCreateInstance` for an in-process server. Returns the interface pointer, or 0. */
export function createInstance(clsid: Uint8Array, iid: Uint8Array): number {
  const lib = comLibs();
  if (lib === null || !ensureApartment()) return 0;
  const out = new Uint8Array(8);
  try {
    const result = lib.ole32.CoCreateInstance(clsid, null, CLSCTX_INPROC_SERVER, iid, out);
    if (result !== S_OK) return 0;
  } catch {
    return 0;
  }
  return Number(new DataView(out.buffer).getBigUint64(0, true));
}

/** Frees memory a COM method allocated for us. */
export function taskMemFree(memory: number | bigint): void {
  const lib = comLibs();
  if (lib === null || memory === 0 || memory === 0n) return;
  try {
    lib.ole32.CoTaskMemFree(memory);
  } catch {
    // A leak on a failure path is not worth a throw.
  }
}
