/**
 * What actually changed in an update frame.
 *
 * ## The problem this exists for
 *
 * Several VRChat pipeline frames announce that something moved and then decline to say what.
 * `friend-update` arrives whenever *anything* on a profile changes and carries a whole user object;
 * `economy-update` arrives whenever anything about the account's entitlements changes and carries a
 * whole wallet. So the bus had `friend.updated` and `economy.update`, kinds that could mean four or
 * five different things, and the feed could only render them as "Ada updated their profile" and
 * "Your economy changed" — the same sentence every time, telling a reader nothing. Worse, VRChat
 * re-sends these on changes to fields nobody models, so a large share of those rows described a
 * change that was invisible even in principle.
 *
 * The frame cannot answer this on its own. The only way to recover the field is to hold the
 * previous copy and compare, which is what this does: one snapshot per (account, subject), a fixed
 * vocabulary of aspects, and a refined kind on the way out.
 *
 * ## Absent is not empty, and this is the whole subtlety
 *
 * Every field on these payloads is optional, and an update frame routinely omits fields it has
 * nothing to say about. Treating an omitted `bio` as `""` would report "Ada cleared their bio" on
 * every frame that did not mention it. So a snapshot value is `null` for **unknown** and `""` for
 * **known to be empty**, `to === null` is never a change, and merging a new snapshot over the old
 * one keeps the old value wherever the new one is unknown.
 *
 * ## Why a frame that changed nothing is dropped rather than emitted
 *
 * Dropping is only safe because the tracked aspects are a superset of what `PresenceService`
 * compares in `sameRecord` — a frame this module calls a no-op cannot be one that would have moved
 * the presence cache. Location is the exception and is deliberate: it has its own kinds
 * (`friend.location`), and a user object's `location` is subject to every quirk in
 * `PipelineLocation`, so it is neither tracked nor diffed here.
 */

import {
  ECONOMY_CHANGE_ASPECTS,
  type EconomyChangeAspect,
  type FieldChange,
  PROFILE_CHANGE_ASPECTS,
  type ProfileChangeAspect,
} from "@vrcz/shared";
import { trustLevelOf } from "../accounts/presence.ts";
import type { PipelineEconomyUpdate, PipelineUser } from "../pipeline/index.ts";

/** Every tracked aspect's current value: `null` for unknown, `""` for known to be empty. */
type Snapshot<A extends string> = Readonly<Record<A, string | null>>;

/** `""` is how VRChat spells an unset string, but only for the fields where it means that. */
function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/** Numbers and booleans are compared as their rendered form, which is what a row shows anyway. */
function scalar(value: number | boolean | undefined): string | null {
  return value === undefined ? null : String(value);
}

// ---------------------------------------------------------------------------
// The vocabularies
// ---------------------------------------------------------------------------

/**
 * The picture a user deliberately set, *excluding* the avatar fallback.
 *
 * Not `pickUserImageUrl`, which is right for a list row and wrong here: it falls back to the avatar
 * image, so changing an avatar would report both `avatar` and `icon`. Keeping the two disjoint is
 * what lets a row say "changed their avatar" rather than "changed their avatar and their picture".
 */
function iconOf(user: PipelineUser): string | null {
  return nonEmpty(user.userIcon) ?? nonEmpty(user.profilePicOverride);
}

function profileSnapshot(user: PipelineUser): Snapshot<ProfileChangeAspect> {
  return {
    name: nonEmpty(user.displayName),
    // Thumbnail first, matching the ordering `pickUserImageUrl` justifies: the two move together,
    // and reading whichever arrived avoids a spurious change when only one of them is sent.
    avatar: nonEmpty(user.currentAvatarThumbnailImageUrl) ?? nonEmpty(user.currentAvatarImageUrl),
    icon: iconOf(user),
    // Not `nonEmpty`: a bio really can be cleared, and "" is the value that says so.
    bio: user.bio ?? null,
    status: nonEmpty(user.status),
    status_message: user.statusDescription ?? null,
    trust: user.tags === undefined ? null : trustLevelOf(user.tags),
    platform: nonEmpty(user.last_platform),
  };
}

/**
 * `economy-update` is documented upstream as unstable and is modelled as `balance`, but the frames
 * that actually arrive spell it `walletBalance`. Both are read, newest spelling first, because
 * dropping either would mean the one kind this event almost always is could not be named.
 */
interface EconomyFields extends PipelineEconomyUpdate {
  readonly walletBalance?: number;
}

function economySnapshot(update: EconomyFields): Snapshot<EconomyChangeAspect> {
  return {
    wallet_balance: scalar(update.walletBalance) ?? scalar(update.balance),
    vrchat_plus: scalar(update.isVRChatPlus),
  };
}

// ---------------------------------------------------------------------------
// The differ
// ---------------------------------------------------------------------------

/** What the bridge should do with one update frame. */
export type UpdateVerdict =
  /** Nothing tracked moved. The frame is about a field this build does not model. */
  | { readonly verdict: "unchanged" }
  /**
   * The first frame seen for this subject, so there was nothing to compare against. Something did
   * change (VRChat does not send these idly), but naming it would be a guess.
   */
  | { readonly verdict: "unknown" }
  | { readonly verdict: "changed"; readonly changes: readonly FieldChange[] };

/**
 * Remembers the last version of something, and says what a new one changed.
 *
 * Bounded by the account's friend list rather than by time, which is why there is no eviction: the
 * set is the people VRChat sends updates about, a few thousand at the outside, and each entry is a
 * handful of short strings. `forget` exists for account removal, where the whole account's worth
 * goes at once.
 */
export class UpdateDiffs<A extends string, S> {
  readonly #byAccount = new Map<string, Map<string, Snapshot<A>>>();

  constructor(
    private readonly aspects: readonly A[],
    private readonly snapshot: (subject: S) => Snapshot<A>,
  ) {}

  /**
   * Records the frame and reports what it moved.
   *
   * Always call this exactly once per frame: it is a write as much as a read, and asking twice
   * would make the second answer "unchanged" for a frame that did change something.
   */
  observe(accountId: string, subjectId: string, subject: S): UpdateVerdict {
    let bySubject = this.#byAccount.get(accountId);
    if (bySubject === undefined) {
      bySubject = new Map<string, Snapshot<A>>();
      this.#byAccount.set(accountId, bySubject);
    }

    const next = this.snapshot(subject);
    const previous = bySubject.get(subjectId);
    if (previous === undefined) {
      bySubject.set(subjectId, next);
      return { verdict: "unknown" };
    }

    const changes: FieldChange[] = [];
    const merged = {} as Record<A, string | null>;
    for (const aspect of this.aspects) {
      const to = next[aspect];
      const from = previous[aspect];
      merged[aspect] = to ?? from;
      // Unknown is not a change. See the header: this is the difference between "they cleared
      // their bio" and "this frame was not about their bio".
      if (to === null || from === to) continue;
      changes.push({ aspect, from, to });
    }

    bySubject.set(subjectId, merged);
    return changes.length === 0 ? { verdict: "unchanged" } : { verdict: "changed", changes };
  }

  forget(accountId: string): void {
    this.#byAccount.delete(accountId);
  }

  clear(): void {
    this.#byAccount.clear();
  }
}

/**
 * The differs a daemon needs, constructed together.
 *
 * One object rather than two arguments threaded through the bridge, so adding a third update kind
 * with the same defect is a change here and at one `switch` arm, not at every call site.
 */
export class UpdateDiffSet {
  readonly profiles = new UpdateDiffs<ProfileChangeAspect, PipelineUser>(
    PROFILE_CHANGE_ASPECTS,
    profileSnapshot,
  );

  readonly economy = new UpdateDiffs<EconomyChangeAspect, EconomyFields>(
    ECONOMY_CHANGE_ASPECTS,
    economySnapshot,
  );

  forget(accountId: string): void {
    this.profiles.forget(accountId);
    this.economy.forget(accountId);
  }

  clear(): void {
    this.profiles.clear();
    this.economy.clear();
  }
}
