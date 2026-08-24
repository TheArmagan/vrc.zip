import { resolve } from "node:path";
import { launchUrl as buildLaunchUrl, DEFAULT_HOSTNAME, type JsonValue } from "@vrcz/shared";
import { CookieJar } from "./accounts/cookie-jar.ts";
import { AccountManager } from "./accounts/manager.ts";
import { NotificationService } from "./accounts/notifications.ts";
import { PresenceService } from "./accounts/presence.ts";
import { EventBus } from "./bus/event-bus.ts";
import { type ForwardProxy, forwardProxyBanner, startForwardProxy } from "./forward-proxy/index.ts";
import { discoverLogDirectories, LogWatcher } from "./game-logs/index.ts";
import { createBuiltinNodes, type GraphReads } from "./graphs/builtins/index.ts";
import { GraphEngine } from "./graphs/index.ts";
import { RateLimiter } from "./net/rate-limiter.ts";
import { RequestMeter } from "./net/request-meter.ts";
import { buildUserAgent } from "./net/user-agent.ts";
import { DesktopNotifier } from "./os/desktop-notification.ts";
import { installedVersion, installLocally, installTarget, isInstalled } from "./os/install.ts";
import { openExternalUrl, openUrl, openVrchatLaunch } from "./os/open-url.ts";
import { createStartupControl } from "./os/startup.ts";
import { databasePath, ensureStateDir } from "./paths.ts";
import { PipelineClient } from "./pipeline/index.ts";
import type { PendingPluginConsent } from "./plugins/consent.ts";
import type { PanelChange, PluginToast } from "./plugins/ui-panels.ts";
import { ConsentRegistry } from "./proxy/consent.ts";
import { PipelineMirror } from "./proxy/pipeline-mirror.ts";
import { createProxyLogger, PROXY_LOG_ENV } from "./proxy/request-log.ts";
import { loadOrCreateMasterKey } from "./security/keychain.ts";
import { SecretsStore } from "./security/secrets.ts";
import { resolveSessionToken } from "./security/session-token.ts";
import { readStateFile, removeStateFile, writeStateFile } from "./security/state-file.ts";
import { isPackaged } from "./servers/embedded-ui.ts";
import { type BoundServers, bindServers, createAppApi } from "./servers/index.ts";
import { loadSettings, needsFirstRun, type Settings, saveSettings } from "./settings.ts";
import { type RetentionScheduler, Store, startRetentionScheduler } from "./store/index.ts";
import { WebhookManager } from "./webhooks/index.ts";
import { createAppApiDeps } from "./wiring/app-api-deps.ts";
import { attachConsentAlerts } from "./wiring/consent-alert.ts";
import { createControlDeps } from "./wiring/control-deps.ts";
import { FeedWriter } from "./wiring/feed-writer.ts";
import { createGraphApi } from "./wiring/graph-api.ts";
import { createGraphData } from "./wiring/graph-data.ts";
import { PluginNodeProvider } from "./wiring/graph-provider.ts";
import { createGraphReads } from "./wiring/graph-reads.ts";
import { createLogSink } from "./wiring/log-bridge.ts";
import { attachNotificationActivations } from "./wiring/notification-activation.ts";
import { NotificationSink } from "./wiring/notification-sink.ts";
import { publishPipelineEvent } from "./wiring/pipeline-bridge.ts";
import { createPluginHost } from "./wiring/plugin-host.ts";
import { createSelfActions } from "./wiring/self-actions.ts";
import { createSocialActions } from "./wiring/social-actions.ts";
import { createToastImageResolver } from "./wiring/toast-image.ts";
import { createTriggerContext } from "./wiring/trigger-context.ts";
import { UpdateDiffSet } from "./wiring/update-diff.ts";
import { attachWebhookBridge } from "./wiring/webhook-bridge.ts";

/**
 * The composition root. Everything is constructed here and nowhere else, which is what makes the
 * dependency directions in the rest of the daemon checkable by eye: no module reaches out for a
 * singleton, so no module can quietly acquire a dependency it shouldn't have.
 *
 * Startup order is load-bearing in two places, both noted below.
 */

/** See the `anonymousJar` comment in `startDaemon`. Never collides: real ids are `usr_<uuid>`. */
const ANONYMOUS_ACCOUNT_ID = "vrczip:anonymous";

export interface DaemonOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides the VRChat base URL. Tests point this at the recorded fixture. */
  readonly baseUrl?: string;
  /**
   * Overrides the pipeline WebSocket endpoint. Tests point this at a local fixture socket — the
   * only way "two accounts, two independent sockets" (PLAN.md §1.10) is testable at all, since
   * nothing else in the daemon can stand two real sockets up against `pipeline.vrchat.cloud`.
   */
  readonly pipelineUrl?: string;
}

export interface RunningDaemon {
  readonly bus: EventBus;
  readonly store: Store;
  readonly accounts: AccountManager;
  readonly servers: BoundServers;
  /** Null when the forward proxy is switched off in settings, or when it failed to start. */
  readonly forwardProxy: ForwardProxy | null;
  readonly settings: Settings;
  /**
   * The outbound webhook subsystem. Exposed for the same reason `servers` is: the control API's
   * webhook routes are mounted against this instance, and a second `WebhookManager` over the same
   * store would be a second scanner racing the first for the same delivery rows.
   */
  readonly webhooks: WebhookManager;
  readonly sessionToken: string;
  readonly launchUrl: string;
  /**
   * Lines for the entry point to print after the URL block.
   *
   * Returned rather than logged from wherever they arise, so that everything a user reads at
   * startup is ordered by what it *means* — addresses first, then the things to do about them —
   * instead of by which subsystem happened to construct itself first.
   */
  readonly startupNotes: readonly string[];
  stop(): Promise<void>;
}

/**
 * Where the daemon may be pointed instead of VRChat, and the rule that keeps that safe.
 *
 * `DaemonOptions.baseUrl` and `pipelineUrl` have existed since Phase 1 for the integration tests,
 * which construct the daemon in-process. Nothing could set them from outside, so a manual run
 * against a stand-in — a smoke test, the screenshot pipeline in `tools/src/docs/` — had no way to
 * exist without importing the daemon into another package.
 *
 * **Loopback only, and that is a safety property rather than a convenience.** These are the two
 * addresses the user's VRChat password is sent to. An env var that could name any host is a way to
 * talk somebody into exfiltrating their own credentials with a one-line change to a `.env` file, so
 * anything that is not `127.0.0.1`/`::1`/`localhost` is refused loudly at startup rather than
 * quietly ignored — ignoring it would be worse, since the run would then look like it worked.
 */
export const UPSTREAM_ENV = {
  base: "VRCZIP_VRCHAT_BASE_URL",
  pipeline: "VRCZIP_PIPELINE_URL",
} as const;

export function readUpstreamOverride(
  env: NodeJS.ProcessEnv,
  key: (typeof UPSTREAM_ENV)[keyof typeof UPSTREAM_ENV],
): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim();
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new Error(`${key} is not a URL: ${value}`);
  }
  if (host !== "127.0.0.1" && host !== "::1" && host !== "[::1]" && host !== "localhost") {
    throw new Error(
      `${key} may only point at this machine (127.0.0.1, ::1 or localhost). ` +
        `Refusing ${host}: that address would receive your VRChat password.`,
    );
  }
  return value;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const env = options.env;
  /*
   * The explicit option wins over the environment: a test that constructed the daemon with a
   * fixture URL must not have it changed by whatever is in the developer's shell.
   */
  const baseUrl = options.baseUrl ?? readUpstreamOverride(env ?? process.env, UPSTREAM_ENV.base);
  const pipelineUrl =
    options.pipelineUrl ?? readUpstreamOverride(env ?? process.env, UPSTREAM_ENV.pipeline);

  // Before anything else touches the filesystem. Nothing below creates its own parent directory,
  // and the failure without this is an opaque SQLITE_CANTOPEN on every genuinely fresh install.
  ensureStateDir(env);

  const settings = await loadSettings(env);

  const masterKey = await loadOrCreateMasterKey(env);
  if (masterKey.degraded) {
    console.warn(
      "[vrc.zip] No OS keychain available — the master key is in a 0600 file. " +
        "Credentials are still encrypted, but anyone who can read your home directory can decrypt them.",
    );
  }

  const secrets = await SecretsStore.open(masterKey, env);
  const store = Store.open(databasePath(env));
  const bus = new EventBus();
  bus.onError((error, event) => {
    console.error(`[bus] subscriber failed on ${event.kind}:`, error);
  });

  const limiter = new RateLimiter();
  // The limiter knows the ceiling; this is what the daemon actually spends against it, per account
  // and per connected app. See `net/request-meter.ts` — without it the shell can only ever render
  // the configured limit and call it a reading.
  const meter = new RequestMeter();
  // Hourly, jittered like everything else that runs on a clock here, and `unref`ed so it cannot
  // hold the process open. Nothing breaks if it never runs; idle series simply stay allocated.
  const meterPrune = setInterval(() => meter.prune(), 3_600_000 + Math.random() * 600_000);
  meterPrune.unref?.();

  // First run has no contact string, so no honest User-Agent can be built. The daemon still starts
  // — the user needs the UI in order to supply one — but nothing may talk to VRChat until they do.
  // See PLAN.md §1.4: a placeholder contact is worse than none.
  const userAgent = needsFirstRun(settings) ? null : buildUserAgent(settings.contact);

  const accounts = new AccountManager({
    secrets,
    bus,
    limiter,
    meter,
    userAgent: userAgent ?? "",
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  if (userAgent) await accounts.loadAll();

  // ORDER MATTERS: `events` and `sessions` carry a foreign key to `accounts`, so every account
  // needs a row before anything can reference it. Attaching the feed writer first would drop the
  // first batch of every cold start.
  for (const snapshot of accounts.list()) {
    store.upsertAccount({
      id: snapshot.id,
      display_name: snapshot.displayName ?? snapshot.username,
      added_at: Date.now(),
      enabled: 1,
      last_seen_at: snapshot.state === "online" ? Date.now() : null,
    });
  }

  const feedWriter = new FeedWriter(store);
  feedWriter.attach(bus);

  // Notifications are state rather than history — the UI needs the current set on a cold start,
  // not a feed to replay. See NotificationSink.
  const notifications = new NotificationSink(store);
  notifications.attach(bus);

  // --- pipeline sockets, one per online account -----------------------------
  // One real socket per account, fanned out to however many apps are connected. That ratio is the
  // whole reason the mirror exists: every extra socket against `pipeline.vrchat.cloud` is another
  // session against an undisclosed cap. See PLAN.md §Phase 2.
  const pipelineMirror = new PipelineMirror({
    onViolation: ({ accountId, type }) => {
      console.error(
        `[vrc.zip] PIPELINE MIRROR WITHHELD A FRAME: a real VRChat credential appeared in a ` +
          `${type} frame for ${accountId}. Connected apps did not receive it. See PLAN.md §Phase 2.`,
      );
    },
  });

  const pipelines = new Map<string, PipelineClient>();

  /*
   * The previous copy of everything the pipeline announces changes to without saying what changed
   * — profiles and the wallet — so a frame can be resolved into the field it moved. Owned here
   * rather than by the bridge because the bridge is a pure mapping and this is state, and because
   * account removal has to be able to drop it.
   */
  const updateDiffs = new UpdateDiffSet();

  function connectPipeline(accountId: string): void {
    if (pipelines.has(accountId) || !userAgent) return;

    const client = new PipelineClient({
      userAgent,
      ...(pipelineUrl !== undefined ? { url: pipelineUrl } : {}),
      // Re-read on every attempt rather than captured once: a reconnect after a re-auth must use
      // the new token, and the old one is exactly what a stale closure would hand it.
      getAuthToken: async () => accounts.get(accountId)?.authToken() ?? "",
      onEvent: (decoded) => {
        publishPipelineEvent(bus, accountId, decoded, updateDiffs);
        // The mirror gets the frame as it arrived, not the normalised bus event: its contract is
        // VRChat's wire format, and the bus event is deliberately a different shape.
        pipelineMirror.publish(accountId, decoded);
      },
      onReauthRequired: () => {
        void accounts.get(accountId)?.reauthenticate();
      },
      onStateChange: (change) => {
        bus.emit({
          kind: "pipeline.state",
          accountId,
          ts: Date.now(),
          payload: change,
        });
      },
    });
    client.start();
    pipelines.set(accountId, client);
  }

  for (const snapshot of accounts.list()) {
    if (snapshot.state === "online") connectPipeline(snapshot.id);
  }

  // An account that comes online later — a fresh login, or a 2FA challenge answered — gets its
  // socket here rather than at every call site that might cause it. `account.ready` rather than
  // `account.state`, because the latter fires before the manager has filed the account under its
  // real id. See AccountManager#announceReady.
  bus.subscribe(
    (event) => {
      if (event.accountId) connectPipeline(event.accountId);
    },
    { kinds: ["account.ready"] },
  );

  // Removing an account drops the profiles remembered through it. Not for the memory, which is
  // trivial, but so that re-adding the account starts from "no previous copy" rather than diffing
  // today's frames against snapshots taken before it was removed.
  bus.subscribe(
    (event) => {
      if (event.accountId) updateDiffs.forget(event.accountId);
    },
    { kinds: ["account.removed"] },
  );

  // --- friend presence ------------------------------------------------------
  const presence = new PresenceService({ accounts, store, bus });
  presence.start();

  // --- notification backfill -------------------------------------------------
  // The sink below persists what the *socket* delivers; this fetches what was already pending
  // before we connected. Without it the Notifications screen only ever shows what happened to
  // arrive while the daemon was watching, which on a real account means an empty screen and a
  // three-hundred-item backlog nobody can see.
  const notificationSync = new NotificationService({ accounts, store, bus });
  notificationSync.start();

  // --- game log watcher -----------------------------------------------------
  const logDirectories =
    settings.logDirectories.length > 0
      ? settings.logDirectories
      : (await discoverLogDirectories()).map((candidate) => candidate.path);

  const watcher = new LogWatcher({
    directories: logDirectories,
    sink: createLogSink(store, bus),
    // Attributes a log file to an account. Returns null for a client signed into an account
    // vrc.zip does not manage, which keeps the session unlinked rather than misattributed.
    resolveAccountId: (userId) => accounts.get(userId)?.id ?? null,
    /*
     * Persistent read positions, so a restart resumes each log rather than replaying it.
     *
     * Without this the watcher re-read every `output_log_*.txt` in the directory from byte 0 on
     * every start and re-emitted every line as a fresh event — one full replay of the user's
     * whole log history per daemon start, which under `bun --watch` is one per code edit. The
     * feed showed the result as six identical "Client quit" rows for one shutdown. Migration 007
     * has the long version and cleans up what already accumulated.
     */
    offsets: {
      get: (logKey) => store.getLogOffset(logKey)?.byte_offset ?? null,
      set: (logKey, logPath, byteOffset) => {
        store.putLogOffset(logKey, logPath, byteOffset);
      },
      reset: (logKey) => {
        store.deleteLogOffset(logKey);
      },
    },
  });
  watcher.start();

  // --- retention ------------------------------------------------------------
  const retention: RetentionScheduler = startRetentionScheduler(store);

  // --- outbound webhooks ----------------------------------------------------
  // Constructed after the store and the bus and before the servers, because the control API is
  // handed this instance to mount `register`/`list`/`remove` against.
  //
  // `start()` only begins the scan loop that drains the durable queue; a delivery left pending by
  // the previous run — including one that was mid-backoff when the daemon stopped — is picked up by
  // the first scan, which is the entire reason that queue is a table. Attaching the bridge before
  // starting the scanner is harmless in either order: `onEvent` writes rows, it never sends.
  const webhooks = new WebhookManager({
    store,
    onError: (error, context) => {
      console.error(`[webhooks] ${context}:`, error);
    },
  });
  const detachWebhooks = attachWebhookBridge({ bus, manager: webhooks });
  webhooks.start();

  // --- plugins --------------------------------------------------------------
  // Constructed here and started at the very end, and the gap between the two is deliberate: the
  // control API is handed this instance to mount its management routes against, so it has to exist
  // before `bindServers`; but a plugin process is a spawn, and nothing the user is waiting for
  // should queue behind N of them. See `wiring/plugin-host.ts` for what it holds together.
  /*
   * Assigned once the session URL and the stream-client count exist, both of which are built well
   * below this point. A holder rather than a forward reference so the ordering is stated rather
   * than relied on: an install cannot happen before the servers are up, but a closure that would
   * throw if it did is not something to leave to reading order.
   */
  /*
   * The notifier, and the two holders it needs.
   *
   * It is constructed here rather than reached for, like everything else in this file — it owns the
   * live toasts and the COM handlers Windows calls back into, and a second one would be a second set
   * of those in a process that can only have one. Both of its outward-facing dependencies are
   * assigned below: `launchUrl` needs a bound port and a session token, and the image resolver needs
   * the control deps, which need the plugin host, which needs this. Same holder shape and same
   * reason as `publishToast` underneath.
   */
  let launchUrl = "";
  let resolveToastImage: (source: string) => Promise<string | null> = async () => null;

  const notifier = new DesktopNotifier({
    ...(env !== undefined ? { env } : {}),
    // Two openers, because they are two different rules: `openUrl` refuses anything off loopback
    // (it is handed URLs with a session token in them) and would silently do nothing for a public
    // link. Routing a notification's button through the wrong one is a button that does not work.
    openUrl: (url) => {
      void openExternalUrl(url);
    },
    openScreen: (path) => {
      if (launchUrl === "") return;
      void openUrl(`${launchUrl}#${path}`);
    },
    resolveImage: async (source) => await resolveToastImage(source),
  });

  let publishToast: (toast: PluginToast) => void = () => {
    // Nothing is attached yet, and a toast is by nature about *now* — queuing one for whoever
    // connects later would show a stale message to someone who was not there.
  };

  let publishPanelChange: (change: PanelChange) => void = () => {
    // Before the servers exist there is no browser to tell, and the panel is already stored — a
    // reader that connects later gets it from `GET /api/plugins/:id/panels`.
  };

  let alertPluginConsent: (pending: PendingPluginConsent) => void = (pending) => {
    console.warn(
      `[vrc.zip] ${pending.manifest.name} ${pending.manifest.version} is waiting to be installed, before the daemon finished starting.`,
    );
  };

  const plugins = createPluginHost({
    store,
    accounts,
    // Plugins are bus subscribers like everything else; the events bridge inside the host is what
    // turns a subscription frame into a filtered, credited, batched view of this stream.
    bus,
    ...(env !== undefined ? { env } : {}),
    /*
     * An install now parks until somebody answers, so a request nobody can see is a request that
     * times out five minutes later with no explanation. This is the minimum honest thing: say in
     * the log that something is waiting and where to answer it.
     *
     * It is deliberately not the whole of decision 61's two-channel treatment — a Web Notification
     * when a UI client is connected, an OS notification and a browser when none is. That belongs
     * with 3.8's consent screen, which is what the second channel would open.
     */
    onConsentPending: (pending) => alertPluginConsent(pending),
    // Forwarded to every attached browser. The holder is assigned once `deps` exists, for the same
    // ordering reason as the consent alert above.
    onPanelChange: (change) => publishPanelChange(change),
    onToast: (toast) => publishToast(toast),
    // The other end of `nodes.fire`, wired to nothing until Phase 4 existed. The provider owns the
    // instance table, so an id from a trigger that has since been disarmed starts nothing.
    onNodeFire: (event) => {
      nodeProvider.onFire(event);
    },
  });

  // --- graphs ---------------------------------------------------------------
  // The engine is constructed here and started with the rest of the daemon, but it is *armed* from
  // the database: a graph the user switched off is not armed, and switching one on is a `reload`
  // from the control API rather than a restart.
  // One instance, handed to both the control deps and the graph action nodes: two copies would be
  // two places for a future rate budget or audit hook to be added to, and only one would get it.
  const social = createSocialActions({ accounts, store });
  // The other half of that pair: the things vrc.zip does to the user's *own* account, which the Me
  // nodes are made of. Separate from `social` because it is a different kind of act — see the file.
  const self = createSelfActions({ accounts, store });
  /*
   * The resolver nodes read through the control deps, which do not exist yet — they are built below
   * and need the plugin host, which needs this. A holder rather than a forward reference, the same
   * shape (and the same reason) as `publishToast` above: the ordering is stated rather than relied
   * on, and a resolver that somehow ran first fails with a sentence instead of a null dereference.
   */
  let graphReads: GraphReads | undefined;
  const graphData = createGraphData(store);
  const builtinNodes = createBuiltinNodes({
    bus,
    social,
    self,
    // The one node in the Me set that touches the machine rather than VRChat. `attach` is the
    // node's own config, defaulting on, so a running client shows the instance instead of a second
    // client starting up and fighting the first for the account.
    launch: async (location, attach) => await openVrchatLaunch(location, attach),
    // What a trigger asks about the world as it fires. Both answers come from memory — the open
    // sessions and the presence map — because a map runs inside a bus subscription and a burst of
    // forty player-joins runs it forty times per armed graph.
    triggerContext: createTriggerContext({ store, presence }),
    reads: {
      user: async (accountId, userId) => await requireReads().user(accountId, userId),
      world: async (accountId, worldId) => await requireReads().world(accountId, worldId),
      instance: async (accountId, location) => await requireReads().instance(accountId, location),
      avatar: async (accountId, avatarId) => await requireReads().avatar(accountId, avatarId),
      group: async (accountId, groupId) => await requireReads().group(accountId, groupId),
      friends: async (accountId) => await requireReads().friends(accountId),
      instancePlayers: (accountId) => requireReads().instancePlayers(accountId),
    },
    // Every VRChat operation the spec describes, as a node. Through the account, the limiter and
    // the User-Agent like everything else — see `wiring/graph-api.ts`.
    api: createGraphApi({ accounts }),
    // The same notifier the consent alert uses, so a graph's toast and the daemon's own look alike
    // and obey the same suppression switch. It never rejects and reports whether anything actually
    // appeared, which is what the node hands back on its `Shown` port.
    notify: async (notification) => await notifier.notify(notification),
    // The cooldown and counter nodes. Four SQL statements behind a two-method seam, so the graph
    // runtime never learns that SQLite is under there.
    state: {
      get: (graphId, nodeId, key) => store.getGraphState(graphId, nodeId, key),
      put: (graphId, nodeId, key, value, at) => {
        store.putGraphState(graphId, nodeId, key, value, at);
      },
    },
    // The named stores, which are the *shared* half: `state` above is private to one node, this is
    // addressed by name and read by whoever names it. The same object the plugin host gets, because
    // "shared" has to mean the same rows. See `wiring/graph-data.ts`.
    data: graphData,
  });

  function requireReads(): GraphReads {
    if (graphReads === undefined) {
      throw new Error("vrc.zip is still starting up. Try this graph again in a moment.");
    }
    return graphReads;
  }
  const nodeProvider = new PluginNodeProvider({ host: plugins, builtins: builtinNodes });
  const graphs = new GraphEngine({
    store,
    bus,
    provider: nodeProvider,
    // Read per execution rather than snapshotted: a secret the user changes takes effect on the
    // next node that needs it, not on the next restart.
    secrets: (graphId, nodeId, fieldId) => secrets.graphSecret(graphId, nodeId, fieldId),
  });
  // Into the *same* registry a plugin's node types land in, so the palette and the type checker ask
  // one place. See `NodeRegistry.registerBuiltin`.
  plugins.registerBuiltinNodes(builtinNodes.definitions());

  // --- servers --------------------------------------------------------------
  // Must read `state.json` before `writeStateFile` below overwrites it. Fresh token by default;
  // the previous run's only under `--watch` / `--hot` / `VRCZIP_STABLE_TOKEN=1`.
  const session = await resolveSessionToken(env !== undefined ? { env } : {});
  const sessionToken = session.token;
  if (session.stable) {
    // Loud on purpose. A stable credential that appears without saying so is how one ends up in a
    // production build unnoticed — this line is the thing that makes that visible in a log.
    console.warn(
      session.reused
        ? "[vrc.zip] dev mode: reusing the session token from state.json — it does NOT rotate on restart."
        : "[vrc.zip] dev mode: session token will be stable across restarts (none stored yet, minting one).",
    );
  }

  // --- the proxy's collaborators --------------------------------------------
  // Consent is its own object rather than something the proxy owns, because the *UI* is the other
  // half of it: the sheet, the account picker, and the six-digit code all live on the control API,
  // and a registry buried inside the mirror would have to be reached back into from there. It is
  // built here, above the control deps, because both sides read the same instance.
  // Opt-in, off by default, and built here so both proxy ports share one instance and one level.
  // Redaction lives inside it rather than at the call sites — see `proxy/request-log.ts`.
  const proxyLogger = createProxyLogger(env ?? process.env);
  if (proxyLogger.enabled) {
    console.warn(
      `[vrc.zip] ${PROXY_LOG_ENV}=${proxyLogger.level} — proxy requests are being logged. ` +
        "Credentials are redacted, but the log still shows which accounts and apps are in use.",
    );
  }

  const consent = new ConsentRegistry({ store, bus });

  // The identity unauthenticated pass-through calls are charged to. Not a real account and never
  // one: it exists so `GET /config` — which a VRChat client fetches *before* it logs in, and which
  // would therefore deadlock against the consent handshake if it needed a grant — still passes
  // through the rate limiter. Its own bucket, so a burst of public calls cannot starve a real
  // account, while the per-IP ceiling still sees every one of them.
  const anonymousJar = new CookieJar();

  const proxyDeps = {
    consent,
    grants: store,
    resolveAccount: (username: string) => {
      const account = accounts.resolve(username);
      return account === undefined
        ? null
        : { id: account.id, displayName: account.user?.displayName ?? account.username };
    },
    // The account's own cached `CurrentUser`. Still synthesised rather than proxied, and correctly
    // so: on the handshake there are no upstream bytes to be faithful to, because the login never
    // reaches VRChat. Byte-fidelity starts at `passthrough` below.
    currentUser: (accountId: string) => accounts.get(accountId)?.user ?? null,
    pipeline: pipelineMirror,
    passthrough: {
      grants: store,
      context: (accountId: string, grantId?: string) => {
        const context = accounts.get(accountId)?.context();
        if (context === undefined) return null;
        // Tagging here rather than inside `Account` is what keeps the account unaware of grants:
        // it is the pass-through that knows an app asked for this, and only on that path.
        return grantId === undefined ? context : { ...context, grantId };
      },
      // A cookie jar of its own, created once and never fed a `Set-Cookie` that matters: the
      // unauthenticated endpoints have no session to keep, and sharing a real account's jar would
      // attach a signed-in user to a call that did not need one.
      anonymousContext: () =>
        userAgent === null
          ? null
          : {
              accountId: ANONYMOUS_ACCOUNT_ID,
              jar: anonymousJar,
              userAgent,
              limiter,
              meter,
              ...(baseUrl !== undefined ? { baseUrl } : {}),
            },
    },
  };

  const deps = createControlDeps({
    accounts,
    store,
    bus,
    limiter,
    secrets,
    settings,
    presence,
    consent,
    pipelineMirror,
    meter,
    webhooks,
    plugins,
    graphs,
    social,
    connectPipeline,
    ...(env !== undefined ? { env } : {}),
    onSettingsSaved: (next) => saveSettings(next, env),
    // "Start with Windows" lives in the registry rather than in `settings.json`, and is injected so
    // nothing under `wiring/` can reach it directly. The same object the tray gets; see
    // `os/startup.ts` for why one factory builds both.
    startup: createStartupControl(process.platform, isPackaged()),
    // Same posture: the settings screen's Install button reaches the filesystem and the registry
    // through here, and only on a packaged Windows build. Everywhere else the route reports that
    // the platform cannot do it, rather than the route not existing.
    ...(process.platform === "win32" && isPackaged()
      ? {
          install: {
            run: (request: Parameters<typeof installLocally>[0]) => installLocally(request),
            status: () => ({
              installed: isInstalled(),
              path: installTarget(),
              version: installedVersion(),
            }),
          },
        }
      : {}),
  });

  // The holder above, filled in now that the deps exist.
  graphReads = createGraphReads(deps, store);

  /*
   * The third-party surface at `/app` on the control port, and the reason it is built here rather
   * than inside `bindServers`: it needs the webhook manager, and there must be exactly one of those
   * per store — two would be two scanners racing the same delivery rows.
   */
  const appApi = createAppApi({
    deps: createAppApiDeps({ store, bus, webhooks }),
  });

  const servers = await bindServers({
    deps,
    appApi,
    proxyDeps,
    proxyLogger,
    token: () => sessionToken,
    ports: settings.ports,
    // `new URL(...).pathname` yields "/C:/Users/..." on Windows, which no fs call resolves — the
    // daemon then silently serves the "UI not built" placeholder while the bundle sits right there.
    uiDistDir: resolve(import.meta.dir, "..", "..", "ui", "dist"),
  });

  // --- the forward proxy ----------------------------------------------------
  // Started after `bindServers` and given `servers.proxy.port` rather than the configured one: if
  // the mirror fell back to an ephemeral port, a forward proxy pointed at 7774 would relay every
  // VRChat request into whatever else is squatting there.
  //
  // A failure here is logged and survived. It is the one listener with a moving part outside our
  // control (minting and reading TLS material off disk), and losing an opt-in convenience port must
  // not cost the user their accounts, their feed, and their game log.
  /** Lines the entry point prints after the URL block. See the forward proxy note below. */
  const startupNotes: string[] = [];

  let forwardProxy: ForwardProxy | null = null;
  if (settings.forwardProxy.enabled) {
    try {
      forwardProxy = await startForwardProxy({
        port: settings.ports.forward,
        hostname: DEFAULT_HOSTNAME,
        mirrorPort: servers.proxy.port,
        interceptHosts: settings.forwardProxy.interceptHosts,
        logger: proxyLogger,
        ...(env !== undefined ? { env } : {}),
      });
      /*
       * Collected rather than printed.
       *
       * The URL now lives in the startup summary with every other address, and what is left here is
       * an *instruction* that applies on exactly one run — the boot that minted a CA. Handing it
       * back lets the entry point put it after the summary, where somebody reading top to bottom
       * has already seen what the daemon is serving.
       */
      startupNotes.push(
        ...forwardProxyBanner({
          proxyUrl: forwardProxy.url,
          caCertPath: forwardProxy.caCertPath,
          caIsNew: forwardProxy.caIsNew,
          hosts: forwardProxy.interceptHosts,
        }),
      );
    } catch (error) {
      console.error(
        "[vrc.zip] the forward proxy failed to start; the rest of the daemon is up:",
        error,
      );
    }
  }

  // `bindServer` has always returned `fellBack` and nothing has ever read it, which is why a daemon
  // orphaned by an earlier `bun --watch` could hold 7773-7775 while every later start quietly moved
  // to a random ephemeral port — breaking the bookmarked URL, the saved `curl`, and the open tab
  // with no message anywhere. Falling back is still the right behaviour; it just has to be audible.
  // Must run before `writeStateFile` below, which overwrites the very evidence it reads.
  for (const line of await portFallbackWarnings(
    [
      { name: "UI", server: servers.ui, wanted: settings.ports.ui },
      { name: "proxy", server: servers.proxy, wanted: settings.ports.proxy },
      { name: "control", server: servers.control, wanted: settings.ports.control },
      ...(forwardProxy === null
        ? []
        : [
            {
              name: "forward proxy",
              server: forwardProxy,
              wanted: settings.ports.forward,
            },
          ]),
    ]
      .filter((entry) => entry.server.fellBack)
      .map(({ name, server, wanted }) => ({ name, wanted, bound: server.port })),
    env,
  )) {
    console.warn(line);
  }

  await writeStateFile(
    {
      ...servers.urls,
      ...(forwardProxy === null ? {} : { forwardProxyUrl: forwardProxy.url }),
      sessionToken,
      pid: process.pid,
      startedAt: Date.now(),
    },
    env,
  );

  launchUrl = buildLaunchUrl(servers.urls.uiUrl, sessionToken);

  // --- getting a consent request in front of the user -----------------------
  // Which channel runs depends on whether anyone is watching; see `wiring/consent-alert.ts`. The
  // token is in the URL because a browser opened cold has no other way to authenticate its first
  // navigation — the same reason the launch URL carries one.
  /*
   * The plugin half of the same problem, with the channels weighted differently on purpose.
   *
   * `consent-alert.ts` fires an OS notification unconditionally for an *app* pairing, because that
   * flow's whole premise is that the user is elsewhere — in a headset, in a game window — and a UI
   * client holding a socket says nothing about anyone looking at it.
   *
   * A plugin install is the opposite: the ordinary case is a person who clicked Install on the
   * plugins screen one second ago, and toasting them about a sheet already on their screen is
   * noise. So when a UI client is connected this only logs, and the screen's own poll surfaces it.
   *
   * The case that still needs reaching is an install started with no UI at all — a script, a
   * terminal, `curl`. There the request would otherwise park for five minutes and expire in
   * silence, so both channels fire: a toast, and a browser on the plugins screen.
   */
  publishToast = (toast) => {
    const plugin = plugins.list().find((entry) => entry.status.pluginId === toast.pluginId);
    deps.publishPluginToast({
      pluginId: toast.pluginId,
      // Named rather than id'd: a toast says "Notes" and not "acme.notes", because the person
      // reading it is being interrupted and has to place it in one glance.
      pluginName: plugin?.name ?? toast.pluginId,
      message: toast.message,
      ...(toast.description === undefined ? {} : { description: toast.description }),
      tone: toast.tone,
    });
  };

  publishPanelChange = (change) => {
    deps.publishPluginPanel({
      pluginId: change.pluginId,
      panelId: change.panelId,
      op: change.op,
      ...(change.op === "patch" ? { key: change.key } : {}),
      tree: change.op === "close" ? null : (change.tree as unknown as JsonValue),
    });
  };

  alertPluginConsent = (pending) => {
    const what = `${pending.manifest.name} ${pending.manifest.version}`;
    if (deps.streamClientCount() > 0) {
      console.warn(
        `[vrc.zip] ${what} is waiting to be installed. Approve or deny it on the plugins screen.`,
      );
      return;
    }
    console.warn(
      `[vrc.zip] ${what} is waiting to be installed and no vrc.zip window is open. Opening one — it expires in five minutes and nothing is granted until then.`,
    );
    // Best-effort, both of them. A headless box has no browser and no notification daemon, and the
    // install still works: the request is on the control API for anything that asks.
    void notifier.notify({
      title: "vrc.zip: a plugin wants to be installed",
      body: `${what} is waiting for you to approve or deny it.`,
      tag: "plugin-consent",
      // The button is the point of the toast now: the browser tab below is the fallback for
      // somebody who is not at their desk, and this is the way there for somebody who is.
      click: { action: "screen", argument: "/plugins" },
      buttons: [{ id: "open", label: "Open vrc.zip", action: "screen", argument: "/plugins" }],
    });
    void openUrl(`${launchUrl}#/plugins`);
  };

  resolveToastImage = createToastImageResolver({
    // The one path in the daemon that fetches a caller-chosen URL, reused rather than reopened: an
    // unpackaged app's toast cannot load an image over the network, and a VRChat image cannot be
    // fetched without the auth cookie and the User-Agent. See `wiring/toast-image.ts`.
    fetchImage: async (url) => await deps.fetchImage(url),
    ...(env !== undefined ? { env } : {}),
  });

  /*
   * A press on a toast becomes an event, and from there it is an event like any other: the graph
   * trigger subscribes to a kind, the feed writes it, a webhook can filter on it. This adapter is
   * the only thing that knows the notifier and the bus both exist.
   */
  const detachActivations = attachNotificationActivations({
    bus,
    onActivation: (handler) => notifier.onActivation(handler),
  });

  const detachConsentAlerts = attachConsentAlerts({
    bus,
    consent,
    notify: async (notification) => await notifier.notify(notification),
    uiConnected: () => deps.streamClientCount() > 0,
    consentUrl: (pairingId) => `${launchUrl}#/consent/${encodeURIComponent(pairingId)}`,
    openBrowser: () => settings.openBrowserOnStart,
  });

  /*
   * Last, after every listener is up.
   *
   * Sequential inside, and a plugin that cannot start is recorded against that plugin rather than
   * thrown — one bad install must not be able to stop the daemon booting. Awaited rather than left
   * floating so a caller that resolves `startDaemon` knows the plugins have at least been asked to
   * start; the promise resolves when each has been *spawned and sent `activate`*, never when it is
   * healthy, because health is a running judgement about a process we do not trust.
   */
  await plugins.start();

  /*
   * After the plugins, and that order is load-bearing: arming a trigger is a call *into* a plugin,
   * so a graph armed before its plugin was attached would be armed against nothing. A plugin that
   * is still starting fails its arm and is recorded, not thrown — the same posture as above.
   *
   * This also picks up runs left parked on a `wait` by the previous process, which is the whole
   * reason `graph_runs` is a table.
   */
  await graphs.start();

  return {
    bus,
    store,
    accounts,
    servers,
    forwardProxy,
    startupNotes,
    settings,
    webhooks,
    sessionToken,
    launchUrl,
    async stop() {
      // Order is the reverse of construction, and the first two lines are the ones that matter:
      // stop accepting work, then flush what is already queued, before anything closes.
      detachConsentAlerts();
      detachActivations();
      // With it, since it is what the consent alert was raising. A toast outlives the process that
      // showed it unless it is taken down, and one left on screen with an `Open vrc.zip` button
      // pointing at a daemon that has exited is a button that does nothing.
      notifier.stop();
      // Before the plugins, for the mirror of the reason it starts after them: disarming a trigger
      // is a call into a plugin, and a graph left armed against a stopped host would spend the
      // shutdown logging failures about a process that is already gone.
      await graphs.stop();
      // Early, and before the servers: a plugin is the one subsystem here that is a separate
      // process, so leaving it running while the daemon tears itself down means it makes calls into
      // a host that is half gone. Bounded — `stopAll` gives every plugin the same grace and then
      // stops waiting, because a wedged plugin must not be able to hold the user's quit open.
      await plugins.stop();
      watcher.stop();
      presence.stop();
      notificationSync.stop();
      retention.stop();
      // Detach before stopping the scanner, in that order and for the stated reason: unsubscribing
      // first means nothing new is enqueued, and stopping second lets a scan already in flight
      // finish and write its outcome. A delivery abandoned mid-attempt is simply pending again on
      // the next start, so nothing is lost either way — but a row enqueued after the scanner has
      // stopped would sit undelivered until then for no reason.
      detachWebhooks();
      webhooks.stop();
      clearInterval(meterPrune);
      for (const client of pipelines.values()) client.dispose();
      feedWriter.detach();
      notifications.detach();

      // Before the mirror it forwards to, so an in-flight request cannot be relayed into a port
      // that has just stopped listening.
      await forwardProxy?.stop();
      await servers.stop();

      // In dev mode the file is deliberately left behind, because it is the only place the token
      // survives to. `bun --watch` does not hard-kill: it sends SIGTERM to the outgoing process and
      // that handler runs to completion (verified on Bun 1.4.0/Windows — the old pid logs its
      // shutdown before the new pid boots), so deleting here would erase the token a fraction of a
      // second before the reload tries to read it and reuse could never work. The cost is a stale
      // `state.json` pointing at a dead pid between a Ctrl-C and the next start, which is a
      // dev-only annoyance; `readStateFile` callers already have to tolerate a dead daemon.
      if (!session.stable) await removeStateFile(env).catch(() => undefined);

      // Deliberately `goOffline`, never `PUT /logout`: cookies survive so the next start resumes
      // instead of minting a session. PLAN.md §Guardrails.
      accounts.shutdown();
      store.close();
    },
  };
}

// --- port fallback diagnostics ----------------------------------------------

/** One server that did not get the port it asked for. */
export interface PortFallback {
  /** How the server is named to the user: "UI", "proxy", "control". */
  readonly name: string;
  readonly wanted: number;
  readonly bound: number;
}

/**
 * The warning lines for servers that fell back to an ephemeral port.
 *
 * Returns strings rather than logging, so the wording is assertable without binding a real port.
 * Empty in the normal case, and it does no I/O at all then — the `state.json` read only happens
 * when there is actually something to explain.
 *
 * The blame is deliberately conservative: a previous run's pid is only named when that run's own
 * `state.json` recorded it on the very port now contested *and* the pid is still alive. Anything
 * short of both gets the generic line, because "pid 4812 holds your port" is worse than useless if
 * pid 4812 is actually an unrelated process that inherited a recycled id.
 */
export async function portFallbackWarnings(
  fallbacks: readonly PortFallback[],
  env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  if (fallbacks.length === 0) return [];

  const previous = await previousDaemon(env);
  return fallbacks.map(({ name, wanted, bound }) => {
    // `=== true` rather than a truthiness check: it is what narrows `previous` to non-null for the
    // `.pid` read below, and it keeps Biome from asking for an optional chain that would not.
    const cause =
      previous?.ports.has(wanted) === true
        ? `port ${wanted} is held by an existing vrc.zip daemon (pid ${previous.pid}) still running from an earlier start`
        : `port ${wanted} was already taken — an orphaned vrc.zip daemon from an earlier \`bun --watch\` run is the usual cause`;
    return `[vrc.zip] ${name} server fell back to port ${bound}: ${cause}. Bookmarked URLs and saved tokens on ${wanted} will not reach this daemon.`;
  });
}

/** The still-running daemon described by `state.json`, or null if there isn't one. */
async function previousDaemon(
  env?: NodeJS.ProcessEnv,
): Promise<{ pid: number; ports: Set<number> } | null> {
  const state = await readStateFile(env);
  // Never blame ourselves: in dev mode `state.json` survives shutdown, so a stale file naming a
  // recycled pid is a real possibility and this process is the one pid we know isn't the culprit.
  if (state === null || state.pid === process.pid || !isProcessAlive(state.pid)) return null;

  const ports = new Set<number>();
  for (const url of [state.uiUrl, state.proxyUrl, state.controlUrl]) {
    const port = portOf(url);
    if (port !== null) ports.add(port);
  }
  return { pid: state.pid, ports };
}

/**
 * Signal 0 sends nothing and only asks whether the pid can be signalled. Portable to Windows, where
 * Bun maps it onto a process-handle lookup. `EPERM` means the process exists but belongs to someone
 * else, which still counts as alive; only `ESRCH` means gone.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function portOf(url: string): number | null {
  try {
    const port = Number.parseInt(new URL(url).port, 10);
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}
