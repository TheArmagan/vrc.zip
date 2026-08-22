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
 * There is a `hint` path too, and it earns its keep: nearly every route into this dialog — a
 * represented badge, a row in a user's Groups tab — already holds a `UserGroup` with the name, the
 * icon, the banner and the member count on it. Seeding those means the card is drawn *before* the
 * fetch, and the fetch fills in what only it can know. A `GroupDetail` is a `UserGroup` plus the
 * rest, so this is a widening rather than two shapes to reconcile.
 */

import { api, type GroupDetail, type UserGroup } from "../api.ts";
import { shortId } from "../format.ts";
import { EntityModalState, type ResumePoint } from "./entity-modal.svelte.ts";
import type { GroupInstanceRow } from "./group-screen.svelte.ts";
import { PagedList } from "./paged.svelte.ts";

/**
 * The modal's tabs.
 *
 * Overview is the group as a document and is what the whole dialog used to be. Instances earned a
 * tab of its own because it is not a fact *about* the group at all — it is where the group is
 * gathering right now, it changes minute to minute, and it costs a second request that nobody
 * should pay for opening a badge. Raw JSON is the same escape hatch the user modal has: the card is
 * a curated reading of the data, and this is how anyone finds out when the reading and the data
 * disagree.
 */
export type GroupModalTab = "overview" | "instances" | "raw";

export const GROUP_MODAL_TABS: readonly GroupModalTab[] = ["overview", "instances", "raw"];

export const GROUP_MODAL_TAB_LABELS: Record<GroupModalTab, string> = {
  overview: "Overview",
  instances: "Instances",
  raw: "Raw JSON",
};

export interface OpenGroupOptions {
  /**
   * The summary the caller already had on screen. Drawn immediately, then replaced by the fetch.
   * Never merged field-by-field with the answer: a half-fetched card that mixes two reads is
   * harder to reason about than one that is briefly incomplete.
   */
  readonly hint?: UserGroup | null | undefined;
  /** The account this group was seen through; it decides `membershipStatus` and visibility. */
  readonly accountId?: string | null | undefined;
}

class GroupModalState extends EntityModalState {
  groupId = $state<string | null>(null);
  /** The caller's summary, held until the full record lands. Null when there was none. */
  hint = $state<UserGroup | null>(null);

  group = $state<GroupDetail | null>(null);

  /** Which tab is showing. Always back to `overview` when the dialog moves to a new group. */
  tab = $state<GroupModalTab>("overview");

  /**
   * The group's open instances, as a one-page list.
   *
   * The route answers unpaged, but `PagedSection` is what draws every list of this shape in the app
   * — skeleton, empty state, and a `forbidden` that is a rule about who may look rather than an
   * error. Wrapping the single answer in a `PagedList` buys all of that instead of a fourth
   * hand-written set of the same states. Same trick, and the same `id`, as the group screen's.
   */
  instances: PagedList<GroupInstanceRow>;

  constructor() {
    super();
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
    const same = this.groupId === groupId && this.phase === "ready";
    // First, before the assignments below — see `EntityModalState.takeScreen`.
    this.takeScreen(!same);
    this.groupId = groupId;
    this.accountId = options.accountId ?? null;
    // Reopening the group already on screen keeps it there. Anything else starts clean, so the
    // previous group's description never sits under the new group's name.
    if (same) return;
    this.tab = "overview";
    this.hint = options.hint ?? null;
    void this.#load(groupId);
  }

  retry(): void {
    if (this.groupId !== null) void this.#load(this.groupId);
  }

  /**
   * Loads the open instances the first time their tab is reached, and not before.
   *
   * `PagedList.ensure()` is the `phase !== "idle"` guard, which is the same guard the user modal's
   * lazy tabs use and needs the same care about abandonment: `idle` is the only state it will run
   * from again, so a load that was thrown away has to end back there rather than at `loading`. It
   * does, because the only thing that abandons this list is `reset()` in `resetPayload`, and that
   * aborts and returns the phase to `idle` in the same call.
   */
  ensureInstances(): void {
    if (this.groupId === null) return;
    this.instances.ensure();
  }

  /** Switches tabs, loading whatever that tab needs the first time it is reached. */
  selectTab(tab: GroupModalTab): void {
    this.tab = tab;
    if (tab === "instances") this.ensureInstances();
  }

  /**
   * The summary rides back as the hint, so a step back onto a group whose fetch has to run again
   * still draws its name, icon and banner immediately rather than a spinner over a short id.
   *
   * The tab comes back too: someone who stepped away from Instances and lands on Overview has been
   * moved rather than returned. It goes through `selectTab` so a list that `resetPayload` just
   * emptied starts loading again instead of sitting on a skeleton nothing will ever fill.
   */
  protected resumePoint(): ResumePoint | null {
    const groupId = this.groupId;
    if (groupId === null) return null;
    const { title, tab, summary: hint, accountId } = this;
    return {
      label: title,
      restore: () => {
        this.openGroup(groupId, { hint, accountId });
        this.selectTab(tab);
      },
    };
  }

  protected resetPayload(): void {
    this.group = null;
    // Aborts anything in flight and puts the list back to `idle`, which is what lets
    // `ensureInstances` run again for the next group.
    this.instances.reset();
  }

  async #load(groupId: string): Promise<void> {
    const { generation, signal } = this.beginLoad();
    try {
      const group = await api.groups.get(groupId, this.accountId, signal);
      if (!this.isCurrent(generation)) return;
      this.group = group;
      this.phase = "ready";
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
