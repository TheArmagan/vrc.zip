/**
 * The one group modal, and everything it knows.
 *
 * The third of the three — see `entity-modal.svelte.ts` for the machinery all of them share, and
 * `user-modal.svelte.ts` for why a dialog opened from a hundred different rows is a singleton the
 * callers re-target rather than a component each of them mounts.
 *
 * Groups reached vrc.zip last, and until now a group was a badge that opened vrchat.com in a
 * browser tab. That was honest while the daemon knew three fields about a group; it stopped being
 * honest once `GET /groups/{id}` was wired up, because leaving the app to read something the app
 * has is worse than not having it.
 *
 * This used to be half a group: the card, plus a route at `#/groups/<id>` that carried the members,
 * the posts and the galleries. Two places for one noun was the mistake. A reader who opened a badge
 * and wanted the roster had to leave the dialog, and the route then had its own account picker, its
 * own header, and its own set of the same four failure states drifting away from these. One dialog
 * with six tabs is the same information with one implementation of it.
 *
 * Two things are specific to a group and neither is an error:
 *
 *  - **A 404 has two causes and they are indistinguishable.** VRChat answers 404 both for a group
 *    that no longer exists and for a private one the asking account may not see. So the sentence
 *    says both. Guessing which, in front of a user who can see the group perfectly well on their
 *    own screen, would be a confident wrong answer — the failure mode this codebase keeps finding.
 *  - **`membershipStatus` is about the viewer, not the group.** It moves when `accountId` does,
 *    which is exactly why `accountId` is threaded from whatever row was clicked instead of the
 *    daemon picking any online account.
 *
 * ## Which account is asking is part of the question
 *
 * Every route behind these tabs takes an `accountId`, and the answers genuinely differ by it: a
 * group shows its member list to its own members and 403s everyone else, and `membershipStatus` is
 * a statement about the viewer rather than about the group. So the account the dialog was opened
 * through is a control the reader can change, and changing it re-reads *everything* — the record
 * and every list together. Keeping one account's member list under another account's membership
 * badge would be a lie assembled out of two true halves.
 *
 * ## Lists load when their tab is first opened, not on arrival
 *
 * Four lists eagerly fetched on open is four requests through a 20/s per-account bucket for three
 * lists nobody looked at, paid for by clicking a badge. `PagedList.ensure()` is idempotent, so
 * `selectTab` just calls the right one and the guard does the rest. The guard runs from `idle`
 * only, which is why every abandonment goes through `reset()` — see `resetPayload`.
 *
 * There is a `hint` path too, and it earns its keep: nearly every route into this dialog — a
 * represented badge, a row in a user's Groups tab — already holds a `UserGroup` with the name, the
 * icon, the banner and the member count on it. Seeding those means the card is drawn *before* the
 * fetch, and the fetch fills in what only it can know. A `GroupDetail` is a `UserGroup` plus the
 * rest, so this is a widening rather than two shapes to reconcile.
 */

import {
  api,
  type GroupDetail,
  type GroupGalleryImageSummary,
  type GroupInstanceSummary,
  type GroupMemberSummary,
  type GroupPostSummary,
  type UserGroup,
} from "../api.ts";
import { shortId } from "../format.ts";
import { EntityModalState, type ResumePoint } from "./entity-modal.svelte.ts";
import { PagedList } from "./paged.svelte.ts";

/**
 * The modal's tabs.
 *
 * Overview is the group as a document and is what the whole dialog used to be. The three lists in
 * the middle are the group as a *place*: who is in it, what has been said in it, what has been put
 * on its walls. Instances is not a fact about the group at all — it is where the group is gathering
 * right now, it changes minute to minute, and most groups have none, which is why its empty state
 * is allowed to say so rather than leaving a blank stretch of the card. Raw JSON is the same escape
 * hatch the user modal has: the card is a curated reading of the data, and this is how anyone finds
 * out when the reading and the data disagree.
 */
export type GroupModalTab = "overview" | "members" | "posts" | "galleries" | "instances" | "raw";

export const GROUP_MODAL_TABS: readonly GroupModalTab[] = [
  "overview",
  "members",
  "posts",
  "galleries",
  "instances",
  "raw",
];

export const GROUP_MODAL_TAB_LABELS: Record<GroupModalTab, string> = {
  overview: "Overview",
  members: "Members",
  posts: "Posts",
  galleries: "Galleries",
  instances: "Instances",
  raw: "Raw JSON",
};

/** Page size for the three paged lists. VRChat's own ceiling is 100; the daemon clamps there. */
const PAGE_SIZE = 50;

/** An instance row carries no `id` of its own upstream, so the instance id stands in as one. */
export interface GroupInstanceRow extends GroupInstanceSummary {
  readonly id: string;
}

export interface OpenGroupOptions {
  /**
   * The summary the caller already had on screen. Drawn immediately, then replaced by the fetch.
   * Never merged field-by-field with the answer: a half-fetched card that mixes two reads is
   * harder to reason about than one that is briefly incomplete.
   */
  readonly hint?: UserGroup | null | undefined;
  /** The account this group was seen through; it decides `membershipStatus` and visibility. */
  readonly accountId?: string | null | undefined;
  /**
   * Which tab to land on. Absent means Overview.
   *
   * It exists for the callers that already know what the reader is after — a command palette entry
   * whose whole title is "members, posts and galleries" would be answered badly by a description.
   */
  readonly tab?: GroupModalTab | undefined;
}

class GroupModalState extends EntityModalState {
  groupId = $state<string | null>(null);
  /** The caller's summary, held until the full record lands. Null when there was none. */
  hint = $state<UserGroup | null>(null);

  group = $state<GroupDetail | null>(null);

  /** Which tab is showing. Always back to `overview` when the dialog moves to a new group. */
  tab = $state<GroupModalTab>("overview");

  /** Which gallery the galleries tab is showing. Null until the group record names one. */
  galleryId = $state<string | null>(null);

  members: PagedList<GroupMemberSummary>;
  posts: PagedList<GroupPostSummary>;
  images: PagedList<GroupGalleryImageSummary>;

  /**
   * The group's open instances, as a one-page list.
   *
   * The route answers unpaged, but `PagedSection` is what draws every list of this shape in the app
   * — skeleton, empty state, and a `forbidden` that is a rule about who may look rather than an
   * error. Wrapping the single answer in a `PagedList` buys all of that instead of a fourth
   * hand-written set of the same states, written slightly differently, which is how the fourth one
   * ends up the buggy one.
   */
  instances: PagedList<GroupInstanceRow>;

  constructor() {
    super();
    /*
     * Each daemon route names its array after what is in it - `members`, `posts`, `images` - while
     * `PagedList` speaks in `items`. Renaming happens here, at the one seam, rather than the wire
     * being flattened to a generic envelope: `{ members }` is the more useful shape to read in a
     * network tab and in a third-party client, and one `.members` per fetcher is a cheap adapter.
     *
     * Every fetcher reads `groupId` and `accountId` off `this` at call time rather than closing
     * over them, because both move underneath a list that is already built.
     */
    this.members = new PagedList<GroupMemberSummary>(async (offset, n, signal) => {
      const groupId = this.groupId;
      if (groupId === null) return { items: [], hasMore: false };
      const page = await api.groups.members(groupId, offset, n, this.accountId, signal);
      return { items: page.members, hasMore: page.hasMore };
    }, PAGE_SIZE);

    this.posts = new PagedList<GroupPostSummary>(async (offset, n, signal) => {
      const groupId = this.groupId;
      if (groupId === null) return { items: [], hasMore: false };
      const page = await api.groups.posts(groupId, offset, n, this.accountId, signal);
      return { items: page.posts, hasMore: page.hasMore };
    }, PAGE_SIZE);

    this.images = new PagedList<GroupGalleryImageSummary>(async (offset, n, signal) => {
      const groupId = this.groupId;
      const gallery = this.galleryId;
      // A group with no galleries at all is an ordinary group, and the tab renders its empty state
      // rather than a failure. There is nothing to request.
      if (groupId === null || gallery === null) return { items: [], hasMore: false };
      const page = await api.groups.galleryImages(
        groupId,
        gallery,
        offset,
        n,
        this.accountId,
        signal,
      );
      return { items: page.images, hasMore: page.hasMore };
    }, PAGE_SIZE);

    this.instances = new PagedList<GroupInstanceRow>(async (_offset, _limit, signal) => {
      const groupId = this.groupId;
      // The list only ever loads from `ensureInstances`, which runs behind an open group. A page
      // asked for before then has nothing to ask about.
      if (groupId === null) return { items: [], hasMore: false };
      const { instances } = await api.groups.instances(groupId, this.accountId, signal);
      // VRChat gives these rows no id of their own, and `{#each}` needs a stable unique key or
      // Svelte 5 takes the whole list down rather than warning.
      return {
        items: instances.map((instance) => ({ ...instance, id: instance.instanceId })),
        hasMore: false,
      };
    });
  }

  /**
   * What to render: the fetched group, else the caller's summary, else nothing.
   *
   * The card reads from this rather than from `group`, which is what makes the hint worth having —
   * a name, an icon and a banner are on screen from the first frame, and the rows that only the
   * fetch can fill appear as it lands rather than replacing a spinner.
   */
  summary = $derived<UserGroup | null>(this.group ?? this.hint);

  /** The name for the title bar: the loaded one, the caller's, or the short id. */
  title = $derived(this.summary?.name ?? shortId(this.groupId, 18));

  /** The banner, then nothing. A group icon stretched across a letterbox is not a banner. */
  bannerUrl = $derived(this.summary?.bannerUrl ?? null);

  /** The galleries the group record named. They ride in with it, so listing them costs nothing. */
  get galleries() {
    return this.group?.galleries ?? [];
  }

  /**
   * Everything the dialog holds, as a plain object — what "Copy JSON" copies.
   *
   * Same reasoning as the other two modals: the card above is a curated reading of the data, and
   * this is how anyone finds out when the reading and the data disagree.
   */
  snapshot = $derived({
    groupId: this.groupId,
    seenThroughAccountId: this.accountId,
    group: this.group,
  });

  /** Opens the dialog on `groupId`, replacing whatever it was showing. */
  openGroup(groupId: string, options: OpenGroupOptions = {}): void {
    const accountId = options.accountId ?? null;
    /*
     * The account is part of what "the same group" means here, not incidental to it. Every list
     * behind these tabs is filtered by who is asking, so re-opening the same id through a different
     * account is a different question and has to be re-read rather than recognised.
     */
    const same = this.groupId === groupId && this.accountId === accountId && this.phase === "ready";
    // First, before the assignments below — see `EntityModalState.takeScreen`.
    this.takeScreen(!same);
    this.groupId = groupId;
    this.accountId = accountId;
    // Reopening the group already on screen keeps it there, and keeps every list it has already
    // paid for. Only the tab moves, and only when the caller asked for one.
    if (same) {
      if (options.tab !== undefined) this.selectTab(options.tab);
      return;
    }
    this.hint = options.hint ?? null;
    // `#load` begins by resetting the tab and all four lists — see `resetPayload` — so `selectTab`
    // has to come after it, or the tab it just chose would be reset back to Overview.
    void this.#load(groupId);
    this.selectTab(options.tab ?? "overview");
  }

  retry(): void {
    if (this.groupId !== null) void this.#load(this.groupId);
  }

  /**
   * Re-reads everything through a different account.
   *
   * Everything, not just the group record: `membershipStatus` moves, and so does whether the member
   * list 403s at all. Keeping the old lists while the badge above them changed account would put
   * one account's answers under another account's name, which is the exact failure the generation
   * counter in `EntityModalState` exists to prevent.
   *
   * The tab stays where the reader left it — they changed who is asking, not what they were reading
   * — so it is captured and re-selected, which is also what starts its list loading again.
   */
  setAccount(accountId: string | null): void {
    if (this.accountId === accountId) return;
    this.accountId = accountId;
    const groupId = this.groupId;
    if (groupId === null) return;
    const tab = this.tab;
    void this.#load(groupId);
    this.selectTab(tab);
  }

  /**
   * Loads a tab's first page the first time it is reached, and not before.
   *
   * `PagedList.ensure()` is the `phase !== "idle"` guard, which is the same guard the user modal's
   * lazy tabs use and needs the same care about abandonment: `idle` is the only state it will run
   * from again, so a load that was thrown away has to end back there rather than at `loading`. It
   * does, because the only thing that abandons these lists is `reset()` in `resetPayload`, and that
   * aborts and returns the phase to `idle` in the same call.
   */
  ensureMembers(): void {
    if (this.groupId === null) return;
    this.members.ensure();
  }

  ensurePosts(): void {
    if (this.groupId === null) return;
    this.posts.ensure();
  }

  ensureImages(): void {
    if (this.groupId === null) return;
    this.images.ensure();
  }

  ensureInstances(): void {
    if (this.groupId === null) return;
    this.instances.ensure();
  }

  /** Switches tabs, loading whatever that tab needs the first time it is reached. */
  selectTab(tab: GroupModalTab): void {
    this.tab = tab;
    switch (tab) {
      case "members":
        this.ensureMembers();
        return;
      case "posts":
        this.ensurePosts();
        return;
      case "galleries":
        this.ensureImages();
        return;
      case "instances":
        this.ensureInstances();
        return;
      default:
        // Overview and Raw draw from the record the dialog already has.
        return;
    }
  }

  /** Switches the galleries tab to another gallery, discarding the previous one's pages. */
  selectGallery(galleryId: string): void {
    if (this.galleryId === galleryId) return;
    this.galleryId = galleryId;
    this.images.reset();
    this.images.ensure();
  }

  /**
   * The summary rides back as the hint, so a step back onto a group whose fetch has to run again
   * still draws its name, icon and banner immediately rather than a spinner over a short id.
   *
   * The tab comes back too: someone who stepped away from Members and lands on Overview has been
   * moved rather than returned. It goes through `openGroup`'s `tab` option, which routes it through
   * `selectTab`, so a list that `resetPayload` just emptied starts loading again instead of sitting
   * on a skeleton nothing will ever fill.
   */
  protected resumePoint(): ResumePoint | null {
    const groupId = this.groupId;
    if (groupId === null) return null;
    const { title, tab, summary: hint, accountId } = this;
    return {
      label: title,
      restore: () => {
        this.openGroup(groupId, { hint, accountId, tab });
      },
    };
  }

  protected resetPayload(): void {
    this.group = null;
    this.tab = "overview";
    this.galleryId = null;
    // Aborts anything in flight and puts each list back to `idle`, which is what lets the
    // `ensure…` guards run again for the next group.
    for (const list of [this.members, this.posts, this.images, this.instances]) list.reset();
  }

  async #load(groupId: string): Promise<void> {
    const { generation, signal } = this.beginLoad();
    try {
      const group = await api.groups.get(groupId, this.accountId, signal);
      if (!this.isCurrent(generation)) return;
      this.group = group;
      this.phase = "ready";
      /*
       * The gallery list arrives with the group, so the first one can be selected without a second
       * round trip. The `reset` after it is not redundant: a reader who opened the galleries tab
       * while this request was still in flight has already run the images list with no gallery to
       * ask about, and it answered "ready, empty". Without starting it over, that emptiness would
       * outlive the reason for it, because `ensure` only ever runs from `idle`.
       */
      this.galleryId = group.galleries[0]?.id ?? null;
      this.images.reset();
      if (this.tab === "galleries") this.ensureImages();
    } catch (cause) {
      /*
       * Aborted or superseded loads are not failures; see `EntityModalState.recordFailure`.
       *
       * Note what is *not* cleared here: the hint. A group that could not be fetched is still one
       * the caller could name, so the card keeps its name, icon and banner and explains the gap
       * underneath, rather than emptying itself into an error box.
       */
      this.recordFailure(cause, generation);
    }
  }
}

export const groupModal = new GroupModalState();
