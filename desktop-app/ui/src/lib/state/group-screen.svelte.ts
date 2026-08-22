/**
 * The full group screen's state: one group record and its four paged lists.
 *
 * The counterpart to `group-modal.svelte.ts`, and the split between them is deliberate. The modal
 * answers "what is this group" in one glance from wherever you already were, and it is a singleton
 * because it is re-targeted constantly. This is a *place*: it has a URL, it survives a reload, and
 * it holds four independent lists that each want their own scroll position and their own failure.
 * A dialog sharing a back stack with two other dialogs is the wrong container for that.
 *
 * ## Which account is asking is part of the question
 *
 * Every route here takes an `accountId`, and the answers genuinely differ by it: a group shows its
 * member list to members and 403s everyone else, and `membershipStatus` is a statement about the
 * viewer rather than about the group. The screen therefore lets the reader change it and re-reads
 * everything when they do, rather than the daemon silently picking whichever account is online.
 *
 * ## Lists load when their tab is first opened, not on arrival
 *
 * Four lists eagerly fetched on mount is four requests through a 20/s per-account bucket for three
 * lists nobody looked at. `ensure()` is idempotent, so the tab just calls it on show and the guard
 * does the rest.
 */

import {
  api,
  describeError,
  type GroupDetail,
  type GroupGalleryImageSummary,
  type GroupInstanceSummary,
  type GroupMemberSummary,
  type GroupPostSummary,
  isAbort,
  type UserGroup,
} from "../api.ts";
import { classifyFailure, type LoadFailure, type LoadPhase } from "./entity-modal.svelte.ts";
import { PagedList } from "./paged.svelte.ts";

export const GROUP_TABS = ["members", "posts", "galleries", "instances"] as const;
export type GroupTab = (typeof GROUP_TABS)[number];

export function isGroupTab(value: string): value is GroupTab {
  return (GROUP_TABS as readonly string[]).includes(value);
}

/** Page size for the three paged lists. VRChat's own ceiling is 100; the daemon clamps there. */
const PAGE_SIZE = 50;

/**
 * Instances arrive unpaged, but the screen renders them through the same component as the others.
 *
 * So they are wrapped in a one-page `PagedList` rather than given a parallel loading/empty/failure
 * path of their own. The alternative is a fourth set of the same four states written slightly
 * differently, which is how the fourth one ends up the buggy one.
 */
function unpaged<T extends { readonly id: string }>(
  fetchAll: (signal: AbortSignal) => Promise<readonly T[]>,
): PagedList<T> {
  return new PagedList<T>(
    async (_offset, _limit, signal) => ({
      items: await fetchAll(signal),
      hasMore: false,
    }),
    PAGE_SIZE,
  );
}

/** An instance row carries no `id` of its own upstream, so the screen keys on the instance id. */
export interface GroupInstanceRow extends GroupInstanceSummary {
  readonly id: string;
}

export class GroupScreenState {
  groupId = $state<string | null>(null);
  accountId = $state<string | null>(null);

  /** The summary a caller already had, drawn while the record loads. Same trick as the modal. */
  hint = $state<UserGroup | null>(null);
  group = $state<GroupDetail | null>(null);

  phase = $state<LoadPhase>("idle");
  failure = $state<LoadFailure | null>(null);
  error = $state<string | null>(null);

  tab = $state<GroupTab>("members");

  /** Which gallery the galleries tab is showing. Null until the group record names one. */
  galleryId = $state<string | null>(null);

  members: PagedList<GroupMemberSummary>;
  posts: PagedList<GroupPostSummary>;
  instances: PagedList<GroupInstanceRow>;
  images: PagedList<GroupGalleryImageSummary>;

  #controller: AbortController | null = null;
  #generation = 0;

  constructor() {
    /*
     * Each daemon route names its array after what is in it - `members`, `posts`, `images` - while
     * `PagedList` speaks in `items`. Renaming happens here, at the one seam, rather than the wire
     * being flattened to a generic envelope: `{ members }` is the more useful shape to read in a
     * network tab and in a third-party client, and one `.members` per fetcher is a cheap adapter.
     */
    this.members = new PagedList<GroupMemberSummary>(async (offset, n, signal) => {
      const page = await api.groups.members(this.#id(), offset, n, this.accountId, signal);
      return { items: page.members, hasMore: page.hasMore };
    }, PAGE_SIZE);
    this.posts = new PagedList<GroupPostSummary>(async (offset, n, signal) => {
      const page = await api.groups.posts(this.#id(), offset, n, this.accountId, signal);
      return { items: page.posts, hasMore: page.hasMore };
    }, PAGE_SIZE);
    this.instances = unpaged<GroupInstanceRow>(async (signal) => {
      const { instances } = await api.groups.instances(this.#id(), this.accountId, signal);
      // Keyed on the instance id because VRChat gives these rows no id field of their own, and
      // `{#each}` needs a stable unique key or Svelte 5 takes the whole list down.
      return instances.map((instance) => ({ ...instance, id: instance.instanceId }));
    });
    this.images = new PagedList<GroupGalleryImageSummary>(async (offset, n, signal) => {
      const gallery = this.galleryId;
      // A group with no galleries at all is an ordinary group, and the tab renders its empty state
      // rather than a failure. There is nothing to request.
      if (gallery === null) return { items: [], hasMore: false };
      const page = await api.groups.galleryImages(
        this.#id(),
        gallery,
        offset,
        n,
        this.accountId,
        signal,
      );
      return { items: page.images, hasMore: page.hasMore };
    }, PAGE_SIZE);
  }

  /** The name to show now: the fetched record, else the caller's summary, else nothing. */
  summary = $derived<UserGroup | null>(this.group ?? this.hint);

  get galleries() {
    return this.group?.galleries ?? [];
  }

  /** Points a fresh screen at a group. Safe to call again with the same id — it does nothing. */
  open(
    groupId: string,
    options: { accountId?: string | null; hint?: UserGroup | null } = {},
  ): void {
    const accountId = options.accountId ?? this.accountId;
    if (this.groupId === groupId && this.accountId === accountId && this.phase !== "idle") return;

    this.groupId = groupId;
    this.accountId = accountId;
    this.hint = options.hint ?? null;
    this.#reload();
  }

  /**
   * Re-reads everything through a different account.
   *
   * Everything, not just the group record: `membershipStatus` moves, and so does whether the member
   * list 403s. Keeping the old lists while the header changed account would put one account's
   * answers under another account's name, which is the exact failure the entity modals' generation
   * counter exists to prevent.
   */
  setAccount(accountId: string | null): void {
    if (this.accountId === accountId) return;
    this.accountId = accountId;
    this.#reload();
  }

  retry(): void {
    this.#reload();
  }

  /** Abandons everything in flight. The screen's teardown. */
  dispose(): void {
    this.#controller?.abort();
    this.#controller = null;
    for (const list of [this.members, this.posts, this.instances, this.images]) list.dispose();
  }

  /** Switches the galleries tab to another gallery, discarding the previous one's pages. */
  selectGallery(galleryId: string): void {
    if (this.galleryId === galleryId) return;
    this.galleryId = galleryId;
    this.images.reset();
    this.images.ensure();
  }

  #id(): string {
    // Every fetcher runs behind `open()`, which sets this first. A list cannot be asked for a page
    // before the screen knows what it is showing.
    return this.groupId ?? "";
  }

  #reload(): void {
    this.members.reset();
    this.posts.reset();
    this.instances.reset();
    this.images.reset();
    this.galleryId = null;
    void this.#loadGroup();
  }

  async #loadGroup(): Promise<void> {
    const groupId = this.groupId;
    if (groupId === null) return;

    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    this.#generation += 1;
    const generation = this.#generation;

    this.phase = "loading";
    this.failure = null;
    this.error = null;
    this.group = null;

    try {
      const group = await api.groups.get(groupId, this.accountId, controller.signal);
      if (generation !== this.#generation) return;
      this.group = group;
      this.phase = "ready";
      // The gallery list arrives with the group, so the first one can be selected without a second
      // round trip. Its images still wait for the tab to be opened.
      this.galleryId = group.galleries[0]?.id ?? null;
    } catch (cause) {
      if (isAbort(cause) || generation !== this.#generation) return;
      this.failure = classifyFailure(cause);
      this.error = describeError(cause);
      this.phase = "error";
    }
  }
}

/**
 * One instance, like the modals.
 *
 * The screen is a route rather than a component someone mounts twice, and holding the state outside
 * the component means a back-and-forward through the group keeps what it had already loaded.
 */
export const groupScreen = new GroupScreenState();
