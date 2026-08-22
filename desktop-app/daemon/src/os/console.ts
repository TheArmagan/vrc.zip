/**
 * The console window: getting one of our own, and making output reach it.
 *
 * ## The problem this solves
 *
 * A console-subsystem executable gets a console window from Windows, and on Windows 11 that window
 * belongs to whatever the user set as their **default terminal application** — usually Windows
 * Terminal, which paints it with its own default profile: PowerShell's icon, PowerShell's title,
 * PowerShell's colours. Double-clicking vrc.zip.exe looked like opening PowerShell, because in every
 * visible respect it was.
 *
 * So the executable is built with `--windows-hide-console` — a **GUI-subsystem** binary, which
 * Windows gives no console at all — and it asks for one itself. Measured, not assumed: a console
 * created with `AllocConsole` from a GUI process comes back as class `ConsoleWindowClass`, the
 * classic `conhost` window, which takes its icon from the process that owns it. Ours.
 *
 * ## Output does not follow the console
 *
 * The part that is not obvious, and that a first attempt gets wrong. Bun binds `process.stdout` at
 * startup; in a GUI-subsystem process there is nothing to bind to, and **`SetStdHandle` afterwards
 * does not retroactively rebuild the stream**. Verified by reading the console screen buffer back:
 * after `AllocConsole` + `SetStdHandle`, `console.log` and `process.stdout.write` left the screen
 * empty, while `WriteConsoleW` on the same handle painted.
 *
 * So when we claim a console, `console.*` is rerouted through `WriteConsoleW`. That override is the
 * whole reason this returns something rather than just doing its work: it is a real change to a
 * global, and it should be visible at the call site in `index.ts`.
 *
 * ## When we do nothing
 *
 * Whenever stdout already goes somewhere. Running from a terminal in development, or with output
 * redirected to a file, the handle is valid and the ordinary path works — hijacking either would
 * mean a dev's logs vanishing into a window they did not ask for, or `> log.txt` producing an empty
 * file and a popup.
 */

import { dlopen, FFIType, suffix } from "bun:ffi";

const IS_WINDOWS = process.platform === "win32";

const STD_OUTPUT_HANDLE = -11;
const STD_ERROR_HANDLE = -12;
/** `AttachConsole(ATTACH_PARENT_PROCESS)`: use the console of whoever launched us, if they have one. */
const ATTACH_PARENT_PROCESS = 0xffffffff;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;

const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const FILE_SHARE_READ_WRITE = 0x0000_0003;
const OPEN_EXISTING = 3;
/** `GetFileType` results. `CHAR` covers both a console and the NUL device, which is why it is not
 * enough on its own — see {@link alreadyHasOutput}. */
const FILE_TYPE_DISK = 0x0001;
const FILE_TYPE_PIPE = 0x0003;

interface Kernel32 {
  AllocConsole: () => number;
  AttachConsole: (pid: number) => number;
  SetConsoleTitleW: (title: Uint8Array) => number;
  GetStdHandle: (which: number) => unknown;
  SetStdHandle: (which: number, handle: unknown) => number;
  GetFileType: (handle: unknown) => number;
  GetConsoleMode: (handle: unknown, mode: Uint8Array) => number;
  SetConsoleMode: (handle: unknown, mode: number) => number;
  CreateFileW: (
    name: Uint8Array,
    access: number,
    share: number,
    security: null,
    disposition: number,
    flags: number,
    template: null,
  ) => unknown;
  WriteConsoleW: (
    handle: unknown,
    text: Uint8Array,
    count: number,
    written: null,
    reserved: null,
  ) => number;
  GetConsoleWindow: () => unknown;
  GetModuleHandleW: (name: null) => unknown;
  GetNumberOfConsoleInputEvents: (handle: unknown, count: Uint8Array) => number;
  ReadConsoleInputW: (
    handle: unknown,
    records: Uint8Array,
    length: number,
    read: Uint8Array,
  ) => number;
}

let kernel32: Kernel32 | null = null;
let attempted = false;

/**
 * Opens kernel32 once, and never throws.
 *
 * Everything here is presentation. A machine where `dlopen` fails — a locked-down policy, a future
 * Windows that moved these symbols — should get a working daemon with plain output, not a startup
 * crash over a window title.
 */
function load(): Kernel32 | null {
  if (attempted) return kernel32;
  attempted = true;
  if (!IS_WINDOWS) return null;
  try {
    const lib = dlopen(`kernel32.${suffix}`, {
      AllocConsole: { args: [], returns: FFIType.i32 },
      AttachConsole: { args: [FFIType.u32], returns: FFIType.i32 },
      SetConsoleTitleW: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
      SetStdHandle: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      GetFileType: { args: [FFIType.ptr], returns: FFIType.u32 },
      GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CreateFileW: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.ptr,
      },
      WriteConsoleW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
      GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
      GetNumberOfConsoleInputEvents: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      ReadConsoleInputW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
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
  for (let index = 0; index < value.length; index += 1) {
    view.setUint16(index * 2, value.charCodeAt(index), true);
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
 * Whether this process already has somewhere real to write.
 *
 * **`GetFileType` is not the test, and this was measured.** A GUI-subsystem process launched from
 * Explorer arrives with a non-null stdout whose type is `FILE_TYPE_CHAR` — the NUL device, not a
 * console — so a "is the handle usable" check passes and the process runs on with its output going
 * nowhere and no window. That is exactly the bug this function exists to avoid.
 *
 * `GetConsoleMode` is the honest question: it succeeds **only** for a real console handle. So:
 *
 *  - console → leave everything alone (a terminal in development).
 *  - pipe or disk file → leave it alone too; the user redirected output on purpose, and a window
 *    popping up while `> log.txt` fills with nothing is worse than either outcome alone.
 *  - anything else, including the Explorer case → claim a console.
 */
function alreadyHasOutput(lib: Kernel32): boolean {
  try {
    const handle = lib.GetStdHandle(STD_OUTPUT_HANDLE);
    if (handle === null || handle === 0) return false;

    const mode = new Uint8Array(4);
    if (lib.GetConsoleMode(handle, mode) !== 0) return true;

    const type = lib.GetFileType(handle);
    return type === FILE_TYPE_DISK || type === FILE_TYPE_PIPE;
  } catch {
    return true; // Unsure means leave it alone: the quiet failure is the safer one here.
  }
}

export interface ClaimedConsole {
  /** True when this process created the window, rather than borrowing a parent's. */
  readonly allocated: boolean;
}

/**
 * Gets this process a console, and makes `console.*` reach it.
 *
 * Returns null when nothing was needed — running from a terminal, or with output redirected — which
 * is the common case in development and the one where doing anything would be wrong.
 *
 * **`console.*` is overridden when we claim one.** Bun's streams were bound before the console
 * existed and cannot be repointed at it, so the writer goes straight to `WriteConsoleW`. Every log
 * line in the daemon goes through `console.*`, which is what makes one override enough.
 */
export function claimConsole(): ClaimedConsole | null {
  const lib = load();
  if (lib === null) return null;
  if (alreadyHasOutput(lib)) return null;

  let allocated = false;
  try {
    // Borrow the launching terminal's console when there is one — a `vrc.zip --help` typed into a
    // shell should answer in that shell rather than flashing a window that closes on exit.
    if (lib.AttachConsole(ATTACH_PARENT_PROCESS) === 0) {
      if (lib.AllocConsole() === 0) return null;
      allocated = true;
    }

    const handle = lib.CreateFileW(
      wide("CONOUT$"),
      GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ_WRITE,
      null,
      OPEN_EXISTING,
      0,
      null,
    );
    if (handle === null || handle === 0) return null;

    // Set for anything that reads the handles directly (a child process inherits these).
    lib.SetStdHandle(STD_OUTPUT_HANDLE, handle);
    lib.SetStdHandle(STD_ERROR_HANDLE, handle);

    const write = (text: string): void => {
      // `\n` alone leaves the cursor in the same column on a real console: every line after the
      // first would start where the last one ended.
      const encoded = wide(text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"));
      try {
        lib.WriteConsoleW(handle, encoded, (encoded.length - 2) / 2, null, null);
      } catch {
        // A closed window mid-write. Losing a log line is not worth taking the daemon down.
      }
    };

    installConsoleWriter(write);
    return { allocated };
  } catch {
    return null;
  }
}

/**
 * Points `console.*` at `write`.
 *
 * Formatting is deliberately minimal — join the arguments, `JSON.stringify` what is not a string.
 * `util.inspect`'s full object graphs are for a debugger; what reaches this console is startup
 * output and the occasional warning, both of which are written as sentences.
 */
function installConsoleWriter(write: (text: string) => void): void {
  const format = (args: readonly unknown[]): string =>
    args
      .map((value) => {
        if (typeof value === "string") return value;
        if (value instanceof Error) return `${value.name}: ${value.message}`;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(" ");

  const line = (args: readonly unknown[]): void => {
    write(`${format(args)}\n`);
  };

  console.log = (...args: unknown[]) => {
    line(args);
  };
  console.info = (...args: unknown[]) => {
    line(args);
  };
  console.warn = (...args: unknown[]) => {
    line(args);
  };
  console.error = (...args: unknown[]) => {
    line(args);
  };
  console.debug = (...args: unknown[]) => {
    line(args);
  };
}

/**
 * Asks the console to interpret ANSI escapes.
 *
 * Returns whether colour is safe to emit. `false` is a normal answer — a redirected stdout, or a
 * console that refused — and the caller's job is to fall back to plain text rather than report it.
 */
export function enableAnsiColour(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (!IS_WINDOWS) return process.stdout.isTTY === true;

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

/* ---------------------------------------------------------------------------------------------- */
/* Keyboard                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One `INPUT_RECORD`, in bytes.
 *
 * `WORD EventType` plus two bytes of padding, then the union — whose largest member is a `DWORD`,
 * so the whole record aligns to four and comes to twenty. Written down because the number is
 * invisible in the code otherwise, and reading the stream at the wrong stride decodes garbage that
 * *looks* like keypresses.
 */
export const INPUT_RECORD_BYTES = 20;
const KEY_EVENT = 0x0001;

/**
 * Pulls the characters out of a block of `INPUT_RECORD`s.
 *
 * Pure, and exported, because this is the part worth testing: a console cannot be typed into from a
 * test, but a buffer of bytes can be built by hand. Key-*up* events are skipped — every press
 * produces both, and acting on the pair would open two browser tabs for one keystroke.
 */
export function decodeKeyPresses(records: Uint8Array, count: number): string[] {
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = index * INPUT_RECORD_BYTES;
    if (base + INPUT_RECORD_BYTES > records.byteLength) break;
    if (view.getUint16(base, true) !== KEY_EVENT) continue;
    // bKeyDown is a 4-byte BOOL at +4; the character sits at +14.
    if (view.getUint32(base + 4, true) === 0) continue;
    const char = view.getUint16(base + 14, true);
    if (char === 0) continue;
    out.push(String.fromCharCode(char));
  }
  return out;
}

/**
 * Calls `handler` for each key typed into our console.
 *
 * Polled rather than blocking, for the same reason the log watcher polls: a blocking read would
 * need a thread this runtime does not hand out, and the alternative — a read on the event loop —
 * stops the daemon. Eighty milliseconds is under the threshold where a keypress feels delayed and
 * far above the cost of asking.
 *
 * Returns a stop function, or null when there is no console of ours to read from (a redirected
 * stdout, a non-Windows host, or a dev terminal where Bun's own stdin already works).
 */
export function onConsoleKey(handler: (key: string) => void): (() => void) | null {
  const lib = load();
  if (lib === null) return null;

  let input: unknown;
  try {
    input = lib.CreateFileW(
      wide("CONIN$"),
      GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ_WRITE,
      null,
      OPEN_EXISTING,
      0,
      null,
    );
  } catch {
    return null;
  }
  if (input === null || input === 0) return null;

  const pending = new Uint8Array(4);
  const records = new Uint8Array(INPUT_RECORD_BYTES * 32);
  const read = new Uint8Array(4);

  const timer = setInterval(() => {
    try {
      if (lib.GetNumberOfConsoleInputEvents(input, pending) === 0) return;
      const waiting = new DataView(pending.buffer).getUint32(0, true);
      if (waiting === 0) return;

      if (lib.ReadConsoleInputW(input, records, 32, read) === 0) return;
      const count = new DataView(read.buffer).getUint32(0, true);
      for (const key of decodeKeyPresses(records, count)) handler(key);
    } catch {
      // A console that went away mid-poll. Nothing here is worth taking the daemon down for.
    }
  }, 80);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The window icon                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

const WM_SETICON = 0x0080;
const ICON_SMALL = 0;
const ICON_BIG = 1;
const IMAGE_ICON = 1;
const LR_DEFAULTCOLOR = 0x0000;
/** Windows names the first icon resource in an executable `1` by convention, and Bun follows it. */
const FIRST_ICON_RESOURCE = 1;

/**
 * Puts this executable's icon on the console window, at the two sizes Windows asks for.
 *
 * `conhost` already takes an icon from the process, so this is not about *having* one — it is about
 * **which entry**. Asking `LoadImageW` for an exact pixel size makes Windows pick the matching entry
 * out of the icon directory; letting it default means it takes what it is given and scales, which is
 * where a large view of a small entry gets its soft edges.
 *
 * Small and big are set separately because they are different slots: the title bar and Alt-Tab read
 * `ICON_SMALL`, the task switcher's large view and the taskbar read `ICON_BIG`, and a window that
 * sets only one leaves the other to be derived by scaling the one it did set.
 *
 * Best-effort throughout. A window that keeps a slightly soft icon is not worth a failed start.
 */
export function applyWindowIcon(): boolean {
  const lib = load();
  if (lib === null) return false;
  let user32: {
    LoadImageW: (
      module: unknown,
      name: number,
      type: number,
      cx: number,
      cy: number,
      load: number,
    ) => unknown;
    SendMessageW: (hwnd: unknown, message: number, wParam: number, lParam: unknown) => unknown;
    GetSystemMetrics: (index: number) => number;
  };
  try {
    const opened = dlopen(`user32.${suffix}`, {
      LoadImageW: {
        args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32],
        returns: FFIType.ptr,
      },
      SendMessageW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr],
        returns: FFIType.ptr,
      },
      GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    user32 = opened.symbols as unknown as typeof user32;
  } catch {
    return false;
  }

  try {
    const hwnd = lib.GetConsoleWindow();
    if (hwnd === null || hwnd === 0) return false;
    const module = lib.GetModuleHandleW(null);

    // SM_CXSMICON / SM_CXICON: the sizes this display's scaling actually wants, rather than 16/32
    // assumed. At 150% they are 24 and 48, and both are real entries in the icon.
    const small = user32.GetSystemMetrics(49) || 16;
    const big = user32.GetSystemMetrics(11) || 32;

    for (const [which, size] of [
      [ICON_SMALL, small],
      [ICON_BIG, big],
    ] as const) {
      const icon = user32.LoadImageW(
        module,
        FIRST_ICON_RESOURCE,
        IMAGE_ICON,
        size,
        size,
        LR_DEFAULTCOLOR,
      );
      if (icon !== null && icon !== 0) user32.SendMessageW(hwnd, WM_SETICON, which, icon);
    }
    return true;
  } catch {
    return false;
  }
}
