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

/** How a session's client is presenting: headset or flatscreen. */
export type VrMode = "vr" | "desktop";

/** A VRChat instance location broken into its parts (`wrld_…:12345~region(us)~group(grp_…)`). */
export interface ParsedLocation {
  /** The full location string exactly as VRChat wrote it. */
  location: string;
  worldId: string;
  /** Instance number, `null` for a bare world id with no instance suffix. */
  instanceId: string | null;
  region: string | null;
  groupId: string | null;
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

export type ParsedEvent =
  | (LineBase & { kind: "world-enter"; worldName: string })
  | (LineBase & { kind: "location-join"; location: ParsedLocation })
  | (LineBase & { kind: "player-join"; displayName: string; userId: string | null })
  | (LineBase & { kind: "player-leave"; displayName: string; userId: string | null })
  | (LineBase & {
      kind: "portal-spawn";
      /** Display name of whoever dropped the portal, when the line carries it. */
      spawnerDisplayName: string | null;
      /** Destination the portal points at, when the line carries it. */
      target: ParsedLocation | null;
      /** The raw object path VRChat instantiated, e.g. `Portals/PortalInternalDynamic`. */
      objectPath: string | null;
    })
  | (LineBase & { kind: "destination-set"; location: ParsedLocation })
  | (LineBase & { kind: "left-room" })
  | (LineBase & { kind: "join-failed"; reason: string })
  | (LineBase & { kind: "screenshot"; path: string })
  | (LineBase & { kind: "app-quit" })
  | (LineBase & { kind: "vr-mode"; vrMode: VrMode })
  | (LineBase & { kind: "authenticated"; displayName: string; userId: string })
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

function readTaggedValue(location: string, tag: string): string | null {
  const start = location.indexOf(tag);
  if (start === -1) return null;
  const from = start + tag.length;
  const close = location.indexOf(")", from);
  if (close === -1) return null;
  const value = location.slice(from, close);
  return value.length > 0 ? value : null;
}

/** Breaks `wrld_…:12345~region(us)~group(grp_…)` into parts. Returns `null` for a non-location. */
export function parseLocation(raw: string): ParsedLocation | null {
  const location = raw.trim();
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

  return {
    location,
    worldId,
    instanceId,
    region: readTaggedValue(location, "~region("),
    groupId: readTaggedValue(location, "~group("),
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

  return { spawnerDisplayName, target, objectPath };
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
    return { ...base, kind: "player-join", displayName, userId };
  }

  if (body.startsWith(MARKER_PLAYER_LEFT)) {
    const { displayName, userId } = splitUser(body.slice(MARKER_PLAYER_LEFT.length));
    if (displayName.length === 0) return unmatched(at, line);
    return { ...base, kind: "player-leave", displayName, userId };
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

  if (body.startsWith(MARKER_LEFT_ROOM)) {
    return { ...base, kind: "left-room" };
  }

  if (body.startsWith(MARKER_INSTANTIATED_CLONE)) {
    return { ...base, kind: "portal-spawn", ...parsePortal(body) };
  }

  if (body.startsWith(MARKER_JOIN_FAILED)) {
    const reason = body.slice(MARKER_JOIN_FAILED.length).trimEnd();
    if (reason.length === 0) return unmatched(at, line);
    return { ...base, kind: "join-failed", reason };
  }

  if (body.startsWith(MARKER_SCREENSHOT)) {
    const path = body.slice(MARKER_SCREENSHOT.length).trimEnd();
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

  // These two carry a `[Behaviour]` tag in some builds and none in others, so they are matched
  // anywhere in the body rather than at offset 0.
  if (body.includes(MARKER_VRSDK)) return { ...base, kind: "vr-mode", vrMode: "vr" };
  if (body.includes(MARKER_VR_DISABLED)) return { ...base, kind: "vr-mode", vrMode: "desktop" };

  return unmatched(at, line);
}
