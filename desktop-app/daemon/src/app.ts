import { resolve } from "node:path";
import { launchUrl as buildLaunchUrl, DEFAULT_HOSTNAME } from "@vrcz/shared";
import { CookieJar } from "./accounts/cookie-jar.ts";
import { AccountManager } from "./accounts/manager.ts";
import { NotificationService } from "./accounts/notifications.ts";
import { PresenceService } from "./accounts/presence.ts";
import { EventBus } from "./bus/event-bus.ts";
import { type ForwardProxy, forwardProxyBanner, startForwardProxy } from "./forward-proxy/index.ts";
import { discoverLogDirectories, LogWatcher } from "./game-logs/index.ts";
import { RateLimiter } from "./net/rate-limiter.ts";
import { buildUserAgent } from "./net/user-agent.ts";
import { databasePath, ensureStateDir } from "./paths.ts";
import { PipelineClient } from "./pipeline/index.ts";
import { ConsentRegistry } from "./proxy/consent.ts";
import { PipelineMirror } from "./proxy/pipeline-mirror.ts";
import { createProxyLogger, PROXY_LOG_ENV } from "./proxy/request-log.ts";
import { loadOrCreateMasterKey } from "./security/keychain.ts";
import { SecretsStore } from "./security/secrets.ts";
import { resolveSessionToken } from "./security/session-token.ts";
import { readStateFile, removeStateFile, writeStateFile } from "./security/state-file.ts";
import { type BoundServers, bindServers } from "./servers/index.ts";
import { loadSettings, needsFirstRun, type Settings, saveSettings } from "./settings.ts";
import { type RetentionScheduler, Store, startRetentionScheduler } from "./store/index.ts";
import { attachConsentAlerts } from "./wiring/consent-alert.ts";
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
  readonly sessionToken: string;
  readonly launchUrl: string;
  stop(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const env = options.env;

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

  function connectPipeline(accountId: string): void {
    if (pipelines.has(accountId) || !userAgent) return;

    const client = new PipelineClient({
      userAgent,
      ...(options.pipelineUrl !== undefined ? { url: options.pipelineUrl } : {}),
      // Re-read on every attempt rather than captured once: a reconnect after a re-auth must use
      // the new token, and the old one is exactly what a stale closure would hand it.
      getAuthToken: async () => accounts.get(accountId)?.authToken() ?? "",
      onEvent: (decoded) => {
        publishPipelineEvent(bus, accountId, decoded);
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
  });
  watcher.start();

  // --- retention ------------------------------------------------------------
  const retention: RetentionScheduler = startRetentionScheduler(store);

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
      context: (accountId: string) => accounts.get(accountId)?.context() ?? null,
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
              ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
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
    connectPipeline,
    ...(env !== undefined ? { env } : {}),
    onSettingsSaved: (next) => saveSettings(next, env),
  });

  const servers = await bindServers({
    deps,
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
      for (const line of forwardProxyBanner({
        proxyUrl: forwardProxy.url,
        caCertPath: forwardProxy.caCertPath,
        caIsNew: forwardProxy.caIsNew,
        hosts: forwardProxy.interceptHosts,
      })) {
        console.info(line);
      }
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

  const launchUrl = buildLaunchUrl(servers.urls.uiUrl, sessionToken);

  // --- getting a consent request in front of the user -----------------------
  // Which channel runs depends on whether anyone is watching; see `wiring/consent-alert.ts`. The
  // token is in the URL because a browser opened cold has no other way to authenticate its first
  // navigation — the same reason the launch URL carries one.
  const detachConsentAlerts = attachConsentAlerts({
    bus,
    consent,
    uiConnected: () => deps.streamClientCount() > 0,
    consentUrl: (pairingId) => `${launchUrl}#/consent/${encodeURIComponent(pairingId)}`,
    openBrowser: () => settings.openBrowserOnStart,
  });

  return {
    bus,
    store,
    accounts,
    servers,
    forwardProxy,
    settings,
    sessionToken,
    launchUrl,
    async stop() {
      // Order is the reverse of construction, and the first two lines are the ones that matter:
      // stop accepting work, then flush what is already queued, before anything closes.
      detachConsentAlerts();
      watcher.stop();
      presence.stop();
      notificationSync.stop();
      retention.stop();
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
