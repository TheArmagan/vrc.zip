import { describe, expect, test } from "bun:test";
import {
  assignMemoryCap,
  buildExtendedLimitInformation,
  JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE,
  JOB_OBJECT_LIMIT_JOB_MEMORY,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  JOB_OBJECT_LIMIT_PROCESS_MEMORY,
} from "./job-object.ts";

/**
 * The struct tests run everywhere, including a Linux CI runner: the layout is the part of this that
 * is *silently* wrong when it is wrong, so it is asserted by offset rather than by behaviour.
 *
 * The behavioural tests spawn real processes and only run on Windows. There is no way to fake them
 * usefully — the question they answer is whether the kernel honours the limit.
 */

const onWindows = process.platform === "win32";

describe("buildExtendedLimitInformation", () => {
  test("is exactly the 144 bytes SetInformationJobObject expects", () => {
    expect(buildExtendedLimitInformation(1024).byteLength).toBe(
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_SIZE,
    );
  });

  test("sets the three limit flags at offset 16 and nothing else", () => {
    const view = new DataView(buildExtendedLimitInformation(1024).buffer);
    expect(view.getUint32(16, true)).toBe(
      JOB_OBJECT_LIMIT_PROCESS_MEMORY |
        JOB_OBJECT_LIMIT_JOB_MEMORY |
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    );
  });

  test("writes the cap little-endian at the process and job memory offsets", () => {
    const limit = 384 * 1024 * 1024;
    const view = new DataView(buildExtendedLimitInformation(limit).buffer);
    // Both, not just the first: a plugin that spawns grandchildren would otherwise multiply its
    // allowance by the number of processes it can start.
    expect(view.getBigUint64(112, true)).toBe(BigInt(limit));
    expect(view.getBigUint64(120, true)).toBe(BigInt(limit));
  });

  test("leaves every other field zeroed, so no unasked-for limit rides along", () => {
    const bytes = buildExtendedLimitInformation(1024);
    for (let offset = 0; offset < bytes.length; offset++) {
      const inFlags = offset >= 16 && offset < 20;
      const inLimits = offset >= 112 && offset < 128;
      if (inFlags || inLimits) continue;
      expect(bytes[offset]).toBe(0);
    }
  });
});

describe("assignMemoryCap", () => {
  test("declines without complaint on a platform that has no job objects", () => {
    expect(assignMemoryCap(1234, 1024 * 1024, "linux")).toBeNull();
    expect(assignMemoryCap(1234, 1024 * 1024, "darwin")).toBeNull();
  });

  test("declines a missing pid or an absent limit rather than guessing", () => {
    expect(assignMemoryCap(null, 1024 * 1024, "win32")).toBeNull();
    expect(assignMemoryCap(0, 1024 * 1024, "win32")).toBeNull();
    expect(assignMemoryCap(1234, 0, "win32")).toBeNull();
    expect(assignMemoryCap(1234, Number.NaN, "win32")).toBeNull();
  });

  test.skipIf(!onWindows)("is non-fatal for a pid that does not exist", () => {
    // A plugin that died between `Bun.spawn` returning and the assignment is an ordinary race, and
    // the answer is `null` rather than a throw that would take the spawn path down with it.
    expect(assignMemoryCap(0x7fff_fffe, 64 * 1024 * 1024)).toBeNull();
  });

  test.skipIf(!onWindows)(
    "makes the OS refuse the allocation, where an uncapped child sails past it",
    async () => {
      const cap = 128 * 1024 * 1024;
      // Allocates well past the cap in visible steps. `Bun.sleepSync` keeps the steps distinct so a
      // pass cannot come from the process simply not getting far enough.
      const code = `
        const held = [];
        for (let i = 0; i < 24; i++) {
          held.push(new Uint8Array(32 * 1024 * 1024).fill(i));
          Bun.sleepSync(5);
        }
        console.error("SURVIVED");
      `;

      const run = async (capped: boolean) => {
        const child = Bun.spawn([process.execPath, "-e", code], {
          stdout: "ignore",
          stderr: "pipe",
        });
        const job = capped ? assignMemoryCap(child.pid, cap) : null;
        const stderr = await new Response(child.stderr).text();
        await child.exited;
        job?.close();
        return { code: child.exitCode, stderr, job };
      };

      const capped = await run(true);
      expect(capped.job).not.toBeNull();
      expect(capped.stderr).not.toContain("SURVIVED");
      // JSC reports the refused allocation as an ordinary out-of-memory and the process dies on its
      // own, which is why this surfaces through the transport as a crash rather than as a kill.
      expect(capped.stderr).toContain("Out of memory");
      expect(capped.code).not.toBe(0);

      const uncapped = await run(false);
      expect(uncapped.stderr).toContain("SURVIVED");
      expect(uncapped.code).toBe(0);
    },
    30_000,
  );

  test.skipIf(!onWindows)(
    "kills what is still inside the job when the handle closes",
    async () => {
      // KILL_ON_JOB_CLOSE is the anti-orphan clause: a daemon that dies must not leave plugin
      // processes running on the user's machine. Closing the handle is the closest reachable
      // stand-in for the daemon's own handles being closed by the OS.
      const child = Bun.spawn([process.execPath, "-e", "Bun.sleepSync(60000)"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const job = assignMemoryCap(child.pid, 128 * 1024 * 1024);
      expect(job).not.toBeNull();

      const began = Date.now();
      job?.close();
      // Closing twice must not throw: the transport closes on exit and nothing guarantees it is
      // the only caller forever.
      job?.close();
      await child.exited;
      expect(Date.now() - began).toBeLessThan(10_000);
    },
    30_000,
  );
});
