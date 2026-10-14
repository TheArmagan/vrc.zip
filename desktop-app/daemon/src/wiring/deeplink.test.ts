import { describe, expect, test } from "bun:test";
import type { AccountSnapshot } from "../accounts/account.ts";
import type { DesktopNotification } from "../os/desktop-notification.ts";
import { ControlError } from "../servers/control.ts";
import { createDeepLinkHandler, findDeepLinkArg, parseDeepLink } from "./deeplink.ts";

const AVATAR = "avtr_c38a1615-5bf5-42b4-84eb-a8b6c37cbd11";

function snapshot(id: string, displayName: string | null): AccountSnapshot {
  return {
    id,
    username: `${id}-login`,
    displayName,
    state: "online",
    lastError: null,
    pendingTwoFactorMethods: [],
    iconUrl: null,
  };
}

describe("parseDeepLink", () => {
  test("reads the avatar and the optional account index", () => {
    expect(parseDeepLink(`vrczip://selectavatar/${AVATAR}`)).toEqual({
      action: "selectAvatar",
      avatarId: AVATAR,
      accountIndex: null,
    });
    expect(parseDeepLink(`vrczip://selectavatar/${AVATAR}/2`)).toMatchObject({ accountIndex: 2 });
    // What launchers do to a link on the way past: a trailing slash, the scheme in capitals.
    expect(parseDeepLink(`VRCZIP://SelectAvatar/${AVATAR}/`)).toMatchObject({ avatarId: AVATAR });
  });

  test("refuses anything that is not exactly a link it understands", () => {
    for (const raw of [
      "vrczip://selectavatar/",
      "vrczip://selectavatar/usr_1",
      `vrczip://selectavatar/${AVATAR}/-1`,
      `vrczip://selectavatar/${AVATAR}/0/extra`,
      `vrczip://selectavatar/${AVATAR}?x=1`,
      `vrczip://selectavatar/${AVATAR}" --uninstall`,
      `vrczip://wipe/${AVATAR}`,
      `https://selectavatar/${AVATAR}`,
    ]) {
      expect(parseDeepLink(raw), raw).toBeNull();
    }
  });

  test("findDeepLinkArg picks the link out of argv by its scheme", () => {
    expect(findDeepLinkArg(["--hidden"])).toBeNull();
    expect(findDeepLinkArg([`vrczip://selectavatar/${AVATAR}`])).toBe(
      `vrczip://selectavatar/${AVATAR}`,
    );
  });
});

describe("createDeepLinkHandler", () => {
  function harness(
    accounts: AccountSnapshot[],
    select: (accountId: string, avatarId: string) => Promise<void> = async () => {},
  ) {
    const toasts: DesktopNotification[] = [];
    const selects: { accountId: string; avatarId: string }[] = [];
    const open = createDeepLinkHandler({
      accounts: { list: () => accounts },
      social: {
        selectAvatar: async (accountId, avatarId) => {
          selects.push({ accountId, avatarId });
          await select(accountId, avatarId);
        },
      },
      notify: async (notification) => {
        toasts.push(notification);
      },
      describeAvatar: async () => ({ name: "Ada's Fox", image: "https://api.vrchat.cloud/x.png" }),
    });
    return { open, toasts, selects };
  }

  test("no index means the first account, and the toast names the avatar", async () => {
    const h = harness([snapshot("usr_a", "Ada"), snapshot("usr_b", "Bea")]);
    expect(await h.open(`vrczip://selectavatar/${AVATAR}`)).toEqual({
      action: "selectAvatar",
      avatarId: AVATAR,
      accountId: "usr_a",
    });
    expect(h.selects).toEqual([{ accountId: "usr_a", avatarId: AVATAR }]);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]?.body).toBe("Ada is now wearing Ada's Fox.");
    expect(h.toasts[0]?.image).toBe("https://api.vrchat.cloud/x.png");
  });

  test("an index picks that account, counted from 0", async () => {
    const h = harness([snapshot("usr_a", "Ada"), snapshot("usr_b", null)]);
    await h.open(`vrczip://selectavatar/${AVATAR}/1`);
    expect(h.selects).toEqual([{ accountId: "usr_b", avatarId: AVATAR }]);
    // No display name yet falls back to the login, never to an empty string.
    expect(h.toasts[0]?.body).toBe(`usr_b-login is now wearing Ada's Fox.`);
  });

  test("an index past the end is refused, toasted, and nothing is sent", async () => {
    const h = harness([snapshot("usr_a", "Ada")]);
    await expect(h.open(`vrczip://selectavatar/${AVATAR}/3`)).rejects.toMatchObject({
      status: 404,
      code: "unknown_account",
    });
    expect(h.selects).toEqual([]);
    expect(h.toasts[0]?.title).toBe("vrc.zip: could not change avatar");
  });

  test("a link it cannot read is refused with a toast rather than silently", async () => {
    const h = harness([snapshot("usr_a", "Ada")]);
    await expect(h.open("vrczip://nonsense")).rejects.toMatchObject({ code: "invalid_deeplink" });
    expect(h.toasts).toHaveLength(1);
    expect(h.selects).toEqual([]);
  });

  test("VRChat's refusal is passed through in the toast and the rejection alike", async () => {
    const refusal = new ControlError(403, "avatar_forbidden", "No wearing that one.");
    const h = harness([snapshot("usr_a", "Ada")], async () => {
      throw refusal;
    });
    await expect(h.open(`vrczip://selectavatar/${AVATAR}`)).rejects.toBe(refusal);
    expect(h.toasts[0]?.body).toBe("No wearing that one.");
  });
});
