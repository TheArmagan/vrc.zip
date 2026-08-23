/**
 * The notification-area icon, and the menu behind it.
 *
 * ## Why this is FFI rather than a helper process
 *
 * The obvious way to put an icon in the tray from a runtime with no window toolkit is to spawn
 * PowerShell and let `System.Windows.Forms.NotifyIcon` do it, which is exactly what
 * `desktop-notification.ts` does for toasts. It is the wrong trade here, and for one measurable
 * reason: a toast is a PowerShell process that lives for a second, and a tray icon is one that lives
 * for the whole session. A PowerShell host is 40 to 60MB resident. This app's stated idle footprint
 * is 50 to 80MB, so a helper process would roughly double it to draw a 16px square.
 *
 * So it is `Shell_NotifyIconW` over `bun:ffi`, on the same pattern `console.ts` already uses for
 * kernel32. The cost is about two hundred lines of struct packing; the benefit is that the icon is
 * free.
 *
 * ## The message loop, and why there *is* a callback
 *
 * A tray icon needs a window to receive its click notifications, and a window needs a message loop.
 * The first version of this file tried to avoid handing Windows a pointer into JavaScript at all: it
 * registered **`DefWindowProcW` itself** as the class procedure and let the pump read messages with
 * `PeekMessageW` and inspect them before dispatching. That draws a perfect icon and receives
 * absolutely nothing.
 *
 * The reason is the distinction between a *posted* and a *sent* message. `PeekMessageW` returns
 * posted messages, which sit in the thread queue; a sent message is not queued at all, and the
 * retrieval call delivers it by invoking the target window's procedure directly before it goes
 * looking for anything queued. The shell's tray callbacks are sent, and so is the `WM_CONTEXTMENU`
 * that version 4 uses for a right-click. So every click went straight into `DefWindowProcW` and was
 * discarded, while `PostMessageW`-ing `WM_TRAY` at our own window by hand worked perfectly, which is
 * what made the failure so hard to read. Electron does not do it this way either: `NotifyIconHost`
 * registers a real `WndProcStatic` and handles the callback inside it.
 *
 * So there is a `JSCallback` now, and the original worry about it is answered by keeping it
 * trivial rather than by not having one. The procedure never opens a menu, never touches the daemon
 * and cannot throw: it turns a notification into a `PostMessageW` at our own window and returns.
 * Everything with any weight to it — building the menu, the modal `TrackPopupMenu`, opening a URL,
 * shutting down — happens later, on our own stack, out of the pump. Windows only ever calls back
 * into JavaScript from inside our own `PeekMessageW` on our own thread, which is the one case where
 * a callback is not a cross-thread hazard.
 *
 * The pump runs on an `unref`ed interval, so it never keeps the process alive on its own — the
 * servers do that — and a daemon shutting down does not wait for a tick.
 *
 * ## Explorer restarts
 *
 * When explorer crashes and comes back it broadcasts `TaskbarCreated`, and every icon that was in
 * the notification area is gone until its owner adds it again. That broadcast only reaches
 * top-level windows, which is why the window is `WS_POPUP` rather than a message-only child.
 *
 * ## Hide is only offered when the console is ours
 *
 * `claimConsole()` allocates a console only when the process did not already have one. When it
 * *did* — a developer running `bun run daemon` in their terminal — that window belongs to them, and
 * "Hide console" would make their terminal disappear. The menu item is only built when we own the
 * window we would be hiding.
 */

import { dlopen, FFIType, JSCallback, ptr, suffix } from "bun:ffi";

const IS_WINDOWS = process.platform === "win32";

/* -------------------------------------------------------------------------------------------- */
/* Win32 constants                                                                                */
/* -------------------------------------------------------------------------------------------- */

const NIM_ADD = 0x0000;
const NIM_MODIFY = 0x0001;
const NIM_DELETE = 0x0002;
const NIM_SETVERSION = 0x0004;
/** `NOTIFYICON_VERSION_4`. See the note next to the `NIM_SETVERSION` call. */
const NOTIFYICON_VERSION_4 = 4;
const NIF_MESSAGE = 0x0001;
const NIF_ICON = 0x0002;
const NIF_TIP = 0x0004;
/** Turns the next `NIM_MODIFY` into a balloon rather than an edit. */
const NIF_INFO = 0x0010;
/** `NIIF_WARNING`: the yellow triangle. What a refusal is. */
const NIIF_WARNING = 0x0002;

/** Our own notification message. `WM_APP` and above are reserved for exactly this. */
const WM_TRAY = 0x8000 + 1;
/**
 * What the window procedure posts at us once it has been *sent* a `WM_TRAY`.
 *
 * The whole point of the second id: the procedure runs inside Windows' own call, so it does the one
 * cheap thing it can safely do there and lets the pump pick the work up on our stack. See the note
 * at the top of this file.
 */
const WM_TRAY_QUEUED = 0x8000 + 2;
/** Posted the same way when `TaskbarCreated` arrives, to re-add an icon explorer forgot. */
const WM_TRAY_RESTORE = 0x8000 + 3;
const WM_LBUTTONUP = 0x0202;
const WM_LBUTTONDBLCLK = 0x0203;
/** Version 4's left-click notifications, by mouse and by keyboard. */
const NIN_SELECT = 0x0400;
const NIN_KEYSELECT = 0x0401;
const WM_RBUTTONUP = 0x0205;
const WM_CONTEXTMENU = 0x007b;
const WM_NULL = 0x0000;
const WM_QUIT = 0x0012;

/** A top-level window, which is what a `TaskbarCreated` broadcast will actually reach. */
const WS_POPUP = 0x80000000;

const PM_REMOVE = 0x0001;
const SW_HIDE = 0;
const SW_SHOW = 5;

const IMAGE_ICON = 1;
const LR_DEFAULTCOLOR = 0x0000;
/** Resource id 1: what the packaging step writes the app icon in as. See `tools/src/icon.ts`. */
const FIRST_ICON_RESOURCE = 1;
/** `IDI_APPLICATION`, for a run from source where the binary has no icon of its own. */
const IDI_APPLICATION = 32512;

/** `MSGFLT_ALLOW`, for `ChangeWindowMessageFilterEx`. */
const MSGFLT_ALLOW = 1;

const MF_STRING = 0x0000;
const MF_SEPARATOR = 0x0800;
/** Draws the tick. The item is still `MF_STRING`; this is an extra bit, not another kind. */
const MF_CHECKED = 0x0008;
/** Greyed and unclickable, for an item that is worth *showing* as unavailable. */
const MF_GRAYED = 0x0001;
const TPM_RIGHTBUTTON = 0x0002;
/** Hands the chosen command back as the return value instead of posting `WM_COMMAND`. */
const TPM_RETURNCMD = 0x0100;

/** Menu command ids. Arbitrary, but non-zero: zero is what `TrackPopupMenu` returns for "nothing". */
const ID_OPEN = 1;
const ID_CONSOLE = 2;
const ID_GITHUB = 3;
const ID_EXIT = 4;
const ID_STARTUP = 5;

/* -------------------------------------------------------------------------------------------- */
/* Structs                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** `sizeof(MSG)` on x64: hwnd, message, wParam, lParam, time, POINT, and the tail padding. */
export const MSG_BYTES = 48;
/** `sizeof(WNDCLASSEXW)` on x64. */
export const WNDCLASSEXW_BYTES = 80;
/**
 * `sizeof(NOTIFYICONDATAW)` on x64, for the current (Vista and later) version of the struct.
 *
 * Exported and asserted in a test because it is the one number here that fails *silently*: Windows
 * uses `cbSize` to decide which version of the struct it was handed, and a wrong value is not an
 * error — it is an icon that never appears.
 */
export const NOTIFYICONDATAW_BYTES = 976;

/** Field offsets in `NOTIFYICONDATAW`, x64. See the note on {@link NOTIFYICONDATAW_BYTES}. */
const NID = {
  cbSize: 0,
  hWnd: 8,
  uID: 16,
  uFlags: 20,
  uCallbackMessage: 24,
  hIcon: 32,
  szTip: 40,
  /** The balloon's body, 256 `WCHAR`s. */
  szInfo: 304,
  /** Union of `uTimeout` and `uVersion`; the latter is what `NIM_SETVERSION` reads. */
  uVersion: 816,
  /** The balloon's title, 64 `WCHAR`s. */
  szInfoTitle: 820,
  dwInfoFlags: 948,
} as const;

/** UTF-16LE, NUL-terminated. Every `…W` entry point wants this. */
function wide(value: string): Uint8Array {
  const buffer = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(buffer.buffer);
  for (let index = 0; index < value.length; index += 1) {
    view.setUint16(index * 2, value.charCodeAt(index), true);
  }
  return buffer;
}

/**
 * Writes a NUL-terminated UTF-16 string into a fixed-width field, truncating rather than overrunning.
 *
 * `szTip` is 128 `WCHAR`s. A longer tip is a caller's mistake and not worth failing over, but
 * writing past the field would corrupt the struct that follows it.
 */
function writeFixedWide(view: DataView, offset: number, value: string, chars: number): void {
  const limit = Math.min(value.length, chars - 1);
  for (let index = 0; index < limit; index += 1) {
    view.setUint16(offset + index * 2, value.charCodeAt(index), true);
  }
  view.setUint16(offset + limit * 2, 0, true);
}

function setPointer(view: DataView, offset: number, value: number | bigint | null): void {
  view.setBigUint64(offset, BigInt(value ?? 0), true);
}

/* -------------------------------------------------------------------------------------------- */
/* The libraries                                                                                  */
/* -------------------------------------------------------------------------------------------- */

interface TrayLibs {
  readonly user32: {
    RegisterClassExW: (klass: Uint8Array) => number;
    UnregisterClassW: (name: Uint8Array, instance: number | null) => number;
    CreateWindowExW: (
      exStyle: number,
      klass: Uint8Array,
      name: Uint8Array,
      style: number,
      x: number,
      y: number,
      width: number,
      height: number,
      parent: number | null,
      menu: number | null,
      instance: number | null,
      param: number | null,
    ) => number | null;
    DestroyWindow: (hwnd: number) => number;
    /** Called by our own window procedure for everything that is not ours. */
    DefWindowProcW: (
      hwnd: number,
      message: number,
      wParam: number | bigint,
      lParam: number | bigint,
    ) => bigint;
    RegisterWindowMessageW: (name: Uint8Array) => number;
    PeekMessageW: (
      msg: Uint8Array,
      hwnd: number | null,
      min: number,
      max: number,
      remove: number,
    ) => number;
    TranslateMessage: (msg: Uint8Array) => number;
    DispatchMessageW: (msg: Uint8Array) => number | null;
    CreatePopupMenu: () => number | null;
    AppendMenuW: (menu: number, flags: number, id: number, text: Uint8Array | null) => number;
    DestroyMenu: (menu: number) => number;
    TrackPopupMenu: (
      menu: number,
      flags: number,
      x: number,
      y: number,
      reserved: number,
      hwnd: number,
      rect: null,
    ) => number;
    GetCursorPos: (point: Uint8Array) => number;
    SetForegroundWindow: (hwnd: number) => number;
    ChangeWindowMessageFilterEx: (
      hwnd: number,
      message: number,
      action: number,
      change: Uint8Array | null,
    ) => number;
    PostMessageW: (
      hwnd: number,
      message: number,
      wParam: number | bigint,
      lParam: number | bigint,
    ) => number;
    ShowWindow: (hwnd: number, command: number) => number;
    IsWindowVisible: (hwnd: number) => number;
    LoadImageW: (
      instance: number | null,
      name: number,
      type: number,
      cx: number,
      cy: number,
      load: number,
    ) => number | null;
    LoadIconW: (instance: number | null, name: number) => number | null;
    GetSystemMetrics: (index: number) => number;
  };
  readonly shell32: {
    Shell_NotifyIconW: (message: number, data: Uint8Array) => number;
    ExtractIconW: (instance: number | null, path: Uint8Array, index: number) => number | null;
  };
  readonly kernel32: {
    GetModuleHandleW: (name: Uint8Array | null) => number | null;
    GetConsoleWindow: () => number | null;
    GetModuleFileNameW: (module: number | null, buffer: Uint8Array, size: number) => number;
  };
}

let libs: TrayLibs | null = null;
let attempted = false;

/**
 * Opens the three libraries once, and never throws.
 *
 * Same posture as `console.ts`: everything here is decoration, and a machine where `dlopen` fails
 * should get a working daemon with no tray icon rather than a startup crash.
 */
function load(): TrayLibs | null {
  if (attempted) return libs;
  attempted = true;
  if (!IS_WINDOWS) return null;
  try {
    const user32 = dlopen(`user32.${suffix}`, {
      RegisterClassExW: { args: [FFIType.ptr], returns: FFIType.u16 },
      UnregisterClassW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      CreateWindowExW: {
        args: [
          FFIType.u32,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u32,
          FFIType.i32,
          FFIType.i32,
          FFIType.i32,
          FFIType.i32,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
        ],
        returns: FFIType.ptr,
      },
      DestroyWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
      DefWindowProcW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64],
        returns: FFIType.i64,
      },
      RegisterWindowMessageW: { args: [FFIType.ptr], returns: FFIType.u32 },
      PeekMessageW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32],
        returns: FFIType.i32,
      },
      TranslateMessage: { args: [FFIType.ptr], returns: FFIType.i32 },
      DispatchMessageW: { args: [FFIType.ptr], returns: FFIType.ptr },
      CreatePopupMenu: { args: [], returns: FFIType.ptr },
      AppendMenuW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
      DestroyMenu: { args: [FFIType.ptr], returns: FFIType.i32 },
      TrackPopupMenu: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.i32,
          FFIType.i32,
          FFIType.i32,
          FFIType.ptr,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
      SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
      ChangeWindowMessageFilterEx: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      PostMessageW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64],
        returns: FFIType.i32,
      },
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
      LoadImageW: {
        args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32],
        returns: FFIType.ptr,
      },
      LoadIconW: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
      GetSystemMetrics: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    const shell32 = dlopen(`shell32.${suffix}`, {
      Shell_NotifyIconW: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      ExtractIconW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    });
    const kernel32 = dlopen(`kernel32.${suffix}`, {
      GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
      GetModuleFileNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    });
    libs = {
      user32: user32.symbols as unknown as TrayLibs["user32"],
      shell32: shell32.symbols as unknown as TrayLibs["shell32"],
      kernel32: kernel32.symbols as unknown as TrayLibs["kernel32"],
    };
  } catch {
    libs = null;
  }
  return libs;
}

/* -------------------------------------------------------------------------------------------- */
/* The tray                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * The "Start with Windows" item's two halves.
 *
 * `isEnabled` is read every time the menu opens rather than cached, because the registry is the
 * truth and the user can clear it from Task Manager's Startup tab without telling us. A menu that
 * remembers what it last wrote is a tick that lies.
 */
export interface TrayStartup {
  isEnabled(): boolean;
  /**
   * Reports rather than throws. A refusal comes back with a sentence, which the tray shows as a
   * balloon — the alternative is a menu item that unticks itself with no explanation, and "vrc.zip
   * is in your Downloads folder" is exactly the kind of thing that needs saying out loud.
   */
  setEnabled(enabled: boolean): { ok: boolean; reason: string | null };
}

export interface TrayOptions {
  /** Shown as the hover tooltip, and as the disabled first line of the menu. */
  readonly title: string;
  /** Opened by "Open vrc.zip" and by a double-click on the icon. Carries the session token. */
  readonly launchUrl: string;
  readonly githubUrl: string;
  /**
   * Whether the console window belongs to us.
   *
   * False when the daemon inherited somebody's terminal, in which case there is no Hide item at
   * all — hiding a developer's terminal out from under them is not a feature.
   */
  readonly ownsConsole: boolean;
  /**
   * "Start with Windows", or null to leave the item out entirely.
   *
   * Injected rather than called directly for the same reason `open` is: this file should not be
   * able to write to the registry, and a test that opens a menu should not be able to either. See
   * `os/startup.ts`, which is where the value actually lives.
   */
  readonly startup: TrayStartup | null;
  /** How the tray opens the launch URL. Injected so a test does not launch a browser. */
  open(url: string): void;
  /**
   * How the tray opens a public link, which is a different opener rather than the same one.
   *
   * `openUrl` refuses anything off loopback on purpose — it is handed a URL with a session token in
   * it — so routing "Open on GitHub" through it is not a restriction to argue with, it is a menu
   * item that silently does nothing. Which is exactly how this was found.
   */
  openExternal(url: string): void;
  /** Chosen "Exit". The caller owns shutdown; the tray only reports the click. */
  onExit(): void;
}

export interface Tray {
  /** Removes the icon and stops the pump. Safe to call twice. */
  stop(): void;
}

/**
 * Whether to put an icon in the notification area: `--tray` / `--no-tray`, defaulting to on.
 *
 * The same shape as `shouldOpenBrowser`, including `--no-tray` winning over `--tray` — a flag that
 * turns something off should not depend on the order a script happened to append them in. The
 * default differs though, and deliberately: a browser tab is an interruption and an icon is not, so
 * this is on everywhere it works rather than only in a packaged build. Off it goes for anyone who
 * wants a daemon with no desktop presence at all, which is a reasonable thing to want and currently
 * takes a code edit.
 */
export function shouldShowTray(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  if (argv.includes("--no-tray")) return false;
  return true;
}

/**
 * Puts the icon in the notification area. Returns null when it could not, which is not an error.
 *
 * Nothing here is load-bearing: a daemon with no tray icon still prints its URL and still runs. The
 * failure paths are silent for that reason.
 */
export function startTray(options: TrayOptions): Tray | null {
  const lib = load();
  if (lib === null) return null;

  const { user32, shell32, kernel32 } = lib;
  const instance = kernel32.GetModuleHandleW(null);

  /** Explorer's "I just restarted, add your icon again" broadcast. Zero if it cannot be registered. */
  const taskbarCreated = user32.RegisterWindowMessageW(wide("TaskbarCreated"));

  /*
   * The window procedure.
   *
   * Deliberately the smallest thing that can work, for the reasons in the note at the top: it is
   * called by Windows, from inside our own `PeekMessageW`, and anything it throws is thrown across a
   * foreign stack frame. So it recognises two messages, turns each into a post at our own window,
   * and hands everything else — including the `WM_NCCREATE`/`WM_CREATE` pair that arrives while
   * `CreateWindowExW` is still running — to `DefWindowProcW`. The `try` is belt and braces; there is
   * nothing in here that can reasonably fail.
   */
  const procedure = new JSCallback(
    (hwnd: number, message: number, wParam: bigint, lParam: bigint): bigint => {
      try {
        if (message === WM_TRAY) {
          user32.PostMessageW(hwnd, WM_TRAY_QUEUED, wParam, lParam);
          return 0n;
        }
        if (taskbarCreated !== 0 && message === taskbarCreated) {
          user32.PostMessageW(hwnd, WM_TRAY_RESTORE, 0, 0);
          return 0n;
        }
        return user32.DefWindowProcW(hwnd, message, wParam, lParam);
      } catch {
        return 0n;
      }
    },
    {
      args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64],
      returns: FFIType.i64,
    },
  );

  const className = wide(`vrczip-tray-${String(process.pid)}`);
  const klass = new Uint8Array(WNDCLASSEXW_BYTES);
  const klassView = new DataView(klass.buffer);
  klassView.setUint32(0, WNDCLASSEXW_BYTES, true);
  setPointer(klassView, 8, procedure.ptr);
  setPointer(klassView, 24, instance);
  setPointer(klassView, 64, ptr(className));
  if (user32.RegisterClassExW(klass) === 0) {
    procedure.close();
    return null;
  }

  const hwnd = user32.CreateWindowExW(
    0,
    className,
    wide("vrc.zip"),
    WS_POPUP,
    0,
    0,
    0,
    0,
    null,
    null,
    instance,
    null,
  );
  if (hwnd === null || hwnd === 0) {
    user32.UnregisterClassW(className, instance);
    procedure.close();
    return null;
  }

  /*
   * Let the shell's click notifications through to us.
   *
   * UIPI blocks a posted message from a lower-integrity process to a higher-integrity one, and it
   * blocks it *silently*: run the daemon from an elevated terminal and explorer (medium integrity)
   * can still add our icon, draw it, and show its tooltip, while every click it posts back is
   * dropped before it reaches our queue. The icon looks perfect and the menu simply never opens,
   * with nothing logged anywhere. This is the documented fix, and it is a no-op when we are not
   * elevated, so it is unconditional rather than guarded on a privilege check.
   */
  user32.ChangeWindowMessageFilterEx(hwnd, WM_TRAY, MSGFLT_ALLOW, null);
  if (taskbarCreated !== 0) {
    user32.ChangeWindowMessageFilterEx(hwnd, taskbarCreated, MSGFLT_ALLOW, null);
  }

  const icon = loadIcon(lib, instance);

  const data = new Uint8Array(NOTIFYICONDATAW_BYTES);
  const dataView = new DataView(data.buffer);
  dataView.setUint32(NID.cbSize, NOTIFYICONDATAW_BYTES, true);
  setPointer(dataView, NID.hWnd, hwnd);
  dataView.setUint32(NID.uID, 1, true);
  dataView.setUint32(NID.uFlags, NIF_MESSAGE | NIF_ICON | NIF_TIP, true);
  dataView.setUint32(NID.uCallbackMessage, WM_TRAY, true);
  setPointer(dataView, NID.hIcon, icon);
  writeFixedWide(dataView, NID.szTip, options.title, 128);

  /*
   * Add the icon, then immediately tell the shell which contract it runs under.
   *
   * Wrapped in a function because `TaskbarCreated` needs the exact same pair again: after explorer
   * restarts, the icon is gone and the version it was told about is gone with it.
   */
  let version4 = false;
  const install = (): boolean => {
    if (shell32.Shell_NotifyIconW(NIM_ADD, data) === 0) return false;
    dataView.setUint32(NID.uVersion, NOTIFYICON_VERSION_4, true);
    version4 = shell32.Shell_NotifyIconW(NIM_SETVERSION, data) !== 0;
    return true;
  };

  if (!install()) {
    user32.DestroyWindow(hwnd);
    user32.UnregisterClassW(className, instance);
    procedure.close();
    return null;
  }

  /*
   * A word on what `NIM_SETVERSION` in there is for.
   *
   * Version 4 changes the callback's shape: `wParam` carries the click's screen coordinates and
   * `lParam` the notification in its low half, so the id to switch on is `WM_CONTEXTMENU` or
   * `NIN_SELECT` rather than a raw mouse message. Without it the icon runs the original 1996
   * contract, where `lParam` is the mouse message itself. Both spellings are accepted below, because
   * an icon whose `NIM_SETVERSION` quietly failed should still open its menu rather than look
   * broken in exactly the way this file already looked broken once.
   */

  const message = new Uint8Array(MSG_BYTES);
  const messageView = new DataView(message.buffer);
  const point = new Uint8Array(8);
  let stopped = false;

  const consoleWindow = (): number | null => {
    const found = kernel32.GetConsoleWindow();
    return found === null || found === 0 ? null : found;
  };

  /**
   * Says something in a balloon from our own icon.
   *
   * A balloon rather than `notifyDesktop`, which would be the other option: this is a reply to a
   * click the user just made on this icon, so it belongs on this icon rather than arriving as a
   * separate toast from a PowerShell process a second later.
   *
   * `uFlags` is put back afterwards, and that is not tidiness. `NIF_INFO` is sticky — it lives in
   * the same struct the tooltip and the icon are edited through, so leaving it set turns the next
   * ordinary `NIM_MODIFY` into a repeat of this balloon.
   */
  const balloon = (title: string, body: string): void => {
    writeFixedWide(dataView, NID.szInfoTitle, title, 64);
    writeFixedWide(dataView, NID.szInfo, body, 256);
    dataView.setUint32(NID.dwInfoFlags, NIIF_WARNING, true);
    dataView.setUint32(NID.uFlags, NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_INFO, true);
    shell32.Shell_NotifyIconW(NIM_MODIFY, data);
    dataView.setUint32(NID.uFlags, NIF_MESSAGE | NIF_ICON | NIF_TIP, true);
  };

  const showMenu = (): void => {
    const menu = user32.CreatePopupMenu();
    if (menu === null || menu === 0) return;
    try {
      user32.AppendMenuW(menu, MF_STRING, ID_OPEN, wide("Open vrc.zip"));
      const console = options.ownsConsole ? consoleWindow() : null;
      if (console !== null) {
        const visible = user32.IsWindowVisible(console) !== 0;
        user32.AppendMenuW(
          menu,
          MF_STRING,
          ID_CONSOLE,
          wide(visible ? "Hide console" : "Show console"),
        );
      }
      /*
       * The tick is read from the registry every time this menu is built.
       *
       * `isEnabled` can throw only if the injected implementation does; it is wrapped because a
       * menu that fails to open is a worse answer than a menu whose tick is missing, and this runs
       * on the path a right-click takes.
       */
      if (options.startup !== null) {
        let enabled = false;
        try {
          enabled = options.startup.isEnabled();
        } catch {
          enabled = false;
        }
        user32.AppendMenuW(
          menu,
          MF_STRING | (enabled ? MF_CHECKED : 0),
          ID_STARTUP,
          wide("Start with Windows"),
        );
      } else {
        // Shown greyed rather than hidden. "Can this start with Windows?" is a question people come
        // to this menu with, and an item that is missing reads as an app that cannot do it at all,
        // where a greyed one reads as "not from here" — which is what running from source means.
        user32.AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, wide("Start with Windows"));
      }

      user32.AppendMenuW(menu, MF_STRING, ID_GITHUB, wide("Open on GitHub"));
      user32.AppendMenuW(menu, MF_SEPARATOR, 0, null);
      user32.AppendMenuW(menu, MF_STRING, ID_EXIT, wide("Exit vrc.zip"));

      user32.GetCursorPos(point);
      const cursor = new DataView(point.buffer);
      /*
       * Both of these are load-bearing quirks rather than ceremony, and both are documented on
       * `TrackPopupMenu`: without the foreground call the menu opens behind whatever is in front,
       * and without the posted `WM_NULL` afterwards it stays on screen when the user clicks away.
       */
      user32.SetForegroundWindow(hwnd);
      const chosen = user32.TrackPopupMenu(
        menu,
        TPM_RIGHTBUTTON | TPM_RETURNCMD,
        cursor.getInt32(0, true),
        cursor.getInt32(4, true),
        0,
        hwnd,
        null,
      );
      user32.PostMessageW(hwnd, WM_NULL, 0, 0);

      switch (chosen) {
        case ID_OPEN:
          options.open(options.launchUrl);
          break;
        case ID_CONSOLE: {
          const window = consoleWindow();
          if (window !== null) {
            user32.ShowWindow(window, user32.IsWindowVisible(window) !== 0 ? SW_HIDE : SW_SHOW);
          }
          break;
        }
        case ID_STARTUP: {
          const startup = options.startup;
          if (startup === null) break;
          // Read again rather than reusing what the tick was drawn from: the menu may have been
          // open for a while, and the registry is the truth.
          const result = startup.setEnabled(!startup.isEnabled());
          // A refusal that shows nothing is a checkbox that will not tick and will not say why,
          // which is the single most annoying thing a settings control can do.
          if (!result.ok && result.reason !== null) {
            balloon("vrc.zip cannot start with Windows", result.reason);
          }
          break;
        }
        case ID_GITHUB:
          options.openExternal(options.githubUrl);
          break;
        case ID_EXIT:
          options.onExit();
          break;
        default:
          // Zero: the menu was dismissed without choosing anything.
          break;
      }
    } finally {
      user32.DestroyMenu(menu);
    }
  };

  /**
   * One pass of the message queue.
   *
   * Bounded rather than drained: `TrackPopupMenu` is modal and blocks this thread until the menu
   * closes, so an unbounded loop over a queue that keeps filling would be a way to stall the whole
   * daemon. Sixty-four messages is far more than a tray icon ever produces in a tick.
   */
  /*
   * How many pump ticks between "is the icon still there?" checks. 120ms x 40 is roughly five
   * seconds, which is soon enough that nobody sits looking at an empty notification area and rare
   * enough that the cost is nothing.
   */
  const HEALTH_TICKS = 40;
  let ticks = 0;

  /**
   * Puts the icon back if it has gone, and answers whether it had to.
   *
   * `NIM_MODIFY` is the cheap existence check the shell already offers: it fails when there is no
   * icon with our id, which is exactly the question. `TaskbarCreated` handles the case we get told
   * about; this handles the ones we do not, and there turn out to be several. An icon can go
   * because the shell decided our window had stopped answering, because explorer was replaced by
   * something that never sent the broadcast, or because of whatever the shell was doing while some
   * other part of this process was busy. A tray icon is the only way back to a daemon whose console
   * is hidden, so "it is usually there" is not a good enough guarantee for it.
   */
  const healIcon = (): boolean => {
    if (shell32.Shell_NotifyIconW(NIM_MODIFY, data) !== 0) return false;
    install();
    return true;
  };

  const pump = (): void => {
    if (stopped) return;

    ticks += 1;
    if (ticks >= HEALTH_TICKS) {
      ticks = 0;
      healIcon();
    }

    for (let index = 0; index < 64; index += 1) {
      /*
       * This call is doing two jobs, and the second one is invisible.
       *
       * It returns the next posted message, which is what the loop below reads. It also delivers
       * every message that was *sent* to one of this thread's windows by calling the procedure —
       * which is where the shell's clicks actually arrive, and where they turn into the
       * `WM_TRAY_QUEUED` this loop then picks up on a later pass.
       */
      if (user32.PeekMessageW(message, null, 0, 0, PM_REMOVE) === 0) return;
      const id = messageView.getUint32(8, true);
      if (id === WM_QUIT) return;
      if (id === WM_TRAY_RESTORE) {
        install();
        continue;
      }
      // `WM_TRAY` too, so a message posted straight at the window still works: the probe harness
      // does that, and so does anything that reaches us before `NIM_SETVERSION` lands.
      if (id === WM_TRAY_QUEUED || id === WM_TRAY) {
        /*
         * The notification rides in the low half of lParam under version 4, and *is* lParam under
         * the old contract. Same bits either way — but which spellings to *accept* is not a matter
         * of taste, and accepting both is a bug: a version 4 icon delivers the raw mouse message
         * as well as the `NIN_*` notification for the same click, so a pump that answers to both
         * opened the launch URL twice per click. Whichever contract `NIM_SETVERSION` actually left
         * us on is the only one we listen to.
         */
        const which = Number(messageView.getBigInt64(24, true) & 0xffffn);
        const menu = version4 ? which === WM_CONTEXTMENU : which === WM_RBUTTONUP;
        const select = version4
          ? which === NIN_SELECT || which === NIN_KEYSELECT
          : which === WM_LBUTTONUP || which === WM_LBUTTONDBLCLK;
        if (menu) showMenu();
        else if (select) options.open(options.launchUrl);
        continue;
      }
      user32.TranslateMessage(message);
      user32.DispatchMessageW(message);
    }
  };

  // 120ms: below the threshold where a right-click feels laggy, and 8 wake-ups a second of a
  // function that usually returns on its first `PeekMessageW`.
  const timer = setInterval(pump, 120);
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        shell32.Shell_NotifyIconW(NIM_DELETE, data);
        // Order matters: the window has to be gone before the procedure it points at is, or a
        // message arriving in between would call into freed memory.
        user32.DestroyWindow(hwnd);
        user32.UnregisterClassW(className, instance);
        procedure.close();
      } catch {
        // Shutting down. An icon left behind is Windows' problem to clean up, not a reason to fail
        // the exit path.
      }
    },
  };
}

/**
 * The icon the tray entry draws, from the best source available.
 *
 * Three attempts, and the order was arrived at by watching what Windows 11 actually renders:
 *
 *  1. **Resource 1 of our own module.** What `tools/src/icon.ts` writes into the packaged binary,
 *     and the only source that is guaranteed to be vrc.zip's own artwork at the requested size.
 *  2. **`ExtractIconW` on our own executable.** The same idea without assuming a resource id — it
 *     takes whichever icon is first, which is what Explorer shows for the file. This is the one that
 *     works from source, where the binary is `bun.exe` and its icon is not resource 1 (attempt one
 *     fails with `ERROR_RESOURCE_TYPE_NOT_FOUND`).
 *  3. **`IDI_APPLICATION`.**
 *
 * The third is last for a measured reason rather than a stylistic one. It returns a perfectly valid
 * handle that `Shell_NotifyIcon` accepts — `NIM_ADD` and a follow-up `NIM_MODIFY` both report
 * success — and then Windows 11 draws **nothing**: a blank square in the overflow, with no error
 * anywhere to explain it. An icon extracted from a real file draws. So a failure here is not a
 * failure that says so, and the fallbacks are ordered to reach a real file first.
 */
function loadIcon(lib: TrayLibs, instance: number | null): number | null {
  const { user32, shell32, kernel32 } = lib;
  const size = user32.GetSystemMetrics(49) || 16;

  const fromResource = user32.LoadImageW(
    instance,
    FIRST_ICON_RESOURCE,
    IMAGE_ICON,
    size,
    size,
    LR_DEFAULTCOLOR,
  );
  if (fromResource !== null && fromResource !== 0) return fromResource;

  const path = ownExecutablePath(kernel32);
  if (path !== null) {
    const extracted = shell32.ExtractIconW(instance, wide(path), 0);
    // 1 is `ExtractIcon`'s documented "the file has no icons" answer, and it is not a handle.
    if (extracted !== null && extracted !== 0 && extracted !== 1) return extracted;
  }

  return user32.LoadIconW(null, IDI_APPLICATION);
}

/** `GetModuleFileNameW(NULL, …)`: the full path of the running executable. */
function ownExecutablePath(kernel32: TrayLibs["kernel32"]): string | null {
  // 260 WCHARs is `MAX_PATH`, which a long-path install can exceed; 1024 costs nothing and a
  // truncated path would fail `ExtractIcon` in a way that looks like "no icon in this file".
  const buffer = new Uint8Array(1024 * 2);
  const written = kernel32.GetModuleFileNameW(null, buffer, 1024);
  if (written === 0) return null;
  const view = new DataView(buffer.buffer);
  let path = "";
  for (let index = 0; index < written; index += 1) {
    path += String.fromCharCode(view.getUint16(index * 2, true));
  }
  return path;
}

/** Re-exported for the packaging step, which has to know the icon resource id it writes. */
export const TRAY_ICON_RESOURCE = FIRST_ICON_RESOURCE;
export const TRAY_MODIFY = NIM_MODIFY;
