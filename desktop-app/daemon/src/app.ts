import { AccountManager } from "./accounts/manager.ts";
import { PresenceService } from "./accounts/presence.ts";
import { EventBus } from "./bus/event-bus.ts";
import { discoverLogDirectories, LogWatcher } from "./game-logs/index.ts";
import { RateLimiter } from "./net/rate-limiter.ts";
import { buildUserAgent } from "./net/user-agent.ts";
import { databasePath } from "./paths.ts";
import { PipelineClient } from "./pipeline/index.ts";
import { loadOrCreateMasterKey } from "./security/keychain.ts";
import { SecretsStore } from "./security/secrets.ts";
import { generateSessionToken } from "./security/session-token.ts";
import { removeStateFile, writeStateFile } from "./security/state-file.ts";
import { type BoundServers, bindServers } from "./servers/index.ts";
import { loadSettings, needsFirstRun, type Settings, saveSettings } from "./settings.ts";
import { type RetentionScheduler, Store, startRetentionScheduler } from "./store/index.ts";
import { createControlDeps } from "./wiring/control-deps.ts";
import { FeedWriter } from "./wiring/feed-writer.ts";
import { createLogSink } from "./wiring/log-bridge.ts";
import { NotificationSink } from "./wiring/notification-sink.ts";
import { publishPipelineEvent } from "./wiring/pipeline-bridge.ts";

/**
 * The composition root. Everything is constructed here and nowhere else, which is what makes the
 * dependency directions in the rest of the daemon checkable by eye: no module reaches out for a
 * singleton, so no module can quietly acquire a dependency it shouldn't have.
 *
 * Startup order is load-bearing in two places, both noted below.
 */

export interface DaemonOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides the VRChat base URL. Tests point this at the recorded fixture. */
  readonly baseUrl?: string;
}

export interface RunningDaemon {
  readonly bus: EventBus;
  readonly store: Store;
  readonly accounts: AccountManager;
  readonly servers: BoundServers;
  readonly settings: Settings;
  readonly sessionToken: string;
  readonly launchUrl: string;
  stop(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const env = options.env;
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

  // First run has no contact string, so no honest User-Agent can be built. The daemon still starts
  // — the user needs the UI in order to supply one — but nothing may talk to VRChat until they do.
  // See PLAN.md §1.4: a placeholder contact is worse than none.
  const userAgent = needsFirstRun(settings) ? null : buildUserAgent(settings.contact);

  const accounts = new AccountManager({
    secrets,
    bus,
    limiter,
    userAgent: userAgent ?? "",
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
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
  const pipelines = new Map<string, PipelineClient>();

  function connectPipeline(accountId: string): void {
    if (pipelines.has(accountId) || !userAgent) return;

    const client = new PipelineClient({
      userAgent,
      // Re-read on every attempt rather than captured once: a reconnect after a re-auth must use
      // the new token, and the old one is exactly what a stale closure would hand it.
      getAuthToken: async () => accounts.get(accountId)?.authToken() ?? "",
      onEvent: (decoded) => {
        publishPipelineEvent(bus, accountId, decoded);
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

  // --- friend presence ------------------------------------------------------
  const presence = new PresenceService({ accounts, store, bus });
  presence.start();

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
  });
  watcher.start();

  // --- retention ------------------------------------------------------------
  const retention: RetentionScheduler = startRetentionScheduler(store);

  // --- servers --------------------------------------------------------------
  const sessionToken = generateSessionToken();
  const deps = createControlDeps({
    accounts,
    store,
    bus,
    limiter,
    secrets,
    settings,
    presence,
    connectPipeline,
    ...(env !== undefined ? { env } : {}),
    onSettingsSaved: (next) => saveSettings(next, env),
  });

  const servers = await bindServers({
    deps,
    token: () => sessionToken,
    ports: settings.ports,
    uiDistDir: new URL("../../ui/dist", import.meta.url).pathname,
  });

  await writeStateFile(
    {
      ...servers.urls,
      sessionToken,
      pid: process.pid,
      startedAt: Date.now(),
    },
    env,
  );

  const launchUrl = `${servers.urls.uiUrl}/?token=${sessionToken}`;

  return {
    bus,
    store,
    accounts,
    servers,
    settings,
    sessionToken,
    launchUrl,
    async stop() {
      // Order is the reverse of construction, and the first two lines are the ones that matter:
      // stop accepting work, then flush what is already queued, before anything closes.
      watcher.stop();
      presence.stop();
      retention.stop();
      for (const client of pipelines.values()) client.dispose();
      feedWriter.detach();
      notifications.detach();

      await servers.stop();
      await removeStateFile(env).catch(() => undefined);

      // Deliberately `goOffline`, never `PUT /logout`: cookies survive so the next start resumes
      // instead of minting a session. PLAN.md §Guardrails.
      accounts.shutdown();
      store.close();
    },
  };
}
