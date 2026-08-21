/**
 * Display helpers. Every timestamp crossing the wire is an integer unix millisecond value; the
 * conversion to something a person reads happens here and nowhere else.
 */

import type { EventKind, FriendStatus, TrustLevel } from "./api.ts";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const clockWithSeconds = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dayAndClock = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const dayHeading = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "4m ago", "3h ago", "Tue 21:40". Anything older than a week gets a date. */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const delta = now - ts;
  if (delta < 45_000) return "just now";
  if (delta < HOUR) return relative.format(-Math.round(delta / MINUTE), "minute");
  if (delta < DAY) return relative.format(-Math.round(delta / HOUR), "hour");
  if (delta < 7 * DAY) return relative.format(-Math.round(delta / DAY), "day");
  return dayAndClock.format(ts);
}

export function timeOfDay(ts: number, withSeconds = false): string {
  return (withSeconds ? clockWithSeconds : clock).format(ts);
}

export function fullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function dateHeading(ts: number, now: number = Date.now()): string {
  const start = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= start) return "Today";
  if (ts >= start - DAY) return "Yesterday";
  return dayHeading.format(ts);
}

/** "2h 14m", "48m", "31s". Used for session uptime, which ticks. */
export function duration(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const totalMinutes = Math.floor(ms / MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

// ---------------------------------------------------------------------------
// VRChat locations
// ---------------------------------------------------------------------------

export type InstanceAccess =
  | "public"
  | "friends+"
  | "friends"
  | "invite+"
  | "invite"
  | "group"
  | "unknown";

export interface ParsedLocation {
  readonly worldId: string | null;
  readonly instanceId: string | null;
  readonly access: InstanceAccess;
  readonly region: string | null;
  /** True for `private`, `offline`, `traveling` — places with no instance to jump to. */
  readonly opaque: boolean;
  /** What to show when there is no world name: "Private world", "Between worlds", … */
  readonly label: string;
}

const ACCESS_TAGS: ReadonlyArray<readonly [string, InstanceAccess]> = [
  ["~hidden", "friends+"],
  ["~friends", "friends"],
  ["~private", "invite"],
  ["~group", "group"],
];

/**
 * VRChat encodes access in tags appended to the instance id, and "invite+" is the `canRequestInvite`
 * flag on top of `~private` rather than a tag of its own — which is why this is a parser and not a
 * lookup table.
 */
export function parseLocation(location: string | null): ParsedLocation {
  if (location === null || location === "") {
    return {
      worldId: null,
      instanceId: null,
      access: "unknown",
      region: null,
      opaque: true,
      label: "Unknown",
    };
  }
  if (location === "offline") {
    return { ...opaque("Offline"), label: "Offline" };
  }
  if (location === "private") {
    return { ...opaque("Private"), label: "In a private world" };
  }
  if (location === "traveling") {
    return { ...opaque("Traveling"), label: "Between worlds" };
  }

  const [worldId = null, rest = ""] = location.split(":", 2);
  const instanceId = rest === "" ? null : (rest.split("~")[0] ?? null);

  let access: InstanceAccess = "public";
  for (const [tag, kind] of ACCESS_TAGS) {
    if (rest.includes(tag)) {
      access = kind;
      break;
    }
  }
  if (access === "invite" && rest.includes("~canRequestInvite")) access = "invite+";

  const regionMatch = /~region\(([^)]+)\)/.exec(rest);

  return {
    worldId,
    instanceId,
    access,
    region: regionMatch?.[1] ?? null,
    opaque: false,
    label: instanceId === null ? "Instance" : `#${instanceId}`,
  };
}

function opaque(label: string): ParsedLocation {
  return {
    worldId: null,
    instanceId: null,
    access: "unknown",
    region: null,
    opaque: true,
    label,
  };
}

/** The `vrchat://` deep link that launches the game into an instance, or null if there is none. */
export function launchLink(location: string | null): string | null {
  const parsed = parseLocation(location);
  if (parsed.opaque || location === null) return null;
  return `vrchat://launch?ref=vrc.zip&id=${encodeURIComponent(location)}`;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<FriendStatus, string> = {
  active: "Online",
  "join me": "Join me",
  "ask me": "Ask me",
  busy: "Do not disturb",
  offline: "Offline",
};

export function statusLabel(status: FriendStatus): string {
  return STATUS_LABELS[status] ?? "Unknown";
}

/** Maps a presence status to its theme token suffix (see `--status-*` in app.css). */
export function statusToken(status: FriendStatus): string {
  switch (status) {
    case "active":
      return "status-online";
    case "join me":
      return "status-join-me";
    case "ask me":
      return "status-ask-me";
    case "busy":
      return "status-busy";
    default:
      return "status-offline";
  }
}

const TRUST_LABELS: Record<TrustLevel, string> = {
  visitor: "Visitor",
  new: "New User",
  user: "User",
  known: "Known User",
  trusted: "Trusted User",
  veteran: "Veteran",
  troll: "Nuisance",
  "vrchat-team": "VRChat Team",
};

export function trustLabel(level: TrustLevel): string {
  return TRUST_LABELS[level] ?? "Unknown";
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "friend-online": "Friend came online",
  "friend-offline": "Friend went offline",
  "friend-location": "Friend changed world",
  "friend-add": "Friend added",
  "friend-delete": "Friend removed",
  "friend-request": "Friend request",
  notification: "Notification",
  invite: "Invite",
  "invite-request": "Invite request",
  "player-join": "Player joined",
  "player-leave": "Player left",
  "world-change": "World changed",
  "session-start": "Client started",
  "session-end": "Client closed",
};

/** Falls back to title-casing the raw kind, so a kind this build has never seen still reads. */
export function eventLabel(kind: EventKind): string {
  const known = EVENT_LABELS[kind];
  if (known !== undefined) return known;
  return kind
    .split(/[-_.]/)
    .filter((part) => part !== "")
    .map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** Best-effort human name for an event's subject, pulled out of the untyped payload. */
export function subjectName(payload: Readonly<Record<string, unknown>>): string | null {
  for (const key of ["displayName", "userDisplayName", "senderUsername", "username", "name"]) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

export function payloadText(payload: Readonly<Record<string, unknown>>): string | null {
  for (const key of ["message", "details", "text", "worldName"]) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}
