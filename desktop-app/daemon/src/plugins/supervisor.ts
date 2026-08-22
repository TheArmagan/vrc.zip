/**
 * `PluginSupervisor` — the thing that decides whether **one** plugin is healthy, and what to do when
 * it is not. See PLAN.md §Phase 3 "Isolation: child process, not Worker" (the supervisor paragraph)
 * and "Manifest, lifecycle, storage" ("Disable must be instant and always succeed — the kill path is
 * not optional").
 *
 * **One plugin, not many.** A registry over N plugins — install/uninstall, enumerating the disabled
 * set for the UI, shutting them all down on daemon exit — is a different object with a different
 * lifetime, and it will be built on top of this one rather than inside it. Everything here is scoped
 * to a single `pluginId` so that a supervisor can be constructed, driven and thrown away in a test
 * without a registry existing at all.
 *
 * ## What it watches, and why each mechanism exists
 *
 * - **A host-driven heartbeat.** The host sends `ping`; the *prelude* echoes `pong`. The echo living
 *   in the host-injected prelude rather than in plugin code is the whole point: it makes a missed
 *   beat evidence about the **runtime** rather than about the **author**. A plugin cannot forget to
 *   answer, cannot answer wrongly, and — the property that actually matters — a plugin spinning its
 *   event loop stops answering no matter what it intended, because the reply needs a turn of the
 *   loop it is refusing to yield.
 * - **An RSS watchdog**, from two sources that are not equivalent. See {@link SupervisorOptions.readRssBytes}.
 * - **Activation and call deadlines.** A `lifecycle` frame that goes unanswered is a different
 *   failure from one answered with an error, and the user is told which.
 * - **Exponential restart backoff** with the codebase's existing jitter helper.
 * - **Crash-loop auto-disable**, sticky across daemon restarts via {@link PluginDisableStore}.
 *
 * ## Time
 *
 * Every clock, timer and random source is injected ({@link SupervisorClock}, `random`), following
 * `net/rate-limiter.ts`. This is timing logic; timing logic tested by sleeping is timing logic tested
 * slowly and flakily.
 */

import { deadlineIn, type Envelope, PLUGIN_API_PROTOCOL_MAJOR } from "@vrcz/plugin-api";
import { jitter } from "../net/jitter.ts";
import type {
  ExitInfo,
  PluginTransport,
  TransportFactory,
  TransportSpawnOptions,
} from "./transport.ts";

// ---------------------------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------------------------

/**
 * Named states rather than a pile of booleans.
 *
 * A `#restarting` + `#stopping` + `#disabled` triple has eight combinations and only four of them
 * mean anything, which is exactly how "restart during shutdown" and "exit during restart" — the two
 * races that actually bite — get shipped. Here they are one field with an enumerated transition
 * table, so an impossible combination cannot be written down.
 */
export const SUPERVISOR_STATES = [
  /** Not running, nothing pending. The state after construction and after a clean stop. */
  "idle",
  /** A transport is being created, or has been created and has not yet sent `hello`. */
  "starting",
  /** `hello` accepted; the `lifecycle: activate` frame is out and its deadline is armed. */
  "activating",
  /** Activated. The only state in which the heartbeat runs. */
  "running",
  /** A graceful `stop()` is in flight. No restart will follow, whatever the exit says. */
  "stopping",
  /** Exited unexpectedly; a restart timer is armed. */
  "backoff",
  /** Will not run until something calls {@link PluginSupervisor.enable}. */
  "disabled",
] as const;

export type SupervisorState = (typeof SUPERVISOR_STATES)[number];

/**
 * Every legal edge. Anything else throws — loudly, because an illegal transition is a bug in this
 * file and not a condition a plugin can provoke.
 *
 * Note `disabled` is reachable from everywhere and leads only to `idle`: that asymmetry *is* the
 * "disable always succeeds" requirement, expressed in the type of thing that can be checked.
 */
export const SUPERVISOR_TRANSITIONS = {
  idle: ["starting", "disabled"],
  starting: ["activating", "backoff", "idle", "stopping", "disabled"],
  activating: ["running", "backoff", "idle", "stopping", "disabled"],
  running: ["stopping", "backoff", "idle", "disabled"],
  stopping: ["idle", "disabled"],
  backoff: ["starting", "idle", "disabled"],
  disabled: ["idle"],
} as const satisfies Record<SupervisorState, readonly SupervisorState[]>;

// ---------------------------------------------------------------------------------------------
// Failures and disable reasons
// ---------------------------------------------------------------------------------------------

/**
 * Why a plugin stopped being healthy. These are distinct because they send a user to different
 * places: `activate-hung` means "this plugin blocks", `activate-failed` means "this plugin's own
 * startup code threw", and telling someone the second when it was the first sends them reading the
 * wrong log.
 */
export type SupervisorFailureKind =
  /** The transport could not be created at all — bad bundle path, no runtime, EPERM. */
  | "spawn-failed"
  /** The process started and never said `hello`. Dead on arrival, not "stopped answering". */
  | "hello-timeout"
  /** `hello` named a protocol major this host does not speak. A hard stop, never a restart loop. */
  | "protocol-mismatch"
  /** `lifecycle: activate` was never answered. The plugin is blocking, not failing. */
  | "activate-hung"
  /** `lifecycle: activate` was answered with an error. The plugin's own startup code failed. */
  | "activate-failed"
  /** {@link SupervisorOptions.maxMissedBeats} consecutive pings went unanswered. */
  | "heartbeat-lost"
  /** The RSS watchdog saw the process over its cap. */
  | "rss-exceeded"
  /** It exited on its own. */
  | "crashed";

export interface SupervisorFailure {
  readonly kind: SupervisorFailureKind;
  /** Already in words rather than in errno — this is what a user is shown. */
  readonly detail: string;
  /** Unix ms, integer. */
  readonly at: number;
}

export type DisableReason =
  /** Someone asked. Sticky, obviously: an unchecked box must stay unchecked. */
  | "user"
  /** It could not stay up. Sticky, or it is not auto-disable. */
  | "crash-loop"
  /** It speaks a protocol this host does not. Sticky: nothing about a restart changes that. */
  | "protocol-mismatch"
  /**
   * It could not be spawned. **Not** sticky — a locked file or an exhausted handle table is a
   * condition of the moment, and persisting it would permanently disable a plugin over a transient
   * Windows file lock. The halt still holds for this session.
   */
  | "spawn-failed";

export interface DisableRecord {
  readonly pluginId: string;
  readonly reason: DisableReason;
  /** One line, shown to the user. For `protocol-mismatch` it names the version needed. */
  readonly detail: string;
  /** Unix ms, integer. */
  readonly at: number;
}

/**
 * The seam for making auto-disable survive a daemon restart.
 *
 * **Deliberately synchronous and `void`-returning.** Disable is the one path that may not be allowed
 * to fail or to wait, so it cannot `await` a write — an implementation that needs I/O must queue it
 * and return. The supervisor treats its own in-memory record as authoritative for the session and
 * uses the store purely so the next process starts in the same place.
 */
export interface PluginDisableStore {
  readonly load: (pluginId: string) => DisableRecord | null;
  readonly save: (record: DisableRecord) => void;
  readonly clear: (pluginId: string) => void;
}

/** An in-memory {@link PluginDisableStore}. The default, and what the tests drive. */
export class MemoryDisableStore implements PluginDisableStore {
  readonly #records = new Map<string, DisableRecord>();

  load(pluginId: string): DisableRecord | null {
    return this.#records.get(pluginId) ?? null;
  }

  save(record: DisableRecord): void {
    this.#records.set(record.pluginId, record);
  }

  clear(pluginId: string): void {
    this.#records.delete(pluginId);
  }
}

/** What the user is told when a plugin auto-disables. Mapped to the real sink by `wiring/`. */
export interface SupervisorNotification {
  readonly pluginId: string;
  readonly title: string;
  readonly body: string;
}

// ---------------------------------------------------------------------------------------------
// Clock seam
// ---------------------------------------------------------------------------------------------

/** Cancels a scheduled callback. Idempotent by contract. */
export type CancelTimer = () => void;

/**
 * The only way this file reads time or schedules anything.
 *
 * `schedule` returns its own canceller rather than a handle, so there is no timer-id type to get
 * wrong and no way to cancel the wrong timer.
 */
export interface SupervisorClock {
  readonly now: () => number;
  readonly schedule: (delayMs: number, fn: () => void) => CancelTimer;
}

export const systemClock: SupervisorClock = {
  now: () => Date.now(),
  schedule: (delayMs, fn) => {
    const timer = setTimeout(fn, delayMs);
    // A supervisor timer must never be the reason the daemon refuses to exit.
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

// ---------------------------------------------------------------------------------------------
// Defaults, each with its reason
// ---------------------------------------------------------------------------------------------

const DEFAULTS = {
  /**
   * One ping every 10s. Cheap — a plugin process is woken for a two-field frame — and fine-grained
   * enough that the whole miss budget below still detects a wedged plugin inside half a minute.
   */
  heartbeatIntervalMs: 10_000,
  /**
   * A pong is expected within 5s of its ping, half the interval, so at most one beat is ever
   * outstanding and "missed beats" counts beats rather than overlapping windows.
   */
  pingTimeoutMs: 5_000,
  /**
   * **Three consecutive misses, then `kill()`.**
   *
   * One missed beat is a GC pause, a `--smol` heap compaction, or the OS descheduling the process
   * while something else compiles; killing on it would make the supervisor the leading cause of
   * plugin restarts. Three consecutive misses spanning 30s is not any of those — the event loop is
   * not turning, and the only thing that reaches a process which will not turn its loop is a kill.
   */
  maxMissedBeats: 3,
  /**
   * 256 MiB resident. The daemon's entire pitch against VRCX is a 50-80MB idle footprint, and N
   * plugin processes are the most likely way to lose it; a `--smol` event-handler plugin idles well
   * under 64MB, so this is roughly 4x headroom rather than a tight collar.
   */
  rssLimitBytes: 256 * 1024 * 1024,
  /** A plugin gets 10s to say `hello`. Booting a bundle is milliseconds; 10s covers a cold disk. */
  helloTimeoutMs: 10_000,
  /**
   * 15s for `activate`. Long enough for a plugin that opens its SQLite file and reads settings,
   * short enough that a user watching the plugin list does not conclude the app has hung.
   */
  activateTimeoutMs: 15_000,
  /** How long a graceful `stop()` waits before the transport kills. */
  stopGraceMs: 3_000,
  /**
   * Restart backoff: 1s doubling to a 60s ceiling, the same ladder as the 429 breaker in
   * `net/rate-limiter.ts`. One backoff policy in the codebase is one to reason about, and 60s is
   * short enough that a plugin waiting on something that recovers (the pipeline, a file lock) comes
   * back on its own rather than needing a user.
   */
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  /**
   * **"Stable" is 60s continuously `running`.** Six answered heartbeats — long enough that the
   * plugin is demonstrably past its own startup, which is where crash loops live, and short enough
   * that a plugin failing hourly is not punished with an hour-long backoff for a fault it recovered
   * from. On reaching it, both the backoff ladder and the crash window reset, so the *next* failure
   * is treated as a new incident rather than a continuation of the old one.
   */
  stableAfterMs: 60_000,
  /**
   * **Five crashes inside five minutes auto-disables.** With the ladder above, five restarts spend
   * about 31s in backoff, so reaching five inside five minutes means the plugin genuinely cannot
   * stay up rather than that it was unlucky. Five also tolerates the two or three restarts a real
   * transient — a VRChat outage, a machine waking from sleep — produces, which a threshold of two
   * would not.
   */
  crashWindowMs: 300_000,
  crashLoopThreshold: 5,
} as const;

// ---------------------------------------------------------------------------------------------
// Options and status
// ---------------------------------------------------------------------------------------------

export interface SupervisorOptions {
  readonly pluginId: string;
  /** Passed to the factory on every start. `pluginId` is taken from the option above. */
  readonly spawn: Omit<TransportSpawnOptions, "pluginId" | "helloTimeoutMs">;
  readonly factory: TransportFactory;

  /** Protocol major this host speaks. Defaults to `PLUGIN_API_PROTOCOL_MAJOR`. */
  readonly protocolMajor?: number;

  readonly heartbeatIntervalMs?: number;
  readonly pingTimeoutMs?: number;
  readonly maxMissedBeats?: number;
  readonly rssLimitBytes?: number;
  readonly helloTimeoutMs?: number;
  readonly activateTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly stableAfterMs?: number;
  readonly crashWindowMs?: number;
  readonly crashLoopThreshold?: number;

  /**
   * Reads a live RSS figure for a real pid, or `null` when the platform cannot.
   *
   * **The two RSS sources are not equivalent, and the preference order is not cosmetic.** A number
   * the OS reports about a pid is a fact; `PongFrame.rss` is a number the *measured party* chose to
   * send, and the failure mode that matters most — a plugin whose event loop is wedged while its
   * heap grows — is precisely the one where it stops updating. So the OS reading wins whenever a
   * pid and a reader are both available.
   *
   * When the only number available is the self-reported one (a worker-backed transport has no pid),
   * it is still enforced, because the common case is an honest plugin with a leak and catching that
   * is worth doing. What is *not* claimed is that it bounds a hostile one: a plugin that lies about
   * its RSS, or simply stops answering, is caught by the heartbeat instead, and the real ceiling on
   * a process that will not cooperate is the OS-enforced
   * {@link TransportSpawnOptions.memoryLimitBytes}, which fails the allocation rather than noticing
   * afterwards.
   */
  readonly readRssBytes?: (pid: number) => number | null;

  readonly clock?: SupervisorClock;
  readonly random?: () => number;
  readonly disableStore?: PluginDisableStore;

  /** Frames the supervisor does not own — `req`, `res` for dispatcher ids, `subscribe`, `credit`. */
  readonly onPluginFrame?: (frame: Envelope) => void;
  /** A line the plugin logged. Attribution and truncation happened in the transport. */
  readonly onLog?: (stream: "stdout" | "stderr", line: string) => void;
  /** Called after every state change and every failure. Never throws into the supervisor. */
  readonly onStatus?: (status: SupervisorStatus) => void;
  /** Called exactly once per auto-disable. PLAN.md asks for a notification, not a silent stop. */
  readonly onNotify?: (notification: SupervisorNotification) => void;
}

export interface SupervisorStatus {
  readonly pluginId: string;
  readonly state: SupervisorState;
  /** Restarts since the last stable period. Drives the backoff ladder. */
  readonly restarts: number;
  /** Consecutive unanswered pings right now. */
  readonly missedBeats: number;
  /** Most recent RSS reading in bytes, from whichever source won. `null` before the first. */
  readonly rssBytes: number | null;
  readonly lastFailure: SupervisorFailure | null;
  readonly disabled: DisableRecord | null;
  /** Unix ms the restart timer will fire, while in `backoff`. */
  readonly restartAt: number | null;
}

// ---------------------------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------------------------

export class PluginSupervisor {
  readonly pluginId: string;

  readonly #options: SupervisorOptions;
  readonly #clock: SupervisorClock;
  readonly #random: () => number;
  readonly #store: PluginDisableStore;
  readonly #protocolMajor: number;

  readonly #heartbeatIntervalMs: number;
  readonly #pingTimeoutMs: number;
  readonly #maxMissedBeats: number;
  readonly #rssLimitBytes: number;
  readonly #helloTimeoutMs: number;
  readonly #activateTimeoutMs: number;
  readonly #stopGraceMs: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #stableAfterMs: number;
  readonly #crashWindowMs: number;
  readonly #crashLoopThreshold: number;

  #state: SupervisorState = "idle";
  #transport: PluginTransport | null = null;
  /**
   * Bumped on every start attempt and every disable/stop.
   *
   * This is what makes the two races safe. `factory()` is async, so a `disable()` landing during the
   * await must not be overwritten by the transport that arrives afterwards; and a timer armed for
   * one incarnation must not act on the next. Every asynchronous continuation compares the epoch it
   * captured against the current one and does nothing if they differ.
   */
  #epoch = 0;

  #cancelHello: CancelTimer | null = null;
  #cancelActivate: CancelTimer | null = null;
  #cancelHeartbeat: CancelTimer | null = null;
  #cancelStable: CancelTimer | null = null;
  #cancelRestart: CancelTimer | null = null;

  #restarts = 0;
  #restartAt: number | null = null;
  #missedBeats = 0;
  #rssBytes: number | null = null;
  #lastFailure: SupervisorFailure | null = null;
  #disabled: DisableRecord | null = null;

  /** Outstanding ping, or null when the last one was answered. */
  #pendingPing: { readonly nonce: string; readonly deadline: number } | null = null;
  #pendingActivateId: string | null = null;
  #frameCounter = 0;
  /** Unix ms of each crash inside the window. Trimmed on every push. */
  #crashes: number[] = [];

  constructor(options: SupervisorOptions) {
    this.#options = options;
    this.pluginId = options.pluginId;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.#store = options.disableStore ?? new MemoryDisableStore();
    this.#protocolMajor = options.protocolMajor ?? PLUGIN_API_PROTOCOL_MAJOR;

    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
    this.#pingTimeoutMs = options.pingTimeoutMs ?? DEFAULTS.pingTimeoutMs;
    this.#maxMissedBeats = options.maxMissedBeats ?? DEFAULTS.maxMissedBeats;
    this.#rssLimitBytes = options.rssLimitBytes ?? DEFAULTS.rssLimitBytes;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? DEFAULTS.helloTimeoutMs;
    this.#activateTimeoutMs = options.activateTimeoutMs ?? DEFAULTS.activateTimeoutMs;
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULTS.stopGraceMs;
    this.#baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.#stableAfterMs = options.stableAfterMs ?? DEFAULTS.stableAfterMs;
    this.#crashWindowMs = options.crashWindowMs ?? DEFAULTS.crashWindowMs;
    this.#crashLoopThreshold = options.crashLoopThreshold ?? DEFAULTS.crashLoopThreshold;

    // Auto-disable is only auto-disable if it survives a restart, so the record is read here rather
    // than assumed absent. A supervisor constructed over a disabled plugin starts disabled.
    const persisted = this.#store.load(this.pluginId);
    if (persisted !== null) {
      this.#disabled = persisted;
      this.#state = "disabled";
    }
  }

  get state(): SupervisorState {
    return this.#state;
  }

  get disabled(): DisableRecord | null {
    return this.#disabled;
  }

  get status(): SupervisorStatus {
    return {
      pluginId: this.pluginId,
      state: this.#state,
      restarts: this.#restarts,
      missedBeats: this.#missedBeats,
      rssBytes: this.#rssBytes,
      lastFailure: this.#lastFailure,
      disabled: this.#disabled,
      restartAt: this.#restartAt,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Public control
  // -------------------------------------------------------------------------------------------

  /**
   * Starts the plugin, or does nothing if it is disabled or already up.
   *
   * Resolves once the transport exists and `activate` has been sent — **not** once the plugin is
   * healthy. Health is a running judgement, and a caller that awaited it would be waiting on the
   * event loop of a process it does not trust.
   */
  async start(): Promise<void> {
    if (this.#state !== "idle" && this.#state !== "backoff") return;
    this.#clearRestartTimer();
    this.#transition("starting");

    const epoch = ++this.#epoch;
    let transport: PluginTransport;
    try {
      transport = await this.#options.factory(
        {
          ...this.#options.spawn,
          pluginId: this.pluginId,
          helloTimeoutMs: this.#helloTimeoutMs,
        },
        {
          onFrame: (frame) => {
            this.#onFrame(epoch, frame);
          },
          onProtocolError: (detail) => {
            this.#options.onLog?.("stderr", `protocol error: ${detail}`);
          },
          onLog: (stream, line) => {
            this.#options.onLog?.(stream, line);
          },
          onExit: (info) => {
            this.#onExit(epoch, info);
          },
        },
      );
    } catch (error) {
      if (epoch !== this.#epoch) return;
      const detail = error instanceof Error ? error.message : String(error);
      this.#fail("spawn-failed", `Could not start the plugin process: ${detail}`);
      // Not sticky: see `DisableReason`. The halt holds for this session and a retry is a decision
      // the user or the registry makes, not one a spawn error makes for them.
      this.#disable("spawn-failed", `Could not start the plugin process: ${detail}`, false);
      return;
    }

    // The disable/stop that landed while `factory()` was in flight already believes nothing is
    // running. Kill what arrived rather than adopting it, or we leak a process nobody supervises.
    if (epoch !== this.#epoch) {
      transport.kill();
      return;
    }

    this.#transport = transport;
    // Belt and braces with the transport's own hello timeout: the supervisor cannot know whether a
    // given transport implements one, and its state machine needs an answer either way. Whichever
    // fires first ends in the same place.
    this.#cancelHello = this.#clock.schedule(this.#helloTimeoutMs, () => {
      if (epoch !== this.#epoch || this.#state !== "starting") return;
      this.#fail("hello-timeout", `The plugin did not send hello within ${this.#helloTimeoutMs}ms`);
      this.#killCurrent();
    });
    this.#emit();
  }

  /**
   * Asks the plugin to shut down, then waits for the transport to confirm it is gone.
   *
   * This is the *graceful* path and it is allowed to take time. It is **not** the path a user's
   * "disable" gesture takes — see {@link disable}.
   */
  async stop(): Promise<void> {
    if (this.#state === "disabled" || this.#state === "idle") return;
    const transport = this.#transport;
    this.#epoch++;
    this.#clearTimers();
    if (transport === null) {
      this.#transition("idle");
      this.#emit();
      return;
    }
    this.#transition("stopping");
    this.#emit();
    // Best effort: a plugin that answers gets to flush, one that does not is killed by `stop`'s own
    // grace period. Nothing here waits on the reply.
    transport.send({
      t: "lifecycle",
      id: this.#nextId("lc"),
      deadline: deadlineIn(this.#stopGraceMs, this.#clock.now()),
      phase: "shutdown",
    });
    await transport.stop(this.#stopGraceMs);
    this.#transport = null;
    if (this.#state === "stopping") {
      this.#transition("idle");
      this.#emit();
    }
  }

  /**
   * **Instant, synchronous, always succeeds.** The one control PLAN.md promises will work.
   *
   * It awaits nothing — not `transport.stop()`, not a lifecycle reply, not a store write — because
   * every one of those can be delayed by the very plugin the user is trying to be rid of. It cancels
   * a pending restart, kills whatever is running, and records the decision. Safe to call twice,
   * during a restart, during a start, and after the process has already exited.
   */
  disable(reason: DisableReason = "user", detail = "Disabled by the user"): void {
    this.#disable(reason, detail, reason !== "spawn-failed");
  }

  /** Clears a disable, sticky or not, and returns the supervisor to `idle`. Does not start it. */
  enable(): void {
    if (this.#state !== "disabled") return;
    this.#store.clear(this.pluginId);
    this.#disabled = null;
    this.#restarts = 0;
    this.#crashes = [];
    this.#transition("idle");
    this.#emit();
  }

  // -------------------------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------------------------

  #onFrame(epoch: number, frame: Envelope): void {
    if (epoch !== this.#epoch) return;

    switch (frame.t) {
      case "hello":
        this.#onHello(frame.protocol, frame.pluginId);
        return;

      case "pong": {
        const pending = this.#pendingPing;
        // A pong for a nonce we did not send — or for one already answered — proves nothing about
        // liveness and is exactly what a plugin trying to fake a heartbeat would send.
        if (pending === null || pending.nonce !== frame.nonce) return;
        this.#pendingPing = null;
        this.#missedBeats = 0;
        if (frame.rss !== undefined) this.#observeRss(frame.rss, "pong");
        return;
      }

      case "res":
        if (frame.id === this.#pendingActivateId) {
          this.#onActivated();
          return;
        }
        break;

      case "err":
        if (frame.id === this.#pendingActivateId) {
          this.#pendingActivateId = null;
          this.#clearActivateTimer();
          this.#fail(
            "activate-failed",
            `The plugin's activate handler failed: ${frame.error.message}`,
          );
          // Killed rather than stopped: it never activated, so there is no plugin state worth
          // flushing, and a plugin whose startup just threw is not the one to trust with a
          // graceful shutdown handler.
          this.#killCurrent();
          return;
        }
        break;

      default:
        break;
    }

    this.#options.onPluginFrame?.(frame);
  }

  #onHello(protocol: number, helloPluginId: string): void {
    if (this.#state !== "starting") return;
    this.#clearHelloTimer();

    if (protocol !== this.#protocolMajor) {
      // A hard stop, not a restart: nothing about respawning the same bundle changes which protocol
      // it was compiled against, so a restart loop here would be an infinite one that never even
      // reaches the user with the one fact they need.
      const detail =
        `This plugin speaks plugin API ${protocol}; this daemon speaks ` +
        `${this.#protocolMajor}. Install a build for plugin API ${this.#protocolMajor}.`;
      this.#fail("protocol-mismatch", detail);
      this.#disable("protocol-mismatch", detail, true);
      return;
    }

    if (helloPluginId !== this.pluginId) {
      const detail = `The plugin process identified itself as ${helloPluginId}, not ${this.pluginId}`;
      this.#fail("protocol-mismatch", detail);
      this.#disable("protocol-mismatch", detail, true);
      return;
    }

    const transport = this.#transport;
    if (transport === null) return;

    this.#transition("activating");
    const id = this.#nextId("lc");
    this.#pendingActivateId = id;
    const epoch = this.#epoch;
    transport.send({
      t: "lifecycle",
      id,
      deadline: deadlineIn(this.#activateTimeoutMs, this.#clock.now()),
      phase: "activate",
    });
    this.#cancelActivate = this.#clock.schedule(this.#activateTimeoutMs, () => {
      if (epoch !== this.#epoch || this.#state !== "activating") return;
      this.#pendingActivateId = null;
      // Distinct from `activate-failed` on purpose. "It is not answering" and "it answered with an
      // error" are different things to tell a user and different things for them to do about it.
      this.#fail(
        "activate-hung",
        `The plugin did not finish activating within ${this.#activateTimeoutMs}ms and is not responding`,
      );
      this.#killCurrent();
    });
    this.#emit();
  }

  #onActivated(): void {
    this.#pendingActivateId = null;
    this.#clearActivateTimer();
    this.#transition("running");
    this.#missedBeats = 0;
    this.#pendingPing = null;
    this.#armHeartbeat();
    this.#armStable();
    this.#emit();
  }

  // -------------------------------------------------------------------------------------------
  // Heartbeat and the RSS watchdog
  // -------------------------------------------------------------------------------------------

  #armHeartbeat(): void {
    const epoch = this.#epoch;
    this.#cancelHeartbeat = this.#clock.schedule(this.#heartbeatIntervalMs, () => {
      if (epoch !== this.#epoch || this.#state !== "running") return;
      this.#cancelHeartbeat = null;
      this.#beat();
      if (this.#state === "running" && epoch === this.#epoch) this.#armHeartbeat();
    });
  }

  #beat(): void {
    const now = this.#clock.now();
    const transport = this.#transport;
    if (transport === null) return;

    // Judge the previous beat before sending a new one. With `pingTimeoutMs` at or below the
    // interval, at most one ping is ever outstanding, so this counts *beats* rather than
    // overlapping windows and "three missed beats" means what it reads as.
    const pending = this.#pendingPing;
    if (pending !== null && pending.deadline <= now) {
      this.#missedBeats++;
      this.#pendingPing = null;
      if (this.#missedBeats >= this.#maxMissedBeats) {
        this.#fail(
          "heartbeat-lost",
          `The plugin missed ${this.#missedBeats} heartbeats and is not responding`,
        );
        this.#killCurrent();
        return;
      }
    }

    if (!this.#checkRss()) return;

    const nonce = this.#nextId("hb");
    this.#pendingPing = { nonce, deadline: now + this.#pingTimeoutMs };
    transport.send({ t: "ping", nonce, deadline: deadlineIn(this.#pingTimeoutMs, now) });
    this.#emit();
  }

  /** Returns false when the watchdog fired and the transport is gone. */
  #checkRss(): boolean {
    const transport = this.#transport;
    const pid = transport?.pid ?? null;
    const osReading =
      pid !== null && this.#options.readRssBytes !== undefined
        ? this.#options.readRssBytes(pid)
        : null;
    if (osReading !== null) this.#observeRss(osReading, "os");

    const observed = this.#rssBytes;
    if (observed === null || observed <= this.#rssLimitBytes) return true;

    this.#fail(
      "rss-exceeded",
      `The plugin used ${formatMib(observed)} of memory, over its ${formatMib(this.#rssLimitBytes)} cap`,
    );
    // **A kill, not a stop.** A graceful stop is a request that travels over the plugin's own event
    // loop and is then waited on — and a process over its memory cap is either allocating in a loop
    // (so it will not yield) or about to be OOM-killed by the OS (so waiting spends the time we
    // have on a courtesy). Worse, "please exit" handlers allocate, which is the one thing that must
    // not happen here. Ending it immediately is what bounds the damage.
    this.#killCurrent();
    return false;
  }

  #observeRss(bytes: number, source: "os" | "pong"): void {
    // The OS reading always wins while it is available; a self-reported figure only fills the gap
    // for a transport with no pid. See `SupervisorOptions.readRssBytes`.
    if (source === "pong" && this.#hasOsReader()) return;
    this.#rssBytes = Math.trunc(bytes);
  }

  #hasOsReader(): boolean {
    return this.#options.readRssBytes !== undefined && (this.#transport?.pid ?? null) !== null;
  }

  #armStable(): void {
    const epoch = this.#epoch;
    this.#cancelStable = this.#clock.schedule(this.#stableAfterMs, () => {
      if (epoch !== this.#epoch || this.#state !== "running") return;
      this.#cancelStable = null;
      this.#restarts = 0;
      this.#crashes = [];
      this.#emit();
    });
  }

  // -------------------------------------------------------------------------------------------
  // Exit, restart, crash loop
  // -------------------------------------------------------------------------------------------

  #onExit(epoch: number, info: ExitInfo): void {
    if (epoch !== this.#epoch) return;
    this.#transport = null;
    this.#clearTimersExceptRestart();
    this.#pendingPing = null;
    this.#pendingActivateId = null;

    // The exit-during-restart race, and its mirror: a transport that reports twice, or one whose
    // exit lands after we have already decided what happens next. The contract says `onExit` fires
    // once, but "the supervisor believed a buggy transport" is not a failure mode worth having.
    if (this.#state === "disabled" || this.#state === "backoff" || this.#state === "idle") return;

    if (this.#state === "stopping" || info.reason === "shutdown") {
      this.#transition("idle");
      this.#emit();
      return;
    }

    if (info.reason === "spawn-failed") {
      this.#fail("spawn-failed", info.detail);
      this.#disable("spawn-failed", info.detail, false);
      return;
    }

    // A `killed` exit was the supervisor's own doing and `#fail` already recorded why; a `crashed`
    // one is news, so it gets a failure of its own rather than inheriting a stale one.
    if (info.reason === "crashed") this.#fail("crashed", info.detail);

    this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    const now = this.#clock.now();
    this.#crashes = [...this.#crashes.filter((at) => now - at < this.#crashWindowMs), now];

    if (this.#crashes.length >= this.#crashLoopThreshold) {
      const detail =
        `${this.pluginId} failed ${this.#crashes.length} times in ` +
        `${Math.round(this.#crashWindowMs / 60_000)} minutes and was disabled. ` +
        `Last failure: ${this.#lastFailure?.detail ?? "unknown"}`;
      this.#disable("crash-loop", detail, true);
      this.#options.onNotify?.({
        pluginId: this.pluginId,
        title: `Plugin disabled: ${this.pluginId}`,
        body: detail,
      });
      return;
    }

    this.#restarts++;
    // 1s, 2s, 4s ... capped, then jittered by the shared helper so a machine running several
    // failing plugins does not respawn them all on the same tick.
    const step = Math.min(this.#baseBackoffMs * 2 ** (this.#restarts - 1), this.#maxBackoffMs);
    const delay = jitter(step, { random: this.#random });
    this.#restartAt = now + delay;
    this.#transition("backoff");
    this.#emit();

    const epoch = this.#epoch;
    this.#cancelRestart = this.#clock.schedule(delay, () => {
      this.#cancelRestart = null;
      this.#restartAt = null;
      // The restart-during-shutdown race: a `disable()` or `stop()` between arming and firing bumped
      // the epoch, and this timer must not resurrect what they put down.
      if (epoch !== this.#epoch || this.#state !== "backoff") return;
      void this.start();
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  #disable(reason: DisableReason, detail: string, sticky: boolean): void {
    if (this.#state === "disabled") return;

    // Order matters: bump the epoch *first* so every timer callback and every pending `factory()`
    // continuation is already invalidated before anything else runs, then tear down. Nothing below
    // awaits, and nothing below can be delayed by the plugin.
    this.#epoch++;
    this.#clearTimers();
    this.#pendingPing = null;
    this.#pendingActivateId = null;

    const record: DisableRecord = {
      pluginId: this.pluginId,
      reason,
      detail,
      at: Math.trunc(this.#clock.now()),
    };
    this.#disabled = record;
    this.#transition("disabled");

    const transport = this.#transport;
    this.#transport = null;
    // `kill()`, never `stop()`: `stop()` returns a promise, and a promise is a thing a wedged plugin
    // can hold open. Disable is not allowed to be held open.
    transport?.kill();

    if (sticky) this.#store.save(record);
    this.#emit();
  }

  #fail(kind: SupervisorFailureKind, detail: string): void {
    this.#lastFailure = { kind, detail, at: Math.trunc(this.#clock.now()) };
    this.#emit();
  }

  #killCurrent(): void {
    const transport = this.#transport;
    if (transport === null) return;
    transport.kill();
  }

  #transition(next: SupervisorState): void {
    const allowed: readonly SupervisorState[] = SUPERVISOR_TRANSITIONS[this.#state];
    if (!allowed.includes(next)) {
      throw new Error(
        `Illegal supervisor transition for ${this.pluginId}: ${this.#state} -> ${next}`,
      );
    }
    this.#state = next;
  }

  #emit(): void {
    this.#options.onStatus?.(this.status);
  }

  #nextId(prefix: string): string {
    this.#frameCounter++;
    // Random rather than a bare counter: a predictable nonce is one a plugin could answer *before*
    // it was asked, which would let a plugin that is about to wedge bank a few heartbeats. A pong
    // only counts against the outstanding nonce, and the outstanding nonce is unguessable.
    const salt = Math.trunc(this.#random() * 0xffffff).toString(36);
    return `${prefix}${this.#frameCounter}-${salt}`;
  }

  #clearHelloTimer(): void {
    this.#cancelHello?.();
    this.#cancelHello = null;
  }

  #clearActivateTimer(): void {
    this.#cancelActivate?.();
    this.#cancelActivate = null;
  }

  #clearRestartTimer(): void {
    this.#cancelRestart?.();
    this.#cancelRestart = null;
    this.#restartAt = null;
  }

  #clearTimersExceptRestart(): void {
    this.#clearHelloTimer();
    this.#clearActivateTimer();
    this.#cancelHeartbeat?.();
    this.#cancelHeartbeat = null;
    this.#cancelStable?.();
    this.#cancelStable = null;
  }

  #clearTimers(): void {
    this.#clearTimersExceptRestart();
    this.#clearRestartTimer();
  }
}

function formatMib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
