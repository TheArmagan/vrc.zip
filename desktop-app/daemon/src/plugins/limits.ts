/**
 * OS-level memory caps for plugin processes, and an honest account of where they do not exist.
 *
 * PLAN.md §Phase 3 names two mechanisms: a **Job Object** on Windows and **`RLIMIT_AS`** on Linux.
 * The reason it wants the OS rather than the RSS watchdog is that an OS cap fails the *allocation*,
 * while a watchdog notices afterwards, and a plugin can allocate a gigabyte between two watchdog
 * ticks.
 *
 * ## What is actually implemented, and what is not
 *
 * | Platform | Mechanism | Status |
 * |---|---|---|
 * | Linux    | `RLIMIT_AS` via `sh -c 'ulimit -v …; exec …'` | **implemented, before the spawn** |
 * | Windows  | Job Object, see `job-object.ts`               | **implemented, after the spawn** |
 * | macOS    | `RLIMIT_AS`                                   | **not implementable** |
 *
 * **The two implemented mechanisms apply at different moments, and that is why this file cannot
 * answer "is it capped" on Windows.** `RLIMIT_AS` is a property of the argv, so `planMemoryCap`
 * settles it before anything is spawned. A job object needs a pid, so on Windows the plan can only
 * say which mechanism *will be tried*; the transport spawns, calls `assignMemoryCap`, and decides
 * {@link MemoryCapPlan.enforced} from what actually happened. A `job-object` plan therefore comes
 * back with `enforced: false` and is corrected upward, never the other way round — a cap is never
 * claimed before it exists.
 *
 * **macOS is not an oversight.** Darwin's kernel accepts `RLIMIT_AS` and does not enforce it, so a
 * `ulimit -v` there would be a cap in name only, which is worse than no cap: it reads as enforced in
 * every log and dashboard. macOS is not a v1 platform anyway (see `paths.ts`).
 *
 * ## The caveat that matters on Linux
 *
 * `RLIMIT_AS` caps **virtual address space**, not resident memory, and JavaScriptCore reserves large
 * virtual ranges it never touches. A cap set at the RSS figure a human has in mind will fail
 * allocations long before the plugin is anywhere near that much *real* memory. Callers should pass a
 * generous multiple of the RSS they actually intend to allow and keep the watchdog as the thing that
 * enforces the number a user sees.
 */

/** How a cap is imposed, when one is. */
export type MemoryCapMechanism =
  /** `sh -c 'ulimit -v …; exec …'` wrapping the real argv. Linux only. */
  | "rlimit-as"
  /**
   * A Windows job object, assigned to the pid after the spawn. See `job-object.ts`.
   *
   * Naming it in the plan is a *request*, not a result: only the transport knows whether the
   * assignment succeeded, so it is the transport that sets {@link MemoryCapPlan.enforced}.
   */
  | "job-object"
  /** No cap. The RSS watchdog is the only bound. */
  | "none";

export interface MemoryCapPlan {
  /**
   * The argv to actually spawn. Identical to the input when no cap could be applied, and wrapped
   * when one could — never a second process at runtime, because the wrapper `exec`s, which
   * **preserves the pid**. That matters: the transport hands that pid to the RSS watchdog.
   */
  readonly argv: readonly string[];
  /**
   * True only when the OS will refuse the allocation. Never true "in spirit".
   *
   * For a `job-object` plan this is always `false` as returned from {@link planMemoryCap} and is
   * raised by the transport once the assignment has actually succeeded. See the file header.
   */
  readonly enforced: boolean;
  readonly mechanism: MemoryCapMechanism;
  /**
   * Whether a cap was asked for at all.
   *
   * Separate from {@link enforced} because "nobody asked" and "we could not" are different states
   * and only the second is worth warning about.
   */
  readonly requested: boolean;
  /** One line, in words rather than errno, for a log or a diagnostics page. */
  readonly detail: string;
}

/**
 * Exit code the wrapper uses when it cannot set the limit it was told to set.
 *
 * `EX_OSERR` from `sysexits.h`. Failing to start is the right outcome: a plugin that silently ran
 * uncapped because `ulimit` was unavailable is exactly the state this file exists to prevent.
 */
export const RLIMIT_SETUP_FAILED_EXIT = 71;

/**
 * `$1` is the limit in KiB, `$@` is the real argv after the shift. `exec` replaces the shell, so the
 * pid the caller sees is the plugin's own.
 */
const ULIMIT_SCRIPT = `ulimit -v "$1" || exit ${String(RLIMIT_SETUP_FAILED_EXIT)}; shift; exec "$@"`;

/** `$0` for the wrapper shell. Shows up in `ps`, so it says what it is. */
const ULIMIT_ARGV0 = "vrczip-plugin-limit";

/**
 * Works out how to spawn `argv` under a `limitBytes` address-space cap on this platform.
 *
 * Pure, and takes `platform` explicitly, so the Windows and Linux branches are both testable from
 * whichever machine happens to be running the suite.
 */
export function planMemoryCap(
  argv: readonly string[],
  limitBytes: number,
  platform: NodeJS.Platform = process.platform,
): MemoryCapPlan {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    return {
      argv,
      enforced: false,
      mechanism: "none",
      requested: false,
      detail: "No memory limit was requested, so none was applied.",
    };
  }

  if (platform === "linux") {
    const kib = Math.max(1, Math.ceil(limitBytes / 1024));
    return {
      argv: ["/bin/sh", "-c", ULIMIT_SCRIPT, ULIMIT_ARGV0, String(kib), ...argv],
      enforced: true,
      mechanism: "rlimit-as",
      requested: true,
      detail: `Address space is capped at ${String(kib)} KiB by RLIMIT_AS. Note that this caps virtual address space, not resident memory.`,
    };
  }

  if (platform === "win32") {
    return {
      argv,
      // Not yet. A job object cannot exist before the pid does; the transport raises this.
      enforced: false,
      mechanism: "job-object",
      requested: true,
      detail:
        "A Windows Job Object could not be assigned to this plugin, so it runs uncapped and only the RSS watchdog will stop it.",
    };
  }

  if (platform === "darwin") {
    return {
      argv,
      enforced: false,
      mechanism: "none",
      requested: true,
      detail:
        "macOS accepts RLIMIT_AS and does not enforce it, so no cap was applied rather than a cap that only looks applied. The RSS watchdog is the bound here.",
    };
  }

  return {
    argv,
    enforced: false,
    mechanism: "none",
    requested: true,
    detail: `No memory cap mechanism is implemented for ${platform}, so the RSS watchdog is the only bound.`,
  };
}

/**
 * Platforms already warned about in this process, so the message is loud once rather than once per
 * plugin start. A crash-looping plugin restarts on a backoff, and a warning per restart would turn
 * the honest disclosure into noise nobody reads.
 */
const warnedPlatforms = new Set<string>();

/**
 * Says out loud, once, that a requested cap was not imposed.
 *
 * Deliberately not routed through the plugin's own log: this is the host admitting something about
 * itself, and attributing it to the plugin would put host text in a place users read as plugin
 * output.
 */
export function warnIfUncapped(
  plan: MemoryCapPlan,
  platform: NodeJS.Platform = process.platform,
  warn: (message: string) => void = console.warn,
): void {
  if (plan.enforced || !plan.requested) return;
  if (warnedPlatforms.has(platform)) return;
  warnedPlatforms.add(platform);
  warn(`plugins: ${plan.detail}`);
}

/** Test seam. Lets a test observe the once-per-process behaviour without a fresh process. */
export function resetUncappedWarnings(): void {
  warnedPlatforms.clear();
}
