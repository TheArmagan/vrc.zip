/**
 * `ProcessTransport` — one plugin, one OS process, newline-delimited JSON over its stdio.
 *
 * Implements {@link PluginTransport} exactly as `transport.ts` describes it and knows nothing about
 * what a frame means: it moves envelopes, reports what the peer did wrong, and reports liveness.
 * Every judgement about *behaviour* — a missed heartbeat, a restart, a crash loop — belongs to the
 * supervisor.
 *
 * ## Locating the runtime to spawn
 *
 * PLAN.md's `--smol` argument rests on vrc.zip shipping its own `bun`, so this is an ordinary spawn
 * flag rather than a `process.execPath` re-invocation trick. But the packaged build is a **single
 * compiled `.exe`** (PROGRESS.md decisions 91-94), and that changes what "our bun" means at spawn
 * time, because a compiled Bun binary runs its own embedded entrypoint and ignores any script argv
 * it is handed. Re-invoking `process.execPath` there would start a second daemon, not a plugin host.
 *
 * PROGRESS.md decision 111 settles it: the plugin runtime is a real `bun`, fetched from `bun.sh` on
 * first plugin install, hash-pinned, and written to `<state>/runtime/bun-<version>/`. So
 * {@link resolvePluginRuntime} looks in exactly two places, in this order:
 *
 *  1. **`<state>/runtime/bun-<Bun.version>/bun[.exe]`** — the fetched, pinned runtime. `Bun.version`
 *     is the right key in both worlds: from source it is the developer's pinned Bun, and inside the
 *     compiled exe it is the Bun the exe was compiled with, which is by construction the version the
 *     installer fetched.
 *  2. **`process.execPath`, but only when this process is not packaged** — from a source checkout
 *     the daemon is already running under a real `bun`, which is the same binary the fetch would
 *     produce, so a developer never has to download anything to run a plugin.
 *
 * **The honest gap:** inside the compiled `.exe`, if step 1 misses there is no fallback and this
 * returns a failure naming what is absent. That is deliberate rather than papered over — decision
 * 111 is explicit that a runtime which is not the pinned one must never be silently substituted, and
 * a `PATH` bun is exactly the substitution it forbids.
 *
 * **TODO(packaging): the installer step that decision 111 describes does not exist yet.** What it
 * owes this file is precisely: the pinned SHA-256 of the release asset (a fourth home for the Bun
 * pin, alongside `packageManager`, `engines.bun` and `.bun-version`), the download-verify-extract
 * into `<state>/runtime/bun-<version>/` at `0700` via a temp path and an atomic rename, and a
 * user-facing error naming the URL and the expected hash when the network is unavailable. Until it
 * lands, plugins run from a source checkout and not from a packaged build, and
 * {@link resolvePluginRuntime} says so in words rather than failing at `Bun.spawn`.
 *
 * ## Why stdin EOF is the graceful stop
 *
 * There is no portable "please exit" signal. On Windows every signal Bun accepts is a terminate, so
 * a SIGTERM would make `graceMs` a fiction on the primary platform. Closing stdin means the same
 * thing everywhere, the prelude's read loop ends, and the process exits 0 on its own.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Envelope } from "@vrcz/plugin-api";
import { decodeEnvelope, encodeEnvelope, MAX_FRAME_BYTES } from "@vrcz/plugin-api";
import { pluginDataDir, stateDir } from "../paths.ts";
import { isPackaged } from "../servers/embedded-ui.ts";
import { assignMemoryCap, type JobHandle } from "./job-object.ts";
import { planMemoryCap, warnIfUncapped } from "./limits.ts";
import { encodePreludeConfig, PRELUDE_SOURCE } from "./prelude.ts";
import type {
  ExitInfo,
  ExitReason,
  PluginTransport,
  TransportFactory,
  TransportHandlers,
  TransportSpawnOptions,
} from "./transport.ts";

// ---------------------------------------------------------------------------------------------
// Limits. Each one is the only thing between a hostile plugin and an unbounded cost to the host.
// ---------------------------------------------------------------------------------------------

/**
 * Longest log line the host will keep, in UTF-8 bytes.
 *
 * 2 KiB, and applied to the **incoming byte stream** rather than to an assembled string: a plugin
 * printing a megabyte with no newline gets truncated as the bytes arrive, so nothing accumulates.
 * The size is chosen to fit a stack frame and a message, which is what a log line is actually for;
 * a plugin that needs to emit more than that is emitting data, and data belongs on the wire.
 */
export const MAX_LOG_LINE_BYTES = 2048;

/**
 * Log lines a plugin may emit in a burst before the host starts dropping them.
 *
 * A token bucket rather than a flat cap, because the shape of legitimate logging is bursty — a
 * plugin activating prints a paragraph and then nothing for an hour. 200 covers a start-up burst
 * with room to spare.
 */
export const LOG_BURST_LINES = 200;

/**
 * Sustained log lines per second once the burst is spent.
 *
 * 20/s is more than a human reads and far less than a `for (;;) console.log()` produces, which is
 * the loop this exists to survive. Suppression is announced once and the total is reported when it
 * ends, so a dropped log is visible rather than silent.
 */
export const LOG_REFILL_PER_SECOND = 20;

/**
 * How long `stop()` waits after `kill()` before resolving anyway.
 *
 * `stop()` is contractually obliged to resolve, because PLAN.md promises the user that disabling a
 * plugin is instant and always succeeds. A `SIGKILL`ed process is gone on every OS this runs on, so
 * this backstop should never fire; it exists so that "should never" is not load-bearing.
 */
const KILL_BACKSTOP_MS = 2000;

/**
 * How long the output streams have to drain after the process is gone.
 *
 * The exit is reported after the streams close, because a plugin's last words are usually on stderr
 * immediately before it dies and reporting the crash without them makes it undiagnosable. The
 * deadline exists because that ordering can otherwise be held hostage: a plugin that spawned a
 * grandchild handed it these pipe ends, and the grandchild can outlive it.
 */
const DRAIN_DEADLINE_MS = 1000;

/** Name of the runtime directory under the state tree. See PROGRESS.md decision 111. */
export const PLUGIN_RUNTIME_DIR = "runtime";

// ---------------------------------------------------------------------------------------------
// Runtime resolution
// ---------------------------------------------------------------------------------------------

export type RuntimeResolution =
  | {
      readonly ok: true;
      readonly path: string;
      /** `pinned` is the fetched runtime; `host` is the `bun` this daemon is itself running under. */
      readonly source: "pinned" | "host";
    }
  | { readonly ok: false; readonly detail: string };

/** Where the fetched runtime is expected to live. Exported so the future installer agrees with it. */
export function pluginRuntimePath(env?: NodeJS.ProcessEnv, version: string = Bun.version): string {
  const binary = process.platform === "win32" ? "bun.exe" : "bun";
  return join(stateDir(env), PLUGIN_RUNTIME_DIR, `bun-${version}`, binary);
}

/** See the file header for the two candidates and why there is deliberately no third. */
export function resolvePluginRuntime(env?: NodeJS.ProcessEnv): RuntimeResolution {
  const pinned = pluginRuntimePath(env);
  // A synchronous existence check on one path at spawn time. Cheap next to a process launch, and
  // caching it would mean a runtime installed while the daemon runs stays invisible until restart.
  if (Bun.file(pinned).size > 0) return { ok: true, path: pinned, source: "pinned" };

  if (!isPackaged()) return { ok: true, path: process.execPath, source: "host" };

  return {
    ok: false,
    detail: `The plugin runtime is not installed. Expected a pinned Bun ${Bun.version} at ${pinned}.`,
  };
}

// ---------------------------------------------------------------------------------------------
// The child's environment
// ---------------------------------------------------------------------------------------------

/**
 * Variables Bun synthesises on Windows that are pure disclosure, blanked rather than inherited.
 *
 * Measured, not assumed: spawning with `env: {}` on Windows 11 / Bun 1.4.0 delivers eleven
 * variables to the child — `PATH`, `SYSTEMROOT`, `WINDIR`, `SYSTEMDRIVE`, `TEMP`, `HOMEDRIVE`,
 * `HOMEPATH`, `LOGONSERVER`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`. **An explicit `env` does not
 * replace that set, it merges into it**, so the only way to get rid of one is to hand it a value of
 * your own. An empty string is that value: the variable still exists, and says nothing.
 *
 * None of these carried a secret — `VRCZIP_STATE_DIR`, the daemon's session token and the
 * developer's shell were all absent — but each of them tells a plugin something about the person
 * running it that a plugin has no claim on: their account name, their home directory, their domain
 * controller, and in `PATH` an inventory of every tool installed on the machine. `PATH` is also the
 * one with teeth: blank, a plugin that tries `Bun.spawn(["git", …])` resolves nothing.
 */
const WINDOWS_BLANKED_VARS = [
  "PATH",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
] as const;

/**
 * The environment a plugin process is started with.
 *
 * Empty everywhere except Windows, where empty is not achievable and the next best thing is an
 * explicit minimum. What survives, and why each one earns it:
 *
 * - **`SystemRoot` and `windir`** — mandatory. The Windows loader resolves system DLLs, and CNG
 *   resolves its crypto configuration, relative to them. A `bun` started without them does not get
 *   far enough to run a script.
 * - **`SystemDrive`** — `"C:"` on essentially every machine and consulted by parts of the CRT when
 *   a path has no drive letter. It discloses nothing.
 * - **`TEMP` and `TMP`** — anything that writes a temporary file needs them, and with no value the
 *   CRT falls back to the current directory in some paths and fails in others. They are pointed at
 *   the plugin's **own data directory** rather than the user's temp folder: the plugin is already
 *   running with that directory as its cwd, so it learns nothing new, its temp files stay inside
 *   the one place it is entitled to write, and the user's profile path is not spelled out for it.
 *
 * Everything in {@link WINDOWS_BLANKED_VARS} is present-but-empty for the reason given there.
 * Exported so the set can be asserted from a test on any platform.
 */
export function pluginProcessEnv(
  tempDir: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  // Elsewhere `{}` is honest: POSIX `execve` takes the environment block it is given, so the child
  // really does start with nothing. Adding blanked variables there would be adding variables.
  if (platform !== "win32") return {};

  const env: Record<string, string> = {
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    SystemDrive: "C:",
    TEMP: tempDir,
    TMP: tempDir,
  };
  // The real `SystemRoot` when it is somewhere other than `C:\Windows`, which is rare and legal.
  // Read from the daemon's own environment because the daemon is itself a Windows process that
  // could not have started without it; nothing else about the daemon's environment is consulted.
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (systemRoot !== undefined && systemRoot.length > 0) {
    env.SystemRoot = systemRoot;
    env.windir = systemRoot;
  }
  for (const name of WINDOWS_BLANKED_VARS) env[name] = "";
  return env;
}

// ---------------------------------------------------------------------------------------------
// Line framing
// ---------------------------------------------------------------------------------------------

/**
 * Splits a byte stream into newline-delimited lines under a hard byte cap.
 *
 * The cap is enforced **while the bytes arrive**, not on an assembled string, which is the whole
 * point: a peer that never sends a newline must not be able to make the host allocate. Over the cap
 * the held bytes are dropped, the overflow is reported once, and everything up to the next newline
 * is discarded — so the stream resynchronises on the following frame instead of the connection
 * dying over one bad line.
 *
 * Exported for its test, which asserts {@link buffered} is zero after megabytes of newline-free
 * input. That assertion is the one that actually proves the property; a behavioural test can only
 * show the error was reported.
 */
export class LineSplitter {
  readonly #maxBytes: number;
  readonly #onLine: (line: string) => void;
  readonly #onOverflow: (droppedBytes: number) => void;
  #parts: Uint8Array[] = [];
  #pending = 0;
  #dropped = 0;
  #skipping = false;

  constructor(
    maxBytes: number,
    onLine: (line: string) => void,
    onOverflow: (droppedBytes: number) => void,
  ) {
    this.#maxBytes = maxBytes;
    this.#onLine = onLine;
    this.#onOverflow = onOverflow;
  }

  /** Bytes held for the line currently being assembled. Never exceeds the cap. */
  get buffered(): number {
    return this.#pending;
  }

  push(chunk: Uint8Array): void {
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        if (start < chunk.length) this.#append(chunk.subarray(start));
        return;
      }
      this.#append(chunk.subarray(start, newline));
      this.#flush();
      start = newline + 1;
    }
  }

  /** Emits a trailing line with no newline. Called once at end of stream. */
  end(): void {
    this.#flush();
  }

  #append(part: Uint8Array): void {
    if (this.#skipping) {
      this.#dropped += part.length;
      return;
    }
    if (this.#pending + part.length > this.#maxBytes) {
      this.#dropped = this.#pending + part.length;
      this.#parts = [];
      this.#pending = 0;
      this.#skipping = true;
      return;
    }
    this.#parts.push(part);
    this.#pending += part.length;
  }

  #flush(): void {
    if (this.#skipping) {
      const dropped = this.#dropped;
      this.#skipping = false;
      this.#dropped = 0;
      this.#onOverflow(dropped);
      return;
    }
    if (this.#pending === 0) return;
    const joined = new Uint8Array(this.#pending);
    let at = 0;
    for (const part of this.#parts) {
      joined.set(part, at);
      at += part.length;
    }
    this.#parts = [];
    this.#pending = 0;
    let text = new TextDecoder().decode(joined);
    // Nothing the host writes ends in CR, but a plugin shelling out on Windows might.
    if (text.endsWith("\r")) text = text.slice(0, -1);
    this.#onLine(text);
  }
}

// ---------------------------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------------------------

/** Injection points. Every one of them has a real non-test caller in view; none is test-only. */
export interface ProcessTransportDeps {
  /**
   * Environment used to locate the state tree. Not the child's environment, which is always empty.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * An explicit runtime path, bypassing {@link resolvePluginRuntime}.
   *
   * Decision 111 promises a manual "use this `bun` instead" path for users the download cannot
   * reach; this is where it arrives.
   */
  readonly runtimePath?: string;
  /**
   * Replacement prelude source.
   *
   * Exists for tests that need a peer which behaves in ways the real prelude never would (never
   * sending `hello`, sending a host-only tag), and for a future dev prelude with extra tracing.
   */
  readonly preludeSource?: string;
}

class ProcessTransport implements PluginTransport {
  readonly pluginId: string;
  readonly pid: number | null;

  readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #handlers: TransportHandlers;
  /**
   * The Windows job object holding this process, or `null` on every other platform and whenever
   * one could not be installed. Released in {@link #finalizeIfDone} — never sooner, because
   * `KILL_ON_JOB_CLOSE` means releasing it *is* a kill.
   */
  #job: JobHandle | null;
  readonly #settled: Promise<ExitInfo>;
  #resolveSettled!: (info: ExitInfo) => void;

  #running = true;
  #exitInfo: ExitInfo | null = null;
  #intent: ExitReason | null = null;
  #intentDetail = "";
  #helloSeen = false;
  #helloTimer: ReturnType<typeof setTimeout> | null = null;
  #openStreams = 2;

  #logTokens = LOG_BURST_LINES;
  #logRefilledAt = Date.now();
  #logSuppressed = 0;
  #logSuppressionAnnounced = false;

  constructor(
    child: Bun.Subprocess<"pipe", "pipe", "pipe">,
    options: TransportSpawnOptions,
    handlers: TransportHandlers,
    job: JobHandle | null = null,
  ) {
    this.pluginId = options.pluginId;
    this.pid = child.pid;
    this.#child = child;
    this.#handlers = handlers;
    this.#job = job;
    this.#settled = new Promise<ExitInfo>((resolve) => {
      this.#resolveSettled = resolve;
    });

    this.#helloTimer = setTimeout(() => {
      this.#helloTimer = null;
      if (this.#helloSeen || !this.#running) return;
      // Dead on arrival is a different failure from stopped answering, and telling a user the
      // second when it was the first sends them looking in the wrong place.
      this.#note(
        "spawn-failed",
        `The plugin did not start within ${String(options.helloTimeoutMs)}ms.`,
      );
      this.kill();
    }, options.helloTimeoutMs);

    void this.#pumpStdout();
    void this.#pumpStderr();
    void this.#awaitExit();
  }

  get running(): boolean {
    return this.#running;
  }

  send(frame: Envelope): boolean {
    if (!this.#running) return false;
    const encoded = encodeEnvelope(frame);
    if (!encoded.ok) return false;
    try {
      this.#child.stdin.write(`${encoded.value}\n`);
      // The return value is a promise on backpressure. Awaiting it is not available here — `send`
      // is synchronous by contract, because every caller is mid-decision — so the write is left to
      // drain. A peer that never drains is a peer the supervisor's heartbeat is already killing.
      void this.#child.stdin.flush();
      return true;
    } catch {
      return false;
    }
  }

  async stop(graceMs: number): Promise<ExitInfo> {
    if (this.#exitInfo !== null) return this.#exitInfo;
    this.#note("shutdown", "The plugin stopped when it was asked to.");

    try {
      // The graceful ask: closing stdin ends the prelude's read loop, which exits 0. See the header
      // for why this rather than a signal.
      void this.#child.stdin.end();
    } catch {
      // Already closed. The kill path below covers it.
    }

    const graceful = await raceWithTimeout(this.#settled, Math.max(0, graceMs));
    if (graceful !== null) return graceful;

    this.#note(
      "shutdown",
      `The plugin did not stop within ${String(graceMs)}ms and was closed.`,
      true,
    );
    this.kill();
    const forced = await raceWithTimeout(this.#settled, KILL_BACKSTOP_MS);
    if (forced !== null) return forced;

    // Unreachable on any OS that honours SIGKILL. Reported rather than awaited, because a `stop`
    // that hangs would defeat the one control the user is promised always works. `onExit` is not
    // fired from here: if the process ever does die, the real exit still reports itself once.
    return {
      reason: "killed",
      code: null,
      signal: null,
      detail: "The plugin process did not exit after it was killed.",
    };
  }

  kill(): void {
    this.#note("killed", "The plugin was stopped by the host.");
    try {
      this.#child.kill(9);
    } catch {
      // Already gone, which is the outcome we wanted either way.
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /** First intent wins unless `override`, so a `stop` that escalates stays a shutdown. */
  #note(reason: ExitReason, detail: string, override = false): void {
    if (this.#intent !== null && !override) return;
    this.#intent = reason;
    this.#intentDetail = detail;
  }

  /** A handler that throws is the supervisor's bug, and it must not take the reader down with it. */
  #safely(what: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      console.error(`plugins: a ${what} handler for ${this.pluginId} threw:`, error);
    }
  }

  async #pumpStdout(): Promise<void> {
    const splitter = new LineSplitter(
      MAX_FRAME_BYTES,
      (line) => {
        this.#onStdoutLine(line);
      },
      (dropped) => {
        this.#safely("protocol error", () => {
          this.#handlers.onProtocolError(
            `A stdout line exceeded ${String(MAX_FRAME_BYTES)} bytes and ${String(dropped)} bytes were discarded.`,
          );
        });
      },
    );
    await pump(this.#child.stdout, (chunk) => {
      splitter.push(chunk);
    });
    splitter.end();
    this.#streamClosed();
  }

  async #pumpStderr(): Promise<void> {
    const splitter = new LineSplitter(
      MAX_LOG_LINE_BYTES,
      (line) => {
        this.#log("stderr", line);
      },
      (dropped) => {
        this.#log("stderr", `[a log line over ${String(dropped)} bytes was truncated]`);
      },
    );
    await pump(this.#child.stderr, (chunk) => {
      splitter.push(chunk);
    });
    splitter.end();
    this.#streamClosed();
  }

  #onStdoutLine(line: string): void {
    const text = line.trim();
    if (text.length === 0) return;

    // A frame is always a JSON object. Anything else on stdout is a plugin that reached fd 1
    // around the prelude's redirect, and it is a log rather than a protocol violation. A line that
    // *does* look like a frame and is not one is evidence about the peer, so it is reported.
    if (!text.startsWith("{")) {
      this.#log("stdout", text);
      return;
    }

    const decoded = decodeEnvelope(text, { from: "plugin" });
    if (!decoded.ok) {
      this.#safely("protocol error", () => {
        this.#handlers.onProtocolError(`${decoded.code}: ${decoded.message}`);
      });
      return;
    }
    if (decoded.value.t === "hello") {
      this.#helloSeen = true;
      if (this.#helloTimer !== null) {
        clearTimeout(this.#helloTimer);
        this.#helloTimer = null;
      }
    }
    this.#safely("frame", () => {
      this.#handlers.onFrame(decoded.value);
    });
  }

  /** Token bucket over both streams together: a plugin cannot buy budget by switching stream. */
  #log(stream: "stdout" | "stderr", line: string): void {
    const now = Date.now();
    const elapsed = now - this.#logRefilledAt;
    if (elapsed > 0) {
      this.#logTokens = Math.min(
        LOG_BURST_LINES,
        this.#logTokens + (elapsed * LOG_REFILL_PER_SECOND) / 1000,
      );
      this.#logRefilledAt = now;
    }

    if (this.#logTokens < 1) {
      this.#logSuppressed += 1;
      if (!this.#logSuppressionAnnounced) {
        this.#logSuppressionAnnounced = true;
        this.#emitLog(stream, "[logging too fast, further lines are being dropped]");
      }
      return;
    }
    this.#logTokens -= 1;

    if (this.#logSuppressed > 0) {
      const suppressed = this.#logSuppressed;
      this.#logSuppressed = 0;
      this.#logSuppressionAnnounced = false;
      this.#emitLog(stream, `[${String(suppressed)} log lines were dropped]`);
    }
    this.#emitLog(stream, line);
  }

  #emitLog(stream: "stdout" | "stderr", line: string): void {
    this.#safely("log", () => {
      this.#handlers.onLog(stream, line);
    });
  }

  #streamClosed(): void {
    this.#openStreams -= 1;
    this.#finalizeIfDone();
  }

  async #awaitExit(): Promise<void> {
    try {
      await this.#child.exited;
    } catch {
      // Bun does not reject this, but a transport that assumed so would be a transport that hangs.
    }
    this.#running = false;
    this.#finalizeIfDone();
    if (this.#exitInfo !== null) return;

    // The streams are still open after the process is gone. Normally that is microseconds of
    // draining, but a plugin that spawned a grandchild handed it these pipe ends, and the
    // grandchild can hold them open indefinitely. Waiting forever would mean `onExit` never fires
    // for a plugin that is provably dead, so the drain gets a deadline and the exit is reported
    // without it.
    const drainDeadline = setTimeout(() => {
      this.#openStreams = 0;
      this.#finalizeIfDone();
    }, DRAIN_DEADLINE_MS);
    void this.#settled.then(() => {
      clearTimeout(drainDeadline);
    });
  }

  /**
   * Reports the exit once, and only after both output streams have drained.
   *
   * Ordering matters: a plugin's last words are usually on stderr immediately before it dies, and a
   * transport that reported the exit first would deliver the crash and drop the reason for it.
   */
  #finalizeIfDone(): void {
    if (this.#exitInfo !== null || this.#running || this.#openStreams > 0) return;

    if (this.#helloTimer !== null) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }

    // Safe here and nowhere earlier: the process is gone, so `KILL_ON_JOB_CLOSE` has nothing left
    // to kill and this is purely a handle release. Holding it past this point would leak one kernel
    // handle per plugin restart, which a crash loop turns into a real number.
    this.#job?.close();
    this.#job = null;

    const code = this.#child.exitCode;
    const signal = this.#child.signalCode;
    const reason: ExitReason = this.#intent ?? "crashed";
    const detail =
      this.#intent !== null
        ? this.#intentDetail
        : signal !== null
          ? `The plugin stopped unexpectedly (${signal}).`
          : code === 0
            ? "The plugin exited on its own."
            : `The plugin stopped unexpectedly (exit code ${String(code ?? "unknown")}).`;

    const info: ExitInfo = { reason, code, signal, detail };
    this.#exitInfo = info;
    this.#resolveSettled(info);
    this.#safely("exit", () => {
      this.#handlers.onExit(info);
    });
  }
}

/**
 * A transport for a plugin that never started.
 *
 * Returned instead of throwing, so a supervisor has one shape to handle rather than two. `onExit`
 * fires on a timer rather than synchronously: the caller is still inside `await factory(...)` when
 * this is constructed, and a handler called before it holds the transport cannot act on it.
 */
class StillbornTransport implements PluginTransport {
  readonly pluginId: string;
  readonly pid = null;
  readonly running = false;
  readonly #info: ExitInfo;

  constructor(pluginId: string, detail: string, handlers: TransportHandlers) {
    this.pluginId = pluginId;
    this.#info = { reason: "spawn-failed", code: null, signal: null, detail };
    setTimeout(() => {
      try {
        handlers.onExit(this.#info);
      } catch (error) {
        console.error(`plugins: an exit handler for ${pluginId} threw:`, error);
      }
    }, 0);
  }

  send(): boolean {
    return false;
  }

  stop(): Promise<ExitInfo> {
    return Promise.resolve(this.#info);
  }

  kill(): void {
    // Nothing was ever started.
  }
}

/**
 * Builds a {@link TransportFactory} that spawns real processes.
 *
 * A factory-of-a-factory because the supervisor's `TransportFactory` signature is fixed and knows
 * nothing about state directories or runtime paths, which is exactly right: those are composition
 * concerns and belong to `app.ts`.
 */
export function makeProcessTransportFactory(deps: ProcessTransportDeps = {}): TransportFactory {
  return (options, handlers) => Promise.resolve(spawnTransport(deps, options, handlers));
}

/** The default factory. Resolves the runtime from the real state tree. */
export const createProcessTransport: TransportFactory = makeProcessTransportFactory();

function spawnTransport(
  deps: ProcessTransportDeps,
  options: TransportSpawnOptions,
  handlers: TransportHandlers,
): PluginTransport {
  let runtimePath = deps.runtimePath;
  if (runtimePath === undefined) {
    const resolved = resolvePluginRuntime(deps.env);
    if (!resolved.ok) return new StillbornTransport(options.pluginId, resolved.detail, handlers);
    runtimePath = resolved.path;
  }

  const config = encodePreludeConfig({
    pluginId: options.pluginId,
    bundleUrl: pathToFileURL(options.bundlePath).href,
  });

  // `--smol` selects JSC's small-heap configuration. It is a hint and not a limit: it caps nothing,
  // and the RSS watchdog plus the OS caps in `limits.ts` are still what stop a runaway.
  const argv = [
    runtimePath,
    ...(options.smol ? ["--smol"] : []),
    "-e",
    deps.preludeSource ?? PRELUDE_SOURCE,
    config,
  ];

  const plan = planMemoryCap(argv, options.memoryLimitBytes);

  // The plugin's own data directory is its working directory, so a plugin that reaches the
  // filesystem around the scrub writes relative paths into the one place it is entitled to.
  const cwd = pluginDataDir(options.pluginId, deps.env);
  try {
    mkdirSync(cwd, { recursive: true });
  } catch {
    // A plugin can run without it; the spawn below will say so if it cannot.
  }

  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([...plan.argv], {
      // Nothing the daemon holds is inherited: not VRCZIP_STATE_DIR and therefore not the location
      // of the credential store, not a keychain or token variable, not proxy credentials, not the
      // developer's shell. See `pluginProcessEnv` for what Windows insists on keeping and why.
      env: pluginProcessEnv(cwd),
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return new StillbornTransport(
      options.pluginId,
      `The plugin process could not be started: ${error instanceof Error ? error.message : String(error)}`,
      handlers,
    );
  }

  // The Windows cap is installed *after* the spawn, because a job object needs a pid. That is a
  // window — microseconds during which the child is uncapped — and it is unavoidable without a
  // spawn API that takes a job. It is also uninteresting: a plugin cannot allocate meaningfully
  // before its runtime has finished starting.
  let job: JobHandle | null = null;
  if (plan.mechanism === "job-object") {
    job = assignMemoryCap(child.pid, options.memoryLimitBytes);
  }
  // `enforced` is a fact, not an intention, so a job object that failed to install reports as the
  // uncapped state it actually is and gets the same one-per-process warning every other platform
  // without a cap gets.
  warnIfUncapped(job === null ? { ...plan, enforced: false } : { ...plan, enforced: true });

  return new ProcessTransport(child, options, handlers, job);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

async function pump(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) return;
      if (step.value.length > 0) onChunk(step.value);
    }
  } catch {
    // The pipe broke, which is what a process exiting looks like from here.
  } finally {
    reader.releaseLock();
  }
}

/** Resolves the promise's value, or `null` on timeout. Always clears its timer. */
function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
