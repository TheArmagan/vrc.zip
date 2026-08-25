/**
 * VRChat `output_log_*.txt` line parser.
 *
 * Deliberately substring-driven (`startsWith` / `includes` + offset slicing) rather than
 * regex-driven: a running client writes tens of thousands of lines an hour and only a handful of
 * markers matter, so the hot path must be a few character comparisons and a slice. The line header
 * is validated first — that alone rejects the continuation lines of multi-line stack traces — and
 * only then is the body routed against the marker table. Regex appears exactly once, on the
 * `User Authenticated:` line where capture groups are genuinely needed, and a substring check gates
 * it so it never touches the other 99.9% of lines.
 *
 * Nothing here throws. An unrecognised or malformed line degrades to `{ kind: "unknown" }`.
 */

import { gamePath } from "../paths.ts";

/** How a session's client is presenting: headset or flatscreen. */
export type VrMode = "vr" | "desktop";

/**
 * Who can get into an instance, derived from its `~tag(value)` segments.
 *
 * `unknown` is not a failure mode with one exception: the offline Error World (`local:error_…`)
 * genuinely has no access model, because there is no instance and nobody else can be in it.
 */
export type InstanceAccess =
  | "public"
  | "friends-plus"
  | "friends"
  | "invite"
  | "invite-plus"
  | "group-public"
  | "group-plus"
  | "group-members"
  | "unknown";

/** A VRChat instance location broken into its parts (`wrld_…:12345~region(us)~group(grp_…)`). */
export interface ParsedLocation {
  /** The full location string exactly as VRChat wrote it. */
  location: string;
  worldId: string;
  /** Instance number, `null` for a bare world id with no instance suffix. */
  instanceId: string | null;
  region: string | null;
  groupId: string | null;
  /**
   * Derived from the owner tag plus the two overrides that are applied after it, so tag order does
   * not change the answer. See PARSER-PATTERNS.md §8.
   */
  access: InstanceAccess;
  /**
   * Whoever the instance belongs to: a `usr_…` for the private/friends family, a `grp_…` for the
   * group family, `null` for a public instance which belongs to nobody.
   */
  ownerId: string | null;
  ageGated: boolean;
  /**
   * `local:error_…`, the offline world the client drops you into when a join fails. A real visit,
   * often a long one, so it parses rather than being refused — reporting it as "no instance" made
   * whole sessions look like they went nowhere.
   */
  offline: boolean;
}

interface LineBase {
  /**
   * Unix ms. VRChat writes log timestamps in the machine's LOCAL time with no zone marker, so they
   * are parsed as local time — the resulting number is a true absolute instant, but only because
   * the daemon runs on the same machine as the client that wrote the line.
   */
  at: number;
  /** The log level token from the header (`Log`, `Warning`, `Error`, …). */
  level: string;
  /** The bracketed component tag (`Behaviour`, `VRC Camera`, …), or `null` when absent. */
  component: string | null;
}

/**
 * A display name as the log carried it, plus the same name with VRChat's lookalike-Unicode
 * substitutions undone.
 *
 * Both, not one. `displayName` is what the client wrote and is the only form that will ever match a
 * raw line again; `displayNameClean` is the form a person can type on a keyboard, which is what
 * search and a graph's "only this person" comparison need. Collapsing them would either make names
 * unsearchable or make the stored value disagree with the file it came from.
 */
interface NamePair {
  displayName: string;
  displayNameClean: string;
}

/** What a downloaded thing was. Taken from the component tag, per PARSER-PATTERNS.md §7. */
export type DownloadKind = "string" | "image" | "asset";

/** Which audio device moved. */
export type DeviceKind = "microphone" | "audio";

export type ParsedEvent =
  | (LineBase & { kind: "world-enter"; worldName: string })
  | (LineBase & { kind: "location-join"; location: ParsedLocation })
  | (LineBase & { kind: "instance-ready" })
  | (LineBase & NamePair & { kind: "player-join"; userId: string | null })
  | (LineBase & NamePair & { kind: "player-leave"; userId: string | null })
  | (LineBase & {
      kind: "portal-spawn";
      /** Display name of whoever dropped the portal, when the line carries it. */
      spawnerDisplayName: string | null;
      spawnerDisplayNameClean: string | null;
      /** Destination the portal points at, when the line carries it. */
      target: ParsedLocation | null;
      /** The raw object path VRChat instantiated, e.g. `Portals/PortalInternalDynamic`. */
      objectPath: string | null;
    })
  | (LineBase & { kind: "destination-set"; location: ParsedLocation })
  | (LineBase & {
      kind: "left-room";
      /**
       * VRChat's disconnect reason, from `OnDisconnected:`. `null` on the ordinary `OnLeftRoom`
       * line, which is a deliberate leave and has no reason to give.
       */
      reason: string | null;
    })
  | (LineBase & { kind: "join-failed"; reason: string })
  | (LineBase & { kind: "screenshot"; path: string })
  | (LineBase & { kind: "app-quit" })
  | (LineBase & { kind: "vr-mode"; vrMode: VrMode })
  | (LineBase & { kind: "authenticated"; displayName: string; userId: string })
  | (LineBase &
      NamePair & {
        kind: "avatar-change";
        /** `null` on `Loading avatar for …`, which names the wearer but not the avatar. */
        avatarName: string | null;
      })
  | (LineBase & {
      kind: "video-play";
      /** The URL the world asked for. */
      url: string;
      /** What the player resolved it to, when the line carried a `' resolved to '` pair. */
      resolvedUrl: string | null;
    })
  | (LineBase & {
      kind: "download";
      downloadKind: DownloadKind;
      url: string | null;
      failed: boolean;
    })
  | (LineBase &
      NamePair & {
        kind: "sticker-spawn";
        userId: string | null;
        /** The `file_…` the sticker came from. */
        contentId: string | null;
      })
  | (LineBase &
      NamePair & {
        kind: "prop-spawn";
        userId: string | null;
        contentId: string | null;
        /**
         * `prop` or `item`, taken from the id prefix rather than the client's wording — newer
         * builds log `[VRCItems] Item` where older ones logged `[VRCProps] Prop`, and tallying one
         * feature under two names would split every count in half across a real archive.
         */
        spawnKind: "prop" | "item";
      })
  | (LineBase & { kind: "device-change"; deviceKind: DeviceKind; device: string })
  | (LineBase & { kind: "osc-ready"; port: number })
  | (LineBase & {
      kind: "environment";
      /** The `key: value` lines of the block, keys kept verbatim as VRChat writes them. */
      info: Readonly<Record<string, string>>;
    })
  | (LineBase & {
      kind: "api-failure";
      /** `null` when the line reported a failure by wording rather than by status code. */
      status: number | null;
      method: string | null;
      /** Ids replaced with `:id`, query and fragment dropped. See PARSER-PATTERNS.md §7. */
      endpoint: string | null;
      /** The tail after ` - `, when there is one. */
      reason: string | null;
    })
  | (LineBase & {
      kind: "notification";
      notificationType: string | null;
      fromUserId: string | null;
      fromDisplayName: string | null;
      fromDisplayNameClean: string | null;
      message: string | null;
    })
  | (LineBase & { kind: "friend-updated"; userId: string | null })
  | {
      kind: "unknown";
      /** `null` when the line had no valid header at all (continuation lines, blank lines). */
      at: number | null;
      reason: "no-header" | "unmatched";
      raw: string;
    };

/** Every `kind` except `"unknown"` — what consumers downstream of the watcher actually handle. */
export type KnownEvent = Exclude<ParsedEvent, { kind: "unknown" }>;

/** `yyyy.MM.dd HH:mm:ss` — a fixed 19 characters. */
const TIMESTAMP_LENGTH = 19;
/** VRChat pads the level token and separates it from the body with `" -  "`. */
const HEADER_SEPARATOR = " -  ";
/** The level token is short; refuse to scan an unbounded distance for the separator. */
const MAX_LEVEL_WIDTH = 32;

const MARKER_ENTERING_ROOM = "[Behaviour] Entering Room: ";
const MARKER_JOINING = "[Behaviour] Joining ";
const MARKER_JOINING_OR_CREATING = "[Behaviour] Joining or Creating Room: ";
const MARKER_PLAYER_JOINED = "[Behaviour] OnPlayerJoined ";
const MARKER_PLAYER_LEFT = "[Behaviour] OnPlayerLeft ";
const MARKER_INSTANTIATED_CLONE = "[Behaviour] Instantiated a (Clone [";
const MARKER_DESTINATION_FETCHING = "[Behaviour] Destination fetching: ";
const MARKER_LEFT_ROOM = "[Behaviour] OnLeftRoom";
const MARKER_JOIN_FAILED = "[Behaviour] Failed to join instance ";
const MARKER_SCREENSHOT = "[VRC Camera] Took screenshot to: ";
const MARKER_QUIT = "VRCApplication: OnApplicationQuit at ";
const MARKER_QUIT_HANDLE = "VRCApplication: HandleApplicationQuit at ";
const MARKER_QUIT_HANDLE_BARE = "HandleApplicationQuit at ";
const MARKER_VRSDK = "Initializing VRSDK.";
const MARKER_VR_DISABLED = "VR Disabled";
const MARKER_AUTHENTICATED = "User Authenticated: ";

/**
 * `OnLeftRoom` is a deliberate leave; `OnDisconnected` is the network dropping you and carries a
 * reason; `OnPlayerLeftRoom` is the same departure reported from the other side. All three mean the
 * instance ended, so they are one kind with a nullable reason rather than three kinds a graph
 * author would have to wire up separately to cover "I am no longer in an instance".
 *
 * The `OnPlayerLeft` prefix already in use keeps its trailing space for the opposite reason: without
 * it, `OnPlayerLeftRoom` would parse as a player departure with a display name of `Room`.
 */
const MARKER_DISCONNECTED = "[Behaviour] OnDisconnected";
const MARKER_PLAYER_LEFT_ROOM = "[Behaviour] OnPlayerLeftRoom";

const MARKER_INSTANCE_READY_FINISHED = "[Behaviour] Finished entering world";
const MARKER_INSTANCE_READY_JOINED = "[Behaviour] Successfully joined room";

const MARKER_SWITCHING = "[Behaviour] Switching ";
const MARKER_LOADING_AVATAR = "[Behaviour] Loading avatar for ";
const AVATAR_SWITCH_SEPARATOR = " to avatar ";

const MARKER_MIC_CHANGE = "[Behaviour] Microphone device changing to ";
const MARKER_AUDIO_CHANGE = "[Behaviour] Audio device changing to ";

const MARKER_ENVIRONMENT_INFO = "[UserInfoLogger] Environment Info";

const MARKER_STICKER_SPAWN = "[StickersManager] User ";
const STICKER_SPAWNED = " spawned ";
const MARKER_PROP_SPAWN = "[VRCProps] Prop ";
const MARKER_ITEM_SPAWN = "[VRCItems] Item ";
const PROP_SPAWNED_BY = " spawned by ";

const MARKER_NOTIFICATION = "Received Notification: ";
const MARKER_FRIEND_UPDATED = "FriendUpdated: ";

const MARKER_OSC_ADVERTISE = "Advertising Service";
const OSC_TYPE_SEGMENT = " of type OSC on ";
const MARKER_OSC_DIRECT = "OSC::";

/** Component tags whose lines are a video player talking. */
const VIDEO_TAGS: ReadonlySet<string> = new Set(["Video Playback", "AVProVideo", "VVMW"]);
const RESOLVED_TO = "' resolved to '";

/** Component tag to download kind. Everything else bracketed under a download tag is an asset. */
const DOWNLOAD_TAGS: Readonly<Record<string, DownloadKind>> = {
  "String Download": "string",
  "Image Download": "image",
  AssetBundleDownloadManager: "asset",
  TextureManagement: "image",
};

const API_TAG = "API";
const API_BASE = "https://api.vrchat.cloud/api/1/";
/** Id prefixes collapsed to `:id` so `users/usr_a` and `users/usr_b` are one endpoint, hit twice. */
const ID_PREFIXES = ["usr_", "wrld_", "avtr_", "grp_", "file_", "prop_", "invt_", "prod_"];

/** The one place capture groups are worth a regex. Gated by a `startsWith` on the marker. */
const AUTHENTICATED_RE = /^User Authenticated: (.+?) \((usr_[0-9a-f-]+)\)/;

const USER_ID_SUFFIX = " (usr_";

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function readInt(line: string, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) {
    const code = line.charCodeAt(i);
    if (!isDigit(code)) return Number.NaN;
    value = value * 10 + (code - 48);
  }
  return value;
}

/**
 * Validates and decodes `yyyy.MM.dd HH:mm:ss` at offset 0. Returns unix ms, or `null` if the line
 * does not open with a well-formed header timestamp.
 *
 * The components are fed to the local-time `Date` constructor on purpose: VRChat writes local wall
 * time with no offset, so interpreting it as UTC would shift every event by the machine's offset.
 */
function parseTimestamp(line: string): number | null {
  if (line.length < TIMESTAMP_LENGTH) return null;
  if (line[4] !== "." || line[7] !== "." || line[10] !== " ") return null;
  if (line[13] !== ":" || line[16] !== ":") return null;

  const year = readInt(line, 0, 4);
  const month = readInt(line, 5, 7);
  const day = readInt(line, 8, 10);
  const hour = readInt(line, 11, 13);
  const minute = readInt(line, 14, 16);
  const second = readInt(line, 17, 19);
  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    Number.isNaN(second)
  ) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;

  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

export interface LineHeader {
  at: number;
  level: string;
  /** Everything after `" -  "`, including any leading `[Component]` tag. */
  body: string;
}

/**
 * Splits a line into header and body without allocating beyond two slices. Exported for tests and
 * for any caller that wants the cheap "is this even a log line" pre-check.
 */
export function parseHeader(line: string): LineHeader | null {
  const at = parseTimestamp(line);
  if (at === null) return null;
  if (line[TIMESTAMP_LENGTH] !== " ") return null;

  const searchLimit = TIMESTAMP_LENGTH + 1 + MAX_LEVEL_WIDTH;
  const separator = line.indexOf(HEADER_SEPARATOR, TIMESTAMP_LENGTH);
  if (separator === -1 || separator > searchLimit) return null;

  const level = line.slice(TIMESTAMP_LENGTH + 1, separator).trim();
  if (level.length === 0) return null;
  for (let i = 0; i < level.length; i++) {
    const code = level.charCodeAt(i);
    const isAlpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (!isAlpha) return null;
  }

  return { at, level, body: line.slice(separator + HEADER_SEPARATOR.length) };
}

/** Reads the leading `[Component]` tag off a body, if there is one. */
function readComponent(body: string): string | null {
  if (body.charCodeAt(0) !== 91 /* [ */) return null;
  const close = body.indexOf("] ");
  if (close === -1) return null;
  return body.slice(1, close);
}

/**
 * Splits `Display Name (usr_…)` from the end. Parsed right-to-left because display names may
 * themselves contain parentheses, and because VRChat has shipped this line both with and without
 * the trailing user id — both shapes must parse.
 */
function splitUser(rest: string): { displayName: string; userId: string | null } {
  if (rest.endsWith(")")) {
    const marker = rest.lastIndexOf(USER_ID_SUFFIX);
    if (marker !== -1) {
      const userId = rest.slice(marker + 2, rest.length - 1);
      return { displayName: rest.slice(0, marker), userId };
    }
  }
  return { displayName: rest.trimEnd(), userId: null };
}

/**
 * VRChat substitutes lookalike Unicode for the handful of characters that would otherwise break its
 * own log format, so a person called `A.B & C` is written `A․B ＆ C`. Mapping them back is what
 * makes a name findable by typing it.
 *
 * Table-driven and applied only when a substitution is actually present: the scan is a single pass
 * that exits on the first line with none, which is virtually every line.
 */
const SANITIZED: Readonly<Record<string, string>> = {
  "․": ".",
  "‚": ",",
  "＆": "&",
  ǃ: "!",
  "＃": "#",
  "／": "/",
  "：": ":",
};

const SANITIZED_KEYS = Object.keys(SANITIZED);

/** Undoes {@link SANITIZED}. Returns the input unchanged when there is nothing to undo. */
export function desanitizeName(value: string): string {
  let out = value;
  for (const key of SANITIZED_KEYS) {
    if (!out.includes(key)) continue;
    // `SANITIZED[key]` is present by construction — the keys came from the table itself.
    out = out.replaceAll(key, SANITIZED[key] ?? key);
  }
  return out;
}

/**
 * Strips Unity rich-text tags, depth-counted.
 *
 * World scripts colour their own log tags, so `[<color=#B5438F>Billiards</color>]` and `[Billiards]`
 * arrive as two different strings for one world. Returns the input itself when there is no `<`,
 * which is the common case and costs one `indexOf`.
 */
export function stripRichText(value: string): string {
  if (!value.includes("<")) return value;
  let out = "";
  let depth = 0;
  for (const char of value) {
    if (char === "<") {
      depth++;
      continue;
    }
    if (char === ">") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
}

/** Pairs a raw display name with its de-sanitized form. */
function namePair(displayName: string): NamePair {
  return { displayName, displayNameClean: desanitizeName(displayName) };
}

/**
 * Lifts the value out of the first `'…'` pair. Download and video lines quote their URL.
 *
 * Returns `null` rather than an empty string when there is no pair, so a caller can tell "no URL on
 * this line" from "an empty URL", which are different lines.
 */
function quoted(body: string): string | null {
  const open = body.indexOf("'");
  if (open === -1) return null;
  const close = body.indexOf("'", open + 1);
  if (close === -1 || close === open + 1) return null;
  return body.slice(open + 1, close);
}

function readTaggedValue(location: string, tag: string): string | null {
  const start = location.indexOf(tag);
  if (start === -1) return null;
  const from = start + tag.length;
  const close = location.indexOf(")", from);
  if (close === -1) return null;
  const value = location.slice(from, close);
  return value.length > 0 ? value : null;
}

/** The offline Error World prefix. Not a `wrld_`, but a real place the client puts you. */
const OFFLINE_PREFIX = "local:";

/**
 * Reads the access model off the `~tag(value)` segments.
 *
 * The owner tag decides the base answer; `groupAccessType` and `canRequestInvite` are applied
 * afterwards, deliberately outside the loop, so a line that writes them before their owner tag
 * lands on the same answer as one that writes them after. Doing it inline made the result depend on
 * VRChat's field order, which is not a thing it promises.
 */
function readAccess(location: string): {
  access: InstanceAccess;
  ownerId: string | null;
  ageGated: boolean;
} {
  const hidden = readTaggedValue(location, "~hidden(");
  const friends = readTaggedValue(location, "~friends(");
  const priv = readTaggedValue(location, "~private(");
  const group = readTaggedValue(location, "~group(");

  let access: InstanceAccess = "public";
  let ownerId: string | null = null;
  if (hidden !== null) {
    access = "friends-plus";
    ownerId = hidden;
  } else if (friends !== null) {
    access = "friends";
    ownerId = friends;
  } else if (priv !== null) {
    access = "invite";
    ownerId = priv;
  } else if (group !== null) {
    access = "group-public";
    ownerId = group;
  }

  const groupAccess = readTaggedValue(location, "~groupAccessType(");
  if (access === "group-public" && groupAccess !== null) {
    if (groupAccess === "plus") access = "group-plus";
    else if (groupAccess === "members") access = "group-members";
  }
  // An invite instance whose owner allowed requests is Invite+. Only ever an upgrade from invite:
  // the flag appears on nothing else, and reading it as one would silently relabel group instances.
  if (access === "invite" && location.includes("~canRequestInvite")) access = "invite-plus";

  return { access, ownerId, ageGated: location.includes("~ageGate") };
}

/**
 * Breaks `wrld_…:12345~region(us)~group(grp_…)` into parts. Returns `null` for a non-location.
 *
 * `local:error_…` parses too, as an offline visit with no access model. It is the world a failed
 * join drops you into, people sit in it for a long time, and refusing it reported those sessions as
 * having visited nowhere at all.
 */
export function parseLocation(raw: string): ParsedLocation | null {
  const location = raw.trim();

  if (location.startsWith(OFFLINE_PREFIX)) {
    if (location.length <= OFFLINE_PREFIX.length) return null;
    return {
      location,
      // There is no `wrld_` here and no instance suffix to split off: the whole token *is* the
      // identity of the offline world, so it goes in whole rather than being cut at the colon.
      worldId: location,
      instanceId: null,
      region: null,
      groupId: null,
      access: "unknown",
      ownerId: null,
      ageGated: false,
      offline: true,
    };
  }

  if (!location.startsWith("wrld_")) return null;

  const colon = location.indexOf(":");
  const worldId = colon === -1 ? location : location.slice(0, colon);
  if (worldId.length <= "wrld_".length) return null;

  let instanceId: string | null = null;
  if (colon !== -1) {
    const tilde = location.indexOf("~", colon + 1);
    const value = tilde === -1 ? location.slice(colon + 1) : location.slice(colon + 1, tilde);
    instanceId = value.length > 0 ? value : null;
  }

  const { access, ownerId, ageGated } = readAccess(location);
  return {
    location,
    worldId,
    instanceId,
    region: readTaggedValue(location, "~region("),
    groupId: readTaggedValue(location, "~group("),
    access,
    ownerId,
    ageGated,
    offline: false,
  };
}

const PORTAL_OBJECT_SEPARATOR = ") for ";
const PORTAL_CREATED_BY = " created by ";

/**
 * Portal drops are logged as an instantiation of `Portals/PortalInternalDynamic`. Some builds put
 * the destination and the spawner on that same line; others emit them on a neighbouring line. Only
 * what this line actually carries is reported — the rest stays `null` rather than being guessed.
 */
function parsePortal(body: string): {
  spawnerDisplayName: string | null;
  spawnerDisplayNameClean: string | null;
  target: ParsedLocation | null;
  objectPath: string | null;
} {
  let objectPath: string | null = null;
  const forIndex = body.indexOf(PORTAL_OBJECT_SEPARATOR);
  if (forIndex !== -1) {
    const value = body.slice(forIndex + PORTAL_OBJECT_SEPARATOR.length).trimEnd();
    objectPath = value.length > 0 ? value : null;
  }

  let spawnerDisplayName: string | null = null;
  const byIndex = body.indexOf(PORTAL_CREATED_BY);
  if (byIndex !== -1) {
    const value = body.slice(byIndex + PORTAL_CREATED_BY.length).trimEnd();
    spawnerDisplayName = value.length > 0 ? value : null;
  }

  let target: ParsedLocation | null = null;
  const worldIndex = body.indexOf("wrld_");
  if (worldIndex !== -1) {
    const end = byIndex > worldIndex ? byIndex : body.length;
    target = parseLocation(body.slice(worldIndex, end));
  }

  return {
    spawnerDisplayName,
    spawnerDisplayNameClean:
      spawnerDisplayName === null ? null : desanitizeName(spawnerDisplayName),
    target,
    objectPath,
  };
}

/**
 * Splits `usr_… (Display Name)` — id first, name second.
 *
 * The inverse of {@link splitUser}, and it has to be its own function rather than a flag on that
 * one: sticker and prop lines invert the join line's order, so reusing the join parser here swapped
 * the two fields and filed every sticker under a user id that read as a display name.
 */
function splitIdThenName(rest: string): { userId: string | null; displayName: string } {
  const open = rest.indexOf(" (");
  if (open === -1) return { userId: rest.trim() === "" ? null : rest.trim(), displayName: "" };
  const close = rest.indexOf(")", open + 2);
  const userId = rest.slice(0, open).trim();
  const displayName = close === -1 ? rest.slice(open + 2) : rest.slice(open + 2, close);
  return { userId: userId === "" ? null : userId, displayName };
}

/** Reads the value between `key` and the next `,`. Notification lines are comma-delimited. */
function readUntilComma(body: string, key: string): string | null {
  const start = body.indexOf(key);
  if (start === -1) return null;
  const from = start + key.length;
  const comma = body.indexOf(",", from);
  const value = (comma === -1 ? body.slice(from) : body.slice(from, comma)).trim();
  return value === "" ? null : value;
}

/**
 * The same read, cut at the first space as well as the first comma.
 *
 * For the id fields only. VRChat does not delimit a notification line consistently: `of type:` is
 * followed by a comma, but `sender user id:` is followed by ` of type:` with no comma between them,
 * so a comma-only read swallowed the next field and produced an id ending in ` of type:friendRequest`.
 * An id has no spaces in it, which makes the first space the honest terminator.
 */
function readToken(body: string, key: string): string | null {
  const value = readUntilComma(body, key);
  if (value === null) return null;
  const space = value.indexOf(" ");
  const token = space === -1 ? value : value.slice(0, space);
  return token === "" ? null : token;
}

/**
 * Normalizes an API url for grouping: drops the base, cuts query and fragment, and replaces every
 * id-shaped path segment with `:id`.
 *
 * Without this, a failure list is a few hundred unique rows each with a count of one, which answers
 * nothing. The untouched url is still reachable through the event's raw line.
 */
export function normalizeEndpoint(url: string): string {
  let path = url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url;
  const cut = Math.min(
    path.includes("?") ? path.indexOf("?") : path.length,
    path.includes("#") ? path.indexOf("#") : path.length,
  );
  path = path.slice(0, cut);
  return path
    .split("/")
    .map((segment) => (ID_PREFIXES.some((prefix) => segment.startsWith(prefix)) ? ":id" : segment))
    .join("/");
}

const API_FAILURE_PREFIXES = ["Abandoning request", "Request Finished with Error"];

/**
 * Reads an `[API]` line, returning `null` for the ordinary traffic that is not a failure.
 *
 * Only the bracketed form carries a status, and the wording check runs alongside it rather than
 * instead of it: a malformed bracket must not be able to quietly demote a failure to normal
 * traffic. Model-decode complaints (`TryWriteConvert:` and friends) are *not* failures — the
 * request succeeded and the client could not map part of the reply — so they are dropped here.
 */
function parseApiFailure(body: string): {
  status: number | null;
  method: string | null;
  endpoint: string | null;
  reason: string | null;
} | null {
  const rest = body.slice(body.indexOf("] ") + 2);

  if (
    rest.startsWith("TryWriteConvert:") ||
    rest.startsWith("An error occurred filling the model") ||
    rest.includes("ould not write")
  ) {
    return null;
  }

  let status: number | null = null;
  let method: string | null = null;
  let endpoint: string | null = null;

  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close !== -1) {
      // `[requestId, status, method, url]` — four comma-separated fields, in that order.
      const fields = rest
        .slice(1, close)
        .split(",")
        .map((field) => field.trim());
      const parsed = Number.parseInt(fields[1] ?? "", 10);
      if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) status = parsed;
      method = fields[2] ?? null;
      const url = fields[3];
      if (url !== undefined && url !== "") endpoint = normalizeEndpoint(url);
    }
  }

  const byWording = API_FAILURE_PREFIXES.some((prefix) => rest.startsWith(prefix));
  const byStatus = status !== null && status >= 400;
  if (!byWording && !byStatus) return null;

  const dash = rest.lastIndexOf(" - ");
  const reason = dash === -1 ? null : rest.slice(dash + 3).trimEnd() || null;
  return { status, method, endpoint, reason };
}

/** Pulls the first run of 4-5 digits out of a body. Used for the OSC port fallback. */
function firstPort(body: string): number | null {
  let run = "";
  for (const char of body) {
    if (char >= "0" && char <= "9") {
      run += char;
      continue;
    }
    if (run.length >= 4 && run.length <= 5) break;
    run = "";
  }
  if (run.length < 4 || run.length > 5) return null;
  const port = Number.parseInt(run, 10);
  return port > 0 && port <= 65535 ? port : null;
}

function unmatched(at: number, raw: string): ParsedEvent {
  return { kind: "unknown", at, reason: "unmatched", raw };
}

/**
 * Parses one log line. Never throws; anything unrecognised comes back as `kind: "unknown"` so a
 * VRChat format change degrades to lost detail rather than a dead watcher.
 */
export function parseLine(line: string): ParsedEvent {
  const header = parseHeader(line);
  if (header === null) return { kind: "unknown", at: null, reason: "no-header", raw: line };

  const { at, level, body } = header;
  const base = { at, level, component: readComponent(body) } as const;

  // Ordered roughly by how often each marker actually appears in a live log.
  if (body.startsWith(MARKER_PLAYER_JOINED)) {
    const { displayName, userId } = splitUser(body.slice(MARKER_PLAYER_JOINED.length));
    if (displayName.length === 0) return unmatched(at, line);
    return { ...base, kind: "player-join", ...namePair(displayName), userId };
  }

  if (body.startsWith(MARKER_PLAYER_LEFT)) {
    const { displayName, userId } = splitUser(body.slice(MARKER_PLAYER_LEFT.length));
    if (displayName.length === 0) return unmatched(at, line);
    return { ...base, kind: "player-leave", ...namePair(displayName), userId };
  }

  // The avatar pipeline is the single largest source of `[Behaviour]` lines, so these two sit high
  // in the order even though only a fraction of them carry an avatar name.
  if (body.startsWith(MARKER_SWITCHING)) {
    const rest = body.slice(MARKER_SWITCHING.length);
    const separator = rest.indexOf(AVATAR_SWITCH_SEPARATOR);
    if (separator === -1) return unmatched(at, line);
    const displayName = rest.slice(0, separator).trimEnd();
    const avatarName = rest.slice(separator + AVATAR_SWITCH_SEPARATOR.length).trimEnd();
    if (displayName.length === 0) return unmatched(at, line);
    return {
      ...base,
      kind: "avatar-change",
      ...namePair(displayName),
      avatarName: avatarName.length === 0 ? null : avatarName,
    };
  }

  if (body.startsWith(MARKER_LOADING_AVATAR)) {
    const displayName = body.slice(MARKER_LOADING_AVATAR.length).trimEnd();
    if (displayName.length === 0) return unmatched(at, line);
    // This line names the wearer and never the avatar. An unset field, not a guessed one.
    return { ...base, kind: "avatar-change", ...namePair(displayName), avatarName: null };
  }

  if (body.startsWith(MARKER_JOINING)) {
    // `Joining or Creating Room: <world name>` shares the prefix but carries a world name, not a
    // location; `Entering Room:` already covers it, and it must not be read as a location.
    if (body.startsWith(MARKER_JOINING_OR_CREATING)) return unmatched(at, line);
    const location = parseLocation(body.slice(MARKER_JOINING.length));
    if (location === null) return unmatched(at, line);
    return { ...base, kind: "location-join", location };
  }

  if (body.startsWith(MARKER_ENTERING_ROOM)) {
    const worldName = body.slice(MARKER_ENTERING_ROOM.length).trimEnd();
    if (worldName.length === 0) return unmatched(at, line);
    return { ...base, kind: "world-enter", worldName };
  }

  if (body.startsWith(MARKER_DESTINATION_FETCHING)) {
    const location = parseLocation(body.slice(MARKER_DESTINATION_FETCHING.length));
    if (location === null) return unmatched(at, line);
    return { ...base, kind: "destination-set", location };
  }

  if (
    body.startsWith(MARKER_INSTANCE_READY_FINISHED) ||
    body.startsWith(MARKER_INSTANCE_READY_JOINED)
  ) {
    return { ...base, kind: "instance-ready" };
  }

  if (body.startsWith(MARKER_LEFT_ROOM) || body.startsWith(MARKER_PLAYER_LEFT_ROOM)) {
    return { ...base, kind: "left-room", reason: null };
  }

  if (body.startsWith(MARKER_DISCONNECTED)) {
    // `OnDisconnected: <reason>` in some builds, a bare `OnDisconnected` in others.
    const tail = body.slice(MARKER_DISCONNECTED.length);
    const rest = (tail.startsWith(":") ? tail.slice(1) : tail).trim();
    return { ...base, kind: "left-room", reason: rest.length === 0 ? null : rest };
  }

  if (body.startsWith(MARKER_INSTANTIATED_CLONE) || base.component === "PortalManager") {
    return { ...base, kind: "portal-spawn", ...parsePortal(body) };
  }

  if (body.startsWith(MARKER_MIC_CHANGE) || body.startsWith(MARKER_AUDIO_CHANGE)) {
    const microphone = body.startsWith(MARKER_MIC_CHANGE);
    const marker = microphone ? MARKER_MIC_CHANGE : MARKER_AUDIO_CHANGE;
    const device = body.slice(marker.length).trimEnd();
    if (device.length === 0) return unmatched(at, line);
    // An event rather than a static setting: people swap headsets and interfaces mid-session, and
    // the last value is not the only interesting one. Deduping the repeats VRChat writes on every
    // device refresh is the session tracker's job, not the parser's.
    return {
      ...base,
      kind: "device-change",
      deviceKind: microphone ? "microphone" : "audio",
      device,
    };
  }

  if (body.startsWith(MARKER_STICKER_SPAWN)) {
    const rest = body.slice(MARKER_STICKER_SPAWN.length);
    const spawned = rest.indexOf(STICKER_SPAWNED);
    if (spawned === -1) return unmatched(at, line);
    const { userId, displayName } = splitIdThenName(rest.slice(0, spawned));
    const contentId = rest.slice(spawned + STICKER_SPAWNED.length).trimEnd();
    return {
      ...base,
      kind: "sticker-spawn",
      ...namePair(displayName),
      userId,
      contentId: contentId === "" ? null : contentId,
    };
  }

  if (body.startsWith(MARKER_PROP_SPAWN) || body.startsWith(MARKER_ITEM_SPAWN)) {
    const marker = body.startsWith(MARKER_PROP_SPAWN) ? MARKER_PROP_SPAWN : MARKER_ITEM_SPAWN;
    const rest = body.slice(marker.length);
    const by = rest.indexOf(PROP_SPAWNED_BY);
    const contentId = (by === -1 ? rest : rest.slice(0, by)).trim();
    const { userId, displayName } =
      by === -1
        ? { userId: null, displayName: "" }
        : splitIdThenName(rest.slice(by + PROP_SPAWNED_BY.length));
    return {
      ...base,
      kind: "prop-spawn",
      ...namePair(displayName),
      userId,
      contentId: contentId === "" ? null : contentId,
      // From the identifier, not the wording. `[VRCItems] Item` and `[VRCProps] Prop` are the same
      // feature renamed, and a real archive spans the rename.
      spawnKind: contentId.startsWith("prop_") ? "prop" : "item",
    };
  }

  if (body.startsWith(MARKER_NOTIFICATION)) {
    const rest = body.slice(MARKER_NOTIFICATION.length);
    const fromDisplayName = readUntilComma(rest, "from username:");
    let message: string | null = null;
    const messageStart = rest.indexOf('message: "');
    if (messageStart !== -1) {
      const from = messageStart + 'message: "'.length;
      const close = rest.indexOf('"', from);
      const raw = close === -1 ? rest.slice(from) : rest.slice(from, close);
      // De-sanitized because a notification message routinely embeds a display name, which carries
      // the same lookalike substitutions the name itself does.
      message = raw === "" ? null : desanitizeName(raw);
    }
    return {
      ...base,
      kind: "notification",
      notificationType: readToken(rest, "of type:"),
      fromUserId: readToken(rest, "sender user id:"),
      fromDisplayName,
      fromDisplayNameClean: fromDisplayName === null ? null : desanitizeName(fromDisplayName),
      message,
    };
  }

  if (body.startsWith(MARKER_FRIEND_UPDATED)) {
    const rest = body.slice(MARKER_FRIEND_UPDATED.length).trim();
    const marker = rest.indexOf("usr_");
    if (marker === -1) return { ...base, kind: "friend-updated", userId: null };
    let end = marker;
    while (end < rest.length && rest[end] !== " " && rest[end] !== ")" && rest[end] !== ",") end++;
    return { ...base, kind: "friend-updated", userId: rest.slice(marker, end) };
  }

  if (body.startsWith(MARKER_JOIN_FAILED)) {
    const reason = body.slice(MARKER_JOIN_FAILED.length).trimEnd();
    if (reason.length === 0) return unmatched(at, line);
    return { ...base, kind: "join-failed", reason };
  }

  if (body.startsWith(MARKER_SCREENSHOT)) {
    // Normalised here rather than downstream: this is the only place the raw line exists, and the
    // string goes straight into the event payload, the feed row and the `on-screenshot` graph
    // node's `path` output. See `gamePath` for why it is not `nativePath`.
    const path = gamePath(body.slice(MARKER_SCREENSHOT.length));
    if (path.length === 0) return unmatched(at, line);
    return { ...base, kind: "screenshot", path };
  }

  if (body.startsWith(MARKER_AUTHENTICATED)) {
    // The substring check above is the gate; the regex only ever runs on this one line per session.
    const match = AUTHENTICATED_RE.exec(body);
    const displayName = match?.[1];
    const userId = match?.[2];
    if (displayName === undefined || userId === undefined) return unmatched(at, line);
    return { ...base, kind: "authenticated", displayName, userId };
  }

  if (
    body.startsWith(MARKER_QUIT) ||
    body.startsWith(MARKER_QUIT_HANDLE) ||
    body.startsWith(MARKER_QUIT_HANDLE_BARE)
  ) {
    return { ...base, kind: "app-quit" };
  }

  // -- tag-driven, below the `[Behaviour]` prefixes because they are rarer per line -------------

  if (base.component !== null && VIDEO_TAGS.has(base.component)) {
    const resolved = body.indexOf(RESOLVED_TO);
    if (resolved !== -1) {
      // Split on the whole separator rather than hunting a quote pair. The separator *consumes* the
      // source URL's closing quote, so pair-scanning here silently dropped every resolved URL.
      const url = quoted(body.slice(0, resolved + 1));
      const tail = body.slice(resolved + RESOLVED_TO.length);
      const close = tail.indexOf("'");
      const resolvedUrl = (close === -1 ? tail : tail.slice(0, close)).trim();
      if (url !== null) {
        return {
          ...base,
          kind: "video-play",
          url,
          resolvedUrl: resolvedUrl === "" ? null : resolvedUrl,
        };
      }
    }
    const url = quoted(body);
    if (url !== null) return { ...base, kind: "video-play", url, resolvedUrl: null };
    return unmatched(at, line);
  }

  if (base.component !== null && base.component in DOWNLOAD_TAGS) {
    // Everything a download tag writes that is not a start, a resolution or an error is queue
    // noise, and there is a great deal of it. Dropping it here keeps the bus quiet.
    const failed = body.includes("ERROR") || body.includes("Error") || body.includes("failed");
    const interesting =
      failed ||
      body.includes("Attempting") ||
      body.includes("Starting download") ||
      body.includes("resolved to");
    if (!interesting) return unmatched(at, line);
    return {
      ...base,
      kind: "download",
      downloadKind: DOWNLOAD_TAGS[base.component] ?? "asset",
      url: quoted(body),
      failed,
    };
  }

  if (base.component === API_TAG) {
    const failure = parseApiFailure(body);
    return failure === null ? unmatched(at, line) : { ...base, kind: "api-failure", ...failure };
  }

  if (body.startsWith(MARKER_OSC_ADVERTISE)) {
    // The type must match exactly. OSCQuery is advertised first and on a *random* high port, so
    // taking the last number off whichever line came first recorded the wrong port every time.
    const segment = body.indexOf(OSC_TYPE_SEGMENT);
    if (segment === -1) return unmatched(at, line);
    const tail = body.slice(segment + OSC_TYPE_SEGMENT.length).trim();
    const port = Number.parseInt(tail, 10);
    if (!Number.isInteger(port) || String(port) !== tail) return unmatched(at, line);
    return { ...base, kind: "osc-ready", port };
  }

  if (body.startsWith(MARKER_OSC_DIRECT)) {
    const port = firstPort(body);
    return port === null ? unmatched(at, line) : { ...base, kind: "osc-ready", port };
  }

  // These two carry a `[Behaviour]` tag in some builds and none in others, so they are matched
  // anywhere in the body rather than at offset 0.
  if (body.includes(MARKER_VRSDK)) return { ...base, kind: "vr-mode", vrMode: "vr" };
  if (body.includes(MARKER_VR_DISABLED)) return { ...base, kind: "vr-mode", vrMode: "desktop" };

  return unmatched(at, line);
}

/* ---------------------------------------------------------------------------------------------- */
/* Continuation buffering                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The `[UserInfoLogger] Environment Info` keys worth keeping.
 *
 * An allow-list rather than the whole block: VRChat writes a couple of dozen keys there, most of
 * them internal counters that change every session, and storing all of them would put a wall of
 * noise on a session row for the ten facts anybody reads.
 */
const ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "VRChat Build",
  "Unity Version",
  "Platform",
  "Store",
  "Device Model",
  "Processor Type",
  "Graphics Device Name",
  "System Memory Size",
  "Operating System",
  "XR Device",
]);

const BOM = "\uFEFF";

/**
 * A stateful wrapper over {@link parseLine} that understands multi-line entries.
 *
 * VRChat writes some entries across several lines — the `Environment Info` block is a header
 * followed by a run of `key: value` lines, and a stack trace is a header followed by frames. A line
 * with no valid header is a *continuation* of the entry above it, never an entry of its own; that
 * is what the header check has always rejected, and rejecting it is right for a stack trace and
 * wrong for the environment block.
 *
 * **A completed entry is emitted on its own header line, not on the next one.** Buffering every
 * entry until the following line arrived would have been simpler and is unusable live: a quiet
 * instance would hold a `player-join` unemitted until somebody else moved. Only a line that
 * actually opens a block delays anything, and the block closes on the very next header line.
 */
export class LogScanner {
  #block: { at: number; level: string; info: Record<string, string> } | null = null;
  #atStart = true;

  /**
   * Feeds one line. Returns the events it completed — usually one, occasionally two when the line
   * both closed an open block and was itself an event, and none for a continuation line.
   */
  push(line: string): ParsedEvent[] {
    let text = line;
    if (this.#atStart) {
      // Stripped once, on the first line of the file. A BOM in front of the timestamp fails the
      // shape gate and would make the entire log unparseable.
      if (text.startsWith(BOM)) text = text.slice(BOM.length);
      this.#atStart = false;
    }

    const header = parseHeader(text);
    if (header === null) {
      this.#collect(text);
      return [];
    }

    const events: ParsedEvent[] = [];
    const closed = this.#close();
    if (closed !== null) events.push(closed);

    if (header.body.startsWith(MARKER_ENVIRONMENT_INFO)) {
      this.#block = { at: header.at, level: header.level, info: {} };
      return events;
    }

    events.push(parseLine(text));
    return events;
  }

  /**
   * Closes whatever is still open. Call at end of file: a log that ends inside the environment
   * block still has a perfectly good block, and dropping it would lose the whole thing for any
   * session whose client is still running.
   */
  flush(): ParsedEvent[] {
    const closed = this.#close();
    return closed === null ? [] : [closed];
  }

  #collect(line: string): void {
    const block = this.#block;
    if (block === null) return;
    const colon = line.indexOf(":");
    if (colon === -1) return;
    const key = line.slice(0, colon).trim();
    if (!ENVIRONMENT_KEYS.has(key)) return;
    const value = line.slice(colon + 1).trim();
    if (value !== "") block.info[key] = value;
  }

  #close(): ParsedEvent | null {
    const block = this.#block;
    this.#block = null;
    if (block === null || Object.keys(block.info).length === 0) return null;
    return {
      at: block.at,
      level: block.level,
      component: "UserInfoLogger",
      kind: "environment",
      info: block.info,
    };
  }
}
