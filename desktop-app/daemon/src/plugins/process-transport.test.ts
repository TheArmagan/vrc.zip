import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@vrcz/plugin-api";
import { deadlineIn, MAX_FRAME_BYTES, PLUGIN_API_PROTOCOL_MAJOR } from "@vrcz/plugin-api";
import {
  LineSplitter,
  MAX_LOG_LINE_BYTES,
  makeProcessTransportFactory,
  pluginProcessEnv,
  pluginRuntimePath,
  resolvePluginRuntime,
} from "./process-transport.ts";
import type { ExitInfo, PluginTransport, TransportSpawnOptions } from "./transport.ts";

/**
 * These spawn real processes. That is the point: the failures this file is looking for are at the
 * process boundary — a frame split across two chunk reads, stderr still draining when the process
 * exits, what a kill actually does on Windows — and a fake child hides every one of them.
 */

const FIXTURES = join(import.meta.dir, "__fixtures__");

let stateRoot: string;

beforeAll(() => {
  // Never the real state tree: the transport creates the plugin's data directory as its cwd.
  stateRoot = mkdtempSync(join(tmpdir(), "vrczip-transport-"));
});

afterAll(() => {
  try {
    rmSync(stateRoot, { recursive: true, force: true });
  } catch {
    // Best effort. Windows locks a directory that is any live process's cwd, and a plugin killed
    // microseconds ago may not have been reaped yet. Leaving a temp directory behind is not a test
    // failure; failing the whole file over it would be.
  }
});

function options(overrides: Partial<TransportSpawnOptions> = {}): TransportSpawnOptions {
  return {
    pluginId: "test.plugin",
    bundlePath: join(FIXTURES, "plugin-echo.js"),
    smol: true,
    memoryLimitBytes: 256 * 1024 * 1024,
    helloTimeoutMs: 5000,
    ...overrides,
  };
}

interface Started {
  readonly transport: PluginTransport;
  readonly frames: Envelope[];
  readonly errors: string[];
  readonly logs: { stream: "stdout" | "stderr"; line: string }[];
  readonly exits: ExitInfo[];
  readonly exited: Promise<ExitInfo>;
}

async function start(
  spawnOptions: Partial<TransportSpawnOptions> = {},
  preludeFixture?: string,
): Promise<Started> {
  const frames: Envelope[] = [];
  const errors: string[] = [];
  const logs: { stream: "stdout" | "stderr"; line: string }[] = [];
  const exits: ExitInfo[] = [];
  let resolveExit: (info: ExitInfo) => void = () => undefined;
  const exited = new Promise<ExitInfo>((resolve) => {
    resolveExit = resolve;
  });

  const preludeSource =
    preludeFixture === undefined
      ? undefined
      : await Bun.file(join(FIXTURES, preludeFixture)).text();

  const factory = makeProcessTransportFactory({
    env: { VRCZIP_STATE_DIR: stateRoot },
    ...(preludeSource === undefined ? {} : { preludeSource }),
  });

  const transport = await factory(options(spawnOptions), {
    onFrame: (frame) => {
      frames.push(frame);
    },
    onProtocolError: (detail) => {
      errors.push(detail);
    },
    onLog: (stream, line) => {
      logs.push({ stream, line });
    },
    onExit: (info) => {
      exits.push(info);
      resolveExit(info);
    },
  });

  return { transport, frames, errors, logs, exits, exited };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await Bun.sleep(10);
  }
}

// -----------------------------------------------------------------------------------------------
// Runtime resolution
// -----------------------------------------------------------------------------------------------

describe("runtime resolution", () => {
  test("falls back to the bun this daemon is running under, from a source checkout", () => {
    const resolved = resolvePluginRuntime({ VRCZIP_STATE_DIR: stateRoot });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source).toBe("host");
    expect(resolved.path).toBe(process.execPath);
  });

  test("expects the pinned runtime under the state tree, keyed on the Bun version", () => {
    const path = pluginRuntimePath({ VRCZIP_STATE_DIR: stateRoot });
    expect(path.startsWith(stateRoot)).toBe(true);
    expect(path).toContain(`bun-${Bun.version}`);
  });
});

// -----------------------------------------------------------------------------------------------
// The child's environment
// -----------------------------------------------------------------------------------------------

describe("the child's environment", () => {
  test("is genuinely empty away from Windows, where an empty block is honoured", () => {
    expect(pluginProcessEnv("/tmp/plugin", "linux")).toEqual({});
    expect(pluginProcessEnv("/tmp/plugin", "darwin")).toEqual({});
  });

  test("keeps only the Windows minimum, and blanks what Bun insists on adding", () => {
    const env = pluginProcessEnv("C:\\data\\plugin", "win32");
    expect(env.TEMP).toBe("C:\\data\\plugin");
    expect(env.TMP).toBe("C:\\data\\plugin");
    expect(env.SystemRoot?.length).toBeGreaterThan(0);
    expect(env.windir).toBe(env.SystemRoot);
    // Present, so they override Bun's synthesised values, and empty, so they say nothing. Absent
    // would mean inherited — the merge is the whole reason this function exists.
    for (const name of ["PATH", "USERNAME", "USERPROFILE", "HOMEPATH", "LOGONSERVER"]) {
      expect(env[name]).toBe("");
    }
  });

  test.skipIf(process.platform !== "win32")(
    "leaks nothing about the user or the daemon to a real child process",
    async () => {
      // Asserted against a spawned process rather than against the returned object, because the
      // thing being tested is Bun's merge behaviour on Windows, not our own dictionary.
      const child = Bun.spawn(
        [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
        {
          env: pluginProcessEnv(stateRoot),
          cwd: stateRoot,
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      const seen: Record<string, string> = JSON.parse(await new Response(child.stdout).text());
      await child.exited;
      expect(child.exitCode).toBe(0);

      for (const [name, value] of Object.entries(seen)) {
        if (value.length === 0) continue;
        // Whatever is left with a value must be one of the four the header justifies, and TEMP/TMP
        // must point inside the plugin's own directory rather than at the user's profile.
        expect(["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP"]).toContain(name);
      }
      expect(seen.PATH).toBe("");
      expect(seen.USERNAME).toBe("");
      expect(seen.TEMP).toBe(stateRoot);
      expect(Object.keys(seen).some((name) => name.startsWith("VRCZIP_"))).toBe(false);
    },
    20_000,
  );
});

// -----------------------------------------------------------------------------------------------
// Framing
// -----------------------------------------------------------------------------------------------

describe("LineSplitter", () => {
  const encoder = new TextEncoder();

  test("emits complete lines and reassembles across chunk boundaries", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter(
      1024,
      (line) => lines.push(line),
      () => lines.push("<overflow>"),
    );
    splitter.push(encoder.encode('{"a":1}\n{"b'));
    splitter.push(encoder.encode('":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("holds nothing at all once a line passes the cap, and resynchronises after it", () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const splitter = new LineSplitter(
      MAX_FRAME_BYTES,
      (line) => lines.push(line),
      (dropped) => overflows.push(dropped),
    );

    const megabyte = encoder.encode("x".repeat(1024 * 1024));
    for (let i = 0; i < 8; i++) {
      splitter.push(megabyte);
      // The property that matters, asserted directly rather than inferred: eight megabytes of
      // newline-free input never cost the host more than one frame's worth of memory.
      expect(splitter.buffered).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    }
    expect(splitter.buffered).toBe(0);

    expect(overflows).toHaveLength(0);
    splitter.push(encoder.encode("\nafter\n"));
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(lines).toEqual(["after"]);
  });

  test("strips a trailing carriage return", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter(
      1024,
      (line) => lines.push(line),
      () => undefined,
    );
    splitter.push(encoder.encode("windows\r\n"));
    expect(lines).toEqual(["windows"]);
  });
});

// -----------------------------------------------------------------------------------------------
// The happy path
// -----------------------------------------------------------------------------------------------

describe("a well-behaved plugin", () => {
  test("says hello, answers a request, and stops when asked", async () => {
    const run = await start();
    expect(run.transport.running).toBe(true);
    expect(typeof run.transport.pid).toBe("number");

    await waitFor(() => run.frames.length > 0);
    const hello = run.frames[0];
    expect(hello?.t).toBe("hello");
    if (hello?.t === "hello") {
      expect(hello.pluginId).toBe("test.plugin");
      expect(hello.protocol).toBe(PLUGIN_API_PROTOCOL_MAJOR);
    }

    const sent = run.transport.send({
      t: "req",
      id: "1",
      method: "vrchat.friends.list",
      params: { n: 1 },
      deadline: deadlineIn(30_000),
    });
    expect(sent).toBe(true);

    await waitFor(() => run.frames.some((frame) => frame.t === "res"));
    const response = run.frames.find((frame) => frame.t === "res");
    expect(response).toEqual({
      t: "res",
      id: "1",
      result: { method: "vrchat.friends.list", params: { n: 1 } },
    });

    const info = await run.transport.stop(5000);
    expect(info.reason).toBe("shutdown");
    expect(info.code).toBe(0);
    expect(run.transport.running).toBe(false);
    expect(run.errors).toEqual([]);

    // Exactly once, and a send afterwards fails rather than throwing.
    await Bun.sleep(50);
    expect(run.exits).toHaveLength(1);
    expect(run.transport.send({ t: "pong", nonce: "x" })).toBe(false);
  }, 20_000);

  test("answers a heartbeat from the prelude, with an rss reading", async () => {
    const run = await start();
    await waitFor(() => run.frames.some((frame) => frame.t === "hello"));

    run.transport.send({ t: "ping", nonce: "beat-1", deadline: deadlineIn(5000) });
    await waitFor(() => run.frames.some((frame) => frame.t === "pong"));

    const pong = run.frames.find((frame) => frame.t === "pong");
    expect(pong?.t === "pong" ? pong.nonce : null).toBe("beat-1");
    expect(pong?.t === "pong" ? pong.rss : 0).toBeGreaterThan(0);

    await run.transport.stop(5000);
  }, 20_000);

  test("routes both kinds of plugin output to onLog", async () => {
    const run = await start({ bundlePath: join(FIXTURES, "plugin-noisy.js") });
    await waitFor(() => run.logs.some((entry) => entry.line.includes("straight to fd 1")));

    // console.log is redirected to stderr by the prelude, which is what keeps stdout frames-only.
    const consoleLine = run.logs.find((entry) => entry.line.includes("hello from console"));
    expect(consoleLine?.stream).toBe("stderr");

    // Reaching fd 1 around the redirect is possible, and lands as a log rather than as a frame.
    const rawLine = run.logs.find((entry) => entry.line.includes("straight to fd 1"));
    expect(rawLine?.stream).toBe("stdout");
    expect(run.errors).toEqual([]);

    await run.transport.stop(5000);
  }, 20_000);
});

// -----------------------------------------------------------------------------------------------
// Failure modes
// -----------------------------------------------------------------------------------------------

describe("a plugin that misbehaves", () => {
  test("never sending hello is a spawn failure, not a crash", async () => {
    const run = await start({ helloTimeoutMs: 300 }, "prelude-silent.js");
    const info = await run.exited;
    expect(info.reason).toBe("spawn-failed");
    expect(info.detail).toContain("300ms");
    expect(run.exits).toHaveLength(1);
  }, 20_000);

  test("a host-only frame tag is a protocol error, never a frame", async () => {
    const run = await start({}, "prelude-forbidden.js");
    await waitFor(() => run.errors.length > 0);
    expect(run.errors[0]).toContain("may not send a event frame");
    expect(run.frames.every((frame) => frame.t !== "event")).toBe(true);
    await run.transport.stop(5000);
  }, 20_000);

  test("a line over the frame cap is refused, and the stream resynchronises", async () => {
    const run = await start({}, "prelude-oversize.js");
    await waitFor(() => run.errors.length > 0);
    expect(run.errors[0]).toContain("exceeded");

    // The frame after the flood still arrives: one bad line costs the line, not the conversation.
    await waitFor(() => run.frames.some((frame) => frame.t === "credit"));
    const credit = run.frames.find((frame) => frame.t === "credit");
    expect(credit?.t === "credit" ? credit.credits : 0).toBe(7);

    await run.transport.stop(5000);
  }, 20_000);

  test("throwing at load exits non-zero and reads as a crash", async () => {
    const run = await start({ bundlePath: join(FIXTURES, "plugin-throws.js") });
    const info = await run.exited;
    expect(info.reason).toBe("crashed");
    expect(info.code).toBe(1);
    // The reason for the crash arrived before the exit was reported, which is the ordering that
    // makes a crash diagnosable at all.
    expect(run.logs.some((entry) => entry.line.includes("broken on purpose"))).toBe(true);
  }, 20_000);

  test("stop() still resolves for a plugin that ignores the request", async () => {
    const run = await start({}, "prelude-deaf.js");
    await waitFor(() => run.frames.some((frame) => frame.t === "hello"));

    const began = Date.now();
    const info = await run.transport.stop(300);
    expect(Date.now() - began).toBeLessThan(10_000);
    // Still a shutdown: the host asked it to stop and does not want it restarted. Escalating to a
    // kill changes how it ended, not why.
    expect(info.reason).toBe("shutdown");
    expect(info.detail).toContain("did not stop");
    expect(run.exits).toHaveLength(1);
  }, 20_000);

  test("kill() ends a plugin that is spinning its event loop", async () => {
    const run = await start({}, "prelude-spin.js");
    await waitFor(() => run.frames.some((frame) => frame.t === "hello"));

    run.transport.kill();
    const info = await run.exited;
    expect(info.reason).toBe("killed");
    expect(run.transport.running).toBe(false);
    expect(run.exits).toHaveLength(1);
  }, 20_000);
});

// -----------------------------------------------------------------------------------------------
// The OS memory cap
// -----------------------------------------------------------------------------------------------

describe("the OS memory cap", () => {
  test.skipIf(process.platform !== "win32")(
    "stops a memory bomb at the ceiling instead of waiting for the watchdog",
    async () => {
      // `hostile/memory-bomb-at-load.js` allocates touched pages without bound at module load,
      // before `activate` is ever called. Under a 192 MiB job object the allocation is refused, the
      // rejection lands on the prelude's own `import()`, and the process exits 1 — which is why this
      // reads as a crash rather than as a kill, and why nothing here waits on a watchdog tick.
      //
      // **The load-time half specifically.** Its sibling `memory-bomb.js` allocates from a timer
      // instead, where the same refusal is an *uncaught exception* the prelude deliberately
      // swallows, and the process does not exit at all. See `hostile/hostile.test.ts`.
      const run = await start({
        bundlePath: join(import.meta.dir, "hostile", "memory-bomb-at-load.js"),
        memoryLimitBytes: 192 * 1024 * 1024,
        helloTimeoutMs: 20_000,
      });

      const info = await run.exited;
      expect(info.reason).toBe("crashed");
      expect(info.code).not.toBe(0);
      expect(run.logs.some((entry) => /out of memory/i.test(entry.line))).toBe(true);
    },
    40_000,
  );
});

// -----------------------------------------------------------------------------------------------
// Log budget
// -----------------------------------------------------------------------------------------------

describe("log limits", () => {
  test("a log line is truncated as the bytes arrive", () => {
    const lines: string[] = [];
    const notices: number[] = [];
    const splitter = new LineSplitter(
      MAX_LOG_LINE_BYTES,
      (line) => lines.push(line),
      (dropped) => notices.push(dropped),
    );
    splitter.push(new TextEncoder().encode(`${"y".repeat(MAX_LOG_LINE_BYTES * 4)}\n`));
    expect(lines).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(splitter.buffered).toBe(0);
  });
});
