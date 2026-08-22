/**
 * What one feed row actually says.
 *
 * `format.ts` has `eventLabel`, which maps a dotted kind onto a noun phrase — "Player joined",
 * "Client quit". That is all a row used to show, and it is the same six words whether someone
 * walked into your instance, VRChat refused a join, or a screenshot landed on disk. The payload
 * held who, where and why the whole time; nothing read it.
 *
 * So this module reads it. One function, `describeEvent`, turns an event into the pieces a row
 * needs: an icon, a tone, the subject's name, a verb phrase that follows it, any facts worth
 * chipping out, and the location the row should draw. The row composes them — it still renders
 * names and locations through `UserName`/`LocationLine`, because those are interactive and this
 * module returns data, not markup.
 *
 * Two rules hold throughout, the same two the rest of the app follows:
 *
 * - **Never invent.** A field VRChat did not send produces no fact, not an empty one and not a
 *   guess. Payloads are VRChat's own shapes forwarded verbatim, and it has shipped several of them
 *   more than one way (`gamelog.player_join` has carried a display name with and without an id).
 * - **A kind this build has never heard of still renders.** It falls through to the humanised
 *   label `format.ts` already owns, rather than being dropped or growing a second vocabulary here.
 */

import type { LucideIcon } from "@lucide/svelte";
import ArrowRightIcon from "@lucide/svelte/icons/arrow-right";
import BellIcon from "@lucide/svelte/icons/bell";
import CameraIcon from "@lucide/svelte/icons/camera";
import CircleDotIcon from "@lucide/svelte/icons/circle-dot";
import CircleSlashIcon from "@lucide/svelte/icons/circle-slash";
import DoorOpenIcon from "@lucide/svelte/icons/door-open";
import GlobeIcon from "@lucide/svelte/icons/globe";
import HeadphonesIcon from "@lucide/svelte/icons/headphones";
import ImageIcon from "@lucide/svelte/icons/image";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import LogInIcon from "@lucide/svelte/icons/log-in";
import LogOutIcon from "@lucide/svelte/icons/log-out";
import MonitorIcon from "@lucide/svelte/icons/monitor";
import PackageIcon from "@lucide/svelte/icons/package";
import PowerIcon from "@lucide/svelte/icons/power";
import RadioIcon from "@lucide/svelte/icons/radio";
import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
import SparklesIcon from "@lucide/svelte/icons/sparkles";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import UserMinusIcon from "@lucide/svelte/icons/user-minus";
import UserPlusIcon from "@lucide/svelte/icons/user-plus";
import UsersIcon from "@lucide/svelte/icons/users";
import type { EventKind } from "./api.ts";
import type { LiveEvent } from "./events.ts";
import { eventLabel, platformLabel, subjectName } from "./format.ts";

/**
 * The accent a row wears.
 *
 * Deliberately about *meaning* rather than about family: an arrival is green whether the game log
 * or the pipeline noticed it, because a reader scanning a long list is looking for arrivals, not
 * for which subsystem reported them.
 */
export type EventTone =
  | "arrive"
  | "depart"
  | "place"
  | "alert"
  | "capture"
  | "social"
  | "system"
  | "neutral";

export interface EventFact {
  readonly label: string;
  readonly value: string;
  /** Paths, ids and other things that are read character by character. */
  readonly mono?: boolean;
}

export interface EventDetails {
  readonly icon: LucideIcon;
  readonly tone: EventTone;
  /**
   * The verb phrase that follows the subject — "joined the instance". When `subject` is null it
   * stands alone as the whole sentence, so each one is written to read correctly either way.
   */
  readonly action: string;
  /** Who or what this is about, when the payload names one. */
  readonly subject: string | null;
  readonly facts: readonly EventFact[];
  /** The VRChat location string this row should draw, or null for a row with no place in it. */
  readonly location: string | null;
  /** A world name the payload already carried — always better than one fetched by id later. */
  readonly worldName: string | null;
}

// ---------------------------------------------------------------------------
// Payload probing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(record: Readonly<Record<string, unknown>> | null, key: string): string | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The location string out of a game-log payload.
 *
 * Game-log events carry theirs *nested inside the parsed location object*, not in the event's own
 * `location` column — the log bridge has never set that column. Reading only `event.location` is
 * why every world change in the game log used to render without the world it changed to.
 */
function nestedLocation(
  record: Readonly<Record<string, unknown>> | null,
  key: string,
): string | null {
  return str(asRecord(record?.[key] ?? null), "location");
}

/** The last segment of a screenshot path, which is the only part worth a row's width. */
function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

function fact(label: string, value: string | null, mono = false): EventFact[] {
  if (value === null) return [];
  return [mono ? { label, value, mono } : { label, value }];
}

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

/** The three fields most kinds have nothing to say about, so each case states only what it adds. */
const BLANK: Pick<EventDetails, "facts" | "location" | "worldName"> = {
  facts: [],
  location: null,
  worldName: null,
};

/** Per-family fallbacks, for a kind this build has never seen. Never a dead end. */
function familyFallback(kind: EventKind): Pick<EventDetails, "icon" | "tone"> {
  if (kind.startsWith("friend.")) return { icon: UsersIcon, tone: "social" };
  if (kind.startsWith("notification.")) return { icon: BellIcon, tone: "social" };
  if (kind.startsWith("gamelog.")) return { icon: CircleDotIcon, tone: "neutral" };
  if (kind.startsWith("session.")) return { icon: MonitorIcon, tone: "system" };
  if (kind.startsWith("group.")) return { icon: UsersIcon, tone: "social" };
  if (kind.startsWith("instance.")) return { icon: DoorOpenIcon, tone: "place" };
  if (kind.startsWith("consent.")) return { icon: ShieldCheckIcon, tone: "alert" };
  if (kind.startsWith("content.")) return { icon: PackageIcon, tone: "system" };
  return { icon: CircleDotIcon, tone: "neutral" };
}

export function describeEvent(event: LiveEvent): EventDetails {
  const payload = asRecord(event.payload);
  const who = subjectName(event.payload);

  switch (event.kind) {
    // -- the game log -------------------------------------------------------
    case "gamelog.player_join":
      return {
        ...BLANK,
        icon: LogInIcon,
        tone: "arrive",
        subject: who,
        action: "joined the instance",
      };

    case "gamelog.player_leave":
      return {
        ...BLANK,
        icon: LogOutIcon,
        tone: "depart",
        subject: who,
        action: "left the instance",
      };

    case "gamelog.world_enter":
      return {
        ...BLANK,
        icon: GlobeIcon,
        tone: "place",
        subject: null,
        action: "Entered a world",
        // The name the client itself wrote, which beats anything looked up by id afterwards.
        worldName: str(payload, "worldName"),
      };

    case "gamelog.location_join": {
      const nested = asRecord(payload?.location ?? null);
      const region = str(nested, "region");
      return {
        ...BLANK,
        icon: DoorOpenIcon,
        tone: "place",
        subject: null,
        action: "Joined an instance",
        location: nestedLocation(payload, "location"),
        facts: fact("Region", region === null ? null : region.toUpperCase()),
      };
    }

    case "gamelog.destination_set":
      return {
        ...BLANK,
        icon: ArrowRightIcon,
        tone: "place",
        subject: null,
        action: "Set a destination",
        location: nestedLocation(payload, "location"),
      };

    case "gamelog.portal_spawn":
      return {
        ...BLANK,
        icon: SparklesIcon,
        tone: "place",
        // The spawner is named by a key of its own, which `subjectName` does not know — and a
        // portal whose dropper the log named is a materially different row from one it did not.
        subject: str(payload, "spawnerDisplayName") ?? who,
        action: "dropped a portal",
        location: nestedLocation(payload, "target"),
      };

    case "gamelog.left_room":
      return {
        ...BLANK,
        icon: LogOutIcon,
        tone: "depart",
        subject: null,
        action: "Left the instance",
      };

    case "gamelog.join_failed":
      return {
        ...BLANK,
        icon: TriangleAlertIcon,
        tone: "alert",
        subject: null,
        action: "Could not join an instance",
        facts: fact("Reason", str(payload, "reason")),
      };

    case "gamelog.screenshot": {
      const path = str(payload, "path");
      return {
        ...BLANK,
        icon: CameraIcon,
        tone: "capture",
        subject: null,
        action: "Took a screenshot",
        facts: path === null ? [] : [{ label: "File", value: fileName(path), mono: true }],
      };
    }

    case "gamelog.app_quit":
      return {
        ...BLANK,
        icon: PowerIcon,
        tone: "system",
        subject: null,
        action: "VRChat closed",
      };

    case "gamelog.vr_mode": {
      const desktop = str(payload, "vrMode") === "desktop";
      return {
        ...BLANK,
        icon: desktop ? MonitorIcon : HeadphonesIcon,
        tone: "system",
        subject: null,
        action: desktop ? "Started in desktop mode" : "Started in VR",
      };
    }

    case "gamelog.authenticated":
      return {
        ...BLANK,
        icon: KeyRoundIcon,
        tone: "system",
        subject: who,
        action: "signed in to this client",
      };

    // -- friends ------------------------------------------------------------
    case "friend.online":
    case "friend.active":
      return {
        ...BLANK,
        icon: CircleDotIcon,
        tone: "arrive",
        subject: who,
        action: event.kind === "friend.online" ? "came online" : "became active",
        location: event.location,
        facts: fact("Platform", platformLabel(str(payload, "platform"))),
      };

    case "friend.offline":
      return {
        ...BLANK,
        icon: CircleSlashIcon,
        tone: "depart",
        subject: who,
        action: "went offline",
      };

    case "friend.location":
      return {
        ...BLANK,
        icon: ArrowRightIcon,
        tone: "place",
        subject: who,
        action: "moved",
        location: event.location,
        worldName: str(asRecord(payload?.world ?? null), "name"),
      };

    case "friend.added":
      return {
        ...BLANK,
        icon: UserPlusIcon,
        tone: "social",
        subject: who,
        action: "is now a friend",
      };

    case "friend.removed":
      return {
        ...BLANK,
        icon: UserMinusIcon,
        tone: "depart",
        subject: who,
        action: "is no longer a friend",
      };

    case "friend.updated":
      return {
        ...BLANK,
        icon: UsersIcon,
        tone: "social",
        subject: who,
        action: "changed their profile",
        facts: fact("Status", str(payload, "statusDescription")),
      };

    // -- notifications ------------------------------------------------------
    case "notification.received":
    case "notification.received_v2": {
      const type = str(payload, "type");
      return {
        ...BLANK,
        icon: BellIcon,
        tone: "social",
        subject: who,
        // VRChat's own word for what this is (`invite`, `friendRequest`, `requestInvite`) is the
        // single most useful thing on the row, and it was previously not shown at all: every one
        // of them read "Notification".
        action: type === null ? "sent a notification" : `sent ${notificationPhrase(type)}`,
        facts: fact("Message", str(payload, "message")),
        location: event.location,
      };
    }

    case "notification.responded":
      return {
        ...BLANK,
        icon: BellIcon,
        tone: "social",
        subject: who,
        action: "answered a notification",
      };

    // -- your own account and clients ---------------------------------------
    case "user.location":
      return {
        ...BLANK,
        icon: ArrowRightIcon,
        tone: "place",
        subject: null,
        action: "You moved",
        location: event.location,
      };

    case "session.start":
      return {
        ...BLANK,
        icon: MonitorIcon,
        tone: "system",
        subject: who,
        action: "started a VRChat client",
      };

    case "session.end": {
      const crashed = str(payload, "exitKind") === "crash";
      return {
        ...BLANK,
        icon: PowerIcon,
        tone: crashed ? "alert" : "system",
        subject: null,
        action: crashed ? "A VRChat client stopped without quitting" : "A VRChat client closed",
      };
    }

    case "content.image_updated":
      return {
        ...BLANK,
        icon: ImageIcon,
        tone: "system",
        subject: who,
        action: "changed an image",
      };

    case "pipeline.state":
      return {
        ...BLANK,
        icon: RadioIcon,
        tone: "system",
        subject: null,
        action: "Pipeline state changed",
      };

    default:
      return {
        ...BLANK,
        ...familyFallback(event.kind),
        subject: who,
        action: eventLabel(event.kind),
      };
  }
}

/** VRChat's notification `type`, as something that reads after the word "sent". */
function notificationPhrase(type: string): string {
  switch (type) {
    case "invite":
      return "an invite";
    case "inviteResponse":
      return "an invite response";
    case "requestInvite":
      return "an invite request";
    case "requestInviteResponse":
      return "an invite-request response";
    case "friendRequest":
      return "a friend request";
    case "message":
      return "a message";
    case "boop":
      return "a boop";
    default:
      // An unfamiliar type is still worth naming. Guessing an English article for it is not.
      return `a "${type}" notification`;
  }
}

/**
 * The accent classes per tone.
 *
 * Written out in full for the same reason `StatusDot` writes its own: Tailwind scans source text
 * for class names, so a class composed at runtime is never generated into the stylesheet.
 */
export const TONE_CLASSES: Readonly<Record<EventTone, { icon: string; rule: string }>> = {
  arrive: { icon: "text-status-online", rule: "border-l-status-online" },
  depart: { icon: "text-muted-foreground", rule: "border-l-border" },
  place: { icon: "text-status-join-me", rule: "border-l-status-join-me" },
  alert: { icon: "text-destructive", rule: "border-l-destructive" },
  capture: { icon: "text-chart-3", rule: "border-l-chart-3" },
  social: { icon: "text-chart-4", rule: "border-l-chart-4" },
  system: { icon: "text-chart-5", rule: "border-l-chart-5" },
  neutral: { icon: "text-muted-foreground", rule: "border-l-border" },
};
