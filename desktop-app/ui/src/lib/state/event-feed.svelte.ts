/**
 * The feed and the game log, as one paged, filtered, live-merged list.
 *
 * Both screens used to hand-roll this: fetch a first page in an `$effect`, keep a `stored` array,
 * merge `app.liveEvents` into it, and offer a "Load older" button. Two copies of the same four
 * pieces of state, and both had the same three problems.
 *
 * ## What this fixes
 *
 * **Filtering happened after the fetch.** The feed's family tabs and the game log's `gamelog.`
 * prefix were `.filter()` calls over a page the daemon had already chosen. So a family tab showed
 * whatever that family happened to contribute to the newest 150 rows — often nothing — and "load
 * older" walked history it then threw away. Every filter here is a query parameter, and the daemon
 * narrows in SQL.
 *
 * **The whole list rendered at once.** A page is 150 rows and history is unbounded, so scrolling
 * for a minute put thousands of rows in the DOM and kept them there. Rendering is windowed:
 * {@link EventFeed.visible} is a slice, and the scroll sentinel grows the window one step at a
 * time, fetching another page only once the window has caught up with what is loaded. The reader
 * scrolls; the DOM holds what they have actually scrolled past.
 *
 * **A response could outlive its question.** Switching accounts mid-fetch resolved the old page
 * into the new filter. Every load carries an `AbortSignal` *and* a generation counter, for the
 * same reason `PagedList` does: an abort is not instantaneous, and an already-resolved `fetch`
 * still runs the `await` after it.
 *
 * ## What stays in the screen
 *
 * Which filters exist and what they are called. This class takes a query and pages it; it has no
 * opinion about tabs, chips or clients.
 */

import { api, describeError, isAbort } from "../api.ts";
import {
  collapseRepeats,
  EPHEMERAL_KINDS,
  type EventGroup,
  type LiveEvent,
  mergeEvents,
  rowToEvent,
} from "../events.ts";

/** The filter set, as both the daemon query and the predicate live events are matched against. */
export interface EventFeedQuery {
  /** One account, or absent for every account — including rows with no account at all. */
  readonly accountId?: string | undefined;
  /** One game client, by `sessions.id`. */
  readonly sessionId?: number | undefined;
  /** Exact kinds. Empty means every kind. */
  readonly kinds?: readonly string[] | undefined;
  /** Dotted families, matched as a kind prefix so an unknown kind still lands in its family. */
  readonly families?: readonly string[] | undefined;
  /** Free text over the kind, subject, location and payload. */
  readonly search?: string | undefined;
}

export type FeedPhase = "idle" | "loading" | "ready" | "error";

/** How many rows a page asks the daemon for. */
const PAGE_SIZE = 200;

/**
 * How many rows are added to the render window each time the sentinel fires.
 *
 * Smaller than a page on purpose: a page is what is worth one round trip, a window step is what is
 * worth one layout. Tying them together means every fetch also inserts 200 rows in one frame.
 */
const RENDER_STEP = 60;

/** True when this event would pass the same filter the daemon applied to the stored page. */
export function matchesQuery(event: LiveEvent, query: EventFeedQuery): boolean {
  if (query.accountId !== undefined && event.accountId !== query.accountId) return false;
  if (query.sessionId !== undefined && event.sessionId !== query.sessionId) return false;

  // Kinds and families each narrow independently, matching the daemon's assembled `WHERE`. A list
  // of *families* is alternatives; a family plus a kind list is "these kinds, out of that family".
  const kinds = query.kinds ?? [];
  if (kinds.length > 0 && !kinds.includes(event.kind)) return false;

  const families = query.families ?? [];
  if (families.length > 0 && !families.some((family) => event.kind.startsWith(`${family}.`))) {
    return false;
  }

  const search = (query.search ?? "").trim().toLowerCase();
  if (search === "") return true;
  // The same four fields the daemon's `LIKE` covers, so a live row and a stored row are never
  // judged by different rules — a search that kept live rows the reload then dropped would read
  // as the app losing events.
  const haystack = [
    event.kind,
    event.subjectId ?? "",
    event.location ?? "",
    event.payload === null || event.payload === undefined ? "" : JSON.stringify(event.payload),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

/** Serialised filter set, for deciding whether a query change is a real change. */
function queryKey(query: EventFeedQuery): string {
  return JSON.stringify([
    query.accountId ?? null,
    query.sessionId ?? null,
    [...(query.kinds ?? [])].sort(),
    [...(query.families ?? [])].sort(),
    (query.search ?? "").trim(),
  ]);
}

export interface EventFeedOptions {
  /**
   * The live tail, read reactively. A getter rather than the array itself so the class can depend
   * on the caller's `$state` without owning the socket.
   */
  readonly live: () => readonly LiveEvent[];
  /** Filtering the caller always wants, whatever the reader has picked. The game log's family. */
  readonly base?: EventFeedQuery;
  /** Set false for a list where a run of identical rows is the information (nothing does yet). */
  readonly collapse?: boolean;
}

export class EventFeed {
  /** Everything fetched from the daemon so far, newest first. */
  stored = $state<LiveEvent[]>([]);

  phase = $state<FeedPhase>("idle");
  error = $state<string | null>(null);
  /** Set when a *later* page fails. The first page's failure goes to {@link error}. */
  moreError = $state<string | null>(null);
  loadingMore = $state(false);

  /**
   * False once a short page has come back. Starts true because "we have not looked" and "there is
   * more" are the same thing to the sentinel, and starting false means the first page never loads.
   */
  hasMore = $state(true);

  /** How many rows may render. Grown by {@link advance}, reset by {@link apply}. */
  renderLimit = $state(RENDER_STEP);

  #query = $state<EventFeedQuery>({});
  #key = "";
  #controller: AbortController | null = null;
  #generation = 0;
  readonly #options: EventFeedOptions;

  /*
   * The five derived fields are declared here and *assigned in the constructor*, rather than
   * initialised inline like the `$state` ones above.
   *
   * Class field initialisers run before the constructor body, so an inline `$derived` that reads
   * `this.#options` is reading a field that has not been assigned yet. It happens to work, because
   * a derived is lazy and nothing reads it until long after construction — but it is exactly the
   * kind of "works by accident" that TypeScript is right to reject, and it does
   * ("used before its initialization"). Assigning in the constructor makes the order real rather
   * than merely survivable.
   */

  /** The base query and the reader's filters, as one set. */
  effectiveQuery: EventFeedQuery;

  /** Live rows that pass the current filter. The socket cannot be filtered upstream. */
  live: readonly LiveEvent[];

  /**
   * Everything to show, newest first.
   *
   * Ephemeral kinds are dropped here as well as at the socket: a database written before those
   * kinds joined the feed writer's refusal list still has rows for them, and a row that appears on
   * reload and vanishes on the next one reads as a bug rather than as history.
   */
  rows: LiveEvent[];

  /** The window actually rendered, with identical adjacent rows collapsed into one. */
  visible: EventGroup[];

  /** True while rows are loaded but not yet rendered — the sentinel has window left to grow. */
  hasUnrendered: boolean;

  constructor(options: EventFeedOptions) {
    this.#options = options;

    this.effectiveQuery = $derived<EventFeedQuery>({ ...options.base, ...this.#query });

    this.live = $derived(
      options.live().filter((event) => matchesQuery(event, this.effectiveQuery)),
    );

    this.rows = $derived(
      mergeEvents(this.stored, this.live).filter((event) => !EPHEMERAL_KINDS.has(event.kind)),
    );

    this.visible = $derived<EventGroup[]>(
      options.collapse === false
        ? this.rows
            .slice(0, this.renderLimit)
            .map((event) => ({ event, repeats: 1, oldestTs: event.ts }))
        : collapseRepeats(this.rows.slice(0, this.renderLimit)),
    );

    this.hasUnrendered = $derived(this.rows.length > this.renderLimit);
  }

  /** Nothing loaded, nothing on the way, no filter to blame. Drives the empty state. */
  get isEmpty(): boolean {
    return this.phase === "ready" && this.rows.length === 0;
  }

  /**
   * Points the feed at a filter set. Refetches only when the set actually changed.
   *
   * Safe to call from an `$effect` on every run, which is the point: the screen describes what it
   * wants and this decides whether that is news. Without the comparison, `app.sessions` being
   * replaced wholesale on every refresh would refetch the first page — and throw away the reader's
   * scroll position — every time a session event ticked.
   */
  apply(query: EventFeedQuery): void {
    const key = queryKey({ ...this.#options.base, ...query });
    if (key === this.#key && this.phase !== "idle") return;
    this.#key = key;
    this.#query = query;
    this.renderLimit = RENDER_STEP;
    this.stored = [];
    this.hasMore = true;
    this.moreError = null;
    void this.#load(true);
  }

  /**
   * What the scroll sentinel calls.
   *
   * Renders more of what is already loaded first, and only asks the daemon for another page once
   * the window has caught up. Fetching ahead of the window would load history nobody has scrolled
   * to yet, which is the behaviour this class exists to stop.
   */
  advance(): void {
    if (this.hasUnrendered) {
      this.renderLimit += RENDER_STEP;
      return;
    }
    this.loadMore();
  }

  /** Fetches the next page. Guards its own re-entry: the sentinel legitimately fires twice. */
  loadMore(): void {
    if (this.phase !== "ready" || !this.hasMore || this.loadingMore || this.moreError !== null) {
      return;
    }
    void this.#load(false);
  }

  /** Retries whichever half failed, keeping the pages that did load. */
  retry(): void {
    if (this.phase === "error") {
      void this.#load(true);
      return;
    }
    this.moreError = null;
    this.loadMore();
  }

  /** Abandons anything in flight. Call when the screen goes away. */
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

    const query = this.effectiveQuery;
    // `before` is an exclusive upper bound on the timestamp, so paging continues from the oldest
    // row held rather than from a count. An offset would repeat and skip rows as the daemon writes
    // new ones at the top, which it does continuously.
    const oldest = first ? undefined : this.stored.at(-1)?.ts;

    try {
      const rows = await api.events(
        {
          limit: PAGE_SIZE,
          ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
          ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
          ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
          ...(query.families === undefined ? {} : { families: query.families }),
          ...(query.search === undefined || query.search.trim() === ""
            ? {}
            : { search: query.search.trim() }),
          ...(oldest === undefined ? {} : { before: oldest }),
        },
        controller.signal,
      );
      if (generation !== this.#generation) return;

      const events = rows.map(rowToEvent);
      this.stored = first ? events : [...this.stored, ...events];
      // A short page is the only end-of-history signal there is; the daemon sends no total.
      this.hasMore = rows.length >= PAGE_SIZE;
      this.phase = "ready";
      this.error = null;
    } catch (cause) {
      // An abandoned load is not a failure. Painting an error for a filter the reader has already
      // moved off is worse than painting nothing.
      if (isAbort(cause) || generation !== this.#generation) return;
      if (first) {
        this.error = describeError(cause);
        this.phase = "error";
      } else {
        // A failed later page keeps everything already on screen. Losing two hundred rows because
        // the two hundred and first request failed is the wrong trade.
        this.moreError = describeError(cause);
      }
    } finally {
      if (!first && generation === this.#generation) this.loadingMore = false;
    }
  }
}
