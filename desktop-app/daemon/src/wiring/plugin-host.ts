/**
 * The plugin subsystem, assembled.
 *
 * Everything under `daemon/src/plugins/` is deliberately unaware of everything else: the supervisor
 * knows one plugin, the registry knows a set of them, the dispatcher knows a method table and a
 * grant lookup, the install pipeline knows a directory. None of them knows about the store, the
 * account manager or each other. That is what makes each of them testable in isolation, and it is
 * also why none of them could run: something has to hold the wires.
 *
 * This is that something, and it lives in `wiring/` for the same reason the feed writer, the log
 * bridge and the pipeline bridge do — `app.ts` is a composition root, not a place adapter logic is
 * written. What it owns:
 *
 *  - **The load path.** `createSpawnResolver` is what `PluginRegistry` is constructed with, so the
 *    artifact's SHA-256 is verified on every spawn, every restart and every daemon boot. A refusal
 *    is captured here rather than swallowed, because "this file no longer matches the hash it was
 *    installed under" is the one refusal a user has to act on and the registry's generic sentence
 *    does not say it.
 *  - **The `send` seam.** `supervisor.onPluginFrame` carries frames outward and
 *    `PluginSupervisor.send` carries replies back; a {@link PluginChannel} over the pair is what the
 *    dispatcher attaches to. Attachment follows the supervisor's *state* rather than its
 *    construction, so a plugin that dies has its in-flight host calls aborted at the moment it dies
 *    rather than whenever someone next notices.
 *  - **The grant.** Read live from the store on every call — never cached — so a revoke takes effect
 *    on the next call rather than on the next restart.
 *
 *  - **The events bridge.** The second link in the frame chain: `PluginDispatcher.handleFrame`
 *    answers `false` for `subscribe`/`unsubscribe`/`credit`, and {@link PluginEventsBridge} claims
 *    exactly those. It attaches and detaches on the same supervisor state the dispatcher does, so a
 *    dead plugin stops being a bus subscriber at the moment it dies.
 *
 *  - **Storage.** One {@link PluginStorage} per plugin, opened on first use, closed when the plugin
 *    stops, and deleted at uninstall unless the caller asks to keep it. The lifecycle is here
 *    rather than in the method table because a table that held open file handles would have to be
 *    told about disable and uninstall.
 *
 * **What it deliberately does not own:** consent (3.8). Frames neither owner claims are handed to
 * {@link PluginHostOptions.onUnownedFrame}, which stays the seam for whatever chains behind them.
 */

import { rmSync } from "node:fs";
import {
  type Envelope,
  grantHash,
  isPluginCapability,
  type PluginGrant,
  type PluginManifest,
  parseManifest,
  type UiIntentDispatch,
} from "@vrcz/plugin-api";
import { isEventPatternString, isScope, type JsonValue, type Scope } from "@vrcz/shared";
import type { AccountManager } from "../accounts/manager.ts";
import type { EventBus } from "../bus/event-bus.ts";
import { pluginDataDir } from "../paths.ts";
import { PluginBudget } from "../plugins/budget.ts";
import {
  type ConsentApproval,
  narrowToRequest,
  type PendingPluginConsent,
  PluginConsentBroker,
} from "../plugins/consent.ts";
import { PluginDispatcher } from "../plugins/dispatcher.ts";
import { PluginEventsBridge } from "../plugins/events-bridge.ts";
import {
  createSpawnResolver,
  formatInstallFailure,
  installPluginFromDirectory,
  pruneArtifacts,
  removeArtifacts,
} from "../plugins/install/index.ts";
import { createVrchatMethods, type PluginAccountInfo } from "../plugins/plugin-vrchat.ts";
import { makeProcessTransportFactory } from "../plugins/process-transport.ts";
import { PluginRegistry, type PluginStatus } from "../plugins/registry.ts";
import { ensurePluginRuntime } from "../plugins/runtime-fetch.ts";
import { PluginStorage } from "../plugins/storage/database.ts";
import { createStorageMethods } from "../plugins/storage/methods.ts";
import type { TransportFactory } from "../plugins/transport.ts";
import {
  createUiMethods,
  type PanelChange,
  PanelRegistry,
  type PanelState,
} from "../plugins/ui-panels.ts";
import { DEFAULT_GRANT_BUDGETS } from "../proxy/passthrough.ts";
import type { Store } from "../store/index.ts";

/**
 * The `RequestMeter` key prefix for plugin traffic. Decision 167: a namespace for *accounting*, so
 * a plugin id can never collide with a grant id in the meter, and never for authorization.
 */
export const PLUGIN_METER_PREFIX = "plugin:";

/**
 * The scopes that are dry-run until the user lifts them, per plugin and per scope.
 *
 * The three risky ones, taken from the proxy's own table rather than restated (decision 167). A
 * scope absent from a plugin's `plugin_dry_run_lifted` rows is shadowed, which is why this is
 * derived from an allowlist of lifts: the safe state is the one you get by having no row.
 *
 * Nothing reads it yet — every method in `plugin-vrchat.ts` is a read, and all three of these are
 * writes. It is computed anyway so the grant the gate sees is complete the day outbound actions
 * land, rather than silently permissive until someone remembers this line.
 */
const SHADOWED_SCOPES: readonly Scope[] = Object.keys(DEFAULT_GRANT_BUDGETS).filter(isScope);

/** One budgeted scope for one plugin, as the management page renders it. */
export interface PluginBudgetView {
  readonly scope: string;
  /** False for a budgeted scope this plugin was not granted. The row is shown anyway. */
  readonly granted: boolean;
  readonly used: number;
  /** Null for a scope that carries no budget at all. */
  readonly limit: number | null;
  readonly windowMs: number;
  /** True while calls under this scope would be logged and not performed. */
  readonly dryRun: boolean;
}

/** One installed plugin, as the management surface needs it. */
export interface InstalledPluginView {
  readonly status: PluginStatus;
  /** From the manifest as stored at install, never re-read from disk. */
  readonly name: string;
  readonly publisher: string;
  readonly installedAt: number;
  /** What the live grant carries, not what the manifest asked for. */
  readonly scopes: readonly string[];
  readonly accountIds: readonly string[];
  /**
   * Why this plugin's bundle would not load, when it would not.
   *
   * Distinct from `status.disabledReason`: a tampered artifact is not a disable, it is a refusal to
   * run a file that no longer matches its hash, and the two want different sentences.
   */
  readonly refusal: string | null;
}

export type PluginInstallOutcome =
  | { readonly ok: true; readonly plugin: InstalledPluginView }
  | { readonly ok: false; readonly stage: string; readonly message: string };

export interface PluginHostOptions {
  readonly store: Store;
  readonly accounts: AccountManager;
  /**
   * The spine. Plugins are subscribers like any other (PLAN.md §Architecture) — they get no private
   * side channel, and everything they may see arrives through {@link PluginEventsBridge}.
   */
  readonly bus: EventBus;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Overrides the transport. Real plugins are child processes; a test drives a fake through here
   * rather than spawning one.
   */
  readonly factory?: TransportFactory | undefined;
  /**
   * Frames no owner claimed.
   *
   * `PluginDispatcher.handleFrame` and `PluginEventsBridge.handleFrame` both answer `false` for a
   * tag that is not theirs, so the owners chain without any of them knowing the others' tags. What
   * reaches here today is a `hello` or a `pong` the supervisor has already acted on.
   */
  readonly onUnownedFrame?: ((pluginId: string, frame: Envelope) => void) | undefined;
  /**
   * Raised when an install is waiting to be approved.
   *
   * The same two-channel problem the app consent sheet solves (decision 61): a UI client that is
   * connected raises its own sheet, and nothing connected means the daemon has to reach the user
   * some other way. This is the seam for both.
   */
  readonly onConsentPending?: ((pending: PendingPluginConsent) => void) | undefined;
  /** Raised when a plugin draws, patches or closes a panel, for the control stream to forward. */
  readonly onPanelChange?: ((change: PanelChange) => void) | undefined;
}

export interface PluginHost {
  /** Starts every installed, enabled plugin. Never throws for a plugin that cannot start. */
  start(): Promise<void>;
  /** Bounded, and always completes: a wedged plugin must not hold the daemon's shutdown open. */
  stop(): Promise<void>;

  list(): InstalledPluginView[];
  install(rootDir: string, accountIds: readonly string[]): Promise<PluginInstallOutcome>;
  enable(pluginId: string): Promise<void>;
  /** Instant, synchronous, always succeeds. The one control PLAN.md promises will work. */
  disable(pluginId: string): void;
  /**
   * Removes the plugin, and by default its data with it.
   *
   * `keepData` is the reinstall case: a user replacing a plugin with a newer copy of itself has no
   * reason to lose its settings. Deleting is the default because the opposite — data outliving the
   * thing that wrote it, counted against a quota nobody is watching, for a plugin the user believes
   * they removed — is the worse surprise.
   */
  uninstall(pluginId: string, options?: { readonly keepData?: boolean }): Promise<void>;

  /**
   * What this plugin has spent this hour, per budgeted scope, and whether each is still shadowed.
   *
   * Every budgeted scope is returned, including ones the plugin was not granted — `granted` says
   * which. A row that vanished for a scope the plugin does not hold would hide the control exactly
   * when someone wants to confirm it is closed.
   */
  budgets(pluginId: string): PluginBudgetView[];
  /**
   * Lifts or restores dry-run for one scope of one plugin.
   *
   * The explicit per-plugin, per-scope gesture PLAN.md correction 4 and decision 109 require.
   * Never a timer: "it has behaved for seven days" says nothing about the eighth.
   */
  setDryRunLifted(pluginId: string, scope: string, lifted: boolean): void;

  /** Every panel one plugin is currently drawing. Empty for a plugin that draws none. */
  panels(pluginId: string): PanelState[];
  /**
   * Delivers a user action to the plugin and resolves when it has been received.
   *
   * The tree that results arrives separately, as a panel change — the plugin answers this frame to
   * say it heard, then pushes whatever it decided to draw. Keeping the two apart is what lets the
   * host mark one node busy without waiting on a redraw that may never come.
   */
  dispatchIntent(pluginId: string, dispatch: UiIntentDispatch): Promise<void>;

  /** Plugin installs waiting for someone to answer, and the two ways to answer them. */
  readonly consent: {
    pending(): PendingPluginConsent[];
    approve(id: string, approval: ConsentApproval): boolean;
    deny(id: string): boolean;
  };
}

export function createPluginHost(options: PluginHostOptions): PluginHost {
  const { store, accounts } = options;
  const env = options.env;

  /** Why a plugin's bundle was refused, keyed by plugin id. Cleared on the next attempt. */
  const refusals = new Map<string, string>();

  const spawnFor = createSpawnResolver({
    store,
    ...(env === undefined ? {} : { env }),
    onRefused: (pluginId, detail) => {
      refusals.set(pluginId, detail);
      // Loud, and it should be: the hash mismatch this exists for means the file on disk is not the
      // file the user approved.
      console.error(`[plugin ${pluginId}] will not be started: ${detail}`);
    },
  });

  // ---------------------------------------------------------------------------------------------
  // The grant, read live
  // ---------------------------------------------------------------------------------------------

  /**
   * What the user approved for this plugin, or null.
   *
   * Scoped to the row's *current* version, because grants are keyed by `(plugin, version, hash)` and
   * an upgrade that has not been consented to must not inherit the previous version's authority.
   * Newest live grant wins when there is more than one for a version.
   */
  function liveGrant(pluginId: string): PluginGrant | null {
    const row = store.getPlugin(pluginId);
    if (row === null) return null;

    let best: {
      readonly at: number;
      readonly scopes: string;
      readonly accountIds: string;
      readonly capabilities: string;
      readonly events: string;
    } | null = null;
    for (const grant of store.listPluginGrants(pluginId)) {
      if (grant.revoked_at !== null || grant.version !== row.version) continue;
      if (best === null || grant.granted_at > best.at) {
        best = {
          at: grant.granted_at,
          scopes: grant.scopes,
          accountIds: grant.account_ids,
          capabilities: grant.capabilities,
          events: grant.events,
        };
      }
    }
    if (best === null) return null;

    const scopes = jsonStrings(best.scopes).filter(isScope);
    const lifted = new Set(store.listPluginDryRunLifted(pluginId));
    const dryRunScopes = scopes.filter(
      (scope) => SHADOWED_SCOPES.includes(scope) && !lifted.has(scope),
    );

    return {
      pluginId,
      scopes,
      accountIds: jsonStrings(best.accountIds),
      // Migration 006 has stored this since the table existed and this function dropped it on the
      // floor, which was harmless only for as long as no method required one. 3.7 adds methods that
      // do, so a dropped capability is now a denial rather than a no-op.
      capabilities: jsonStrings(best.capabilities).filter(isPluginCapability),
      // What the consent sheet said the plugin would be told about. Enforced by the events bridge
      // from migration 011 onward; before it, this column did not exist and the sheet was a claim
      // nothing kept.
      events: jsonStrings(best.events).filter(isEventPatternString),
      ...(dryRunScopes.length === 0 ? {} : { dryRunScopes }),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Consent
  // ---------------------------------------------------------------------------------------------

  /**
   * Held rather than constructed inline, because the management page reads it.
   *
   * PLAN.md correction 3 asks for "a UI naming who is eating it", and a budget nothing can read is
   * a budget nobody can act on: the point of the number is that a user can see *which* plugin is
   * spending their account's allowance before VRChat's own limiter tells them.
   */
  const budget = new PluginBudget();

  /**
   * The panels every running plugin is drawing.
   *
   * Constructed here rather than inside the method table because two other things need it: the
   * control API reads it for a browser that opened the screen after the panel was drawn, and
   * `syncAttachment` clears a plugin's panels when it stops — a tree that outlived its process is a
   * screen whose every button reaches nobody.
   */
  const panels = new PanelRegistry({
    ...(options.onPanelChange === undefined ? {} : { onChange: options.onPanelChange }),
  });

  const consent = new PluginConsentBroker({
    ...(options.onConsentPending === undefined ? {} : { onPending: options.onConsentPending }),
  });

  // ---------------------------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------------------------

  /**
   * One {@link PluginStorage} per plugin, created on first use and closed when the plugin stops.
   *
   * Held here rather than inside the method table because the *lifecycle* is the host's business:
   * a database has to be closed when a plugin is disabled and deleted when it is uninstalled, and
   * a method table that owned open file handles would have to be told about both.
   */
  const storages = new Map<string, PluginStorage>();

  function storageFor(pluginId: string): PluginStorage {
    const existing = storages.get(pluginId);
    if (existing !== undefined) return existing;
    const created = new PluginStorage(pluginId, { env });
    storages.set(pluginId, created);
    return created;
  }

  function closeStorage(pluginId: string): void {
    storages.get(pluginId)?.close();
    storages.delete(pluginId);
  }

  // ---------------------------------------------------------------------------------------------
  // The dispatcher
  // ---------------------------------------------------------------------------------------------

  const dispatcher = new PluginDispatcher({
    table: {
      ...createStorageMethods({ storageFor }),
      ...createUiMethods({ panels }),
      ...createVrchatMethods({
        /*
         * The account's own request context, tagged with the plugin id so the meter can name who is
         * spending the user's rate limit. Tagging happens here rather than in `Account`, which is
         * what keeps the account unaware that plugins exist at all.
         */
        context: (accountId, pluginId) => {
          const account = accounts.get(accountId);
          if (account === undefined) return null;
          return { ...account.context(), grantId: `${PLUGIN_METER_PREFIX}${pluginId}` };
        },
        account: (accountId): PluginAccountInfo | null => {
          const account = accounts.get(accountId);
          if (account === undefined) return null;
          const snapshot = account.snapshot();
          return {
            id: snapshot.id,
            displayName: snapshot.displayName ?? snapshot.username,
            online: snapshot.state === "online",
          };
        },
      }),
    },
    grants: liveGrant,
    budget,
    onCall: (record) => {
      // The audit hook. A dedicated plugin audit table is 3.8's, alongside the management page that
      // reads it; until then a refusal is worth a line and a success is not worth one per call.
      if (record.code !== null) {
        console.warn(
          `[plugin ${record.pluginId}] ${record.method} refused: ${record.code}` +
            (record.scope === null ? "" : ` (${record.scope})`),
        );
      }
    },
  });

  // ---------------------------------------------------------------------------------------------
  // The events bridge
  // ---------------------------------------------------------------------------------------------

  /**
   * The same `liveGrant` the dispatcher reads, for the same reason and with one difference in
   * cadence: the dispatcher reads it per *call*, the bridge per *flush tick*. Events are orders of
   * magnitude more frequent than calls, and a store read per event would put SQLite in the emit
   * path. See the bridge's file header.
   */
  const events = new PluginEventsBridge({ bus: options.bus, grants: liveGrant });

  // ---------------------------------------------------------------------------------------------
  // Attachment follows state
  // ---------------------------------------------------------------------------------------------

  /**
   * Plugins the dispatcher currently holds a channel for.
   *
   * Tracked rather than re-derived because `attach` detaches first, and detaching aborts in-flight
   * work: calling it on every status emit would cancel a plugin's own calls on every heartbeat.
   */
  const attached = new Set<string>();

  function syncAttachment(status: PluginStatus): void {
    // Attached from `starting`, not from `running`: a plugin is entitled to call the host from
    // inside its own `activate`, and a dispatcher attached only once activation finished would
    // answer `E_UNAVAILABLE` to exactly those calls.
    const live =
      status.state === "starting" || status.state === "activating" || status.state === "running";
    if (live === attached.has(status.pluginId)) return;

    if (!live) {
      dispatcher.detach(status.pluginId);
      events.detach(status.pluginId);
      attached.delete(status.pluginId);
      // A stopped plugin holds no file handle. It also means a `rm -rf` at uninstall is deleting
      // files nothing has open, which is the difference between working and not on Windows.
      closeStorage(status.pluginId);
      // And draws nothing. Every button on a panel is an intent that would reach a dead process.
      panels.closeAll(status.pluginId);
      return;
    }

    const supervisor = registry.get(status.pluginId);
    if (supervisor === null) return;
    const channel = {
      pluginId: status.pluginId,
      // The channel is valid for the supervisor's whole life; `send` answers false while nothing is
      // running. That is the point of the seam — nobody here holds a transport across a restart.
      send: (frame: Envelope) => supervisor.send(frame),
    };
    dispatcher.attach(channel);
    // One channel, two owners. The bridge's subscriptions die with the process for the same reason
    // the dispatcher's in-flight calls do: a `sub` id is a handle on a queue a fresh process has no
    // memory of.
    events.attach(channel);
    attached.add(status.pluginId);
  }

  // ---------------------------------------------------------------------------------------------
  // The registry
  // ---------------------------------------------------------------------------------------------

  const registry = new PluginRegistry({
    store,
    factory: options.factory ?? makeProcessTransportFactory(env === undefined ? {} : { env }),
    spawnFor,
    onPluginFrame: (pluginId, frame) => {
      // Chained rather than branched, so no owner has to know the others' tags: the dispatcher takes
      // `req`/`res`/`err`, the bridge takes `subscribe`/`unsubscribe`/`credit`, and whatever neither
      // claims falls out of the end.
      if (dispatcher.handleFrame(pluginId, frame)) return;
      if (events.handleFrame(pluginId, frame)) return;
      options.onUnownedFrame?.(pluginId, frame);
    },
    onLog: (pluginId, stream, line) => {
      // Attribution and truncation already happened in the transport; this only decides where it
      // goes. Plugin output is the only way an author debugs one, so it is never dropped.
      const message = `[plugin ${pluginId}] ${line}`;
      if (stream === "stderr") console.error(message);
      else console.info(message);
    },
    onStatus: syncAttachment,
    onNotify: (notification) => {
      // 3.8 puts this in front of the user properly. A plugin the daemon turned off on its own is
      // not something to discover by reading a log, but a log line is better than silence.
      console.warn(`[vrc.zip] ${notification.title}: ${notification.body}`);
    },
  });

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  function manifestOf(pluginId: string): PluginManifest | null {
    const row = store.getPlugin(pluginId);
    if (row === null) return null;
    try {
      const parsed = parseManifest(JSON.parse(row.manifest));
      return parsed.ok ? parsed.manifest : null;
    } catch {
      return null;
    }
  }

  function view(status: PluginStatus): InstalledPluginView {
    const row = store.getPlugin(status.pluginId);
    const manifest = manifestOf(status.pluginId);
    const grant = liveGrant(status.pluginId);
    return {
      status,
      name: manifest?.name ?? status.pluginId,
      publisher: manifest?.publisher ?? "unknown",
      installedAt: row?.installed_at ?? 0,
      scopes: grant?.scopes ?? [],
      accountIds: grant?.accountIds ?? [],
      refusal: refusals.get(status.pluginId) ?? null,
    };
  }

  return {
    async start() {
      await registry.startAll();
    },

    async stop() {
      // Detaching before the stop, so a plugin's last-gasp call cannot arrive at a dispatcher whose
      // channel is about to write into a dead process. `stopAll` is bounded and always returns.
      for (const pluginId of attached) dispatcher.detach(pluginId);
      // And the bus registrations with them, so a stopped daemon has no plugin subscriber left
      // queueing events for a process that is on its way out.
      events.detachAll();
      attached.clear();
      // An unanswered question is not a yes. Every waiting install fails rather than proceeding.
      consent.shutdown();
      await registry.stopAll();
    },

    list() {
      return registry.statuses().map(view);
    },

    async install(rootDir, accountIds) {
      /*
       * First install is exactly when a runtime is first needed (decision 165). From a source
       * checkout this is a stat and nothing is downloaded — `resolvePluginRuntime` answers with the
       * `bun` the daemon is itself running under.
       */
      const runtime = await ensurePluginRuntime(env === undefined ? {} : { env });
      if (!runtime.ok) return { ok: false, stage: "runtime", message: runtime.detail };

      const built = await installPluginFromDirectory(rootDir, env === undefined ? {} : { env });
      if (!built.ok) {
        return { ok: false, stage: built.stage, message: formatInstallFailure(built) };
      }

      const now = Date.now();
      const manifest = built.manifest;

      store.upsertPlugin({
        id: manifest.id,
        version: manifest.version,
        // The manifest **as accepted**, not a re-read of the author's file. It is what the user was
        // shown, and that is a historical fact rather than a view of disk.
        manifest: JSON.stringify(manifest),
        bundle_hash: built.bundleHash,
        // The pipeline says `"local"`; migration 006's column documents `'path' | 'git'`. The
        // schema's vocabulary wins here, since it is what a later reader will grep for.
        source_kind: built.sourceKind === "local" ? "path" : built.sourceKind,
        source_ref: built.sourceRef,
        installed_at: store.getPlugin(manifest.id)?.installed_at ?? now,
        updated_at: now,
      });

      /*
       * Consent. The install parks here until a person answers, and **nothing above this point is
       * authority** — the row records that a bundle was compiled and stored, which is a fact about
       * disk, while the grant below records that somebody agreed to it. Keeping the two separate is
       * what lets a denial leave an installed-but-ungranted plugin that starts nothing.
       */
      const previous = liveGrant(manifest.id);
      const decision = await consent.ask({
        manifest,
        isUpdate: previous !== null,
        // What this version asks for that the last approved one did not. The sheet sorts these
        // first, because "this update wants more" is the question a re-prompt exists to answer.
        newScopes:
          previous === null
            ? []
            : manifest.permissions.scopes.filter((scope) => !previous.scopes.includes(scope)),
        source: built.sourceRef,
      });

      if (!decision.ok) {
        // The plugin stays installed and ungranted rather than being rolled back. It cannot start
        // without a grant, and leaving the artifact means a user who denied by accident, or walked
        // away and let it time out, does not have to rebuild it to be asked again.
        return {
          ok: false,
          stage: "consent",
          message:
            decision.reason === "denied"
              ? "You declined to install this plugin. Nothing was granted, and it will not run."
              : decision.reason === "timeout"
                ? "The consent request expired before it was answered. Nothing was granted."
                : "vrc.zip shut down before the consent request was answered. Nothing was granted.",
        };
      }

      const approved = narrowToRequest(manifest, decision.approval);

      store.insertPluginGrant({
        plugin_id: manifest.id,
        version: manifest.version,
        // Hashed over what the *manifest* asked, not over what was approved: the hash is the
        // identity of the question, and a narrower answer to the same question must not read as a
        // different question the next time it is asked.
        grant_hash: grantHash(manifest),
        scopes: JSON.stringify(approved.scopes),
        account_ids: JSON.stringify(approved.accountIds),
        capabilities: JSON.stringify(approved.capabilities),
        domains: JSON.stringify(manifest.permissions.fetch.domains),
        events: JSON.stringify(approved.events),
        granted_at: now,
      });
      /* ================================================================================= */

      // Everything but the artifact that was just installed. A rollback is a rename, so the old one
      // is only dead once a newer install has landed.
      pruneArtifacts(manifest.id, built.bundleHash, env);
      refusals.delete(manifest.id);

      // `enable` rather than `start`: reinstalling a plugin that crash-looped its way to disabled is
      // a deliberate gesture, and it must clear the sticky record or the install does nothing.
      await registry.enable(manifest.id);

      const status = registry.statuses().find((entry) => entry.pluginId === manifest.id);
      return {
        ok: true,
        plugin:
          status === undefined
            ? {
                status: {
                  pluginId: manifest.id,
                  state: "idle",
                  restarts: 0,
                  missedBeats: 0,
                  rssBytes: null,
                  lastFailure: null,
                  disabled: null,
                  restartAt: null,
                  version: manifest.version,
                  disabledReason: null,
                  disabledBy: null,
                },
                name: manifest.name,
                publisher: manifest.publisher,
                installedAt: now,
                scopes: manifest.permissions.scopes,
                accountIds: [...accountIds],
                refusal: null,
              }
            : view(status),
      };
    },

    async enable(pluginId) {
      refusals.delete(pluginId);
      await registry.enable(pluginId);
    },

    disable(pluginId) {
      registry.disable(pluginId);
    },

    budgets(pluginId) {
      const grant = liveGrant(pluginId);
      const lifted = new Set(store.listPluginDryRunLifted(pluginId));
      return SHADOWED_SCOPES.map((scope) => {
        const usage = budget.usage(pluginId, scope);
        return {
          scope,
          granted: grant?.scopes.includes(scope) ?? false,
          used: usage.used,
          limit: usage.limit,
          windowMs: usage.windowMs,
          // Shadowed unless explicitly lifted. The safe state is the one you get from having no row.
          dryRun: !lifted.has(scope),
        };
      });
    },

    setDryRunLifted(pluginId, scope, lifted) {
      if (lifted) store.liftPluginDryRun(pluginId, scope, Date.now());
      else store.restorePluginDryRun(pluginId, scope);
    },

    panels: (pluginId) => panels.list(pluginId),

    async dispatchIntent(pluginId, dispatch) {
      // `ui.intent` is the one method the *host* calls on the plugin. The dispatcher already owns
      // the deadline and the late-reply drop, so this is a thin forward.
      await dispatcher.call(pluginId, "ui.intent", dispatch as unknown as JsonValue);
    },

    consent: {
      pending: () => consent.pending(),
      approve: (id, approval) => consent.approve(id, approval),
      deny: (id) => consent.deny(id),
    },

    uninstall(pluginId, uninstallOptions) {
      // Kill first. Everything below removes files and rows the running process may still be using,
      // and `disable` is the one path that is instant and cannot be held open by the plugin.
      registry.disable(pluginId, "user", "Uninstalled.");
      dispatcher.detach(pluginId);
      events.detach(pluginId);
      attached.delete(pluginId);
      refusals.delete(pluginId);

      // Revoked before the row goes, so the history says the access ended rather than that it never
      // existed. `plugin_grants` cascades on delete; `plugin_crashes` deliberately does not.
      store.revokePluginGrants(pluginId, Date.now());
      store.deletePlugin(pluginId);
      removeArtifacts(pluginId, env);

      // The data directory. Closed first — an open SQLite handle makes the delete fail outright on
      // Windows rather than partially — then removed unless the caller asked to keep it. It lives
      // outside `plugins/<id>/` precisely so that this is one decision about one directory.
      closeStorage(pluginId);
      if (uninstallOptions?.keepData !== true) {
        rmSync(pluginDataDir(pluginId, env), { recursive: true, force: true });
      }

      return Promise.resolve();
    },
  };
}

/** A stored JSON array of strings, defensively. A row that cannot be read grants nothing. */
function jsonStrings(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}
