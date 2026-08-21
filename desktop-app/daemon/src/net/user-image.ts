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
 * The best available image URL for a user, or `null` when the user has none.
 *
 * **`??` alone would be wrong here.** VRChat returns `""` for an unset image rather than omitting
 * the field, and `"" ?? next` is `""` — so a nullish chain stops at the first empty string and
 * hands the UI a blank `src` for every user without a custom icon. Emptiness is what "absent"
 * looks like on this API, so it is tested for explicitly.
 */
export function pickUserImageUrl(user: UserImageFields | null | undefined): string | null {
  if (!user) return null;

  for (const key of ORDER) {
    const value = user[key];
    if (typeof value === "string" && value !== "") return value;
  }

  return null;
}
