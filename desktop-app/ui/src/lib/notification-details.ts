/**
 * What one inbox row says, in the same shape `event-details.ts` uses for the feed.
 *
 * The screen used to print VRChat's `type` mapped to a noun ("Invite", "Group announcement") and
 * the message underneath. That is fine for an invite and poor for everything else: a group
 * announcement's title lived in `data` and was never shown, an invite's world was in `data` and was
 * never shown, and a vote-to-kick read exactly like a friend request.
 *
 * The two rules are the ones the feed follows. Never invent a field VRChat did not send, and let a
 * `type` this build has never heard of render generically rather than be dropped — VRChat's type
 * list is open and has grown twice already.
 */

import type { LucideIcon } from "@lucide/svelte";
import BellIcon from "@lucide/svelte/icons/bell";
import GavelIcon from "@lucide/svelte/icons/gavel";
import HandIcon from "@lucide/svelte/icons/hand";
import HourglassIcon from "@lucide/svelte/icons/hourglass";
import InfoIcon from "@lucide/svelte/icons/info";
import MegaphoneIcon from "@lucide/svelte/icons/megaphone";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import TicketIcon from "@lucide/svelte/icons/ticket";
import UserPlusIcon from "@lucide/svelte/icons/user-plus";
import UsersIcon from "@lucide/svelte/icons/users";
import type { NotificationItem } from "./api.ts";
import type { EventFact, EventTone } from "./event-details.ts";

export interface NotificationDetails {
  readonly icon: LucideIcon;
  readonly tone: EventTone;
  /** What kind of thing this is, in the app's words. */
  readonly title: string;
  /** The verb phrase after the sender's name: "sent you an invite". */
  readonly action: string;
  readonly facts: readonly EventFact[];
  /** A VRChat location the row should offer, when the notification carries one. */
  readonly location: string | null;
  readonly worldName: string | null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(record: Readonly<Record<string, unknown>> | null, key: string): string | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function fact(label: string, value: string | null): EventFact[] {
  return value === null ? [] : [{ label, value }];
}

/**
 * VRChat's `type`, in the app's words. A courtesy rather than a contract — the set is open, and
 * anything missing is humanised rather than shown as "Unknown".
 */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  friendRequest: "Friend request",
  invite: "Invite",
  inviteResponse: "Invite response",
  requestInvite: "Invite request",
  requestInviteResponse: "Invite request answered",
  message: "Message",
  boop: "Boop",
  votetokick: "Vote to kick",
  "group.announcement": "Group announcement",
  "group.informative": "Group notice",
  "group.invite": "Group invite",
  "group.joinRequest": "Group join request",
  "group.queueReady": "Group queue ready",
  "group.transfer": "Group ownership transfer",
};

export function notificationTypeLabel(type: string): string {
  const known = TYPE_LABELS[type];
  if (known !== undefined) return known;
  const spaced = type
    .replace(/[._-]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return spaced === "" ? type : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const ICONS: Readonly<Record<string, { icon: LucideIcon; tone: EventTone }>> = {
  friendRequest: { icon: UserPlusIcon, tone: "social" },
  invite: { icon: TicketIcon, tone: "place" },
  inviteResponse: { icon: TicketIcon, tone: "social" },
  requestInvite: { icon: HandIcon, tone: "social" },
  requestInviteResponse: { icon: HandIcon, tone: "social" },
  message: { icon: MessageSquareIcon, tone: "social" },
  boop: { icon: HandIcon, tone: "social" },
  votetokick: { icon: GavelIcon, tone: "alert" },
  "group.announcement": { icon: MegaphoneIcon, tone: "social" },
  "group.informative": { icon: InfoIcon, tone: "system" },
  "group.invite": { icon: UsersIcon, tone: "social" },
  "group.joinRequest": { icon: UsersIcon, tone: "social" },
  "group.queueReady": { icon: HourglassIcon, tone: "arrive" },
};

export function describeNotification(item: NotificationItem): NotificationDetails {
  const data = asRecord(item.data);
  const look = ICONS[item.type] ?? { icon: BellIcon, tone: "social" as EventTone };
  const title = notificationTypeLabel(item.type);

  /*
   * The world an invite points at.
   *
   * VRChat puts the location in `data.worldId` (a full instance string, despite the name) and the
   * readable name in `data.worldName`. Both are missing on a friend request and on most group
   * notifications, and neither is invented when absent.
   */
  const location = str(data, "worldId");
  const worldName = str(data, "worldName");

  const facts: EventFact[] = [
    // A group announcement's *title* lives in `data.title` and its body in `message`. Showing only
    // the body dropped the headline, which is the half most announcements lead with.
    ...fact("Title", str(data, "title")),
    ...fact("Message", item.message),
    ...fact("Response", str(data, "responseMessage")),
  ];

  const action =
    item.type === "friendRequest"
      ? "wants to be friends"
      : item.type === "invite"
        ? "invited you"
        : item.type === "requestInvite"
          ? "asked for an invite"
          : item.type === "message"
            ? "sent a message"
            : item.type === "boop"
              ? "booped you"
              : item.type.startsWith("group.")
                ? "posted to a group"
                : `sent a ${title.toLowerCase()}`;

  return { icon: look.icon, tone: look.tone, title, action, facts, location, worldName };
}
