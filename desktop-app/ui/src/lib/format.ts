/**
 * Display helpers. Every timestamp crossing the wire is an integer unix millisecond value; the
 * conversion to something a person reads happens here and nowhere else. So does the vocabulary —
 * one place decides that `friend.location` reads "moved instance" and `otp` reads "recovery code".
 */

import type {
  AccountConnection,
  EventKind,
  FriendStatus,
  GameSession,
  TwoFactorMethod,
} from "./api.ts";

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

/** "1 April 2017". For dates far enough back that a relative time reads as noise. */
const calendarDate = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
  day: "numeric",
});

export function calendarDay(ts: number): string {
  return calendarDate.format(ts);
}

/**
 * True for a VRChat user id, and only for one.
 *
 * A bus event's `subjectId` is whatever identifier its payload carried — a user, but equally a
 * world, a group, or a notification id. Anything that offers to open a *user* has to check, or a
 * `wrld_…` row grows a clickable name that 404s.
 */
export function isUserId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.startsWith("usr_");
}

const TRUST_LABELS: Readonly<Record<string, string>> = {
  trusted: "Trusted",
  veteran: "Trusted",
  known: "Known",
  user: "User",
  basic: "New user",
  visitor: "Visitor",
  nuisance: "Nuisance",
  troll: "Nuisance",
};

/**
 * The rank string, normalised. VRChat spells it three ways depending on where it came from: the
 * daemon's resolved `trustLevel` (`trusted`), the raw tag (`system_trust_veteran`), and the odd
 * capitalised variant out of an older payload. One key, so the label, the colour, the sentence and
 * the sort order can never disagree about which rank they are describing.
 */
function trustKey(trustLevel: string | null | undefined): string {
  if (trustLevel === null || trustLevel === undefined || trustLevel === "") return "";
  return trustLevel.toLowerCase().replace(/^system_trust_/, "");
}

/** VRChat's trust rank, in the words the game uses. Unknown ranks pass through capitalised. */
export function trustLabel(trustLevel: string | null): string | null {
  if (trustLevel === null || trustLevel === "") return null;
  const key = trustKey(trustLevel);
  return TRUST_LABELS[key] ?? trustLevel.charAt(0).toUpperCase() + trustLevel.slice(1);
}

/**
 * What the rank actually *means*, in a sentence.
 *
 * The roster shows rank as a coloured chip, and a colour plus a two-word label still assumes the
 * reader already plays enough VRChat to know that "Known" outranks "User". The tooltip is where
 * that assumption gets paid for, so every rank gets prose rather than only the ones that look
 * alarming.
 */
const TRUST_DESCRIPTIONS: Readonly<Record<string, string>> = {
  trusted:
    "Trusted User — VRChat's highest public rank. Earned over a long time in the game, and the hardest to fake.",
  veteran:
    "Trusted User — VRChat's highest public rank. Earned over a long time in the game, and the hardest to fake.",
  known: "Known User — has spent a substantial amount of time in VRChat.",
  user: "User — past VRChat's new-account ranks, with a moderate amount of time in the game.",
  basic: "New User — a recently created account with little time in VRChat so far.",
  visitor: "Visitor — has not yet passed VRChat's first trust threshold. Everyone starts here.",
  nuisance: "Nuisance — VRChat has flagged this account for abuse. Most people have it hidden.",
  troll: "Nuisance — VRChat has flagged this account for abuse. Most people have it hidden.",
};

export function trustDescription(trustLevel: string | null): string {
  const key = trustKey(trustLevel);
  if (key === "") return "VRChat did not report a trust rank for this person.";
  return (
    TRUST_DESCRIPTIONS[key] ??
    `VRChat reports this person's trust rank as "${trustLevel ?? ""}", which this build has no description for.`
  );
}

/**
 * Sort order, highest rank first. An unrecognised rank sorts after every known one rather than
 * being silently folded into "Visitor" — a rank vrc.zip has not heard of is not evidence of a low
 * one.
 */
const TRUST_ORDER: Readonly<Record<string, number>> = {
  trusted: 0,
  veteran: 0,
  known: 1,
  user: 2,
  basic: 3,
  visitor: 4,
  nuisance: 5,
  troll: 5,
};

export function trustRank(trustLevel: string | null): number {
  const key = trustKey(trustLevel);
  return TRUST_ORDER[key] ?? 6;
}

/**
 * VRChat's own trust colours, written out in full.
 *
 * These are not this app's palette and deliberately so: the rank colours are how VRChat players
 * read trust at a glance in-game, and re-tinting them to fit vrc.zip's tokens would mean showing
 * someone a purple "Trusted" badge for a rank the game paints purple somewhere else. They are
 * literal class strings for the same reason `StatusDot` writes its classes out — Tailwind scans
 * source text, so a composed `text-[${hex}]` would never be generated.
 */
const TRUST_CLASSES: Readonly<Record<string, string>> = {
  trusted: "border-[#8143e6]/40 bg-[#8143e6]/10 text-[#8143e6] dark:text-[#a97ff0]",
  veteran: "border-[#8143e6]/40 bg-[#8143e6]/10 text-[#8143e6] dark:text-[#a97ff0]",
  known: "border-[#ff7b42]/40 bg-[#ff7b42]/10 text-[#c4551f] dark:text-[#ff9c70]",
  user: "border-[#2bcf5c]/40 bg-[#2bcf5c]/10 text-[#1d8f3f] dark:text-[#5fdd85]",
  basic: "border-[#1778ff]/40 bg-[#1778ff]/10 text-[#1778ff] dark:text-[#6aa9ff]",
  visitor: "border-border bg-muted text-muted-foreground",
  nuisance: "border-destructive/40 bg-destructive/10 text-destructive",
  troll: "border-destructive/40 bg-destructive/10 text-destructive",
};

/** The badge classes for a trust rank. An unknown rank gets the neutral outline, never a colour. */
export function trustClass(trustLevel: string | null): string {
  if (trustLevel === null || trustLevel === "") return "";
  return TRUST_CLASSES[trustKey(trustLevel)] ?? "";
}

/**
 * Whether VRChat says this user is age-verified, and in what words.
 *
 * Reads the two fields VRChat actually publishes and the daemon now carries verbatim:
 * `ageVerificationStatus` for the specific claim, and the `ageVerified` boolean behind it. The
 * `system_age_verified` tag is deliberately *not* consulted any more — it was a stand-in for
 * fields the daemon did not send yet, and inferring from a tag when the field exists means two
 * sources of truth that can disagree.
 *
 * `hidden` is the case that matters. It means the user *is* verified and has chosen not to publish
 * it, so it must not read as "unverified" — it returns null and no badge is drawn, exactly as for
 * a user VRChat said nothing about. **Absence of a badge is never a claim here**, and `hidden`
 * short-circuits ahead of `verified` precisely so the boolean cannot re-publish what the user
 * hid.
 */
export function ageVerifiedLabel(
  status: string | null | undefined,
  verified: boolean | undefined,
): string | null {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "hidden") return null;
  if (normalized === "18+") return "18+ verified";
  if (normalized === "verified") return "Age verified";
  if (verified === true) return "Age verified";
  return null;
}

/**
 * A VRChat group's handle: `SHORTCODE.1234`, the form the game itself shows.
 *
 * Both halves are optional in the payload and the discriminator is meaningless without the short
 * code, so a group with only a discriminator gets no handle at all rather than a bare `.1234`.
 */
export function groupTag(
  shortCode: string | null | undefined,
  discriminator: string | null | undefined,
): string | null {
  if (shortCode === null || shortCode === undefined || shortCode === "") return null;
  return discriminator === null || discriminator === undefined || discriminator === ""
    ? shortCode
    : `${shortCode}.${discriminator}`;
}

/**
 * The vrchat.com page for a group.
 *
 * No longer the *only* thing a group offers — `GroupModal` reads the record the daemon fetches —
 * but still the footer link on it, for the same reason the world modal has one: the members, the
 * posts, the galleries and the join button live on that page and vrc.zip does not hold them. An
 * app that quietly omits what it cannot show is worse than one that says where the rest is.
 */
export function groupLink(groupId: string): string {
  return `https://vrchat.com/home/group/${encodeURIComponent(groupId)}`;
}

/**
 * True for a VRChat group id, and only for one.
 *
 * The same guard as {@link isUserId} and for the same reason: an id that reached the UI from a bus
 * event or a log line is whatever its payload carried, and anything offering to open a *group* has
 * to check rather than assume.
 */
export function isGroupId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.startsWith("grp_");
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

/**
 * What clicking "join" should actually do.
 *
 * The deep link is only ever right when **no game client is running**. Fire it at a machine that
 * already has VRChat open and Windows starts a *second* client, which then fights the first one
 * over the same account. With a client running, the thing that works is a self-invite: the daemon
 * asks VRChat to send the account an invite, and the running client shows it as a notification the
 * user clicks to travel. That is what VRCX's "Invite Me" does, and it is the only path that moves
 * the client you already have rather than making another one.
 */
export type JoinPlan =
  /** A client is running; invite this account so its client can travel. */
  | { readonly kind: "invite"; readonly accountId: string }
  /** Nothing is running; `vrchat://` is exactly right. */
  | { readonly kind: "launch"; readonly href: string }
  /** A client is already standing in this instance. There is nothing to do. */
  | { readonly kind: "here" }
  /** Clients are running but none of them can be sent. Never silently launch a second one. */
  | { readonly kind: "blocked"; readonly reason: string };

/** The only two fields of a live session the decision depends on. */
type JoinSession = Pick<GameSession, "accountId" | "currentLocation">;

/**
 * Decides between "invite me" and the deep link.
 *
 * `contextAccountId` is the account the location was *seen through* — the friend list's account
 * filter, or a session card's own account. It is preferred when it has a client running, because
 * when two clients are up "which one travels?" has no correct answer the app can infer, and the
 * account that surfaced the location is the one the user was looking at when they clicked.
 *
 * Order matters and each branch earns its place:
 *  1. nothing joinable in the location at all — no affordance.
 *  2. no client running — launch, the one case the deep link is for.
 *  3. every running client is already here — nothing to do (this is the session card's own row).
 *  4. the context account has a client elsewhere — invite it.
 *  5. exactly one other client is linked to a known account — invite that one; it is unambiguous.
 *  6. otherwise refuse and say why. Two linked clients with no hint, or a client signed into an
 *     account vrc.zip does not manage (which has no credentials to invite with) both land here,
 *     and launching a second client would be precisely the bug this function exists to avoid.
 */
export function planJoin(
  location: string | null,
  sessions: readonly JoinSession[],
  contextAccountId: string | null = null,
): JoinPlan | null {
  const href = launchLink(location);
  if (href === null) return null;
  if (sessions.length === 0) return { kind: "launch", href };

  const elsewhere = sessions.filter((session) => session.currentLocation !== location);
  if (elsewhere.length === 0) return { kind: "here" };

  if (
    contextAccountId !== null &&
    elsewhere.some((session) => session.accountId === contextAccountId)
  ) {
    return { kind: "invite", accountId: contextAccountId };
  }

  const linked = elsewhere.filter((session) => session.accountId !== null);
  const only = linked.length === 1 ? linked[0]?.accountId : undefined;
  if (only != null) return { kind: "invite", accountId: only };

  return {
    kind: "blocked",
    reason:
      linked.length === 0
        ? "VRChat is running under an account vrc.zip does not manage, so there is nobody to invite. Add that account, or travel from inside the game."
        : "More than one client is running and none of them belongs to this view, so vrc.zip will not guess which one to move. Use the Live sessions screen.",
  };
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
