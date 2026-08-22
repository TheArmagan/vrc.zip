/**
 * The set of installed plugins, and one supervisor each.
 *
 * `PluginSupervisor` deliberately manages exactly one plugin — its state machine, backoff ladder and
 * crash window are all per-plugin, and a supervisor that also had to answer "which of these is
 * running" would be two objects wearing one name. This is the other one: it owns the collection,
 * the daemon's start and stop, and the management page's view of what is going on.
 *
 * Three rules shape it.
 *
 * **A disabled plugin is never started.** The check is here, before a supervisor is even
 * constructed, as well as inside the supervisor itself. Two checks rather than one because they
 * fail differently: the supervisor's protects against a start it is asked for while disabled, and
 * this one means a crash-looped plugin does not spend a process spawn on every daemon boot just to
 * be told no.
 *
 * **Starting is not all-or-nothing.** One plugin that cannot spawn must not stop the other five
 * from running, so a failure is recorded against that plugin and the loop continues. The daemon
 * booting with five of six plugins and a visible reason for the sixth is a much better outcome than
 * a daemon that refuses to boot.
 *
 * **Shutdown is bounded and always completes.** `stopAll` gives every plugin the same grace and then
 * stops waiting. PLAN.md promises disable is instant and always succeeds; a shutdown that could hang
 * on one wedged plugin would break that promise at exactly the moment the user is trying to quit.
 */

import type { Envelope } from "@vrcz/plugin-api";
import { APP_NAME } from "@vrcz/shared";
import type { Store } from "../store/index.ts";
import { createPluginDisableStore } from "./disable-store.ts";
import {
  type DisableReason,
  PluginSupervisor,
  type SupervisorNotification,
  type SupervisorOptions,
  type SupervisorStatus,
} from "./supervisor.ts";
import type { TransportFactory, TransportSpawnOptions } from "./transport.ts";

/** One plugin as the management page draws it: what it is, and what it is doing. */
export interface PluginStatus extends SupervisorStatus {
  readonly version: string;
  /** Null while it is allowed to run. Set by the user or by the crash-loop breaker. */
  readonly disabledReason: string | null;
  readonly disabledBy: string | null;
}

export interface PluginRegistryOptions {
  readonly store: Store;
  readonly factory: TransportFactory;
  /**
   * How a plugin's bundle path and resource limits are decided.
   *
   * A function rather than fixed values because the answer is per plugin: the bundle is
   * content-addressed under that plugin's own directory, and `--smol` is opted out of by a manifest
   * that says `performance: "throughput"` — which surfaces at consent, because it spends the
   * *user's* memory rather than the author's.
   */
  readonly spawnFor: (
    pluginId: string,
  ) => Omit<TransportSpawnOptions, "pluginId" | "helloTimeoutMs"> | null;
  /** Per-supervisor tuning, applied to every plugin. Tests pin the clock through this. */
  readonly supervisor?: Omit<SupervisorOptions, "pluginId" | "spawn" | "factory" | "disableStore">;
  /** Frames the supervisor does not own, tagged with which plugin sent them. */
  readonly onPluginFrame?: (pluginId: string, frame: Envelope) => void;
  readonly onLog?: (pluginId: string, stream: "stdout" | "stderr", line: string) => void;
  readonly onStatus?: (status: PluginStatus) => void;
  readonly onNotify?: (notification: SupervisorNotification) => void;
}

export class PluginRegistry {
  readonly #options: PluginRegistryOptions;
  readonly #store: Store;
  readonly #supervisors = new Map<string, PluginSupervisor>();
  /**
   * Why a plugin has no supervisor, when it should have one.
   *
   * Kept separate from the supervisors rather than represented as a supervisor in a failed state,
   * because these are failures that happened *before* one could exist — no installed row, no
   * resolvable bundle. A management page still has to say something about them, and "it is not
   * running and here is why" is a better answer than the plugin quietly missing from the list.
   */
  readonly #unstartable = new Map<string, string>();

  constructor(options: PluginRegistryOptions) {
    this.#options = options;
    this.#store = options.store;
  }

  /** Live supervisors, in no particular order. */
  get running(): readonly PluginSupervisor[] {
    return [...this.#supervisors.values()];
  }

  get(pluginId: string): PluginSupervisor | null {
    return this.#supervisors.get(pluginId) ?? null;
  }

  /**
   * Starts every installed, enabled plugin.
   *
   * Sequential rather than concurrent, and that is a considered trade rather than laziness: N
   * plugins spawning at once is N processes competing for the disk during the daemon's own boot,
   * on the machine that is also about to launch VRChat. Plugins are event handlers; none of them is
   * on the critical path of anything the user is waiting for.
   */
  async startAll(): Promise<void> {
    this.#unstartable.clear();
    for (const row of this.#store.listPlugins()) {
      if (row.disabled_at !== null) continue;
      await this.start(row.id);
    }
  }

  /**
   * Starts one plugin, or records why it could not start.
   *
   * Never throws. A plugin that cannot start is a fact about that plugin, and letting it become an
   * exception in the caller would let one bad install take down the daemon's boot.
   */
  async start(pluginId: string): Promise<void> {
    const row = this.#store.getPlugin(pluginId);
    if (row === null) {
      this.#unstartable.set(pluginId, "That plugin is not installed.");
      return;
    }
    if (row.disabled_at !== null) {
      // Checked here as well as inside the supervisor. This one saves a process spawn per boot for
      // a plugin that is only going to be told no.
      return;
    }

    const spawn = this.#options.spawnFor(pluginId);
    if (spawn === null) {
      this.#unstartable.set(
        pluginId,
        `${APP_NAME} could not find this plugin's installed files. Reinstalling it should fix that.`,
      );
      return;
    }

    const existing = this.#supervisors.get(pluginId);
    if (existing !== undefined) {
      await existing.start();
      return;
    }

    const supervisor = new PluginSupervisor({
      ...this.#options.supervisor,
      pluginId,
      // The resolver, not the value `spawn` above. The check on this line is what produces the
      // friendly first-time sentence; handing the supervisor the resolver is what makes the *hash*
      // re-verified on every restart too, rather than once when this object was constructed. A
      // crash-looping plugin respawns every few seconds forever, and a captured path would mean
      // nobody ever looked at the file again.
      spawn: () => this.#options.spawnFor(pluginId),
      factory: this.#options.factory,
      disableStore: createPluginDisableStore(this.#store),
      onPluginFrame: (frame) => this.#options.onPluginFrame?.(pluginId, frame),
      onLog: (stream, line) => this.#options.onLog?.(pluginId, stream, line),
      onStatus: (status) => this.#options.onStatus?.(this.#decorate(status)),
      onNotify: (notification) => this.#options.onNotify?.(notification),
    });

    this.#supervisors.set(pluginId, supervisor);
    this.#unstartable.delete(pluginId);
    await supervisor.start();
  }

  /**
   * Turns a plugin off now.
   *
   * Synchronous and unconditional, because this is the path PLAN.md says must be instant and must
   * always succeed. It does not await the process actually going away — `disable()` kills rather
   * than asks — and it is safe on a plugin that has no supervisor, which is exactly the case when
   * someone disables one that failed to start.
   */
  disable(pluginId: string, reason: DisableReason = "user", detail = "Disabled by the user"): void {
    const supervisor = this.#supervisors.get(pluginId);
    if (supervisor !== undefined) {
      supervisor.disable(reason, detail);
      return;
    }
    // No supervisor, so nothing is running — but the *durable* state still has to change, or the
    // plugin comes back on the next boot and the button the user pressed did nothing.
    if (this.#store.getPlugin(pluginId) !== null) {
      this.#store.disablePlugin(pluginId, Date.now(), reason, detail);
    }
  }

  /**
   * Clears a disable and starts the plugin again.
   *
   * Both branches end in {@link start} rather than in `supervisor.start()`, so re-enabling goes
   * through the same resolution — and therefore the same hash check and the same "could not find
   * this plugin's files" reporting — as a cold boot. `supervisor.enable()` has already cleared the
   * durable record by the time `start` reads the row.
   */
  async enable(pluginId: string): Promise<void> {
    const supervisor = this.#supervisors.get(pluginId);
    if (supervisor !== undefined) supervisor.enable();
    else this.#store.enablePlugin(pluginId);
    await this.start(pluginId);
  }

  /**
   * Stops everything, and comes back either way.
   *
   * Every supervisor is stopped concurrently and the whole thing is bounded: a plugin that will not
   * die politely must not be able to hold the daemon's shutdown open. `Promise.allSettled` rather
   * than `all`, because one rejection here must not skip the rest of the shutdown.
   */
  async stopAll(timeoutMs = 5_000): Promise<void> {
    const stopping = [...this.#supervisors.values()].map((supervisor) => supervisor.stop());
    await Promise.race([
      Promise.allSettled(stopping),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    this.#supervisors.clear();
  }

  /**
   * What every installed plugin is doing, for the management page.
   *
   * Built from the installed rows rather than from the supervisors, so a plugin that is installed
   * and not running still appears — which is the case someone is most likely looking at this page
   * to understand.
   */
  statuses(): PluginStatus[] {
    return this.#store.listPlugins().map((row) => {
      const supervisor = this.#supervisors.get(row.id);
      const base: SupervisorStatus = supervisor?.status ?? {
        pluginId: row.id,
        state: row.disabled_at === null ? "idle" : "disabled",
        restarts: 0,
        missedBeats: 0,
        rssBytes: null,
        lastFailure: null,
        disabled:
          row.disabled_at === null
            ? null
            : {
                pluginId: row.id,
                reason: "user",
                detail: row.disabled_reason ?? "Disabled.",
                at: row.disabled_at,
              },
        restartAt: null,
      };
      return {
        ...base,
        version: row.version,
        disabledReason: row.disabled_reason ?? this.#unstartable.get(row.id) ?? null,
        disabledBy: row.disabled_by,
      };
    });
  }

  #decorate(status: SupervisorStatus): PluginStatus {
    const row = this.#store.getPlugin(status.pluginId);
    return {
      ...status,
      version: row?.version ?? "unknown",
      disabledReason: row?.disabled_reason ?? null,
      disabledBy: row?.disabled_by ?? null,
    };
  }
}
