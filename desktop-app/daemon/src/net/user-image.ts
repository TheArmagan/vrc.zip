/**
 * Picking the one image URL that represents a VRChat user.
 *
 * A user carries up to five candidate images and VRChat fills in whichever the account actually
 * has. Every consumer that wants "the icon" has to make the same choice, so the choice lives here
 * once — `CurrentUser`, `LimitedUserFriend`, and the partial `user` object on a pipeline frame all
 * feed the same function.
 */

/**
 * The image-bearing subset of VRChat's user shapes.
 *
 * Structural rather than an import of `CurrentUser` / `LimitedUserFriend`: a pipeline frame carries
 * a *partial* user, and the point of this helper is that all three feed it.
 */
export interface UserImageFields {
  readonly userIcon?: string | null | undefined;
  readonly profilePicOverrideThumbnail?: string | null | undefined;
  readonly profilePicOverride?: string | null | undefined;
  readonly currentAvatarThumbnailImageUrl?: string | null | undefined;
  readonly currentAvatarImageUrl?: string | null | undefined;
}

/**
 * The preference order, most deliberate choice first.
 *
 * `userIcon` is what a VRChat+ user explicitly set as their icon; the profile-pic override is the
 * next most intentional; the avatar image is a fallback that at least shows *something*. The
 * thumbnail variants come before their full-size counterparts because this feeds 40px list rows.
 */
const ORDER = [
  "userIcon",
  "profilePicOverrideThumbnail",
  "profilePicOverride",
  "currentAvatarThumbnailImageUrl",
  "currentAvatarImageUrl",
] as const satisfies ReadonlyArray<keyof UserImageFields>;

/**
 * The same preference order with the thumbnail variants removed — **derived**, never retyped.
 *
 * Filtering `ORDER` rather than writing a second list is the point: the two answers must agree
 * about which choice is more deliberate, and two hand-maintained copies of that ordering would
 * drift the first time a field is added to one of them.
 */
const FULL_ORDER = ORDER.filter((key) => !key.includes("Thumbnail"));

/** Shared by both pickers. `""` is how VRChat spells "unset", so emptiness is what is tested. */
function pickFrom(
  user: UserImageFields | null | undefined,
  order: ReadonlyArray<keyof UserImageFields>,
): string | null {
  if (!user) return null;

  for (const key of order) {
    const value = user[key];
    if (typeof value === "string" && value !== "") return value;
  }

  return null;
}

/**
 * The best available image URL for a user, or `null` when the user has none.
 *
 * **`??` alone would be wrong here.** VRChat returns `""` for an unset image rather than omitting
 * the field, and `"" ?? next` is `""` — so a nullish chain stops at the first empty string and
 * hands the UI a blank `src` for every user without a custom icon. Emptiness is what "absent"
 * looks like on this API, so it is tested for explicitly.
 *
 * Prefers **thumbnails**, which is right for the 36px avatar in a list and wrong for "show me the
 * actual image" — see {@link pickUserImageUrlFull}.
 */
export function pickUserImageUrl(user: UserImageFields | null | undefined): string | null {
  return pickFrom(user, ORDER);
}

/**
 * The full-size original, or `null` — for "open image in a new tab".
 *
 * **Never falls back to a thumbnail.** A 256px crop served under the name of the full image would
 * look like it worked, which is worse than not offering the action: `null` lets the UI hide it.
 * That is also why this is a separate function rather than a flag on the one above — the two
 * answer genuinely different questions, and every avatar in the app depends on the thumbnail
 * preference for its bandwidth.
 */
export function pickUserImageUrlFull(user: UserImageFields | null | undefined): string | null {
  return pickFrom(user, FULL_ORDER);
}
