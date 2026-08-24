/**
 * Starting a process that outlives this one, over `CreateProcessW`.
 *
 * ## Why not `Bun.spawn`
 *
 * **Bun kills its subprocesses when the parent exits, and `unref()` does not change that.** Measured
 * on Bun 1.4.0 / Windows 11, not inferred: a parent that spawns `cmd /c timeout 6 & echo ok > file`,
 * calls `unref()` and exits immediately leaves no file behind, while the identical child launched
 * through `CreateProcessW` writes it. `unref()` only stops the child holding the event loop open; it
 * says nothing about what happens at exit.
 *
 * That is fine for every child this daemon babysits — a plugin host should not outlive its host —
 * and fatal for the three places where outliving *is* the point:
 *
 *  - the update handover, which starts the executable it just wrote and then stops being;
 *  - `--uninstall`, whose whole plan is a script that waits for this process to exit and then
 *    deletes the folder it was running from;
 *  - `runProgram`, which launches something the user will then use for an hour.
 *
 * All three quietly did nothing at all. The first is what sent someone looking.
 *
 * ## The flags
 *
 * `DETACHED_PROCESS`, so the child does not inherit this process's console. The console is the
 * second way a handover dies: an unpackaged child attached to our `conhost` gets a close event when
 * that window goes, and the packaged build allocates a console of its own anyway (`os/console.ts`),
 * so there is nothing to inherit that it wants.
 *
 * `CREATE_NEW_PROCESS_GROUP`, so a Ctrl-C in the console that started *us* is not also delivered to
 * a process that is meant to still be here afterwards.
 *
 * `CREATE_BREAKAWAY_FROM_JOB` is deliberately **not** set. It fails outright with `ERROR_ACCESS_DENIED`
 * in a job that does not permit breakaway, which is most of them, and the case it would buy — vrc.zip
 * started inside somebody's job object — is not one this app is in on the path that matters.
 *
 * ## `cmd.exe` was the one worth checking
 *
 * cmd does not parse its command line with `CommandLineToArgvW` — it re-reads the raw text with
 * rules of its own — so the uninstall's `cmd /c <script>` was the case where {@link quoteArgument}
 * might have been exactly wrong. Measured with the script in a folder whose name has spaces in
 * it: the ordinary quoted form runs it correctly, and the `cmd /s /c` idiom the documentation
 * reaches for is not needed. One quoting rule for every caller, then.
 *
 * ## Failure is a `null`, never a throw
 *
 * Same posture as `plugins/job-object.ts`: FFI unavailable, a missing symbol, a call returning zero.
 * The caller decides what a failed launch means, and every caller here has a sentence ready for it.
 */

import { dlopen, FFIType, type Library, ptr } from "bun:ffi";
import { wide } from "./registry.ts";

const IS_WINDOWS = process.platform === "win32";

/** The child gets no console of ours. */
const DETACHED_PROCESS = 0x0000_0008;
/** …and no Ctrl-C of ours either. */
const CREATE_NEW_PROCESS_GROUP = 0x0000_0200;

/** `sizeof(STARTUPINFOW)` on x64: 4 + 4 pad + three pointers + eight DWORDs + two WORDs + 4 pad + four pointers. */
const STARTUPINFOW_BYTES = 104;
/** `sizeof(PROCESS_INFORMATION)`: two handles, then the two ids. */
const PROCESS_INFORMATION_BYTES = 24;
/** Where `dwProcessId` sits inside it. */
const PROCESS_ID_OFFSET = 16;

type Kernel32 = Library<{
  CreateProcessW: {
    args: [
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.i32,
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
    ];
    returns: FFIType.i32;
  };
  CloseHandle: { args: [FFIType.u64]; returns: FFIType.i32 };
}>["symbols"];

let kernel32: Kernel32 | null | undefined;

/** Opened once and remembered, including the failure — a broken `dlopen` will not get better. */
function symbols(): Kernel32 | null {
  if (kernel32 !== undefined) return kernel32;
  if (!IS_WINDOWS) {
    kernel32 = null;
    return null;
  }
  try {
    kernel32 = dlopen("kernel32.dll", {
      CreateProcessW: {
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.i32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    }).symbols;
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

/**
 * One argument, quoted the way `CommandLineToArgvW` un-quotes.
 *
 * `CreateProcessW` takes a command *line*, not an argv, so the list has to be joined — and joining
 * with spaces is how a path with a space in it becomes two arguments. These are the documented
 * rules and they are not the obvious ones: a backslash is literal *except* immediately before a
 * quote, where it doubles.
 *
 * Exported for the test. This function is the only reason an argv can survive the trip.
 */
export function quoteArgument(value: string): string {
  if (value !== "" && !/[\s"]/.test(value)) return value;
  let out = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      // Every backslash run before a quote is doubled, and the quote itself is escaped.
      out += "\\".repeat(slashes * 2 + 1);
      out += '"';
      slashes = 0;
      continue;
    }
    out += "\\".repeat(slashes);
    out += character;
    slashes = 0;
  }
  // A trailing run is doubled too, so the closing quote is not eaten by it.
  out += "\\".repeat(slashes * 2);
  out += '"';
  return out;
}

/** The whole command line, argv[0] included, as `CreateProcessW` wants it. */
export function commandLine(path: string, args: readonly string[]): string {
  return [path, ...args].map(quoteArgument).join(" ");
}

export interface DetachedOptions {
  readonly path: string;
  readonly args?: readonly string[];
  /** The child's working directory. Absent means inheriting ours. */
  readonly directory?: string | undefined;
}

/**
 * Starts `path` detached from this process, and returns its pid.
 *
 * Null when it could not be started, for any reason: not Windows, no FFI, no such file. Nothing is
 * awaited and nothing is watched — this is a launcher, and the pid is the whole of the handle the
 * caller gets.
 */
export function startDetached(options: DetachedOptions): number | null {
  return launch(commandLine(options.path, options.args ?? []), options.directory);
}

/** The `CreateProcessW` call itself, shared by the two entry points above. */
function launch(command: string, workingDirectory?: string): number | null {
  const k32 = symbols();
  if (k32 === null) return null;

  // Mutable by contract: `CreateProcessW` may write into `lpCommandLine`, which is why this is a
  // buffer of our own rather than a string handed straight to FFI.
  const line = wide(command);
  const directory =
    workingDirectory === undefined || workingDirectory.trim() === ""
      ? null
      : wide(workingDirectory);

  const startup = new Uint8Array(STARTUPINFOW_BYTES);
  new DataView(startup.buffer).setUint32(0, STARTUPINFOW_BYTES, true);
  const information = new Uint8Array(PROCESS_INFORMATION_BYTES);

  let ok = 0;
  try {
    ok = k32.CreateProcessW(
      /*
       * `lpApplicationName` is deliberately NULL, with the executable as argv[0] instead.
       *
       * Passing it would be the tidier-looking call and would break every caller that names a
       * program rather than a path: the PATH search only happens when this is NULL. `cmd.exe` and
       * whatever a graph's Run a program node was pointed at are both that kind of name, and the
       * command line is quoted properly, so a path with a space in it is unambiguous anyway.
       */
      null,
      ptr(line),
      null,
      null,
      // No inherited handles. The child opens whatever it needs; ours are none of its business.
      0,
      DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
      null,
      directory === null ? null : ptr(directory),
      ptr(startup),
      ptr(information),
    );
  } catch {
    return null;
  }
  if (ok === 0) return null;

  const view = new DataView(information.buffer);
  // Both handles, closed at once. We are not waiting on this process and never will be; holding
  // them open would keep a zombie entry alive for exactly as long as this daemon runs.
  k32.CloseHandle(view.getBigUint64(0, true));
  k32.CloseHandle(view.getBigUint64(8, true));

  return view.getUint32(PROCESS_ID_OFFSET, true);
}
