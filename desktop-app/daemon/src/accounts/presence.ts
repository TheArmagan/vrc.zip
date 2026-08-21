import type { LimitedUserFriend } from "@vrcz/api/types";
import type { EventBus, Subscription } from "../bus/event-bus.ts";
import { JitteredInterval } from "../net/jitter.ts";
import { vrcFetch } from "../net/request.ts";
import { pickUserImageUrl } from "../net/user-image.ts";
import type { Store } from "../store/index.ts";
import type { AccountManager } from "./manager.ts";

/**
 * Friend presence: who is online, where, and on what.
 *
 * Presence is **in-memory, not a table**. It is a projection of live state that is wrong the moment
 * the daemon stops, and persisting it would mean serving stale "online" rows after a restart until
 * the first poll landed. What *is* persisted is the friendship itself (`friend_log`) and the user
 * record (`user_cache`), both of which are history rather than state.
 *
 * Two sources, and the split matters:
 *  - The **pipeline** carries the deltas, and is the reason presence is live at all.
 *  - A **slow jittered poll** reconciles. Sockets drop, frames are missed, and a friend who went
 *    offline during a reconnect would otherwise show as online forever.
 */

/** VRChat's trust ranks, derived from tags. Ordered low to high; the highest tag present wins. */
const TRUST_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["system_trust_basic", "basic"],
  ["system_trust_known", "known"],
  ["system_trust_trusted", "trusted"],
  ["system_trust_veteran", "veteran"],
];

export function trustLevelOf(tags: readonly string[] | undefined): string {
  if (!tags) return "visitor";
  if (tags.includes("system_troll")) return "troll";

  let level = "visitor";
  for (const [tag, name] of TRUST_TAGS) {
    if (tags.includes(tag)) level = name;
  }
  return level;
}

export interface FriendPresenceRecord {
  readonly id: string;
  readonly displayName: string;
  /** VRChat's own status string: `active`, `join me`, `ask me`, `busy`, `offline`. */
  readonly status: string;
  readonly statusDescription: string | null;
  /**
   * Raw VRChat location. May be `""`, `"offline"`, `"traveling"`, `"traveling:traveling"`,
   * `"private"`, or a real instance string — carried through untouched so the UI decides how to
   * render each. See PLAN.md §1.5.
   */
  readonly location: string | null;
  readonly worldId: string | null;
  readonly platform: string | null;
  readonly trustLevel: string;
  readonly isOnline: boolean;
  /**
   * An absolute VRChat image URL, or null when the friend has no image at all. It is *not* loadable
   * by a browser: those URLs need the account's auth cookie and the mandatory User-Agent, so the UI
   * goes through the daemon's `GET /api/image` proxy.
   */
  readonly iconUrl: string | null;
  /** Unix ms this record was last updated from any source. */
  readonly lastSeenAt: number;
}

export interface PresenceServiceOptions {
  readonly accounts: AccountManager;
  readonly store: Store;
  readonly bus: EventBus;
  /** Base poll interval. Jittered, and never clock-aligned. PLAN.md §1.4 suggests 2–5 minutes. */
  readonly refreshIntervalMs?: number;
  /** VRChat caps `n` at 100. */
  readonly pageSize?: number;
}

const DEFAULT_REFRESH_MS = 3 * 60_000;
const DEFAULT_PAGE_SIZE = 100;

export class PresenceService {
  /** accountId -> userId -> record. Per account, because friend lists differ per account. */
  readonly #byAccount = new Map<string, Map<string, FriendPresenceRecord>>();
  readonly #timers = new Map<string, JitteredInterval>();
  #subscription: Subscription | null = null;
  /**
   * Set by `stop()`. A refresh already awaiting the network resumes *after* shutdown has closed the
   * store, so cancelling the timer is not enough — the resumed continuation would write to a closed
   * database. Anything that outlives `stop()` has to re-check this after every await.
   */
  #disposed = false;

  constructor(private readonly options: PresenceServiceOptions) {}

  start(): void {
    this.#subscription = this.options.bus.subscribe(
      (event) => this.#onBusEvent(event.kind, event),
      {
        kinds: ["friend.*", "user.updated", "account.ready"],
      },
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

  list(accountId: string): FriendPresenceRecord[] {
    const records = [...(this.#byAccount.get(accountId)?.values() ?? [])];
    // Online first, then by name. The friends screen is scanned, not read top-to-bottom.
    return records.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  listAll(): FriendPresenceRecord[] {
    return [...this.#byAccount.keys()].flatMap((id) => this.list(id));
  }

  /**
   * Fetches the full friends list for one account and replaces its presence map.
   *
   * Online and offline are **separate paginated queries** — VRChat's `offline` flag is a filter, not
   * a field, so one pass returns only half the list. Fetching only the online half would make every
   * offline friend vanish from the UI rather than appear as offline.
   */
  async refresh(accountId: string): Promise<void> {
    if (this.#disposed) return;

    const account = this.options.accounts.get(accountId);
    if (account?.state !== "online") return;

    const pageSize = this.options.pageSize ?? DEFAULT_PAGE_SIZE;
    const next = new Map<string, FriendPresenceRecord>();
    const now = Date.now();

    for (const offline of [false, true]) {
      for (let offset = 0; ; offset += pageSize) {
        const query = `?n=${String(pageSize)}&offset=${String(offset)}&offline=${String(offline)}`;
        const response = await vrcFetch(account.context(), `/auth/user/friends${query}`);
        if (this.#disposed) return;
        if (!response.ok) {
          await response.arrayBuffer().catch(() => undefined);
          return;
        }

        const page = (await response.json()) as LimitedUserFriend[];
        if (this.#disposed) return;
        for (const friend of page) {
          next.set(friend.id, this.#toRecord(friend, !offline, now));
        }

        // A short page is the last page. Asking for one more would be a wasted request per refresh,
        // per account, forever.
        if (page.length < pageSize) break;
      }
    }

    if (this.#disposed) return;

    this.#byAccount.set(accountId, next);
    this.#persistFriendships(accountId, next, now);
    this.options.bus.emit({
      kind: "friend.list_refreshed",
      accountId,
      ts: now,
      payload: { count: next.size },
    });
  }

  #toRecord(friend: LimitedUserFriend, isOnline: boolean, now: number): FriendPresenceRecord {
    return {
      id: friend.id,
      displayName: friend.displayName,
      status: friend.status ?? (isOnline ? "active" : "offline"),
      statusDescription: friend.statusDescription ?? null,
      location: friend.location ?? null,
      // `friend.location` is literally "private" when hidden; there is no world id to recover.
      worldId:
        typeof friend.location === "string" && friend.location.startsWith("wrld_")
          ? (friend.location.split(":")[0] ?? null)
          : null,
      platform: friend.platform ?? null,
      trustLevel: trustLevelOf(friend.tags),
      isOnline,
      iconUrl: pickUserImageUrl(friend),
      lastSeenAt: now,
    };
  }

  /**
   * Records the friendship in `friend_log`, which is **never auto-deleted** — "when did we become
   * friends" is the kind of thing people keep for years. Presence itself is not written.
   */
  #persistFriendships(
    accountId: string,
    records: Map<string, FriendPresenceRecord>,
    now: number,
  ): void {
    for (const record of records.values()) {
      const existing = this.options.store.getFriend(accountId, record.id);
      this.options.store.upsertFriend({
        account_id: accountId,
        user_id: record.id,
        display_name: record.displayName,
        trust_level: record.trustLevel,
        // Keep the original date. Overwriting it on every poll would reset every friendship to
        // "friends since today" and quietly destroy the only copy of that history.
        friended_at: existing?.friended_at ?? now,
        unfriended_at: null,
      });
    }
  }

  #onBusEvent(kind: string, event: { accountId: string | null; payload?: unknown }): void {
    if (!event.accountId) return;

    if (kind === "account.ready") {
      // `account.ready`, not `account.state`: the latter fires while the manager still has the
      // account under its pending id, so `accounts.get(realId)` would return undefined and the
      // first refresh would silently do nothing.
      this.#startPolling(event.accountId);
      return;
    }

    const payload = event.payload as
      | { userId?: string; userid?: string; user?: Partial<LimitedUserFriend>; location?: string }
      | undefined;
    if (!payload) return;

    // `friend-active` spells it `userid`. Upstream typo — see PLAN.md §1.5.
    const userId = payload.userId ?? payload.userid ?? payload.user?.id;
    if (!userId) return;

    const map = this.#byAccount.get(event.accountId);
    if (!map) return;

    const existing = map.get(userId);
    const now = Date.now();

    if (kind === "friend.removed") {
      map.delete(userId);
      return;
    }

    const isOnline = kind !== "friend.offline";
    const user = payload.user;

    map.set(userId, {
      id: userId,
      displayName: user?.displayName ?? existing?.displayName ?? userId,
      status: user?.status ?? (isOnline ? (existing?.status ?? "active") : "offline"),
      statusDescription: user?.statusDescription ?? existing?.statusDescription ?? null,
      location:
        payload.location ?? user?.location ?? (isOnline ? (existing?.location ?? null) : null),
      worldId: existing?.worldId ?? null,
      platform: user?.platform ?? existing?.platform ?? null,
      trustLevel: user?.tags ? trustLevelOf(user.tags) : (existing?.trustLevel ?? "visitor"),
      isOnline,
      // A pipeline frame carries a *partial* user, and several frame types carry none of the image
      // fields at all. Falling back to what we already have is the difference between an icon that
      // stays put and one that blinks out the moment a friend changes status.
      iconUrl: pickUserImageUrl(user) ?? existing?.iconUrl ?? null,
      lastSeenAt: now,
    });
  }

  #startPolling(accountId: string): void {
    if (this.#timers.has(accountId)) return;

    const interval = new JitteredInterval(
      this.options.refreshIntervalMs ?? DEFAULT_REFRESH_MS,
      () => this.refresh(accountId),
    );
    interval.start();
    this.#timers.set(accountId, interval);

    // The first refresh is what fills the list at all; `JitteredInterval` deliberately spreads its
    // first tick across the whole interval, which would leave the UI empty for minutes.
    void this.refresh(accountId);
  }
}
