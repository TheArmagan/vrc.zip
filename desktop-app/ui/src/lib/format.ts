/**
 * Display helpers. Every timestamp crossing the wire is an integer unix millisecond value; the
 * conversion to something a person reads happens here and nowhere else. So does the vocabulary —
 * one place decides that `friend.location` reads "moved instance" and `otp` reads "recovery code".
 */

import type { AccountConnection, EventKind, FriendStatus, TwoFactorMethod } from "./api.ts";

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
  if (ms < MINUTE) return `${String(Math.max(0, Math.floor(ms / 1000)))}s`;
  const totalMinutes = Math.floor(ms / MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${String(minutes)}m`;
  return `${String(hours)}h ${String(minutes)}m`;
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

const ACCESS_LABELS: Record<InstanceAccess, string> = {
  public: "Public",
  "friends+": "Friends+",
  friends: "Friends",
  "invite+": "Invite+",
  invite: "Invite",
  group: "Group",
  unknown: "Unknown",
};

export function accessLabel(access: InstanceAccess): string {
  return ACCESS_LABELS[access];
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

/**
 * VRChat encodes access in tags appended to the instance id, and "invite+" is the
 * `canRequestInvite` flag on top of `~private` rather than a tag of its own — which is why this is
 * a parser and not a lookup table.
 */
export function parseLocation(location: string | null): ParsedLocation {
  // VRChat spells "nowhere" six different ways, and `/api/friends` passes the string through raw:
  // "", "offline", "private", "traveling", and "traveling:traveling" all reach here.
  if (location === null || location === "") return opaque("Unknown");
  if (location === "offline") return opaque("Offline");
  if (location === "private") return opaque("In a private world");
  if (location === "traveling" || location.startsWith("traveling:")) {
    return opaque("Between worlds");
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
  if (access === "invite" && rest.includes("canRequestInvite")) access = "invite+";

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

/** The `vrchat://` deep link that launches the game into an instance, or null if there is none. */
export function launchLink(location: string | null): string | null {
  const parsed = parseLocation(location);
  if (parsed.opaque || location === null) return null;
  return `vrchat://launch?ref=vrchat.com&id=${encodeURIComponent(location)}`;
}

/** Worlds are only ever identified by id until a name arrives; `wrld_1234abcd…` -> `wrld_1234ab`. */
export function shortId(id: string | null, keep = 10): string {
  if (id === null || id === "") return "unknown";
  return id.length <= keep + 3 ? id : `${id.slice(0, keep)}…`;
}

/**
 * Avatar initials for a VRChat display name.
 *
 * VRChat names are frequently a single word, often decorated with brackets, dots or emoji, so this
 * takes the first two *letters or digits* of the first two such runs rather than splitting on
 * whitespace and hoping. A name with nothing alphanumeric in it falls back to a bullet, because an
 * empty avatar reads as a failed image load.
 */
export function initials(displayName: string): string {
  const words = displayName.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return "•";
  if (words.length === 1) return (words[0] ?? "").slice(0, 2).toUpperCase();
  return `${(words[0] ?? "").charAt(0)}${(words[1] ?? "").charAt(0)}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const STATUS_LABELS: Readonly<Record<string, string>> = {
  active: "Online",
  "join me": "Join me",
  "ask me": "Ask me",
  busy: "Do not disturb",
  offline: "Offline",
};

export function statusLabel(status: FriendStatus): string {
  return STATUS_LABELS[status] ?? "Unknown";
}

/** Presence status -> the theme token suffix declared in `app.css`. */
export function statusToken(status: FriendStatus): string {
  switch (status) {
    case "active":
      return "online";
    case "join me":
      return "join-me";
    case "ask me":
      return "ask-me";
    case "busy":
      return "busy";
    default:
      return "offline";
  }
}

const CONNECTION_LABELS: Record<AccountConnection, string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Signed out",
  "needs-2fa": "Needs 2FA",
};

export function connectionLabel(connection: AccountConnection): string {
  return CONNECTION_LABELS[connection];
}

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  standalonewindows: "PC",
  android: "Quest",
  ios: "iOS",
  web: "Web",
};

export function platformLabel(platform: string | null): string | null {
  if (platform === null || platform === "") return null;
  return PLATFORM_LABELS[platform.toLowerCase()] ?? platform;
}

/**
 * The log's VR-mode string is not a boolean and not a fixed set — `Standalone`, `Oculus`,
 * `OpenVR`, `None`, `Desktop`. Anything that is not explicitly "no headset" counts as VR.
 */
export function isVrMode(vrMode: string | null): boolean {
  if (vrMode === null || vrMode === "") return false;
  const normalized = vrMode.toLowerCase();
  return normalized !== "none" && normalized !== "desktop" && normalized !== "false";
}

export function vrModeLabel(vrMode: string | null): string {
  if (vrMode === null || vrMode === "") return "Unknown";
  return isVrMode(vrMode) ? "VR" : "Desktop";
}

const TWO_FACTOR_LABELS: Record<TwoFactorMethod, string> = {
  totp: "Authenticator app",
  emailOtp: "Emailed code",
  otp: "Recovery code",
};

export function twoFactorLabel(method: TwoFactorMethod): string {
  return TWO_FACTOR_LABELS[method];
}

/**
 * Bus kinds, in the app's own words. The map is over the dotted taxonomy the daemon actually
 * emits (`daemon/src/wiring/pipeline-bridge.ts` and `log-bridge.ts`), not VRChat's wire names.
 */
const EVENT_LABELS: Readonly<Record<string, string>> = {
  "friend.online": "Friend came online",
  "friend.offline": "Friend went offline",
  "friend.active": "Friend became active",
  "friend.location": "Friend changed instance",
  "friend.updated": "Friend profile changed",
  "friend.added": "Friend added",
  "friend.removed": "Friend removed",
  "user.updated": "Your profile changed",
  "user.location": "You changed instance",
  "notification.received": "Notification",
  "notification.received_v2": "Notification",
  "notification.updated": "Notification updated",
  "notification.deleted": "Notification deleted",
  "notification.responded": "Notification answered",
  "notification.seen": "Notification seen",
  "notification.hidden": "Notification hidden",
  "notification.cleared": "Notifications cleared",
  "gamelog.player_join": "Player joined",
  "gamelog.player_leave": "Player left",
  "gamelog.world_enter": "Entered world",
  "gamelog.location_join": "Joined instance",
  "gamelog.portal_spawn": "Portal dropped",
  "gamelog.destination_set": "Destination set",
  "gamelog.left_room": "Left instance",
  "gamelog.join_failed": "Join failed",
  "gamelog.screenshot": "Screenshot taken",
  "gamelog.app_quit": "Client quit",
  "gamelog.vr_mode": "VR mode reported",
  "gamelog.authenticated": "Client signed in",
  "session.start": "Game client started",
  "session.update": "Game client updated",
  "session.end": "Game client closed",
  "account.state": "Account state changed",
  "pipeline.state": "Pipeline state changed",
  "economy.update": "Subscription updated",
  "instance.queue_joined": "Joined instance queue",
  "instance.queue_ready": "Instance queue ready",
  "group.joined": "Joined group",
  "group.left": "Left group",
  "group.member_updated": "Group member updated",
  "group.role_updated": "Group role updated",
  "content.refresh": "Content refreshed",
  "content.image_updated": "Image updated",
};

/** Falls back to humanising the raw kind, so a kind this build has never seen still reads. */
export function eventLabel(kind: EventKind): string {
  const known = EVENT_LABELS[kind];
  if (known !== undefined) return known;
  const words = kind
    .split(/[.\-_]/)
    .filter((part) => part !== "")
    .join(" ");
  return words === "" ? kind : words.charAt(0).toUpperCase() + words.slice(1);
}

const FAMILY_LABELS: Readonly<Record<string, string>> = {
  friend: "Friends",
  notification: "Notifications",
  gamelog: "Game log",
  session: "Sessions",
  user: "You",
  group: "Groups",
  instance: "Instances",
  account: "Accounts",
  pipeline: "Pipeline",
  economy: "Economy",
  content: "Content",
  other: "Other",
};

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? family;
}

// ---------------------------------------------------------------------------
// Payload probing
// ---------------------------------------------------------------------------

/**
 * Bus payloads are untyped by design — the daemon forwards VRChat's own shapes. These two helpers
 * are the only place the UI guesses at them, and both return null rather than inventing text.
 */
function asRecord(payload: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function firstString(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

const NAME_KEYS = [
  "displayName",
  "userDisplayName",
  "senderUsername",
  "username",
  "playerName",
  "name",
] as const;

/** Best-effort human name for an event's subject, pulled out of the untyped payload. */
export function subjectName(payload: unknown): string | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const direct = firstString(record, NAME_KEYS);
  if (direct !== null) return direct;
  const nested = asRecord(record.user) ?? asRecord(record.data);
  return nested === null ? null : firstString(nested, NAME_KEYS);
}

/** A short line of detail for the event, or null when the payload carries nothing readable. */
export function payloadText(payload: unknown): string | null {
  const record = asRecord(payload);
  if (record === null) return typeof payload === "string" && payload !== "" ? payload : null;
  const direct = firstString(record, ["message", "details", "text", "worldName", "title"]);
  if (direct !== null) return direct;
  const nested = asRecord(record.data);
  return nested === null ? null : firstString(nested, ["message", "details", "text", "worldName"]);
}
