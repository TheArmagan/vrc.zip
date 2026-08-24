/**
 * The hidden window and the message loop, shared by everything in `os/` that needs one.
 *
 * ## Why this is its own module
 *
 * A Win32 process gets exactly one useful message pump: the one on the thread that owns the
 * windows. The tray icon needed a window to receive its click notifications and a loop to deliver
 * them, and built both. Then the notifier needed the same thing for a different reason — a WinRT
 * toast's `Activated` handler is a COM call into a single-threaded apartment, and an STA delivers
 * calls by *sending window messages*, so a toast with buttons is only as alive as the pump on the
 * thread that initialised the apartment. Two loops would work and would be wrong: two intervals,
 * two hidden windows, two `WM_QUIT` stories, and a `PeekMessageW(NULL, …)` in each that steals
 * messages meant for the other, because the queue is the *thread's* and not the window's.
 *
 * So the window and the loop live here, and the tray and the notifier are subscribers. Everything
 * below about *why* the loop is shaped the way it is came out of getting the tray wrong first; the
 * notes are kept because the reasoning is what stops the next person unwinding it.
 *
 * ## The message loop, and why there *is* a callback
 *
 * The first version of this tried to avoid handing Windows a pointer into JavaScript at all: it
 * registered **`DefWindowProcW` itself** as the class procedure and let the pump read messages with
 * `PeekMessageW` and inspect them before dispatching. That draws a perfect icon and receives
 * absolutely nothing.
 *
 * The reason is the distinction between a *posted* and a *sent* message. `PeekMessageW` returns
 * posted messages, which sit in the thread queue; a sent message is not queued at all, and the
 * retrieval call delivers it by invoking the target window's procedure directly before it goes
 * looking for anything queued. The shell's tray callbacks are sent, and so is the `WM_CONTEXTMENU`
 * that version 4 uses for a right-click, and so is every COM call an STA receives. So every click
 * went straight into `DefWindowProcW` and was discarded, while `PostMessageW`-ing at our own window
 * by hand worked perfectly, which is what made the failure so hard to read. Electron does not do it
 * this way either: `NotifyIconHost` registers a real `WndProcStatic` and handles the callback
 * inside it.
 *
 * So there is a `JSCallback`, and the original worry about it is answered by keeping it trivial
 * rather than by not having one. The procedure never opens a menu, never touches the daemon and
 * cannot throw: it turns a *sent* message it has been asked to watch for into a `PostMessageW` at
 * our own window and returns. Everything with any weight to it — building a menu, the modal
 * `TrackPopupMenu`, opening a URL, running a toast's activation handler — happens later, on our own
 * stack, out of the pump. Windows only ever calls back into JavaScript from inside our own
 * `PeekMessageW` on our own thread, which is the one case where a callback is not a cross-thread
 * hazard.
 *
 * The pump runs on an `unref`ed interval, so it never keeps the process alive on its own — the
 * servers do that — and a daemon shutting down does not wait for a tick.
 *
 * ## The window is `WS_POPUP`, not message-only
 *
 * When explorer crashes and comes back it broadcasts `TaskbarCreated`, and that broadcast only
 * reaches top-level windows. A message-only window would never hear it, and every tray icon in the
 * process would stay gone.
 *
 * ## Refcounted, and module-level on purpose
 *
 * This is the one place in the daemon where a module holds process state rather than being handed
 * it by `app.ts`, and the reason is that the thing it holds *is* process state: one window, one
 * thread, one queue. Handing two subsystems a pump each is not a different wiring choice, it is a
 * bug. So holders `acquire()` and `release()`, and the window goes away with the last of them.
 */

import { dlopen, FFIType, JSCallback, ptr, suffix } from "bun:ffi";

const IS_WINDOWS = process.platform === "win32";

/* -------------------------------------------------------------------------------------------- */
/* Win32 constants and struct helpers                                                             */
/* -------------------------------------------------------------------------------------------- */

/** `sizeof(MSG)` on x64: hwnd, message, wParam, lParam, time, POINT, and the tail padding. */
export const MSG_BYTES = 48;
/** `sizeof(WNDCLASSEXW)` on x64. */
export const WNDCLASSEXW_BYTES = 80;

/** A top-level window, which is what a `TaskbarCreated` broadcast will actually reach. */
const WS_POPUP = 0x80000000;
const PM_REMOVE = 0x0001;
const WM_QUIT = 0x0012;
/** `MSGFLT_ALLOW`, for `ChangeWindowMessageFilterEx`. */
const MSGFLT_ALLOW = 1;

/** UTF-16LE, NUL-terminated. Every `…W` entry point wants this. */
export function wide(value: string): Uint8Array {
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
export function writeFixedWide(view: DataView, offset: number, value: string, chars: number): void {
  const limit = Math.min(value.length, chars - 1);
  for (let index = 0; index < limit; index += 1) {
    view.setUint16(offset + index * 2, value.charCodeAt(index), true);
  }
  view.setUint16(offset + limit * 2, 0, true);
}

export function setPointer(view: DataView, offset: number, value: number | bigint | null): void {
  view.setBigUint64(offset, BigInt(value ?? 0), true);
}

/* -------------------------------------------------------------------------------------------- */
/* The library                                                                                    */
/* -------------------------------------------------------------------------------------------- */

interface PumpLibs {
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
  };
  readonly kernel32: {
    GetModuleHandleW: (name: Uint8Array | null) => number | null;
  };
}

let libs: PumpLibs | null = null;
let attempted = false;

/**
 * Opens the two libraries once, and never throws.
 *
 * Same posture as `console.ts`: everything built on this is decoration, and a machine where
 * `dlopen` fails should get a working daemon without it rather than a startup crash.
 */
function load(): PumpLibs | null {
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
      ChangeWindowMessageFilterEx: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      PostMessageW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64],
        returns: FFIType.i32,
      },
    });
    const kernel32 = dlopen(`kernel32.${suffix}`, {
      GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
    });
    libs = {
      user32: user32.symbols as unknown as PumpLibs["user32"],
      kernel32: kernel32.symbols as unknown as PumpLibs["kernel32"],
    };
  } catch {
    libs = null;
  }
  return libs;
}

/* -------------------------------------------------------------------------------------------- */
/* The pump                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** What a holder gets. Every method is a no-op after `release`. */
export interface MessagePump {
  /** The hidden window's handle. Something a `NOTIFYICONDATAW` or a filter call has to name. */
  readonly hwnd: number;
  /** `RegisterWindowMessageW`. Zero when the name could not be registered. */
  registerWindowMessage(name: string): number;
  /**
   * Lets a message through UIPI.
   *
   * It blocks a posted message from a lower-integrity process to a higher-integrity one, and it
   * blocks it *silently*: run the daemon from an elevated terminal and explorer (medium integrity)
   * can still add a tray icon, draw it, and show its tooltip, while every click it posts back is
   * dropped before it reaches our queue. The icon looks perfect and the menu simply never opens,
   * with nothing logged anywhere. This is the documented fix, and it is a no-op when we are not
   * elevated, so callers do not guard it on a privilege check.
   */
  allowMessage(message: number): void;
  /** Posts at our own window. */
  post(message: number, wParam?: number | bigint, lParam?: number | bigint): void;
  /**
   * Watches for a message that will be *sent* to our window, and re-posts it under another id.
   *
   * This is the whole reason the window procedure exists. See the note at the top of the file.
   */
  forwardSent(sent: number, posted: number): void;
  /** Handles a posted message on our own stack. Returns the function that unsubscribes. */
  onMessage(message: number, handler: (wParam: bigint, lParam: bigint) => void): () => void;
  /** Runs every tick, for the health checks a subsystem wants on a timer it does not own. */
  onTick(handler: () => void): () => void;
  /** Gives up this holder's claim. The window and the loop go with the last one. */
  release(): void;
}

interface Shared {
  readonly hwnd: number;
  readonly className: Uint8Array;
  readonly instance: number | null;
  readonly procedure: JSCallback;
  readonly libs: PumpLibs;
  readonly forwarded: Map<number, number>;
  readonly handlers: Map<number, Set<(wParam: bigint, lParam: bigint) => void>>;
  readonly ticks: Set<() => void>;
  readonly timer: ReturnType<typeof setInterval>;
  holders: number;
  stopped: boolean;
}

let shared: Shared | null = null;

/**
 * How often the loop runs.
 *
 * 120ms: below the threshold where a right-click feels laggy, and 8 wake-ups a second of a function
 * that usually returns on its first `PeekMessageW`.
 */
const TICK_MS = 120;

/**
 * The window class name, which the tray test finds this window by.
 *
 * Per-process rather than a constant, because two daemons on one desktop each register their own.
 */
export function pumpClassName(pid: number = process.pid): string {
  return `vrczip-tray-${String(pid)}`;
}

/**
 * Takes a claim on the shared window and loop, building them on the first one.
 *
 * Returns null where there is no Win32 to build them on, or where `dlopen` is locked down. Both are
 * normal, and neither is an error: the caller does without whatever it wanted the pump for.
 */
export function acquireMessagePump(): MessagePump | null {
  const existing = shared ?? create();
  if (existing === null) return null;
  existing.holders += 1;
  return handleFor(existing);
}

function create(): Shared | null {
  const lib = load();
  if (lib === null) return null;

  const { user32, kernel32 } = lib;
  const instance = kernel32.GetModuleHandleW(null);
  const forwarded = new Map<number, number>();

  /*
   * The window procedure.
   *
   * Deliberately the smallest thing that can work, for the reasons at the top: it is called by
   * Windows, from inside our own `PeekMessageW`, and anything it throws is thrown across a foreign
   * stack frame. So it looks one message id up in a `Map`, posts, and hands everything else —
   * including the `WM_NCCREATE`/`WM_CREATE` pair that arrives while `CreateWindowExW` is still
   * running — to `DefWindowProcW`. The `try` is belt and braces; there is nothing in here that can
   * reasonably fail.
   */
  const procedure = new JSCallback(
    (hwnd: number, message: number, wParam: bigint, lParam: bigint): bigint => {
      try {
        const posted = forwarded.get(message);
        if (posted !== undefined) {
          user32.PostMessageW(hwnd, posted, wParam, lParam);
          return 0n;
        }
        return user32.DefWindowProcW(hwnd, message, wParam, lParam);
      } catch {
        return 0n;
      }
    },
    { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
  );

  const className = wide(pumpClassName());
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

  const message = new Uint8Array(MSG_BYTES);
  const messageView = new DataView(message.buffer);

  const state: Shared = {
    hwnd,
    className,
    instance,
    procedure,
    libs: lib,
    forwarded,
    handlers: new Map(),
    ticks: new Set(),
    holders: 0,
    stopped: false,
    timer: setInterval(() => {
      if (state.stopped) return;

      // A copy, because a tick handler is allowed to unsubscribe itself.
      for (const tick of [...state.ticks]) {
        try {
          tick();
        } catch {
          // A subsystem's health check is not allowed to stop the loop every other subsystem is on.
        }
      }

      /*
       * One bounded pass of the queue.
       *
       * Bounded rather than drained: `TrackPopupMenu` is modal and blocks this thread until the
       * menu closes, so an unbounded loop over a queue that keeps filling would be a way to stall
       * the whole daemon. Sixty-four messages is far more than this window ever produces in a tick.
       */
      for (let index = 0; index < 64; index += 1) {
        /*
         * This call is doing two jobs, and the second one is invisible.
         *
         * It returns the next posted message, which is what the loop below reads. It also delivers
         * every message that was *sent* to one of this thread's windows by calling the procedure —
         * which is where the shell's clicks and an STA's COM calls actually arrive.
         *
         * `NULL` rather than our own window, and that is load-bearing now that this is shared: an
         * apartment's incoming calls arrive at a hidden OLE window we do not own, and a filter on
         * `hwnd` would leave them in the queue forever.
         */
        if (user32.PeekMessageW(message, null, 0, 0, PM_REMOVE) === 0) return;
        const id = messageView.getUint32(8, true);
        if (id === WM_QUIT) return;
        const handlers = state.handlers.get(id);
        if (handlers !== undefined && handlers.size > 0) {
          const wParam = messageView.getBigUint64(16, true);
          const lParam = messageView.getBigInt64(24, true);
          for (const handler of [...handlers]) {
            try {
              handler(wParam, lParam);
            } catch {
              // Same reasoning as the tick loop: one subscriber's mistake is not the pump's.
            }
          }
          continue;
        }
        user32.TranslateMessage(message);
        user32.DispatchMessageW(message);
      }
    }, TICK_MS),
  };
  state.timer.unref?.();
  shared = state;
  return state;
}

function handleFor(state: Shared): MessagePump {
  let released = false;
  const { user32 } = state.libs;

  return {
    hwnd: state.hwnd,
    registerWindowMessage(name: string): number {
      if (released || state.stopped) return 0;
      return user32.RegisterWindowMessageW(wide(name));
    },
    allowMessage(message: number): void {
      if (released || state.stopped) return;
      user32.ChangeWindowMessageFilterEx(state.hwnd, message, MSGFLT_ALLOW, null);
    },
    post(message: number, wParam: number | bigint = 0, lParam: number | bigint = 0): void {
      if (released || state.stopped) return;
      user32.PostMessageW(state.hwnd, message, wParam, lParam);
    },
    forwardSent(sent: number, posted: number): void {
      if (released || state.stopped) return;
      state.forwarded.set(sent, posted);
    },
    onMessage(message: number, handler: (wParam: bigint, lParam: bigint) => void): () => void {
      if (released || state.stopped) return () => undefined;
      const set = state.handlers.get(message) ?? new Set();
      set.add(handler);
      state.handlers.set(message, set);
      return () => {
        set.delete(handler);
      };
    },
    onTick(handler: () => void): () => void {
      if (released || state.stopped) return () => undefined;
      state.ticks.add(handler);
      return () => {
        state.ticks.delete(handler);
      };
    },
    release(): void {
      if (released) return;
      released = true;
      state.holders -= 1;
      if (state.holders > 0 || state.stopped) return;
      destroy(state);
    },
  };
}

function destroy(state: Shared): void {
  state.stopped = true;
  clearInterval(state.timer);
  state.handlers.clear();
  state.ticks.clear();
  state.forwarded.clear();
  try {
    // Order matters: the window has to be gone before the procedure it points at is, or a message
    // arriving in between would call into freed memory.
    state.libs.user32.DestroyWindow(state.hwnd);
    state.libs.user32.UnregisterClassW(state.className, state.instance);
    state.procedure.close();
  } catch {
    // Shutting down. Nothing here is worth failing an exit path over.
  }
  if (shared === state) shared = null;
}
