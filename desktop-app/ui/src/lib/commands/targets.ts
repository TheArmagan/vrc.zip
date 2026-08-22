/**
 * What a pasted string points at.
 *
 * Everything vrc.zip can open has an id, and every id travels as text: a friend sends a
 * `https://vrchat.com/home/world/wrld_…` link in Discord, the game's own "copy link" writes a
 * `vrchat://launch?id=wrld_…:12345` into the clipboard, a log line carries a bare `usr_…`, and a
 * support thread quotes a group's `grp_…`. All of those are the same gesture — *open this* — and
 * the palette is where the app answers it, so the recognising is written down once, here, pure and
 * testable, with no idea that a modal or a route exists.
 *
 * Two rules keep this honest:
 *
 *  - **It recognises, it does not guess.** An id prefix is the only evidence accepted. VRChat's
 *    legacy user ids have no prefix at all, so a bare word could be a user id, and offering to open
 *    every word anybody pastes would make the palette answer "open user 'hello'" to a search.
 *  - **Recognised is not the same as supported.** A file id is unmistakably a file id and vrc.zip
 *    has no screen for one. Saying "that is a file, and this build cannot open one" is a real
 *    answer; silently matching nothing is not. Avatars used to be in this bucket and are not any
 *    more — the avatar modal is where an `avtr_…` goes now.
 */

/** The kinds of thing an id can name. Only the last parses and has nowhere to go. */
export type TargetKind = "user" | "world" | "instance" | "group" | "avatar" | "file";

export interface DirectTarget {
  readonly kind: TargetKind;
  /** The entity id. For an instance this is the world half of the location. */
  readonly id: string;
  /** The full `wrld_…:12345~region(eu)` location. Only ever set for `kind: "instance"`. */
  readonly location: string | null;
  /** Whether this build has somewhere to put it. False for files. */
  readonly supported: boolean;
}

/** Prefix to kind, in the order they are tested. `usr_` and `wrld_` cannot collide, so order is cosmetic. */
const PREFIXES: ReadonlyArray<readonly [string, TargetKind]> = [
  ["usr_", "user"],
  ["wrld_", "world"],
  ["grp_", "group"],
  ["avtr_", "avatar"],
  ["file_", "file"],
];

const SUPPORTED: ReadonlySet<TargetKind> = new Set<TargetKind>([
  "user",
  "world",
  "instance",
  "group",
  "avatar",
]);

function target(kind: TargetKind, id: string, location: string | null = null): DirectTarget {
  return { kind, id, location, supported: SUPPORTED.has(kind) };
}

/**
 * Strips what a copy usually brings along with the id.
 *
 * Chat clients wrap links in `<>` to suppress an embed, quoting adds `"`, and a double-click on a
 * URL in a code block picks up a trailing `)` or `.`. None of that is part of the id, and a paste
 * that fails because of a stray angle bracket looks like the feature is broken.
 */
function clean(input: string): string {
  let value = input.trim().replace(/^[<"'([]+/, "");
  /*
   * Trailing punctuation comes off one character at a time, and a closing bracket only when the
   * string holds more of them than it opened. `wrld_…:12345~region(eu)` ends in a parenthesis that
   * is *part of the location*, and a blanket strip would quietly turn a joinable instance into a
   * broken one; `(wrld_…~region(eu))` still loses only its wrapper.
   */
  for (;;) {
    const last = value.at(-1);
    if (last === undefined) break;
    const quoteOrStop =
      last === '"' || last === "'" || last === ">" || last === "," || last === ".";
    const unopened =
      (last === ")" && count(value, ")") > count(value, "(")) ||
      (last === "]" && count(value, "]") > count(value, "["));
    if (!quoteOrStop && !unopened) break;
    value = value.slice(0, -1);
  }
  return value;
}

function count(value: string, character: string): number {
  let total = 0;
  for (const char of value) if (char === character) total += 1;
  return total;
}

/** True once the string carries an instance half — `wrld_…:12345`, tags and all. */
function isLocation(value: string): boolean {
  const [head = "", rest = ""] = value.split(":", 2);
  return head.startsWith("wrld_") && rest !== "";
}

/**
 * The URL forms VRChat itself hands out.
 *
 * `/home/launch` is the odd one: the world and the instance travel as separate query parameters
 * and have to be rejoined into the colon form the rest of the app speaks. `vrchat://launch` already
 * carries the joined location in `id`, which is why it is read straight through.
 */
function fromUrl(raw: string): DirectTarget | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol === "vrchat:") {
    const id = url.searchParams.get("id");
    if (id === null) return null;
    return fromText(id);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== "vrchat.com" && url.hostname !== "www.vrchat.com") return null;

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  // `/home/launch?worldId=…&instanceId=…` — the link the website's "invite" copy button writes.
  if (segments.at(-1) === "launch") {
    const worldId = url.searchParams.get("worldId");
    if (worldId === null || !worldId.startsWith("wrld_")) return null;
    const instanceId = url.searchParams.get("instanceId");
    return instanceId === null || instanceId === ""
      ? target("world", worldId)
      : target("instance", worldId, `${worldId}:${instanceId}`);
  }

  // `/home/user/usr_…`, `/home/world/wrld_…/info`, `/home/group/grp_…/members`: the id is the
  // segment after the noun, and anything after it is a tab this app does not have.
  for (const [index, segment] of segments.entries()) {
    const found = fromText(segments[index + 1] ?? "");
    if (found !== null && (segment === "user" || segment === "world" || segment === "group")) {
      return found;
    }
    if (segment === "avatar") {
      const id = segments[index + 1];
      if (id !== undefined && id !== "") return target("avatar", id);
    }
  }
  return null;
}

/** The bare forms: a location, or an id with a prefix this app knows. */
function fromText(value: string): DirectTarget | null {
  if (isLocation(value)) {
    const worldId = value.split(":", 1)[0] ?? "";
    return target("instance", worldId, value);
  }
  for (const [prefix, kind] of PREFIXES) {
    if (value.startsWith(prefix) && value.length > prefix.length) return target(kind, value);
  }
  return null;
}

/**
 * What this text names, or null when it names nothing this app recognises.
 *
 * Multi-line input is read line by line and the first recognised line wins, because a copy out of
 * a log, a chat message or a JSON blob is usually a paragraph with one id in it.
 */
export function parseTarget(input: string): DirectTarget | null {
  if (input === "") return null;
  for (const line of input.split(/[\s\n]+/)) {
    const value = clean(line);
    if (value === "") continue;
    const found = value.includes("://") ? fromUrl(value) : fromText(value);
    if (found !== null) return found;
  }
  return null;
}

const KIND_NOUNS: Record<TargetKind, string> = {
  user: "profile",
  world: "world",
  instance: "instance",
  group: "group",
  avatar: "avatar",
  file: "file",
};

/** `Open the profile usr_c1ab…` — the palette's line for a target it recognised. */
export function describeTarget(entry: DirectTarget): string {
  return `Open the ${KIND_NOUNS[entry.kind]} ${entry.location ?? entry.id}`;
}

/** Why a recognised target cannot be opened, or null when it can. */
export function unsupportedReason(entry: DirectTarget): string | null {
  if (entry.supported) return null;
  return "That is a file id. vrc.zip reads files through the records that reference them, never on their own.";
}
