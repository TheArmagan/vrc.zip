/**
 * An offset-paged list that loads more when the reader reaches the bottom.
 *
 * Written once because the group screen needs four of them — members, posts, instances, gallery
 * images — and four hand-rolled copies of "am I already loading, did this response outlive its
 * question, is that the last page" is four places for the same bug.
 *
 * What it has to get right, all of which has bitten this codebase before:
 *
 *  - **A response can outlive its question.** Same hazard as the entity modals: the reader switches
 *    tabs, or the subject changes underneath, and an in-flight page resolves into a list that has
 *    moved on. So every load carries an `AbortSignal` *and* a generation counter — an abort is not
 *    instantaneous, and a `fetch` that has already resolved will still run the `await` after it.
 *  - **Duplicate keys are a hard runtime error in Svelte 5**, not a warning: the whole `{#each}`
 *    stops rendering. Offset paging over a list that is being mutated upstream *will* repeat a row
 *    eventually — someone joins the group between page 1 and page 2 and every later row shifts by
 *    one. Appending is therefore always deduplicated, first-wins.
 *  - **`hasMore` cannot be computed from a total.** VRChat does not send one. A short page is the
 *    only end-of-list signal there is, which means a full final page costs one extra empty request.
 *    That is the correct trade: the alternative is a list that silently stops one page early.
 *  - **Concurrent `loadMore` is a duplicate page, not a faster one.** The sentinel can fire twice
 *    before the first response lands (a fast scroll, a resize, a re-render), so re-entry is guarded
 *    rather than assumed not to happen.
 */

import { describeError, isAbort } from "../api.ts";
import {
  classifyFailure,
  dedupeById,
  type LoadFailure,
  type LoadPhase,
} from "./entity-modal.svelte.ts";

/** One page as a fetcher must report it. `hasMore` is the fetcher's call, not this class's. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
}

/**
 * Fetches one page. Receives the signal so it can be abandoned, and must propagate it to `fetch`.
 *
 * `offset` is the number of items already held, not a page number — the daemon's routes take
 * `n`/`offset` because VRChat's do.
 */
export type PageFetcher<T> = (
  offset: number,
  limit: number,
  signal: AbortSignal,
) => Promise<Page<T>>;

/** Rows must be identifiable, because appending deduplicates. See the note at the top. */
export interface Identified {
  readonly id: string;
}

export const DEFAULT_PAGE_SIZE = 50;

export class PagedList<T extends Identified> {
  /** Everything loaded so far, in arrival order, deduplicated by id. */
  items = $state<T[]>([]);

  /** The *first* page's phase. Later pages report through {@link loadingMore} instead. */
  phase = $state<LoadPhase>("idle");
  failure = $state<LoadFailure | null>(null);
  error = $state<string | null>(null);

  /**
   * False once a short page has come back.
   *
   * Starts true because "we have not looked yet" and "there is more" are the same thing as far as
   * the sentinel is concerned, and starting false would mean the first page never loads.
   */
  hasMore = $state(true);

  /** True while a *subsequent* page is in flight. The first page uses {@link phase}. */
  loadingMore = $state(false);

  /** Set when a later page fails. The first page's failure goes to {@link failure}. */
  moreError = $state<string | null>(null);

  #controller: AbortController | null = null;
  #generation = 0;

  constructor(
    private readonly fetchPage: PageFetcher<T>,
    private readonly pageSize: number = DEFAULT_PAGE_SIZE,
  ) {}

  /** True when there is nothing to show and nothing on the way. Drives the empty state. */
  get isEmpty(): boolean {
    return this.phase === "ready" && this.items.length === 0;
  }

  /**
   * Loads the first page, or does nothing if it is already loaded or loading.
   *
   * Idempotent on purpose: a tab's `onVisible` and its parent's mount can both call it, and the
   * guard is what makes "just call ensure" a safe thing to write at the call site.
   */
  ensure(): void {
    if (this.phase !== "idle") return;
    void this.#load(true);
  }

  /**
   * Loads the next page. Safe to call from a scroll sentinel that fires more than once.
   *
   * Every early return here is load-bearing: no first page yet, nothing more to fetch, one already
   * in flight, or the list is in an error state a retry has not cleared.
   */
  loadMore(): void {
    if (this.phase !== "ready" || !this.hasMore || this.loadingMore) return;
    void this.#load(false);
  }

  /** Re-reads from the top. The error state's button, and what a subject change goes through. */
  reset(): void {
    this.#abort();
    this.items = [];
    this.phase = "idle";
    this.failure = null;
    this.error = null;
    this.moreError = null;
    this.hasMore = true;
    this.loadingMore = false;
  }

  /** Retries whichever half failed, without discarding pages that did load. */
  retry(): void {
    if (this.phase === "error") {
      this.phase = "idle";
      this.ensure();
      return;
    }
    this.moreError = null;
    this.loadMore();
  }

  /** Abandons anything in flight. Call when the screen goes away. */
  dispose(): void {
    this.#abort();
  }

  #abort(): void {
    this.#controller?.abort();
    this.#controller = null;
  }

  async #load(first: boolean): Promise<void> {
    if (first) this.#abort();
    const controller = first ? new AbortController() : this.#controller;
    if (controller === null) return;
    if (first) this.#controller = controller;

    this.#generation += 1;
    const generation = this.#generation;

    if (first) {
      this.phase = "loading";
      this.failure = null;
      this.error = null;
    } else {
      this.loadingMore = true;
      this.moreError = null;
    }

    try {
      const page = await this.fetchPage(this.items.length, this.pageSize, controller.signal);
      if (generation !== this.#generation) return;

      // Deduplicated even on the first page: two rows with one id inside a single response is
      // rarer than the paging case but just as fatal to the `{#each}` that renders it.
      this.items = dedupeById(first ? [...page.items] : [...this.items, ...page.items]);
      this.hasMore = page.hasMore;
      this.phase = "ready";
    } catch (cause) {
      // An abandoned load is not a failure. Painting an error for a subject the reader has already
      // navigated away from is worse than painting nothing.
      if (isAbort(cause) || generation !== this.#generation) return;
      if (first) {
        this.failure = classifyFailure(cause);
        this.error = describeError(cause);
        this.phase = "error";
      } else {
        // A failed *later* page keeps everything already loaded on screen. Losing forty rows
        // because the forty-first request failed is the wrong trade.
        this.moreError = describeError(cause);
      }
    } finally {
      if (!first && generation === this.#generation) this.loadingMore = false;
    }
  }
}
