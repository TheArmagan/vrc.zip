import { describe, expect, test } from "bun:test";
import {
  planMemoryCap,
  RLIMIT_SETUP_FAILED_EXIT,
  resetUncappedWarnings,
  warnIfUncapped,
} from "./limits.ts";

const ARGV = ["/opt/bun", "--smol", "-e", "code", "config"];

describe("planMemoryCap", () => {
  test("wraps the argv in a ulimit shell on Linux, preserving the pid through exec", () => {
    const plan = planMemoryCap(ARGV, 64 * 1024 * 1024, "linux");
    expect(plan.enforced).toBe(true);
    expect(plan.mechanism).toBe("rlimit-as");
    expect(plan.argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    // `exec` is what keeps the pid the transport reports pointing at the plugin rather than at a
    // shell that outlives nothing.
    expect(plan.argv[2]).toContain('exec "$@"');
    expect(plan.argv[2]).toContain(`exit ${String(RLIMIT_SETUP_FAILED_EXIT)}`);
    expect(plan.argv[4]).toBe(String(64 * 1024));
    expect(plan.argv.slice(5)).toEqual(ARGV);
  });

  test("rounds a fractional KiB up, never down", () => {
    // Rounding down would mean handing back a cap looser than the one asked for, silently.
    const plan = planMemoryCap(ARGV, 1025, "linux");
    expect(plan.argv[4]).toBe("2");
  });

  test("does not pretend to cap on Windows, and says why", () => {
    const plan = planMemoryCap(ARGV, 64 * 1024 * 1024, "win32");
    expect(plan.enforced).toBe(false);
    expect(plan.requested).toBe(true);
    expect(plan.argv).toEqual(ARGV);
    expect(plan.detail).toContain("Job Object");
    expect(plan.detail).toContain("RSS watchdog");
  });

  test("does not apply RLIMIT_AS on macOS, where the kernel would ignore it", () => {
    const plan = planMemoryCap(ARGV, 64 * 1024 * 1024, "darwin");
    expect(plan.enforced).toBe(false);
    expect(plan.mechanism).toBe("none");
    expect(plan.argv).toEqual(ARGV);
  });

  test("treats no limit as a different state from a limit it could not apply", () => {
    const plan = planMemoryCap(ARGV, 0, "linux");
    expect(plan.requested).toBe(false);
    expect(plan.enforced).toBe(false);
    expect(plan.argv).toEqual(ARGV);
  });
});

describe("warnIfUncapped", () => {
  test("says so once per platform, loudly, and never for a cap that was applied", () => {
    resetUncappedWarnings();
    const said: string[] = [];
    const warn = (message: string) => {
      said.push(message);
    };

    warnIfUncapped(planMemoryCap(ARGV, 1024, "win32"), "win32", warn);
    warnIfUncapped(planMemoryCap(ARGV, 1024, "win32"), "win32", warn);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("plugins:");

    warnIfUncapped(planMemoryCap(ARGV, 1024, "linux"), "linux", warn);
    expect(said).toHaveLength(1);
  });

  test("stays quiet when nobody asked for a cap", () => {
    resetUncappedWarnings();
    const said: string[] = [];
    warnIfUncapped(planMemoryCap(ARGV, 0, "win32"), "win32", (message) => said.push(message));
    expect(said).toEqual([]);
  });
});
