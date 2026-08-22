import { isEventFrame, isRateFrame } from "@vrcz/shared";
/**
 * The shell's shared state: daemon status, accounts, live sessions, settings, and the live event
 * tail. Screens own their own queries; anything the sidebar, the palette, or two screens all need
 * lives here so it is fetched once and updated by the socket rather than polled per screen.
 *
 * Written as a class with `$state` fields and exported as a singleton — the rune equivalent of a
 * store, without the store API.
 */

import {
  type Account,
  ApiError,
  api,
  type DaemonStatus,
  describeError,
  type GameSession,
  isAbort,
  isOffline,
  type NotificationItem,
  onReachabilityChange,
  type Settings,
} from "../api.ts";
import { EPHEMERAL_KINDS, frameToEvent, type LiveEvent } from "../events.ts";
import { notify, notifyForEvent } from "../notifications.ts";
import { hrefFor } from "../router.ts";
import {
  connectStream,
  type StreamConnection,
  type StreamFrame,
  type StreamState,
} from "../stream.ts";
import { consent } from "./consent.svelte.ts";
import { liveSessions } from "./live-sessions.svelte.ts";
import { prefs } from "./prefs.svelte.ts";
import { rates } from "./rates.svelte.ts";

/** How many live events the shell keeps in memory for the feed's "new since you looked" tail. */
const LIVE_TAIL_LIMIT = 500;

/** Coalesces the refetch bursts a single instance transition produces. */
const REFRESH_DEBOUNCE_MS = 250;

export type LoadPhase = "idle" | "loading" | "ready" | "error";

class AppState {
  /** `null` until the first successful `GET /api/status`. */
  status = $state<DaemonStatus | null>(null);
  accounts = $state<Account[]>([]);
  sessions = $state<GameSession[]>([]);
  settings = $state<Settings | null>(null);
  notifications = $state<NotificationItem[]>([]);

  /** Events pushed over the socket since the page loaded, newest first. */
  liveEvents = $state<LiveEvent[]>([]);

  phase = $state<LoadPhase>("idle");
  /** The last non-offline failure, shown inline. Offline gets the full-screen treatment instead. */
  error = $state<string | null>(null);
  /** False once a request has failed to reach the daemon at all. */
  reachable = $state(true);
  /**
   * Why the shell is showing the offline screen.
   *
   * `not-api` is the misconfiguration case, and it needs its own words. The daemon binds the UI on
   * one port and the control API on another, so a packaged build that is reachable can still have
   * nothing but static files answering on `/api`. That returns `index.html`, which parses as
   * neither JSON nor a network failure, and telling the user their daemon has crashed when it is
   * running fine would send them hunting in the wrong place.
   */
  offlineReason = $state<"unreachable" | "not-api">("unreachable");
  streamState = $state<StreamState>("connecting");

  /** Bumped on every friend-affecting frame, so the Friends screen can cheaply refetch. */
  friendsRevision = $state(0);
  /** Bumped on every live event, for screens that only need "something happened". */
  revision = $state(0);

  #stream: StreamConnection | null = null;
  #refreshing = false;
  #timers = new Map<string, number>();

  /** Accounts whose pipeline the daemon currently holds open. */
  connectedAccounts = $derived(
    this.accounts.filter((account) => account.connection === "connected"),
  );

  /** Accounts sitting on an unanswered 2FA challenge — the one state that blocks on the user. */
  accountsNeeding2fa = $derived(
    this.accounts.filter((account) => account.connection === "needs-2fa"),
  );

  /**
   * Running clients the daemon could not attribute to a signed-in account. Normal, not an error:
   * a VRChat client can be signed into an account vrc.zip does not manage.
   */
  unlinkedSessions = $derived(this.sessions.filter((session) => session.accountId === null));

  unseenNotifications = $derived(this.notifications.filter((item) => !item.seen));

  /** True until the user has supplied a contact address. Nothing can talk to VRChat before then. */
  needsFirstRun = $derived(this.settings !== null && this.settings.contact.trim() === "");

  accountById(id: string | null): Account | null {
    if (id === null) return null;
    return this.accounts.find((account) => account.id === id) ?? null;
  }

  /** The name to put on a session card: the account's, the client's own, or "Unlinked client". */
  sessionLabel(session: GameSession): string {
    const account = this.accountById(session.accountId);
    if (account !== null) return account.displayName;
    if (session.displayName !== null && session.displayName !== "") return session.displayName;
    return "Unlinked client";
  }

  /** Fetches everything the shell needs. Safe to call repeatedly; overlapping calls collapse. */
  async refresh(signal?: AbortSignal): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    if (this.status === null) this.phase = "loading";
    try {
      const [status, accounts, sessions, settings] = await Promise.all([
        api.status(signal),
        api.accounts.list(signal),
        api.sessions(signal),
        api.settings.get(signal),
      ]);
      this.status = status;
      this.accounts = accounts;
      // Seed the histories the live socket will extend. Re-seeding on every refresh is deliberate:
      // it is also the resync after a reconnect, when the socket missed however many seconds the
      // daemon was away and the client's own tail has drifted from the truth.
      rates.seedTotal(
        status.rateLimit.used,
        status.rateLimit.api.rate,
        status.rateLimit.queued,
        status.rateLimit.retryAfter,
      );
      for (const account of accounts) rates.seedAccount(account.id, account.rate);
      this.sessions = sessions;
      this.settings = settings;
      this.error = null;
      this.reachable = true;
      this.phase = "ready";
      // Notifications are fetched separately: the badge wants them, but a failure here must not
      // take down the whole shell (this route is newer than the rest of the contract).
      void this.refreshNotifications();
    } catch (error) {
      if (isAbort(error)) return;
      if (isOffline(error)) {
        this.offlineReason = "unreachable";
        this.reachable = false;
        this.phase = "error";
      } else if (error instanceof ApiError && error.kind === "malformed") {
        this.offlineReason = "not-api";
        this.reachable = false;
        this.phase = "error";
      } else {
        this.error = describeError(error);
        this.phase = "error";
      }
    } finally {
      this.#refreshing = false;
    }
  }

  async refreshNotifications(): Promise<void> {
    try {
      /*
       * The shell's copy: the newest few hundred, across every account.
       *
       * It is what the sidebar badge counts and what the Notifications screen merges in as its
       * live tail, so it wants to be recent rather than complete — the screen pages the rest on a
       * cursor. The limit is explicit because the route's default is a hundred, and a hundred is a
       * single busy day on two accounts.
       */
      this.notifications = await api.notifications.list({ limit: 300 });
    } catch {
      /* the badge stays at its last known value; the screen shows its own error */
    }
  }

  /** Optimistically marks one notification seen, then confirms with the daemon. */
  async markNotificationSeen(id: string): Promise<void> {
    const before = this.notifications;
    this.notifications = this.notifications.map((item) =>
      item.id === id ? { ...item, seen: true } : item,
    );
    try {
      await api.notifications.markSeen(id);
    } catch {
      this.notifications = before;
    }
  }

  /** Called by the shell once, on mount. Returns a teardown for symmetry with `$effect`. */
  start(): () => void {
    const stopWatchingReachability = onReachabilityChange((reachable) => {
      this.reachable = reachable;
      if (reachable && this.phase === "error") void this.refresh();
    });

    void this.refresh();

    this.#stream = connectStream({
      onState: (state) => {
        this.streamState = state;
        // The socket opening again means the daemon came back after a restart; whatever changed
        // while it was gone is not in `liveEvents`, so re-read rather than trusting the cache.
        if (state === "open") void this.refresh();
      },
      onFrame: (frame) => {
        this.#ingest(frame);
      },
    });

    return () => {
      stopWatchingReachability();
      for (const timer of this.#timers.values()) window.clearTimeout(timer);
      this.#timers.clear();
      this.#stream?.close();
      this.#stream = null;
    };
  }

  /** Force a reconnect and a re-read — the offline screen's retry button. */
  retry(): void {
    this.reachable = true;
    this.offlineReason = "unreachable";
    this.error = null;
    void this.refresh();
    this.#stream?.reconnectNow();
  }

  #debounce(key: string, run: () => void): void {
    const existing = this.#timers.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    this.#timers.set(
      key,
      window.setTimeout(() => {
        this.#timers.delete(key);
        run();
      }, REFRESH_DEBOUNCE_MS),
    );
  }

  #ingest(frame: StreamFrame): void {
    // A rate sample is not an event: it must not reach the feed, the notifier, or the live tail.
    if (isRateFrame(frame)) {
      rates.apply(frame.payload);
      return;
    }
    if (!isEventFrame(frame)) return;

    liveSessions.apply(frame);
    this.#applySideEffects(frame);

    if (EPHEMERAL_KINDS.has(frame.type)) return;

    const event = frameToEvent(frame);
    if (event === null) return;

    this.liveEvents = [event, ...this.liveEvents].slice(0, LIVE_TAIL_LIMIT);
    this.revision += 1;
    notifyForEvent(event, prefs.shouldNotify, () => {
      window.location.hash = hrefFor("feed");
    });
  }

  #applySideEffects(frame: StreamFrame): void {
    const family = frame.type.split(".", 1)[0];
    switch (family) {
      case "session":
        this.#debounce("sessions", () => {
          void this.#refreshSessions();
        });
        break;
      case "account":
      case "pipeline":
        this.#debounce("accounts", () => {
          void this.#refreshAccounts();
          void this.#refreshStatus();
        });
        break;
      case "friend":
      case "user":
        this.friendsRevision += 1;
        break;
      case "notification":
        this.#applyNotificationFrame(frame);
        break;
      case "consent":
        this.#applyConsentFrame(frame);
        break;
      default:
        break;
    }
  }

  /**
   * Notification frames update the list in place rather than triggering a refetch — a busy inbox
   * would otherwise turn every incoming invite into a round trip. Only `received` needs the
   * daemon, because the frame carries VRChat's shape and the list wants the daemon's.
   */
  /**
   * An app is asking for access, or has stopped asking.
   *
   * The list is **re-read from the control API** rather than built from this frame, because the
   * frame carries no pairing code — it fans out to every stream client and, later, to plugins,
   * while the code belongs only to a screen behind the session token.
   *
   * The Web Notification here is the in-app half of getting the user's attention. The daemon covers
   * the other half: when no UI client is connected at all it raises an OS notification and opens
   * the browser, because a page that is not loaded cannot notify anybody. See
   * `daemon/src/wiring/consent-alert.ts`.
   */
  #applyConsentFrame(frame: StreamFrame): void {
    void consent.refresh();
    if (frame.type !== "consent.pending" || !isEventFrame(frame)) return;

    const data = (frame.payload.data ?? null) as { app?: { name?: string } } | null;
    const name = data?.app?.name ?? "An app";
    const pairingId = frame.payload.subjectId;
    notify({
      title: `${name} wants to use your VRChat account`,
      body: "Open vrc.zip to see the code it needs.",
      // One notification per request, not one per retry.
      tag: `vrcz:consent:${pairingId ?? "unknown"}`,
      onClick: () => {
        window.location.hash = hrefFor("consent", pairingId ?? undefined);
      },
    });
  }

  #applyNotificationFrame(frame: StreamFrame): void {
    if (!isEventFrame(frame)) return;
    const subjectId = frame.payload.subjectId;

    switch (frame.type) {
      case "notification.seen":
      case "notification.hidden":
        if (subjectId === null) break;
        this.notifications = this.notifications.map((item) =>
          item.id === subjectId ? { ...item, seen: true } : item,
        );
        break;
      case "notification.cleared":
        // VRChat's clear frame names nothing, so the daemon marks rather than deletes. Mirror it.
        this.notifications = this.notifications.map((item) => ({ ...item, seen: true }));
        break;
      case "notification.received":
      case "notification.received_v2":
      case "notification.updated":
      case "notification.deleted":
      case "notification.responded":
      // The daemon finished backfilling a pending backlog straight into the store, deliberately
      // without replaying it as live frames. One refetch is how the screen learns about all of it.
      case "notification.synced":
        this.#debounce("notifications", () => {
          void this.refreshNotifications();
        });
        break;
      default:
        break;
    }
  }

  async #refreshSessions(): Promise<void> {
    try {
      this.sessions = await api.sessions();
    } catch {
      /* the next full refresh will pick it up */
    }
  }

  async #refreshAccounts(): Promise<void> {
    try {
      this.accounts = await api.accounts.list();
    } catch {
      /* as above */
    }
  }

  async #refreshStatus(): Promise<void> {
    try {
      this.status = await api.status();
    } catch {
      /* as above */
    }
  }
}

export const app = new AppState();
