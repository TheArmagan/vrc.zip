/**
 * The Windows half of the OS memory cap: a Job Object, driven through `bun:ffi` into `kernel32`.
 *
 * `limits.ts` explains *why* an OS cap is wanted at all — it fails the allocation, where the RSS
 * watchdog can only notice afterwards, and a plugin can allocate a gigabyte between two ticks. This
 * file is the Windows mechanism, kept apart from the transport for the reason `limits.ts` gave when
 * it deferred the work: this is a native-memory struct written by hand *inside the daemon process*,
 * and getting it wrong takes the daemon down rather than the plugin. It gets its own file, its own
 * tests, and a surface small enough to read in one sitting.
 *
 * ## The sequence
 *
 * `Bun.spawn` hands back a pid and no `HANDLE`, and there is no job-object option to pass it. So:
 *
 *  1. `CreateJobObjectW(NULL, NULL)` — an unnamed, non-inheritable job, one per plugin process.
 *  2. `SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, 144)` with
 *     `JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY` set to the cap, and
 *     `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so a daemon that dies takes its plugins with it rather
 *     than leaking orphaned `bun` processes onto the user's machine.
 *  3. `OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid)` — the narrowest access mask
 *     that `AssignProcessToJobObject` accepts.
 *  4. `AssignProcessToJobObject(job, process)`, then `CloseHandle(process)` immediately. The job
 *     handle is the only one kept, and it is what {@link JobHandle.close} releases.
 *
 * ## What the cap actually caps
 *
 * `ProcessMemoryLimit` is **committed** memory, not resident and not reserved address space. That
 * makes it a far better match for a number a human has in mind than Linux's `RLIMIT_AS`, which
 * counts JavaScriptCore's enormous untouched virtual reservations and so has to be set at a generous
 * multiple of the intended RSS. Here the figure can be roughly the figure. `JobMemoryLimit` is set
 * to the same value so that a plugin cannot buy headroom by spawning grandchildren: they inherit the
 * job, and the *sum* is capped too.
 *
 * When a plugin crosses the limit the allocation fails inside it — JSC reports an out-of-memory and
 * the process dies on its own. That surfaces through the transport as an ordinary crash, which is
 * exactly right: it is one.
 *
 * ## Every failure here is non-fatal, by design
 *
 * FFI unavailable, `kernel32` missing a symbol, a call returning zero, a process that exited between
 * the spawn and the `OpenProcess` — all of them return `null` and let the caller spawn anyway, with
 * the RSS watchdog as the bound. Refusing to start a plugin because a memory cap could not be
 * installed would trade a *later* bound for *no plugin at all*, which is the worse outcome. The
 * failure is said out loud once per process so it is not silent either.
 */

import { dlopen, FFIType, type Pointer } from "bun:ffi";

// -----------------------------------------------------------------------------------------------
// Win32 constants. Values from `winnt.h`; the names are kept verbatim so they can be grepped there.
// -----------------------------------------------------------------------------------------------

/** `JobObjectExtendedLimitInformation`, the `JOBOBJECTINFOCLASS` value for the 144-byte struct. */
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;

/** Size of `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` on x64. Wrong here means a rejected call. */
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE = 144;

/** Per-process committed-memory cap. */
export const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x0000_0100;
/** Cap on the committed memory of every process in the job, summed. */
export const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x0000_0200;
/** Kill everything in the job when the last handle to it closes. The anti-orphan clause. */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

// Field offsets inside JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64, all little-endian:
//
//   0   BasicLimitInformation.PerProcessUserTimeLimit  (LARGE_INTEGER)
//   8   BasicLimitInformation.PerJobUserTimeLimit      (LARGE_INTEGER)
//   16  BasicLimitInformation.LimitFlags               (DWORD)
//   24  BasicLimitInformation.MinimumWorkingSetSize    (SIZE_T, 8-byte aligned)
//   32  BasicLimitInformation.MaximumWorkingSetSize    (SIZE_T)
//   40  BasicLimitInformation.ActiveProcessLimit       (DWORD)
//   48  BasicLimitInformation.Affinity                 (ULONG_PTR)
//   56  BasicLimitInformation.PriorityClass            (DWORD)
//   60  BasicLimitInformation.SchedulingClass          (DWORD)
//   64  IoInfo                                         (IO_COUNTERS, 6 x ULONGLONG)
//   112 ProcessMemoryLimit                             (SIZE_T)
//   120 JobMemoryLimit                                 (SIZE_T)
//   128 PeakProcessMemoryUsed                          (SIZE_T)
//   136 PeakJobMemoryUsed                              (SIZE_T)
const OFFSET_LIMIT_FLAGS = 16;
const OFFSET_PROCESS_MEMORY_LIMIT = 112;
const OFFSET_JOB_MEMORY_LIMIT = 120;

/**
 * Builds the `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` bytes for a `limitBytes` cap.
 *
 * Pure and exported so the struct layout — the one part of this file that is silently wrong rather
 * than loudly wrong when it is mistaken — can be asserted byte by byte on any platform, including
 * the Linux runner in CI where none of the calls below exist.
 */
export function buildExtendedLimitInformation(limitBytes: number): Uint8Array {
  const bytes = new Uint8Array(JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(
    OFFSET_LIMIT_FLAGS,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY |
      JOB_OBJECT_LIMIT_JOB_MEMORY |
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    true,
  );
  const limit = BigInt(Math.max(1, Math.floor(limitBytes)));
  view.setBigUint64(OFFSET_PROCESS_MEMORY_LIMIT, limit, true);
  view.setBigUint64(OFFSET_JOB_MEMORY_LIMIT, limit, true);
  return bytes;
}

// -----------------------------------------------------------------------------------------------
// kernel32
// -----------------------------------------------------------------------------------------------

/**
 * A Win32 `HANDLE`.
 *
 * `null` is the failure return from `CreateJobObjectW` and `OpenProcess` alike, and it is also how
 * `bun:ffi` surfaces a null pointer, so the two agree without a sentinel of our own.
 */
type Handle = Pointer | null;

/**
 * Normalises what `bun:ffi` hands back for a pointer return.
 *
 * It is typed as `Pointer | bigint | null` because a pointer past 2^53 cannot survive a double, and
 * a Win32 `HANDLE` never comes close — but the type is honest and has to be narrowed somewhere.
 * A zero is folded into `null` here so that "the call failed" has exactly one representation.
 */
function toHandle(value: Pointer | bigint | null): Handle {
  if (value === null) return null;
  const numeric = typeof value === "bigint" ? Number(value) : value;
  return numeric === 0 ? null : (numeric as Pointer);
}

interface Kernel32 {
  readonly createJobObject: () => Handle;
  readonly setInformation: (job: Pointer, klass: number, info: Uint8Array, size: number) => number;
  readonly openProcess: (access: number, inherit: number, pid: number) => Handle;
  readonly assign: (job: Pointer, process: Pointer) => number;
  readonly closeHandle: (handle: Pointer) => number;
  readonly lastError: () => number;
}

let kernel32: Kernel32 | null = null;
let kernel32Attempted = false;

function loadKernel32(): Kernel32 | null {
  if (kernel32Attempted) return kernel32;
  kernel32Attempted = true;
  try {
    const lib = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      OpenProcess: {
        args: [FFIType.u32, FFIType.i32, FFIType.u32],
        returns: FFIType.ptr,
      },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    });
    const s = lib.symbols;
    kernel32 = {
      createJobObject: () => toHandle(s.CreateJobObjectW(null, null)),
      setInformation: (job, klass, info, size) => s.SetInformationJobObject(job, klass, info, size),
      openProcess: (access, inherit, pid) => toHandle(s.OpenProcess(access, inherit, pid)),
      assign: (job, proc) => s.AssignProcessToJobObject(job, proc),
      closeHandle: (handle) => s.CloseHandle(handle),
      lastError: () => s.GetLastError(),
    };
  } catch (error) {
    kernel32 = null;
    complain(
      `kernel32 could not be opened through bun:ffi (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return kernel32;
}

// -----------------------------------------------------------------------------------------------
// The surface
// -----------------------------------------------------------------------------------------------

/** A live job object holding exactly one plugin process. Closing it is what enforces the kill. */
export interface JobHandle {
  /** The raw `HANDLE` as a number, for tests and diagnostics. Never dereferenced by callers. */
  readonly handle: number;
  /** The cap that was installed, in bytes. */
  readonly limitBytes: number;
  /**
   * Releases the job.
   *
   * With `KILL_ON_JOB_CLOSE` set this **terminates anything still inside it**, so call it only once
   * the plugin process is known to be gone — the transport calls it when it reports the exit. Safe
   * to call more than once.
   */
  close(): void;
}

/**
 * Said once per daemon process, because a crash-looping plugin would otherwise repeat it forever.
 *
 * This names the *cause* only. The consequence — "so the RSS watchdog is the only bound" — is
 * `warnIfUncapped`'s line, and saying it in both places would make one failure read as two.
 */
let complained = false;

function complain(detail: string): void {
  if (complained) return;
  complained = true;
  console.warn(`plugins: the Windows Job Object memory cap could not be installed. ${detail}`);
}

/** Test seam, matching `resetUncappedWarnings` in `limits.ts`. */
export function resetJobObjectWarnings(): void {
  complained = false;
}

/**
 * Puts `pid` inside a fresh job object capped at `limitBytes` of committed memory.
 *
 * Returns `null` on every failure, including "not Windows" and "no cap asked for". A `null` is not
 * an error the caller should propagate: it means the plugin runs with the watchdog as its only
 * bound, which is the pre-existing behaviour this replaces.
 */
export function assignMemoryCap(
  pid: number | null,
  limitBytes: number,
  platform: NodeJS.Platform = process.platform,
): JobHandle | null {
  if (platform !== "win32") return null;
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return null;

  const k32 = loadKernel32();
  if (k32 === null) return null;

  let job: Handle = null;
  let process_: Handle = null;
  try {
    job = k32.createJobObject();
    if (job === null) {
      complain(`CreateJobObjectW failed with error ${String(k32.lastError())}.`);
      return null;
    }

    const info = buildExtendedLimitInformation(limitBytes);
    if (
      k32.setInformation(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
        info,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE,
      ) === 0
    ) {
      complain(`SetInformationJobObject failed with error ${String(k32.lastError())}.`);
      k32.closeHandle(job);
      return null;
    }

    // Narrowest mask the assignment accepts. Notably not PROCESS_VM_READ or _QUERY_INFORMATION:
    // the daemon has no business reading a plugin's memory, and the watchdog gets RSS from the
    // plugin's own heartbeat rather than from here.
    process_ = k32.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if (process_ === null) {
      // The usual cause is a plugin that died between `Bun.spawn` returning and this line, which is
      // not a fault worth a warning that lasts the rest of the daemon's life.
      k32.closeHandle(job);
      return null;
    }

    if (k32.assign(job, process_) === 0) {
      complain(`AssignProcessToJobObject failed with error ${String(k32.lastError())}.`);
      k32.closeHandle(process_);
      k32.closeHandle(job);
      return null;
    }

    // The process handle has done its job. The job handle is the one that must outlive this call:
    // dropping it here would trip KILL_ON_JOB_CLOSE and kill the plugin we just started.
    k32.closeHandle(process_);
    process_ = null;

    let closed = false;
    const jobHandle = job;
    job = null;
    return {
      handle: Number(jobHandle),
      limitBytes,
      close(): void {
        if (closed) return;
        closed = true;
        try {
          k32.closeHandle(jobHandle);
        } catch {
          // A handle that cannot be closed is a leak of one handle, not a reason to fail a stop.
        }
      },
    };
  } catch (error) {
    complain(error instanceof Error ? error.message : String(error));
    try {
      if (process_ !== null) k32.closeHandle(process_);
      if (job !== null) k32.closeHandle(job);
    } catch {
      // Already unwinding.
    }
    return null;
  }
}
