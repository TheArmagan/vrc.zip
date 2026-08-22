/**
 * The inbox, paged and filtered — the notification counterpart of `EventFeed`.
 *
 * The two are deliberately separate classes rather than one generic. They page the same way, but a
 * notification is *state* rather than history: it can be marked read, it is keyed by VRChat's own
 * string id, and its live half comes from `app.notifications` (which the socket updates in place)
 * rather than from the event tail. Folding those differences into one class would mean a type
 * parameter, two callbacks and a lot of `if (isNotification)`.
 *
 * ## What it fixes
 *
 * `GET /api/notifications` took no parameters and answered with a fixed window — fifty rows per
 * account, merged and sorted in the daemon. The screen then filtered *that* in the browser. So
 * "show read" and the account filter only ever searched the newest fifty, and there was no cursor
 * to ask for anything older with: the fifty-first notification on a busy account was unreachable
 * from the UI entirely. Filters are now query parameters, and paging is a `before` cursor.
 *
 * ## Why the live half is `app.notifications`
 *
 * The socket's notification frames update `app.notifications` in place — that list is what the
 * sidebar badge counts, and marking one read has to move both. Rather than duplicate that logic,
 * this merges the app's list in as its live tail, preferring the app's copy of any row it also
 * holds. That way "mark read" is one code path, and a notification that arrives while the screen
 * is open appears at the top without a refetch.
 */

import { api, describeError, isAbort, type NotificationItem } from "../api.ts";
import { app } from "./app.svelte.ts";

export interface NotificationFeedQuery {
  readonly accountId?: string | undefined;
  /** VRChat's own type strings. Empty means every type. */
  readonly types?: readonly string[] | undefined;
  /** `false` hides what has been read. Absent shows both. */
  readonly seen?: boolean | undefined;
  readonly search?: string | undefined;
}

export type FeedPhase = "idle" | "loading" | "ready" | "error";

const PAGE_SIZE = 100;
const RENDER_STEP = 40;

/** True when this notification would pass the same filter the daemon applied to the page. */
export function matchesNotification(item: NotificationItem, query: NotificationFeedQuery): boolean {
  if (query.accountId !== undefined && item.accountId !== query.accountId) return false;
  if (query.seen !== undefined && item.seen !== query.seen) return false;

  const types = query.types ?? [];
  if (types.length > 0 && !types.includes(item.type)) return false;

  const search = (query.search ?? "").trim().toLowerCase();
  if (search === "") return true;
  // The same four columns the daemon's `LIKE` covers, so a live row and a stored row are never
  // judged by different rules.
  return [
    item.type,
    item.senderDisplayName ?? "",
    item.message ?? "",
    item.data === null || item.data === undefined ? "" : JSON.stringify(item.data),
  ]
    .join(" ")
    .toLowerCase()
    .includes(search);
}

function queryKey(query: NotificationFeedQuery): string {
  return JSON.stringify([
    query.accountId ?? null,
    [...(query.types ?? [])].sort(),
    query.seen ?? null,
    (query.search ?? "").trim(),
  ]);
}

export class NotificationFeed {
  /** Everything fetched from the daemon so far, newest first. */
  stored = $state<NotificationItem[]>([]);

  phase = $state<FeedPhase>("idle");
  error = $state<string | null>(null);
  moreError = $state<string | null>(null);
  loadingMore = $state(false);
  hasMore = $state(true);
  renderLimit = $state(RENDER_STEP);

  #query = $state<NotificationFeedQuery>({});
  #key = "";
  #controller: AbortController | null = null;
  #generation = 0;

  /** Everything to show, newest first, with the app's live copy of any row winning. */
  rows: NotificationItem[];

  /** The window actually rendered. */
  visible: NotificationItem[];

  /** True while rows are loaded but not yet rendered. */
  hasUnrendered: boolean;

  constructor() {
    this.rows = $derived.by(() => {
      /*
       * Merged by id, and the *app's* copy wins.
       *
       * Both halves describe the same notifications, but the app's list is the one the socket
       * mutates: a row marked read a second ago is read there and stale here. Preferring the page
       * would make "mark read" visibly undo itself on the next render.
       */
      const live = app.notifications.filter((item) => matchesNotification(item, this.#query));
      const byId = new Map<string, NotificationItem>();
      for (const item of this.stored) byId.set(item.id, item);
      for (const item of live) byId.set(item.id, item);
      return [...byId.values()].sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
    });

    this.visible = $derived(this.rows.slice(0, this.renderLimit));
    this.hasUnrendered = $derived(this.rows.length > this.renderLimit);
  }

  get isEmpty(): boolean {
    return this.phase === "ready" && this.rows.length === 0;
  }

  /** Points the feed at a filter set. Refetches only when the set actually changed. */
  apply(query: NotificationFeedQuery): void {
    const key = queryKey(query);
    if (key === this.#key && this.phase !== "idle") return;
    this.#key = key;
    this.#query = query;
    this.renderLimit = RENDER_STEP;
    this.stored = [];
    this.hasMore = true;
    this.moreError = null;
    void this.#load(true);
  }

  /** Renders more of what is loaded first; asks for another page only once it has caught up. */
  advance(): void {
    if (this.hasUnrendered) {
      this.renderLimit += RENDER_STEP;
      return;
    }
    this.loadMore();
  }

  loadMore(): void {
    if (this.phase !== "ready" || !this.hasMore || this.loadingMore || this.moreError !== null) {
      return;
    }
    void this.#load(false);
  }

  retry(): void {
    if (this.phase === "error") {
      void this.#load(true);
      return;
    }
    this.moreError = null;
    this.loadMore();
  }

  /**
   * Marks one read, here and in the app's list.
   *
   * The local copy is updated optimistically as well as the app's, because a row older than the
   * app's window exists only here — `app.markNotificationSeen` would have nothing to update, and
   * the tick would appear not to work on exactly the rows paging made reachable.
   */
  async markSeen(id: string): Promise<void> {
    this.stored = this.stored.map((item) => (item.id === id ? { ...item, seen: true } : item));
    await app.markNotificationSeen(id);
  }

  dispose(): void {
    this.#controller?.abort();
    this.#controller = null;
  }

  async #load(first: boolean): Promise<void> {
    if (first) {
      this.#controller?.abort();
      this.#controller = new AbortController();
    }
    const controller = this.#controller;
    if (controller === null) return;

    this.#generation += 1;
    const generation = this.#generation;

    if (first) {
      this.phase = "loading";
      this.error = null;
    } else {
      this.loadingMore = true;
      this.moreError = null;
    }

    const query = this.#query;
    const oldest = first ? undefined : this.stored.at(-1)?.ts;

    try {
      const rows = await api.notifications.list(
        {
          limit: PAGE_SIZE,
          ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
          ...(query.types === undefined ? {} : { types: query.types }),
          ...(query.seen === undefined ? {} : { seen: query.seen }),
          ...(query.search === undefined || query.search.trim() === ""
            ? {}
            : { search: query.search.trim() }),
          ...(oldest === undefined ? {} : { before: oldest }),
        },
        controller.signal,
      );
      if (generation !== this.#generation) return;

      this.stored = first ? rows : [...this.stored, ...rows];
      this.hasMore = rows.length >= PAGE_SIZE;
      this.phase = "ready";
      this.error = null;
    } catch (cause) {
      if (isAbort(cause) || generation !== this.#generation) return;
      if (first) {
        this.error = describeError(cause);
        this.phase = "error";
      } else {
        this.moreError = describeError(cause);
      }
    } finally {
      if (!first && generation === this.#generation) this.loadingMore = false;
    }
  }
}
