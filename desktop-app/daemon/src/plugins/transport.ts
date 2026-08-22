/**
 * `PluginTransport` — the seam between "a plugin is running somewhere" and "we can talk to it".
 *
 * PLAN.md §Phase 3 puts a child process behind this interface rather than in front of it, and the
 * reason is worth being precise about. A `Worker` is an isolation primitive, not a security one: it
 * gets its own `globalThis` but keeps `process`, `Bun`, `fetch` and full `node:*` access, and no
 * prelude can disable the `import()` operator, so `await import("node:" + "fs")` reaches the
 * database holding VRChat auth cookies. A process buys real memory caps, a `kill(9)` that always
 * wins, crash containment, and — the part that actually matters — it is the only granularity from
 * which OS-level sandboxing (AppContainer, seccomp) becomes reachable later **without changing the
 * plugin API by one character**.
 *
 * Keeping the interface anyway is not hedging. It buys three concrete things:
 *
 *  - The supervisor is testable against a fake. Heartbeat timeouts, restart backoff and crash-loop
 *    auto-disable are timing logic, and timing logic tested by spawning real processes is timing
 *    logic tested slowly and flakily.
 *  - A `WorkerTransport` stays available for development and for first-party plugins, where the
 *    isolation is not load-bearing and the faster start matters.
 *  - When OS sandboxing lands it lands here, behind an interface every caller already goes through.
 *
 * **This interface deliberately knows nothing about the protocol's meaning.** It moves `Envelope`
 * values and reports liveness; what a frame authorises is the dispatcher's business, and a
 * transport that could be persuaded to care would be a second place to get authorisation wrong.
 */

import type { Envelope } from "@vrcz/plugin-api";

/** Why a plugin process is no longer running. Drives what the supervisor does next. */
export type ExitReason =
  /** The host asked it to stop and it did. No restart. */
  | "shutdown"
  /** It exited on its own, or crashed. Restart, with backoff. */
  | "crashed"
  /** The supervisor killed it: a missed heartbeat, a blown deadline, or the RSS watchdog. */
  | "killed"
  /** It never got far enough to be a plugin — spawn failed, or the prelude died. No restart. */
  | "spawn-failed";

export interface ExitInfo {
  readonly reason: ExitReason;
  /** Process exit code, when there was a process and it had one. */
  readonly code: number | null;
  /** Signal that ended it, when one did. */
  readonly signal: string | null;
  /**
   * What to show a user, already in words rather than in errno.
   *
   * A plugin that dies is a thing the user has to make a decision about — disable it, report it,
   * ignore it — and "exit code 3221225477" is not a basis for one.
   */
  readonly detail: string;
}

/** How a transport reports what it saw. Every callback is optional to implement, none to call. */
export interface TransportHandlers {
  /**
   * One decoded, direction-checked frame from the plugin.
   *
   * A frame that failed to decode never reaches here — it is reported through {@link onProtocolError}
   * instead, because a malformed frame is evidence about the peer rather than a message from it.
   */
  readonly onFrame: (frame: Envelope) => void;
  /**
   * The peer sent something that is not a frame, or sent a frame it is not allowed to send.
   *
   * Separate from `onFrame` on purpose. The supervisor's response to a malformed frame is not to
   * process it — it is to count it, and past a threshold to stop trusting the process at all.
   */
  readonly onProtocolError: (detail: string) => void;
  /**
   * A line the plugin wrote to stdout or stderr that was not a frame.
   *
   * Plugins log, and swallowing it would make debugging one impossible. Captured rather than
   * inherited so it can be attributed, rate-limited and truncated — an unbounded `console.log` in a
   * loop is a denial of service against the host's own log.
   */
  readonly onLog: (stream: "stdout" | "stderr", line: string) => void;
  /** Fired exactly once. After it, the transport is spent and a restart means a new one. */
  readonly onExit: (info: ExitInfo) => void;
}

export interface PluginTransport {
  /** Which plugin this is carrying. Attribution for logs, metrics and the rate budget. */
  readonly pluginId: string;

  /**
   * True between a successful start and `onExit`.
   *
   * Deliberately not "is it healthy" — a spinning plugin is very much alive. Health is the
   * supervisor's judgement, built from heartbeats, and it is not something a transport can see.
   */
  readonly running: boolean;

  /**
   * The OS process id, when there is one.
   *
   * Null for a worker-backed transport, and that asymmetry is honest rather than awkward: an RSS
   * watchdog that reads `/proc` or a Job Object needs a real pid, and a transport that cannot
   * supply one cannot be policed that way. The supervisor falls back to the `rss` a pong carries.
   */
  readonly pid: number | null;

  /**
   * Sends one frame. Returns false when the frame could not be handed over — the peer is gone, or
   * the frame exceeded the wire cap — rather than throwing, because every caller is already in the
   * middle of a decision and none of them wants an exception on a send.
   */
  send(frame: Envelope): boolean;

  /**
   * Asks the process to stop, then kills it if it does not.
   *
   * `graceMs` is how long "asks" lasts. Resolves once the process is actually gone, and it must
   * always resolve: PLAN.md is explicit that disable must be instant and must always succeed, so a
   * transport that could hang here would defeat the one control the user is promised will work.
   */
  stop(graceMs: number): Promise<ExitInfo>;

  /**
   * Ends it now, with no grace period at all.
   *
   * The path the RSS watchdog and the heartbeat timeout take. Separate from `stop` because "please
   * exit" travels over the same event loop a runaway plugin is refusing to yield, so a graceful
   * stop is exactly the thing that cannot be relied on in the cases that need stopping most.
   */
  kill(): void;
}

/**
 * What a supervisor needs to make a transport. A factory rather than a constructor so the
 * supervisor never learns which kind it got.
 */
export type TransportFactory = (
  options: TransportSpawnOptions,
  handlers: TransportHandlers,
) => Promise<PluginTransport>;

export interface TransportSpawnOptions {
  readonly pluginId: string;
  /**
   * Absolute path to the content-addressed bundle — `plugins/<id>/<sha256>.js`.
   *
   * The hash is verified before this is called, not here. A transport that verified would be a
   * second implementation of the check, and the one that mattered would be whichever ran last.
   */
  readonly bundlePath: string;
  /**
   * Whether to spawn with `--smol`.
   *
   * Default for every plugin, because plugin processes are overwhelmingly idle event handlers and
   * the daemon's whole pitch against VRCX is a 50-80MB idle footprint that N plugin processes are
   * the most likely way to lose. A manifest may opt out with `performance: "throughput"`, which
   * surfaces at consent — it spends the *user's* memory, so it is their call rather than the
   * author's to make silently.
   *
   * Note that `--smol` is a hint and not a limit. It caps nothing; the RSS watchdog and the
   * OS-level caps are still what stop a runaway.
   */
  readonly smol: boolean;
  /**
   * Hard ceiling on the process's address space, in bytes, when the platform can impose one.
   *
   * Enforced by the OS where possible (a Job Object on Windows, `RLIMIT_AS` on Linux) rather than
   * by the watchdog, because an OS-enforced cap fails the allocation instead of noticing afterwards
   * — a plugin can allocate a gigabyte between two watchdog ticks.
   */
  readonly memoryLimitBytes: number;
  /**
   * How long the process has to send its `hello` frame before it is considered dead on arrival.
   *
   * A separate deadline from the heartbeat: a plugin that never boots and a plugin that stopped
   * answering are different failures, and telling a user the second when it was the first sends
   * them looking in the wrong place.
   */
  readonly helloTimeoutMs: number;
}
