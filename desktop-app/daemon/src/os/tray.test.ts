import { dlopen, FFIType, suffix } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { MSG_BYTES, NOTIFYICONDATAW_BYTES, startTray, WNDCLASSEXW_BYTES } from "./tray.ts";

/**
 * The struct sizes, derived rather than restated.
 *
 * Asserting `NOTIFYICONDATAW_BYTES === 976` against a literal would only prove the number equals
 * itself. These lay the fields out from their own sizes and alignment, which is the arithmetic that
 * can actually be wrong — and getting it wrong is not an error at runtime: Windows reads `cbSize` to
 * decide which version of the struct it was handed, and a bad value is an icon that never appears
 * with no way to find out why.
 */

/** x64: every pointer is 8 and aligns to 8; a DWORD is 4 and aligns to 4. */
function layout(fields: readonly (readonly [size: number, align: number])[]): number {
  let offset = 0;
  let widest = 1;
  for (const [size, align] of fields) {
    offset = Math.ceil(offset / align) * align;
    offset += size;
    widest = Math.max(widest, align);
  }
  // Tail padding to the struct's own alignment, which is what `sizeof` reports.
  return Math.ceil(offset / widest) * widest;
}

const DWORD = [4, 4] as const;
const UINT = [4, 4] as const;
const POINTER = [8, 8] as const;
const wchars = (count: number) => [count * 2, 2] as const;

describe("the Win32 structs", () => {
  test("NOTIFYICONDATAW is 976 bytes on x64", () => {
    expect(
      layout([
        DWORD, // cbSize
        POINTER, // hWnd
        UINT, // uID
        UINT, // uFlags
        UINT, // uCallbackMessage
        POINTER, // hIcon
        wchars(128), // szTip
        DWORD, // dwState
        DWORD, // dwStateMask
        wchars(256), // szInfo
        UINT, // uTimeout / uVersion
        wchars(64), // szInfoTitle
        DWORD, // dwInfoFlags
        [16, 8], // guidItem
        POINTER, // hBalloonIcon
      ]),
    ).toBe(NOTIFYICONDATAW_BYTES);
  });

  test("MSG is 48 bytes and WNDCLASSEXW is 80", () => {
    expect(
      layout([
        POINTER, // hwnd
        UINT, // message
        POINTER, // wParam
        POINTER, // lParam
        DWORD, // time
        DWORD, // pt.x
        DWORD, // pt.y
      ]),
    ).toBe(MSG_BYTES);

    expect(
      layout([
        UINT, // cbSize
        UINT, // style
        POINTER, // lpfnWndProc
        [4, 4], // cbClsExtra
        [4, 4], // cbWndExtra
        POINTER, // hInstance
        POINTER, // hIcon
        POINTER, // hCursor
        POINTER, // hbrBackground
        POINTER, // lpszMenuName
        POINTER, // lpszClassName
        POINTER, // hIconSm
      ]),
    ).toBe(WNDCLASSEXW_BYTES);
  });
});

describe("startTray", () => {
  test("is absent rather than broken where there is no notification area", () => {
    // The tray is decoration. Everywhere but Windows it answers null, and the caller carries on
    // with a daemon that prints its URL and runs — which is also what a Windows machine whose
    // `dlopen` is locked down gets.
    if (process.platform === "win32") return;
    expect(
      startTray({
        title: "vrc.zip",
        launchUrl: "http://127.0.0.1:7773/",
        githubUrl: "https://example.invalid",
        ownsConsole: false,
        open: () => undefined,
        openExternal: () => undefined,
        onExit: () => undefined,
      }),
    ).toBe(null);
  });

  /**
   * The one test that could have caught the bug this file was written around. See §Gotchas.
   *
   * The tray's first version read the thread queue with `PeekMessageW` and never installed a window
   * procedure, which works for a *posted* message and receives nothing at all for a *sent* one — and
   * the shell sends. So the notification has to come from another process to be a real reproduction:
   * `SendNotifyMessageW` within our own process would be a direct call on our own thread and would
   * pass against the broken version, as would anything using `PostMessageW`.
   */
  test.if(process.platform === "win32")(
    "handles a notification the shell's way, sent from another process",
    async () => {
      const user32 = dlopen(`user32.${suffix}`, {
        FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      }).symbols as unknown as {
        FindWindowW: (klass: Uint8Array, name: null) => number | null;
      };

      const opened: string[] = [];
      const tray = startTray({
        title: "vrc.zip test",
        launchUrl: "http://127.0.0.1:7773/",
        githubUrl: "https://example.invalid",
        ownsConsole: false,
        open: (url) => {
          opened.push(url);
        },
        openExternal: () => undefined,
        onExit: () => undefined,
      });
      // A machine whose `dlopen` is locked down has nothing to assert about.
      if (tray === null) return;

      try {
        const klass = `vrczip-tray-${String(process.pid)}`;
        const wide = new Uint8Array((klass.length + 1) * 2);
        const view = new DataView(wide.buffer);
        for (let index = 0; index < klass.length; index += 1) {
          view.setUint16(index * 2, klass.charCodeAt(index), true);
        }
        const hwnd = user32.FindWindowW(wide, null);
        expect(hwnd).not.toBe(0);

        // `WM_TRAY`, with version 4's lParam: `NIN_SELECT` in the low half, the icon's uID in the
        // high half. A left click, which opens the launch URL rather than a modal menu.
        const child = Bun.spawn(
          [
            process.execPath,
            "-e",
            "import {dlopen,FFIType,suffix} from 'bun:ffi';" +
              "const u=dlopen('user32.'+suffix,{SendNotifyMessageW:" +
              "{args:[FFIType.ptr,FFIType.u32,FFIType.u64,FFIType.i64],returns:FFIType.i32}}).symbols;" +
              "u.SendNotifyMessageW(Number(process.env.VRCZIP_TEST_HWND),0x8001,0n,BigInt(0x00010400));",
          ],
          {
            env: { ...process.env, VRCZIP_TEST_HWND: String(hwnd) },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        expect(await child.exited).toBe(0);

        // The pump ticks at 120ms, and the procedure only posts; the work lands a tick later.
        for (let waited = 0; waited < 4000 && opened.length === 0; waited += 50) {
          await Bun.sleep(50);
        }
        // Exactly one: a version 4 icon delivers the raw mouse message alongside `NIN_SELECT`, and
        // a pump that answers to both opened the launch URL twice for every click.
        expect(opened).toEqual(["http://127.0.0.1:7773/"]);
      } finally {
        tray.stop();
      }
    },
    10_000,
  );
});
