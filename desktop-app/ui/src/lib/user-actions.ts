/**
 * What you can do to a name.
 *
 * Every display name in the app is the same object with the same affordances, so the list of
 * things you can do with one is written down once here and rendered twice: as a right-click
 * context menu on the name itself (`UserContextMenu`), and as the overflow menu in the user
 * modal's header (`UserActionsMenu`). Two menu component families, one list of actions — a
 * "copy id" that exists in one menu and not the other is exactly the drift this prevents.
 *
 * Nothing here reaches the daemon. These are clipboard and navigation actions, which is why they
 * work for a user whose profile failed to load, or when no account is online at all.
 */

import BracesIcon from "@lucide/svelte/icons/braces";
import CopyIcon from "@lucide/svelte/icons/copy";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import IdCardIcon from "@lucide/svelte/icons/id-card";
import UserIcon from "@lucide/svelte/icons/user";
import type { Component } from "svelte";
import { toast } from "svelte-sonner";
import { userModal } from "./state/user-modal.svelte.ts";

/** The canonical web profile. Opening it is a *browser* action; vrc.zip never fetches it. */
export function vrchatProfileUrl(userId: string): string {
  return `https://vrchat.com/home/user/${userId}`;
}

/**
 * Copies text and says so.
 *
 * `navigator.clipboard` needs a secure context. `127.0.0.1` is one and so is `local.vrc.zip` over
 * https, which covers both supported ways of reaching this UI — but a browser can still refuse
 * (permissions policy, a non-focused document), and a copy that silently does nothing is worse
 * than one that admits it, so the failure is reported rather than swallowed.
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
}

export interface UserAction {
  readonly id: string;
  readonly label: string;
  readonly icon: Component;
  /** Draws a separator above this item. Groups "go somewhere" apart from "copy something". */
  readonly separatorBefore?: boolean;
  readonly run: () => void;
}

/** The menu, in the order it is shown. Identical in the context menu and the overflow menu. */
export function userActions(target: UserActionTarget): UserAction[] {
  const meta = target.meta;
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
