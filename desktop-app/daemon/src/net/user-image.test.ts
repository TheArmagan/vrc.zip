import { describe, expect, test } from "bun:test";
import { pickUserImageUrl } from "./user-image.ts";

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
