/**
 * What you can do to a name.
 *
 * Every display name in the app is the same object with the same affordances, so the list of
 * things you can do with one is written down once here and rendered twice: as a right-click
 * context menu on the name itself (`UserContextMenu`), and as the overflow menu in the user
 * modal's header (`UserActionsMenu`). Two menu component families, one list of actions — a
 * "copy id" that exists in one menu and not the other is exactly the drift this prevents.
 *
 * Most actions here are clipboard or navigation actions, which is why they work for a user whose
 * profile failed to load, or when no account is online at all. Three of them are not, and they are
 * grouped apart for exactly that reason: invite, ask for an invite, and boop all put something in
 * another person's inbox **with the user's name on it**. They appear only when the app knows
 * without guessing which account is asking (see `social-actions.ts`), because with two accounts
 * signed in a wrong guess is not a glitch — it is the wrong identity appearing to have messaged a
 * stranger. The two image items are hidden on the same principle: shown only when the caller has
 * the URL to open, rather than opening a blank tab.
 */

import BracesIcon from "@lucide/svelte/icons/braces";
import CopyIcon from "@lucide/svelte/icons/copy";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import GalleryHorizontalIcon from "@lucide/svelte/icons/gallery-horizontal";
import HandIcon from "@lucide/svelte/icons/hand";
import IdCardIcon from "@lucide/svelte/icons/id-card";
import ImageIcon from "@lucide/svelte/icons/image";
import MailPlusIcon from "@lucide/svelte/icons/mail-plus";
import MailQuestionIcon from "@lucide/svelte/icons/mail-question";
import UserIcon from "@lucide/svelte/icons/user";
import type { Component } from "svelte";
import { toast } from "svelte-sonner";
import { imageUrl } from "./api.ts";
import { boop, canAct, inviteToMyInstance, myInstance, requestInvite } from "./social-actions.ts";
import { userModal } from "./state/user-modal.svelte.ts";

/** The canonical web profile. Opening it is a *browser* action; vrc.zip never fetches it. */
export function vrchatProfileUrl(userId: string): string {
  return `https://vrchat.com/home/user/${userId}`;
}

/**
 * Copies text and says so.
 *
 * `navigator.clipboard` needs a secure context, which `127.0.0.1` is — but a browser can still
 * refuse (permissions policy, a non-focused document), and a copy that silently does nothing is
 * worse than one that admits it, so the failure is reported rather than swallowed.
 */
export async function copyText(label: string, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`, { duration: 2000 });
  } catch {
    toast.error(`Could not copy the ${label.toLowerCase()}`, {
      description: "This browser refused clipboard access to the page.",
      duration: 6000,
    });
  }
}

export interface UserActionTarget {
  readonly userId: string;
  readonly name: string;
  readonly accountId?: string | null;
  /**
   * Everything known about this user, for "copy as JSON". A thunk because the caller with the most
   * to say — the modal — only has the full profile once it has loaded, and the callers with least
   * (a feed row) should not build an object nobody asked for.
   */
  readonly meta?: () => unknown;
  /**
   * The **full-size** profile image, as VRChat's own absolute URL — `UserProfile.iconUrlFull`.
   *
   * Absent for every caller that has only a name and an id (a feed row, a roster entry), and null
   * for a user with no full-size original. Both hide the action rather than opening a thumbnail
   * blown up to look like the real thing.
   */
  readonly iconUrlFull?: string | null;
  /** The profile banner, VRChat's absolute URL. Already full size; there is no thumbnail of it. */
  readonly bannerUrl?: string | null;
}

export interface UserAction {
  readonly id: string;
  readonly label: string;
  readonly icon: Component;
  /** Draws a separator above this item. Groups "go somewhere" apart from "copy something". */
  readonly separatorBefore?: boolean;
  readonly run: () => void;
}

/**
 * Opens a VRChat asset in a new tab, through the daemon.
 *
 * Never the VRChat URL itself: those need the owning account's auth cookie and a User-Agent a
 * browser is not allowed to set, so a tab pointed at one gets a 403. `GET /api/image` is
 * same-origin, so the new tab carries the page's session cookie the same way an `<img>` does.
 */
function openImage(url: string): void {
  const src = imageUrl(url);
  if (src === undefined) return;
  window.open(src, "_blank", "noopener,noreferrer");
}

/**
 * The menu, in the order it is shown. Identical in the context menu and the overflow menu.
 *
 * The image items are the only conditional ones: a caller that knows nothing but a name and an id
 * omits them entirely, rather than offering something that would open a blank tab.
 */
/**
 * The three actions that reach the other person.
 *
 * Omitted entirely rather than disabled when there is nobody to act as: a greyed-out "Boop" with no
 * explanation is a worse answer than a menu that does not offer it, and the explanation belongs on
 * the screen that could fix it (Accounts), not in a context menu tooltip.
 *
 * "Invite to my instance" has its own condition on top: it needs a running client somewhere a
 * second person can actually be invited to, and it acts as *that client's* account rather than the
 * caller's preference — inviting to a room from an account that is not in it is a request VRChat
 * would refuse for a reason nobody could see from here.
 */
function socialActions(target: UserActionTarget): UserAction[] {
  const actions: UserAction[] = [];
  if (myInstance() !== null) {
    actions.push({
      id: "invite",
      label: "Invite to my instance",
      icon: MailPlusIcon,
      separatorBefore: true,
      run: () => {
        void inviteToMyInstance(target.userId, target.name);
      },
    });
  }
  if (canAct(target.accountId)) {
    actions.push(
      {
        id: "request-invite",
        label: "Ask for an invite",
        icon: MailQuestionIcon,
        separatorBefore: actions.length === 0,
        run: () => {
          void requestInvite(target.userId, target.name, target.accountId);
        },
      },
      {
        id: "boop",
        label: "Boop",
        icon: HandIcon,
        run: () => {
          void boop(target.userId, target.name, target.accountId);
        },
      },
    );
  }
  return actions;
}

export function userActions(target: UserActionTarget): UserAction[] {
  const meta = target.meta;
  const icon = target.iconUrlFull ?? null;
  const banner = target.bannerUrl ?? null;
  const imageActions: UserAction[] = [];
  if (icon !== null && icon !== "") {
    imageActions.push({
      id: "open-image",
      label: "Open profile image",
      icon: ImageIcon,
      run: () => {
        openImage(icon);
      },
    });
  }
  if (banner !== null && banner !== "") {
    imageActions.push({
      id: "open-banner",
      label: "Open profile banner",
      icon: GalleryHorizontalIcon,
      run: () => {
        openImage(banner);
      },
    });
  }

  return [
    {
      id: "open",
      label: "Open profile",
      icon: UserIcon,
      run: () => {
        userModal.openUser(target.userId, { name: target.name, accountId: target.accountId });
      },
    },
    {
      id: "vrchat",
      label: "Open on vrchat.com",
      icon: ExternalLinkIcon,
      run: () => {
        window.open(vrchatProfileUrl(target.userId), "_blank", "noopener,noreferrer");
      },
    },
    ...imageActions,
    ...socialActions(target),
    {
      id: "copy-name",
      label: "Copy display name",
      icon: CopyIcon,
      separatorBefore: true,
      run: () => {
        void copyText("Display name", target.name);
      },
    },
    {
      id: "copy-id",
      label: "Copy user id",
      icon: IdCardIcon,
      run: () => {
        void copyText("User id", target.userId);
      },
    },
    {
      id: "copy-link",
      label: "Copy profile link",
      icon: CopyIcon,
      run: () => {
        void copyText("Profile link", vrchatProfileUrl(target.userId));
      },
    },
    {
      id: "copy-meta",
      label: "Copy details as JSON",
      icon: BracesIcon,
      run: () => {
        const value = meta === undefined ? { id: target.userId, displayName: target.name } : meta();
        void copyText("Details", JSON.stringify(value, null, 2));
      },
    },
  ];
}
