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
 * **What it deliberately does not own:** consent (3.8), the events bridge (3.6), per-plugin storage
 * (3.7). Frames the dispatcher does not claim are handed to {@link PluginHostOptions.onUnownedFrame}
 * exactly so 3.6 can chain behind it without this file learning what a subscription is.
 */

import {
  type Envelope,
  grantHash,
  type PluginGrant,
  type PluginManifest,
  parseManifest,
} from "@vrcz/plugin-api";
import { isScope, type Scope } from "@vrcz/shared";
import type { AccountManager } from "../accounts/manager.ts";
import { PluginBudget } from "../plugins/budget.ts";
import { PluginDispatcher } from "../plugins/dispatcher.ts";
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
import type { TransportFactory } from "../plugins/transport.ts";
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
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Overrides the transport. Real plugins are child processes; a test drives a fake through here
   * rather than spawning one.
   */
  readonly factory?: TransportFactory | undefined;
  /**
   * Frames the dispatcher did not claim: `subscribe`, `unsubscribe`, `credit`.
   *
   * `PluginDispatcher.handleFrame` answers `false` for exactly those so the owners can be chained
   * without any of them knowing the others' tags. 3.6's events bridge is the next link.
   */
  readonly onUnownedFrame?: ((pluginId: string, frame: Envelope) => void) | undefined;
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
  uninstall(pluginId: string): Promise<void>;
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

    let best: { readonly at: number; readonly scopes: string; readonly accountIds: string } | null =
      null;
    for (const grant of store.listPluginGrants(pluginId)) {
      if (grant.revoked_at !== null || grant.version !== row.version) continue;
      if (best === null || grant.granted_at > best.at) {
        best = { at: grant.granted_at, scopes: grant.scopes, accountIds: grant.account_ids };
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
      ...(dryRunScopes.length === 0 ? {} : { dryRunScopes }),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // The dispatcher
  // ---------------------------------------------------------------------------------------------

  const dispatcher = new PluginDispatcher({
    table: createVrchatMethods({
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
    grants: liveGrant,
    budget: new PluginBudget(),
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
      attached.delete(status.pluginId);
      return;
    }

    const supervisor = registry.get(status.pluginId);
    if (supervisor === null) return;
    dispatcher.attach({
      pluginId: status.pluginId,
      // The channel is valid for the supervisor's whole life; `send` answers false while nothing is
      // running. That is the point of the seam — nobody here holds a transport across a restart.
      send: (frame) => supervisor.send(frame),
    });
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
      // `handleFrame` answers false for `subscribe` / `unsubscribe` / `credit`, which belong to the
      // events bridge. Chained rather than branched here so no owner has to know the others' tags.
      if (!dispatcher.handleFrame(pluginId, frame)) {
        options.onUnownedFrame?.(pluginId, frame);
      }
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
      attached.clear();
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
        // Never self-declared, and never anything but this until 3.8 verifies a signature.
        trust: "unsigned",
        publisher_key: null,
        installed_at: store.getPlugin(manifest.id)?.installed_at ?? now,
        updated_at: now,
      });

      /*
       * ================== 3.8 REPLACES EVERYTHING BETWEEN THESE LINES ==================
       *
       * The grant is written here, from the manifest, without asking anyone. That is a placeholder
       * and nothing more: PLAN.md's consent flow — the account picker, the dangerous block behind a
       * second toggle, hold-to-confirm on the unsigned tier — is step 3.8, and it is what turns
       * "the author requested this" into "the user approved this".
       *
       * Two properties are kept even so, because losing them would be a security regression rather
       * than an unfinished feature:
       *
       *  - The grant is a **row**, keyed by `(plugin, version, grantHash)` exactly as it will be
       *    after 3.8, so the gate reads what was approved and never the manifest.
       *  - `accountIds` defaults to **nothing**, and only what the caller explicitly names is
       *    granted. Defaulting to every account the daemon holds would be the exact over-grant the
       *    account picker exists to prevent, and under-permitting is the direction a placeholder is
       *    allowed to be wrong in.
       */
      store.insertPluginGrant({
        plugin_id: manifest.id,
        version: manifest.version,
        grant_hash: grantHash(manifest),
        scopes: JSON.stringify(manifest.permissions.scopes),
        account_ids: JSON.stringify([...accountIds]),
        capabilities: JSON.stringify(manifest.permissions.capabilities),
        domains: JSON.stringify(manifest.permissions.fetch.domains),
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
                  trust: "unsigned",
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

    uninstall(pluginId) {
      // Kill first. Everything below removes files and rows the running process may still be using,
      // and `disable` is the one path that is instant and cannot be held open by the plugin.
      registry.disable(pluginId, "user", "Uninstalled.");
      dispatcher.detach(pluginId);
      attached.delete(pluginId);
      refusals.delete(pluginId);

      // Revoked before the row goes, so the history says the access ended rather than that it never
      // existed. `plugin_grants` cascades on delete; `plugin_crashes` deliberately does not.
      store.revokePluginGrants(pluginId, Date.now());
      store.deletePlugin(pluginId);
      removeArtifacts(pluginId, env);

      // The plugin's own data directory is left alone on purpose: it lives outside `plugins/<id>/`
      // precisely so that keeping data across an uninstall-reinstall is a decision rather than an
      // accident of layout. 3.7 owns that decision.
      //
      // A promise even though every step above is synchronous: uninstall will grow a `rm -rf` over
      // that directory the moment 3.7 gives the user the choice, and a caller that has to be
      // rewritten to await it then is a caller that will not be.
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
