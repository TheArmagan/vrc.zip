/**
 * The console window itself: its title, and whether it can render colour.
 *
 * ## What this can and cannot do
 *
 * A compiled Bun binary is a **console application**, so double-clicking it opens a console window
 * that Windows owns. Two things about that window are ours:
 *
 *  - **The icon** — already handled, at build time: `--windows-icon` puts the VZ icon on the
 *    executable, and the console host draws the icon of the program it is hosting.
 *  - **The title** — set here. Without it the window is titled with the full path to the exe, which
 *    is both ugly and a way to show someone's home directory in a screenshot.
 *
 * What is *not* ours: a console the app was launched *into*. Running from PowerShell means
 * PowerShell's window, PowerShell's icon, and a title we are borrowing rather than owning — so the
 * title is restored on the way out. A window of our own with our own chrome would mean shipping a
 * GUI, which is Phase 5's question and not this file's.
 *
 * ## Why `SetConsoleMode` is here too
 *
 * Windows Terminal understands ANSI colour; the older `conhost.exe` that a double-click can still
 * land in does not, unless asked. Without the flag a user sees the escape sequences themselves —
 * `←[36m` before every line — which looks broken rather than plain. Asking costs one call and the
 * failure mode is "no colour", which is exactly what the fallback would have been.
 */

import { dlopen, FFIType, suffix } from "bun:ffi";

const IS_WINDOWS = process.platform === "win32";

/** `ENABLE_VIRTUAL_TERMINAL_PROCESSING`. The one flag that turns escape sequences into colour. */
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const STD_OUTPUT_HANDLE = -11;

interface Kernel32 {
  SetConsoleTitleW: (title: Uint8Array) => unknown;
  GetStdHandle: (which: number) => unknown;
  GetConsoleMode: (handle: unknown, mode: Uint8Array) => unknown;
  SetConsoleMode: (handle: unknown, mode: number) => unknown;
}

let kernel32: Kernel32 | null = null;
let attempted = false;

/**
 * Opens kernel32 once, and never throws.
 *
 * Every caller here is cosmetic. A machine where `dlopen` fails — a locked-down policy, a future
 * Windows that moved these symbols — should get a working daemon with a plain console, not a
 * startup crash over a window title.
 */
function load(): Kernel32 | null {
  if (attempted) return kernel32;
  attempted = true;
  if (!IS_WINDOWS) return null;
  try {
    const lib = dlopen(`kernel32.${suffix}`, {
      SetConsoleTitleW: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
      GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    kernel32 = lib.symbols as unknown as Kernel32;
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

/** UTF-16LE, NUL-terminated — what every `…W` entry point in kernel32 expects. */
function wide(value: string): Uint8Array {
  const buffer = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < value.length; i += 1) {
    view.setUint16(i * 2, value.charCodeAt(i), true);
  }
  return buffer;
}

/** Names the console window. Returns whether it worked, for the tests. */
export function setConsoleTitle(title: string): boolean {
  const lib = load();
  if (lib === null) return false;
  try {
    lib.SetConsoleTitleW(wide(title));
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks the console to interpret ANSI escapes.
 *
 * Returns whether colour is safe to emit. `false` is a normal answer — a redirected stdout, a
 * non-Windows terminal that already handles ANSI, or a console that refused — and the caller's job
 * is to fall back to plain text rather than to report it.
 */
export function enableAnsiColour(): boolean {
  // A pipe is not a terminal: colour in a redirected log is noise somebody has to strip later.
  if (!process.stdout.isTTY) return false;
  // The convention, honoured before anything platform-specific. https://no-color.org
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (!IS_WINDOWS) return true;

  const lib = load();
  if (lib === null) return false;
  try {
    const handle = lib.GetStdHandle(STD_OUTPUT_HANDLE);
    const mode = new Uint8Array(4);
    if (lib.GetConsoleMode(handle, mode) === 0) return false;
    const current = new DataView(mode.buffer).getUint32(0, true);
    if ((current & ENABLE_VIRTUAL_TERMINAL_PROCESSING) !== 0) return true;
    return lib.SetConsoleMode(handle, current | ENABLE_VIRTUAL_TERMINAL_PROCESSING) !== 0;
  } catch {
    return false;
  }
}
