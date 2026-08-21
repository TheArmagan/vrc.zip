import type { EventBus, Subscription } from "../bus/event-bus.ts";
import { JitteredInterval } from "../net/jitter.ts";
import type { RequestContext } from "../net/request.ts";
import { vrcFetch } from "../net/request.ts";
import type { Store } from "../store/index.ts";
import { toNotificationRow } from "../wiring/notification-sink.ts";

/**
 * Only what this service needs of the account manager: look one up, and list the online ones.
 *
 * Narrower than `AccountManager` on purpose. `PresenceService` takes the concrete class and pays
 * for it in its tests, which have to stand up a real HTTP fixture, a secrets store, and a temp
 * directory to exercise paging logic that touches none of them. Structural typing means the real
 * manager satisfies this with no adapter at the call site.
 */
export interface NotificationAccounts {
  get(id: string): { readonly state: string; context(): RequestContext } | undefined;
  list(): ReadonlyArray<{ readonly id: string; readonly state: string }>;
}

/**
 * Notification backfill and reconciliation.
 *
 * **Why this exists at all:** until it did, the pipeline socket was the *only* source of
 * notifications, so vrc.zip knew about exactly those that arrived while it happened to be
 * connected. Everything already pending when you signed in — every friend request, every invite,
 * the whole backlog — was invisible, and the Notifications screen was empty on a real account with
 * hundreds waiting. A socket carries deltas; it cannot tell you the current state, and
 * notifications are state (see `NotificationSink`).
 *
 * It is the same shape as `PresenceService` and for the same reasons: the pipeline carries the
 * deltas and is why the screen is live, while a slow jittered poll reconciles what the socket
 * missed across a reconnect.
 *
 * Two generations are fetched, because VRChat has two live at once and they carry different
 * things: `/auth/user/notifications` has friend requests and invites, `/notifications` (v2) has
 * group announcements, boops, and badge awards. Fetching only one leaves a category permanently
 * missing, which looks exactly like the bug this class fixes.
 */

export interface NotificationServiceOptions {
  readonly accounts: NotificationAccounts;
  readonly store: Store;
  readonly bus: EventBus;
  /** Base poll interval. Jittered, never clock-aligned. */
  readonly refreshIntervalMs?: number;
  /** VRChat caps `n` at 100. */
  readonly pageSize?: number;
  /**
   * Stop paging after this many notifications per generation, per account. A backlog of hundreds
   * is normal and must be fetched; an unbounded loop against a broken endpoint is not.
   */
  readonly maxPerGeneration?: number;
}

const DEFAULT_REFRESH_MS = 5 * 60_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PER_GENERATION = 2_000;
/** v2 has no offset, so its one request asks for as much as it will give in a single call. */
const V2_MAX_LIMIT = 100;

interface Generation {
  readonly name: string;
  /** Builds the path for one page. */
  readonly path: (pageSize: number, offset: number) => string;
  /**
   * Whether this endpoint actually supports paging.
   *
   * **The two generations do not agree, and getting this wrong is silent.** v1 takes `n` + `offset`
   * and pages properly. v2 takes only `limit` — no offset exists — so sending one is accepted and
   * ignored, every request returns the same first page, the short-page check never fires, and the
   * loop runs to `maxPerGeneration` re-writing identical rows on every poll forever. So v2 is one
   * request, and the cap is what bounds it.
   */
  readonly paged: boolean;
}

const GENERATIONS: readonly Generation[] = [
  {
    name: "v1",
    paged: true,
    path: (n, offset) => `/auth/user/notifications?n=${String(n)}&offset=${String(offset)}`,
  },
  {
    name: "v2",
    paged: false,
    path: (n) => `/notifications?limit=${String(n)}`,
  },
];

export class NotificationService {
  readonly #timers = new Map<string, JitteredInterval>();
  #subscription: Subscription | null = null;
  /**
   * Set by `stop()`. A refresh already awaiting the network resumes *after* shutdown has closed the
   * store, so cancelling the timer is not enough — anything that outlives `stop()` re-checks this
   * after every await. Same hazard as `PresenceService`.
   */
  #disposed = false;

  constructor(private readonly options: NotificationServiceOptions) {}

  start(): void {
    this.#subscription = this.options.bus.subscribe(
      (event) => {
        // `account.ready`, not `account.state`: the latter fires while the manager still has the
        // account under its pending id, so the first refresh would silently do nothing.
        if (event.accountId) this.#startPolling(event.accountId);
      },
      { kinds: ["account.ready"] },
    );

    for (const snapshot of this.options.accounts.list()) {
      if (snapshot.state === "online") this.#startPolling(snapshot.id);
    }
  }

  stop(): void {
    this.#disposed = true;
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    for (const timer of this.#timers.values()) timer.stop();
    this.#timers.clear();
  }

  /**
   * Fetches every notification for one account and upserts it.
   *
   * Rows are written **straight to the store rather than emitted onto the bus** as
   * `notification.received`. That distinction is the whole ergonomics of this feature: a backlog of
   * three hundred replayed as live events would raise three hundred desktop notifications and bury
   * the feed, announcing years-old friend requests as if they had just arrived. One summary event
   * goes out instead, which is enough for the UI to refetch.
   */
  async refresh(accountId: string): Promise<void> {
    if (this.#disposed) return;

    const account = this.options.accounts.get(accountId);
    if (account?.state !== "online") return;

    const pageSize = this.options.pageSize ?? DEFAULT_PAGE_SIZE;
    const cap = this.options.maxPerGeneration ?? DEFAULT_MAX_PER_GENERATION;
    const now = Date.now();
    let written = 0;

    for (const generation of GENERATIONS) {
      for (let offset = 0; offset < cap; offset += pageSize) {
        const requested = generation.paged ? pageSize : Math.min(cap, V2_MAX_LIMIT);
        const response = await vrcFetch(account.context(), generation.path(requested, offset));
        if (this.#disposed) return;

        if (!response.ok) {
          // A generation that is unavailable for this account must not abort the other one. The
          // body has to be drained either way or the connection leaks.
          await response.arrayBuffer().catch(() => undefined);
          break;
        }

        const page: unknown = await response.json();
        if (this.#disposed) return;
        if (!Array.isArray(page)) break;

        for (const item of page) {
          const row = toNotificationRow(item, accountId, now);
          if (row === null) continue;
          this.options.store.putNotification(row);
          written += 1;
        }

        // A short page is the last page. Asking for one more is a wasted request per refresh, per
        // account, per generation, forever. An unpaged generation is always one request.
        if (!generation.paged || page.length < pageSize) break;
      }
    }

    if (this.#disposed) return;

    this.options.bus.emit({
      kind: "notification.synced",
      accountId,
      ts: now,
      payload: { count: written },
    });
  }

  #startPolling(accountId: string): void {
    if (this.#timers.has(accountId)) return;

    const interval = new JitteredInterval(
      this.options.refreshIntervalMs ?? DEFAULT_REFRESH_MS,
      () => this.#safeRefresh(accountId),
    );
    interval.start();
    this.#timers.set(accountId, interval);

    // The first refresh is what fills the screen at all; `JitteredInterval` spreads its first tick
    // across the whole interval, which would leave a signed-in user staring at an empty list for
    // minutes on every start.
    void this.#safeRefresh(accountId);
  }

  /** A poll that throws must not kill the timer — the next tick should still run. */
  async #safeRefresh(accountId: string): Promise<void> {
    try {
      await this.refresh(accountId);
    } catch (error) {
      if (!this.#disposed) console.error(`[notifications] refresh failed for ${accountId}:`, error);
    }
  }
}
