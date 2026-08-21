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
import { EntityModalState } from "./entity-modal.svelte.ts";

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
    this.groupId = groupId;
    this.accountId = options.accountId ?? null;
    this.open = true;
    // Reopening the group already on screen keeps it there. Anything else starts clean, so the
    // previous group's description never sits under the new group's name.
    if (same) return;
    this.hint = options.hint ?? null;
    void this.#load(groupId);
  }

  retry(): void {
    if (this.groupId !== null) void this.#load(this.groupId);
  }

  protected resetPayload(): void {
    this.group = null;
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
