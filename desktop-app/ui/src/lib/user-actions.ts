/**
 * What you can do to a name.
 *
 * Every display name in the app is the same object with the same affordances, so the list of
 * things you can do with one is written down once here and rendered twice: as a right-click
 * context menu on the name itself (`UserContextMenu`), and as the overflow menu in the user
 * modal's header (`UserActionsMenu`). Two menu component families, one list of actions — a
 * "copy id" that exists in one menu and not the other is exactly the drift this prevents.
 *
 * Every action here is a clipboard or navigation action, which is why they work for a user whose
 * profile failed to load, or when no account is online at all. The two image items are the one
 * qualification: they open a daemon URL in a new tab, so they need the daemon reachable — and they
 * are the only items that are hidden when the caller does not have the URL to open.
 */

import BracesIcon from "@lucide/svelte/icons/braces";
import CopyIcon from "@lucide/svelte/icons/copy";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import GalleryHorizontalIcon from "@lucide/svelte/icons/gallery-horizontal";
import IdCardIcon from "@lucide/svelte/icons/id-card";
import ImageIcon from "@lucide/svelte/icons/image";
import UserIcon from "@lucide/svelte/icons/user";
import type { Component } from "svelte";
import { toast } from "svelte-sonner";
import { imageUrl } from "./api.ts";
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
