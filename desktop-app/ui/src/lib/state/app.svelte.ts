/**
 * The shell's shared state: daemon status, accounts, live sessions, settings, and the live event
 * tail. Screens own their own queries; anything the sidebar, the palette, or two screens all
 * need lives here so it is fetched once and updated by the socket rather than polled per screen.
 *
 * Written as a class with `$state` fields and exported as a singleton — the rune equivalent of a
 * store, without the store API.
 */

import {
  type Account,
  api,
  type DaemonStatus,
  describeError,
  type FeedEvent,
  type GameSession,
  isAbort,
  isOffline,
  onReachabilityChange,
  type Settings,
} from "../api.ts";
import { notifyForEvent } from "../notifications.ts";
import { hrefFor } from "../router.ts";
import { connectStream, type StreamConnection, type StreamState } from "../stream.ts";

/** How many live events the shell keeps in memory for the feed's "new since you looked" tail. */
const LIVE_TAIL_LIMIT = 300;

export type LoadPhase = "idle" | "loading" | "ready" | "error";

class AppState {
  /** `null` until the first successful `/api/status`. */
  status = $state<DaemonStatus | null>(null);
  accounts = $state<Account[]>([]);
  sessions = $state<GameSession[]>([]);
  settings = $state<Settings | null>(null);

  /** Events pushed over the socket since the page loaded, newest first. */
  liveEvents = $state<FeedEvent[]>([]);

  phase = $state<LoadPhase>("idle");
  /** The last non-offline failure, shown inline. Offline gets the full-screen treatment instead. */
  error = $state<string | null>(null);
  /** False once a request has failed to reach the daemon at all. */
  reachable = $state(true);
  streamState = $state<StreamState>("connecting");

  /** Bumped on every live event so screens can cheaply watch for "something happened". */
  revision = $state(0);

  #stream: StreamConnection | null = null;
  #refreshing = false;

  /** Accounts the daemon currently holds a live pipeline for. */
  onlineAccounts = $derived(this.accounts.filter((account) => account.online));

  /** Sessions still running, i.e. no exit recorded. */
  runningSessions = $derived(this.sessions.filter((session) => session.exitKind === null));

  /** Running clients the daemon could not attribute to a logged-in account. */
  unlinkedSessions = $derived(this.runningSessions.filter((session) => session.accountId === null));

  accountById(id: string | null): Account | null {
    if (id === null) return null;
    return this.accounts.find((account) => account.id === id) ?? null;
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
      this.sessions = sessions;
      this.settings = settings;
      this.error = null;
      this.phase = "ready";
    } catch (error) {
      if (isAbort(error)) return;
      if (isOffline(error)) {
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
        // The socket reconnecting means the daemon came back after a restart; whatever changed
        // while it was gone is not in `liveEvents`, so re-read rather than trusting the cache.
        if (state === "open") void this.refresh();
      },
      onMessage: (message) => {
        switch (message.type) {
          case "event":
            this.#ingestEvent(message.event);
            break;
          case "sessions":
            this.sessions = [...message.sessions];
            break;
          case "accounts-changed":
            void this.#refreshAccounts();
            break;
          case "status-changed":
            void this.#refreshStatus();
            break;
          case "hello":
            break;
          default:
            break;
        }
      },
    });

    return () => {
      stopWatchingReachability();
      this.#stream?.close();
      this.#stream = null;
    };
  }

  /** Force a reconnect and a re-read — the offline screen's retry button. */
  retry(): void {
    this.reachable = true;
    this.error = null;
    void this.refresh();
    this.#stream?.reconnectNow();
  }

  #ingestEvent(event: FeedEvent): void {
    this.liveEvents = [event, ...this.liveEvents].slice(0, LIVE_TAIL_LIMIT);
    this.revision += 1;
    const enabled = this.settings?.notifyOn ?? [];
    notifyForEvent(event, enabled, () => {
      window.location.hash = hrefFor("feed");
    });
  }

  async #refreshAccounts(): Promise<void> {
    try {
      this.accounts = await api.accounts.list();
    } catch {
      /* the next full refresh will pick it up */
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
