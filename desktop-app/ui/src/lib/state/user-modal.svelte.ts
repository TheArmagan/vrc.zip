/**
 * The one user modal, and everything it knows.
 *
 * Every display name in the app is a control that opens this, from five different screens and from
 * rows that are re-rendered by a live socket. Giving each of those its own `<Dialog>` would mean N
 * dialogs racing to be the open one, so there is exactly one instance — mounted by `App.svelte` —
 * and this module is the only thing that decides what it shows. Callers say `userModal.open(id)`
 * and nothing else.
 *
 * The abort/generation machinery, the phase and failure vocabulary, and the dedup helper live in
 * `entity-modal.svelte.ts`, shared with the world and group modals — see that file for why a
 * re-targetable singleton dialog needs all three. What stays here is what is true about a *user*:
 *
 *  - **no account online** (503). Not an error. A profile can only be read through somebody's
 *    credentials and vrc.zip may hold none that are signed in; the modal says so in a sentence.
 *  - **unknown user** (404). VRChat looked and found nobody.
 *  - **a shorter profile for a non-friend.** VRChat's answer genuinely carries fewer fields, which
 *    is why `accountId` — whose eyes this was looked up through — is threaded everywhere.
 */

import {
  api,
  describeError,
  type FeedEvent,
  isAbort,
  type MutualFriend,
  type MutualFriendPage,
  type UserGroup,
  type UserProfile,
} from "../api.ts";
import { app } from "./app.svelte.ts";
import {
  classifyFailure,
  dedupeById,
  EntityModalState,
  type LoadFailure,
  type LoadPhase,
} from "./entity-modal.svelte.ts";

/** How many history rows a page holds. The list is dense, so this is roughly three screens. */
const HISTORY_PAGE = 50;

/**
 * How many mutual friends a page holds.
 *
 * Small on purpose. The daemon walks a friend list to answer this, and the tab is a two-column
 * grid of short rows, so a page is about a screenful — enough that most pairs of people need no
 * second request, few enough that the pathological case costs one visible click rather than a
 * silent minute of fetching.
 */
const MUTUALS_PAGE = 50;

/**
 * The modal's tabs.
 *
 * Overview and History are the two that always have something to show: the first is the profile,
 * the second is vrc.zip's own record, which needs no VRChat call at all. Groups and Friends load
 * only when their tab is opened — a profile click should cost two requests, not four, and the
 * group list of a user with sixty groups is not something to fetch on the chance that someone
 * looks. Nothing in the header depends on either: the represented group arrives on the profile
 * itself, so the card is complete before a tab is touched.
 */
export type UserTab = "overview" | "groups" | "friends" | "history" | "raw";

export const USER_TABS: readonly UserTab[] = ["overview", "groups", "friends", "history", "raw"];

export const USER_TAB_LABELS: Record<UserTab, string> = {
  overview: "Overview",
  groups: "Groups",
  friends: "Mutual friends",
  history: "History",
  raw: "Raw JSON",
};

export interface OpenUserOptions {
  /**
   * The name the caller already had on screen. Shown as the title while the profile loads, so the
   * dialog opens with the user's name in it rather than a spinner and a blank header.
   */
  readonly name?: string | undefined;
  /**
   * The account this user was seen through — the friends screen's filter, a notification's
   * recipient, an event row's account. It decides whose credentials the lookup runs through, and
   * VRChat genuinely answers differently per caller, so it is worth threading.
   */
  readonly accountId?: string | null | undefined;
}

class UserModalState extends EntityModalState {
  /** The user currently being shown. Null only before the first open. */
  userId = $state<string | null>(null);
  /** The caller's name for them, held so the header has something to say while loading. */
  hintName = $state<string | null>(null);

  profile = $state<UserProfile | null>(null);

  /** Which tab is showing. Always reset to `overview` when the dialog moves to a new user. */
  tab = $state<UserTab>("overview");

  /** The group memberships the endpoint returned, in the order it returned them. */
  groups = $state<UserGroup[]>([]);
  /** Free-text filter for the Groups tab. Matches name and short code. */
  groupQuery = $state("");
  groupsPhase = $state<LoadPhase>("idle");
  groupsError = $state<string | null>(null);
  /** `no-account` is the 503, and it is an ordinary outcome with its own sentence, not a fault. */
  groupsFailure = $state<LoadFailure | null>(null);

  mutuals = $state<MutualFriend[]>([]);
  /** Free-text filter for the Mutual friends tab. Matches display name. */
  mutualQuery = $state("");
  mutualsPhase = $state<LoadPhase>("idle");
  mutualsError = $state<string | null>(null);
  mutualsFailure = $state<LoadFailure | null>(null);
  /** The daemon's word on whether another page exists. Never inferred from a page length. */
  mutualsHasMore = $state(false);
  mutualsLoadingMore = $state(false);

  /** Local history, newest first. Stored rows only — this is what vrc.zip recorded, not a live tail. */
  history = $state<FeedEvent[]>([]);
  historyPhase = $state<LoadPhase>("idle");
  historyError = $state<string | null>(null);
  historyExhausted = $state(false);
  loadingMore = $state(false);

  /** The note as it is being edited. `savedNote` is what the daemon last confirmed. */
  noteDraft = $state("");
  savedNote = $state("");
  savingNote = $state(false);
  noteError = $state<string | null>(null);

  /** True when the id being shown is one of the accounts vrc.zip signs in as. */
  isOwnAccount = $derived(
    this.userId !== null && app.accounts.some((account) => account.id === this.userId),
  );

  /** The name to put in the title bar: the loaded one, the caller's hint, or the id. */
  title = $derived(this.profile?.displayName ?? this.hintName ?? this.userId ?? "User");

  /** Unsaved note edits. Drives the save button and the "not saved yet" hint. */
  noteDirty = $derived(this.noteDraft !== this.savedNote);

  /**
   * The group the user chose to display next to their name, or null.
   *
   * It rides on the profile now, so the header can show it on the same request that fills the rest
   * of the card — no waiting on the Groups tab, and no header that rearranges itself later. The
   * group list is only consulted as a fallback, for the case where a build's profile route has not
   * caught up but its group route has.
   *
   * **Null is the common answer.** Most people represent nothing, and that is not an empty state.
   */
  representedGroup = $derived(
    this.profile?.representedGroup ?? this.groups.find((group) => group.isRepresenting) ?? null,
  );

  /**
   * The Groups tab's list: represented first, then largest, then alphabetical.
   *
   * The represented group is spliced in when the endpoint did not include it. VRChat answers the
   * group list with only the memberships the *asking* account may see, and a user can represent a
   * group whose membership list is private — so the one group we are certain about can genuinely
   * be missing from the list of the ones we are allowed to enumerate.
   */
  groupList = $derived.by(() => {
    /*
     * Deduplicated by id, and that is a correctness requirement rather than tidiness.
     *
     * The list is rendered `{#each … (group.id)}`, and a repeated key is a **hard runtime error**
     * in Svelte 5 — not a warning, not a double row: the tab stops rendering. So the wire is not
     * permitted to decide whether this component survives. VRChat can legitimately answer with the
     * same group twice (a user holding more than one membership row in it), and this list is also
     * merged with the represented group from a second endpoint, so two paths can each contribute
     * the same group.
     *
     * A `Map` keyed on id keeps the first occurrence and is O(n). The representing copy is
     * preferred when a later duplicate carries the flag and the earlier one did not, since that is
     * the fact the sort below is about to rank on.
     */
    const byId = new Map<string, UserGroup>();
    for (const group of [
      ...this.groups,
      ...(this.representedGroup ? [this.representedGroup] : []),
    ]) {
      // The daemon drops entries with no id, so an empty one here means a build mismatch. Skipping
      // is right either way: an unkeyed row is the crash this comment is about.
      if (group.id === "") continue;
      const existing = byId.get(group.id);
      if (existing === undefined) byId.set(group.id, group);
      else if (!existing.isRepresenting && group.isRepresenting) byId.set(group.id, group);
    }

    return [...byId.values()].sort(
      (a, b) =>
        Number(b.isRepresenting) - Number(a.isRepresenting) ||
        (b.memberCount ?? 0) - (a.memberCount ?? 0) ||
        a.name.localeCompare(b.name),
    );
  });

  /** `groupList` narrowed by `groupQuery`. The whole list is loaded, so this filter is complete. */
  visibleGroups = $derived.by(() => {
    const needle = this.groupQuery.trim().toLowerCase();
    if (needle === "") return this.groupList;
    return this.groupList.filter(
      (group) =>
        group.name.toLowerCase().includes(needle) ||
        (group.shortCode?.toLowerCase().includes(needle) ?? false),
    );
  });

  /**
   * `mutuals` narrowed by `mutualQuery`.
   *
   * **This filters only what has been loaded**, because mutual friends are paged. A filter that
   * silently searches one page of a longer list would be a quiet lie, so the tab says so whenever a
   * filter is active and `mutualsHasMore` is still true — see `mutualsFilterIncomplete`.
   */
  visibleMutuals = $derived.by(() => {
    const needle = this.mutualQuery.trim().toLowerCase();
    if (needle === "") return this.mutuals;
    return this.mutuals.filter((friend) => friend.displayName.toLowerCase().includes(needle));
  });

  /** True when a filter is narrowing a list the daemon has more of. Drives the honesty note. */
  mutualsFilterIncomplete = $derived(this.mutualQuery.trim() !== "" && this.mutualsHasMore);

  /**
   * Everything the modal is holding, as a plain object.
   *
   * This is what the Raw JSON tab renders and what "copy details as JSON" copies. It is the whole
   * point of having it: the profile above is a curated reading of the data, and when the curation
   * and the data disagree — a field the daemon renamed, a status VRChat invented last week — the
   * raw view is how anyone finds out without opening devtools.
   */
  snapshot = $derived({
    userId: this.userId,
    seenThroughAccountId: this.accountId,
    profile: this.profile,
    groups: this.groups,
    mutualFriends: this.mutuals,
    localHistory: this.history,
  });

  /**
   * The image behind the header, or null — which is what most users have.
   *
   * The user's own banner wins: it is the thing they set on purpose about themselves. A
   * represented group's banner stands in behind it, because choosing to represent a group is also
   * a statement about how they want to be seen. Nothing else is substituted — an avatar photo
   * cropped to a letterbox is not a banner, and the header is designed to look finished with no
   * image rather than to need one filled in.
   */
  bannerUrl = $derived(this.profile?.bannerUrl ?? this.representedGroup?.bannerUrl ?? null);

  /** Opens the dialog on `userId`, replacing whatever it was showing. */
  openUser(userId: string, options: OpenUserOptions = {}): void {
    const sameUser = this.userId === userId && this.phase === "ready";
    this.userId = userId;
    this.hintName = options.name ?? this.hintName;
    /*
     * A user who is one of our own accounts is looked up through *itself*, because VRChat returns
     * the full profile to the account it belongs to and a trimmed one to everybody else.
     */
    this.accountId = options.accountId ?? this.#ownAccountId(userId) ?? null;
    this.open = true;
    // Reopening the same user whose profile is already loaded keeps it on screen; anything else
    // starts clean, so the previous person's bio never flashes under the new person's name.
    if (!sameUser) {
      this.tab = "overview";
      void this.#load(userId);
    }
  }

  /** Re-reads the profile and the first page of history. The error state's retry button. */
  retry(): void {
    if (this.userId !== null) void this.#load(this.userId);
  }

  #ownAccountId(userId: string): string | undefined {
    return app.accounts.find((account) => account.id === userId)?.id;
  }

  protected resetPayload(): void {
    this.profile = null;
    this.groups = [];
    this.groupQuery = "";
    this.groupsPhase = "idle";
    this.groupsError = null;
    this.groupsFailure = null;
    this.mutuals = [];
    this.mutualQuery = "";
    this.mutualsPhase = "idle";
    this.mutualsError = null;
    this.mutualsFailure = null;
    this.mutualsHasMore = false;
    this.mutualsLoadingMore = false;
    this.history = [];
    this.historyError = null;
    this.historyExhausted = false;
    this.loadingMore = false;
    this.noteDraft = "";
    this.savedNote = "";
    this.noteError = null;
  }

  async #load(userId: string): Promise<void> {
    const { generation, signal } = this.beginLoad();
    this.historyPhase = "loading";

    /*
     * Two requests, and the split is deliberate.
     *
     * Local history is vrc.zip's own data and still works when VRChat cannot be reached at all —
     * which is exactly when it is most interesting — so it must not be chained behind a profile
     * fetch that may 503. The profile now carries the represented group, so nothing in the header
     * waits on a list; the group list and the mutual friends are both a tab's own business, and
     * mutual friends in particular cost the daemon a walk over a friend list.
     */
    await Promise.all([
      this.#loadProfile(userId, generation, signal),
      this.#loadHistory(userId, generation, signal),
    ]);
  }

  /** Loads the group list the first time its tab is opened, and not before. */
  async ensureGroups(): Promise<void> {
    const userId = this.userId;
    if (userId === null || this.groupsPhase !== "idle") return;
    const generation = this.generation;
    this.groupsPhase = "loading";
    try {
      const groups = await api.users.groups(userId, this.accountId ?? undefined, this.signal);
      if (!this.isCurrent(generation)) return;
      this.groups = groups;
      this.groupsPhase = "ready";
    } catch (cause) {
      // A superseded generation owns nothing: `beginLoad()` has already put the new target's phase
      // back to "idle", and writing here would corrupt it.
      if (!this.isCurrent(generation)) return;
      /*
       * An abort must fall back to "idle", not stay "loading".
       *
       * Closing the modal aborts the in-flight request. Leaving the phase at "loading" wedged this
       * tab permanently for that user: reopening the *same* user takes the `sameUser` path that
       * deliberately preserves loaded state, so `ensureGroups` short-circuits on
       * `groupsPhase !== "idle"`, and `retryGroups()` refuses to run while it reads "loading".
       * The tab then showed a spinner forever with no way back. Abandoned work is not failed work
       * — it is work that has not started.
       */
      if (isAbort(cause)) {
        this.groupsPhase = "idle";
        return;
      }
      this.groupsFailure = classifyFailure(cause);
      this.groupsError = describeError(cause);
      this.groupsPhase = "error";
    }
  }

  /** Re-reads the group list after a failure. Clears the phase so `ensureGroups` will run again. */
  retryGroups(): void {
    if (this.groupsPhase === "loading") return;
    this.groupsPhase = "idle";
    this.groupsError = null;
    this.groupsFailure = null;
    void this.ensureGroups();
  }

  /** Loads the first page of mutual friends the first time their tab is opened, and not before. */
  async ensureMutuals(): Promise<void> {
    const userId = this.userId;
    if (userId === null || this.mutualsPhase !== "idle") return;
    const generation = this.generation;
    this.mutualsPhase = "loading";
    try {
      const page = await this.#fetchMutuals(userId, 0);
      if (!this.isCurrent(generation)) return;
      // Deduplicated on arrival, for the same reason `groupList` is: the rows are keyed on
      // `friend.id`, and a repeated key kills the tab. `loadMoreMutuals` already dedupes what it
      // appends; the first page was the gap.
      this.mutuals = dedupeById(page.users);
      this.mutualsHasMore = page.hasMore;
      this.mutualsPhase = "ready";
    } catch (cause) {
      if (!this.isCurrent(generation)) return;
      // Same wedge as `ensureGroups`, same fix — both are lazy, so nothing else ever re-runs them.
      if (isAbort(cause)) {
        this.mutualsPhase = "idle";
        return;
      }
      this.mutualsFailure = classifyFailure(cause);
      this.mutualsError = describeError(cause);
      this.mutualsPhase = "error";
    }
  }

  /**
   * Pages forward through mutual friends.
   *
   * The offset is the number of rows already held, so a page that overlaps the previous one — the
   * friend list can shift under a paged read — appends only what is genuinely new rather than
   * producing a duplicate key and a Svelte crash.
   */
  async loadMoreMutuals(): Promise<void> {
    const userId = this.userId;
    if (userId === null || this.mutualsLoadingMore || !this.mutualsHasMore) return;
    const generation = this.generation;
    this.mutualsLoadingMore = true;
    this.mutualsError = null;
    try {
      const page = await this.#fetchMutuals(userId, this.mutuals.length);
      if (!this.isCurrent(generation)) return;
      const seen = new Set(this.mutuals.map((friend) => friend.id));
      const fresh = page.users.filter((friend) => !seen.has(friend.id));
      this.mutuals = [...this.mutuals, ...fresh];
      // A page of nothing but rows we already had would otherwise loop the button forever.
      this.mutualsHasMore = page.hasMore && fresh.length > 0;
    } catch (cause) {
      if (isAbort(cause) || !this.isCurrent(generation)) return;
      this.mutualsError = describeError(cause);
    } finally {
      this.mutualsLoadingMore = false;
    }
  }

  /** Re-reads mutual friends from the first page after a failure. */
  retryMutuals(): void {
    if (this.mutualsPhase === "loading") return;
    this.mutuals = [];
    this.mutualsPhase = "idle";
    this.mutualsError = null;
    this.mutualsFailure = null;
    this.mutualsHasMore = false;
    void this.ensureMutuals();
  }

  #fetchMutuals(userId: string, offset: number): Promise<MutualFriendPage> {
    return api.users.mutualFriends(
      userId,
      { accountId: this.accountId ?? undefined, n: MUTUALS_PAGE, offset },
      this.signal,
    );
  }

  /** Switches tabs, loading whatever that tab needs the first time it is reached. */
  selectTab(tab: UserTab): void {
    this.tab = tab;
    if (tab === "groups") void this.ensureGroups();
    if (tab === "friends") void this.ensureMutuals();
  }

  async #loadProfile(userId: string, generation: number, signal: AbortSignal): Promise<void> {
    try {
      const profile = await api.users.get(userId, this.accountId ?? undefined, signal);
      if (!this.isCurrent(generation)) return;
      this.profile = profile;
      this.savedNote = profile.note ?? "";
      this.noteDraft = profile.note ?? "";
      this.phase = "ready";
    } catch (cause) {
      // Aborted or superseded loads are not failures; see `EntityModalState.recordFailure`.
      this.recordFailure(cause, generation);
    }
  }

  async #loadHistory(userId: string, generation: number, signal: AbortSignal): Promise<void> {
    try {
      const rows = await api.events({ subjectId: userId, limit: HISTORY_PAGE }, signal);
      if (!this.isCurrent(generation)) return;
      this.history = rows;
      this.historyExhausted = rows.length < HISTORY_PAGE;
      this.historyPhase = "ready";
    } catch (cause) {
      if (isAbort(cause) || !this.isCurrent(generation)) return;
      this.historyError = describeError(cause);
      this.historyPhase = "error";
    }
  }

  /** Pages backwards through local history from the oldest row currently held. */
  async loadMoreHistory(): Promise<void> {
    const userId = this.userId;
    const oldest = this.history.at(-1);
    if (userId === null || oldest === undefined || this.loadingMore || this.historyExhausted) {
      return;
    }
    const generation = this.generation;
    this.loadingMore = true;
    try {
      const rows = await api.events(
        { subjectId: userId, limit: HISTORY_PAGE, before: oldest.ts },
        this.signal,
      );
      if (!this.isCurrent(generation)) return;
      this.history = [...this.history, ...rows];
      this.historyExhausted = rows.length < HISTORY_PAGE;
    } catch (cause) {
      if (isAbort(cause) || !this.isCurrent(generation)) return;
      this.historyError = describeError(cause);
    } finally {
      this.loadingMore = false;
    }
  }

  /** Saves the note. Local only — VRChat is never told, and nothing leaves this machine. */
  async saveNote(): Promise<void> {
    const userId = this.userId;
    if (userId === null || this.savingNote) return;
    const generation = this.generation;
    const value = this.noteDraft;
    this.savingNote = true;
    this.noteError = null;
    try {
      const saved = await api.users.setNote(userId, value, this.accountId ?? undefined);
      if (!this.isCurrent(generation)) return;
      // The daemon's answer wins over the draft: an empty note is stored as a deletion and comes
      // back as null, and the note is per-account, so this is also where a mismatch would show.
      this.savedNote = saved.note ?? "";
      this.noteDraft = saved.note ?? "";
      if (this.profile !== null) {
        this.profile = { ...this.profile, note: saved.note, noteUpdatedAt: saved.updatedAt };
      }
    } catch (cause) {
      if (isAbort(cause) || !this.isCurrent(generation)) return;
      this.noteError = describeError(cause);
    } finally {
      this.savingNote = false;
    }
  }
}

export const userModal = new UserModalState();
