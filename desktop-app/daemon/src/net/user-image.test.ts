import { describe, expect, test } from "bun:test";
import { pickUserImageUrl, pickUserImageUrlFull } from "./user-image.ts";

const ICON = "https://api.vrchat.cloud/api/1/file/file_icon/1/256";
const OVERRIDE_THUMB = "https://api.vrchat.cloud/api/1/file/file_pfp/2/128";
const OVERRIDE = "https://api.vrchat.cloud/api/1/file/file_pfp/2/512";
const AVATAR_THUMB = "https://api.vrchat.cloud/api/1/image/file_av/3/128";
const AVATAR = "https://api.vrchat.cloud/api/1/image/file_av/3/1024";

describe("pickUserImageUrl", () => {
  test("prefers the most deliberate choice available", () => {
    expect(
      pickUserImageUrl({
        userIcon: ICON,
        profilePicOverrideThumbnail: OVERRIDE_THUMB,
        currentAvatarImageUrl: AVATAR,
      }),
    ).toBe(ICON);

    expect(
      pickUserImageUrl({
        profilePicOverrideThumbnail: OVERRIDE_THUMB,
        profilePicOverride: OVERRIDE,
      }),
    ).toBe(OVERRIDE_THUMB);

    expect(pickUserImageUrl({ profilePicOverride: OVERRIDE, currentAvatarImageUrl: AVATAR })).toBe(
      OVERRIDE,
    );

    expect(
      pickUserImageUrl({
        currentAvatarThumbnailImageUrl: AVATAR_THUMB,
        currentAvatarImageUrl: AVATAR,
      }),
    ).toBe(AVATAR_THUMB);

    expect(pickUserImageUrl({ currentAvatarImageUrl: AVATAR })).toBe(AVATAR);
  });

  test('treats "" as absent, which is the whole reason this is not a `??` chain', () => {
    // VRChat returns empty strings rather than omitting these fields. `"" ?? next` is `""`, so a
    // nullish chain would hand the UI a blank src for every user without a custom icon.
    expect(
      pickUserImageUrl({
        userIcon: "",
        profilePicOverrideThumbnail: "",
        profilePicOverride: "",
        currentAvatarThumbnailImageUrl: AVATAR_THUMB,
      }),
    ).toBe(AVATAR_THUMB);
  });

  test("returns null when there is nothing to show", () => {
    expect(pickUserImageUrl(null)).toBeNull();
    expect(pickUserImageUrl(undefined)).toBeNull();
    expect(pickUserImageUrl({})).toBeNull();
    expect(pickUserImageUrl({ userIcon: "", currentAvatarImageUrl: "" })).toBeNull();
  });
});

describe("pickUserImageUrlFull", () => {
  test("keeps the same deliberateness order, minus the thumbnails", () => {
    expect(
      pickUserImageUrlFull({
        userIcon: ICON,
        profilePicOverride: OVERRIDE,
        currentAvatarImageUrl: AVATAR,
      }),
    ).toBe(ICON);

    expect(
      pickUserImageUrlFull({ profilePicOverride: OVERRIDE, currentAvatarImageUrl: AVATAR }),
    ).toBe(OVERRIDE);

    expect(pickUserImageUrlFull({ currentAvatarImageUrl: AVATAR })).toBe(AVATAR);
  });

  test("a thumbnail never stands in for the full image", () => {
    // The two pickers deliberately disagree here, and that disagreement is the feature: the list
    // avatar wants the 128px crop, and "open the full image" must not quietly open it too.
    const thumbnailsOnly = {
      profilePicOverrideThumbnail: OVERRIDE_THUMB,
      currentAvatarThumbnailImageUrl: AVATAR_THUMB,
    };
    expect(pickUserImageUrl(thumbnailsOnly)).toBe(OVERRIDE_THUMB);
    // Null, not a crop labelled "full" — the UI hides the action rather than lying about it.
    expect(pickUserImageUrlFull(thumbnailsOnly)).toBeNull();
  });

  test('treats "" as absent and null-ish input as nothing, like its sibling', () => {
    expect(pickUserImageUrlFull({ userIcon: "", profilePicOverride: "" })).toBeNull();
    expect(pickUserImageUrlFull({ userIcon: "", currentAvatarImageUrl: AVATAR })).toBe(AVATAR);
    expect(pickUserImageUrlFull(null)).toBeNull();
    expect(pickUserImageUrlFull(undefined)).toBeNull();
    expect(pickUserImageUrlFull({})).toBeNull();
  });
});
