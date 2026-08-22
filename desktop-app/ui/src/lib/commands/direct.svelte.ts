/**
 * Direct access: an id or a link goes in, the thing it names opens.
 *
 * Everything else in the app is a path — a friend row to a profile, a feed row to a world, a badge
 * to a group. That works until the id arrives from outside vrc.zip: a link in Discord, a
 * `vrchat://` copied out of the game, a `usr_…` quoted in a bug report. Before this, the only way
 * in was to find something that happened to mention it. Now there is a front door.
 *
 * **The clipboard is the primary path**, and that shapes this whole file. An id that reached you as
 * text is already selected and already copied, so the fastest correct gesture is one keystroke that
 * reads it, recognises it, and opens it. Ctrl+Shift+V is that keystroke. The typed prompts
 * underneath it are for when the clipboard holds something else, and they prefill from it anyway.
 *
 * Two things worth knowing about reading the clipboard from a page:
 *
 *  - It needs a secure context and a user gesture. `127.0.0.1` is secure and a keystroke is a
 *    gesture, so both hold here — but Chrome may still put a permission prompt in front of the
 *    first read, and a browser is always free to refuse. A refusal is reported rather than
 *    swallowed: a command that appears to do nothing is indistinguishable from a broken one.
 *  - What comes back is arbitrary text, not an id. `parseTarget` recognises rather than guesses, so
 *    "the clipboard holds no id" is an ordinary answer with a sentence of its own.
 */

import {
  type CommandDefinition,
  registerCommandSource,
  registerCommands,
} from "../commands.svelte.ts";
import { planJoin } from "../format.ts";
import { requestJoin } from "../join.ts";
import { navigate } from "../router.ts";
import { app } from "../state/app.svelte.ts";
import { groupModal } from "../state/group-modal.svelte.ts";
import { userModal } from "../state/user-modal.svelte.ts";
import { worldModal } from "../state/world-modal.svelte.ts";
import type { CommandHost } from "./host.ts";
import {
  type DirectTarget,
  describeTarget,
  parseTarget,
  type TargetKind,
  unsupportedReason,
} from "./targets.ts";

/** The nouns used in every prompt and every refusal. One spelling per kind. */
const KIND_LABELS: Record<TargetKind, string> = {
  user: "user",
  world: "world",
  instance: "instance",
  group: "group",
  avatar: "avatar",
  file: "file",
};

/** English, so a refusal reads as a sentence rather than as a template. */
function article(kind: TargetKind): string {
  return kind === "instance" || kind === "avatar" ? "an" : "a";
}

/**
 * Opens a target this build has somewhere to put.
 *
 * The three modals are singletons over the *set* and share one back stack, so this is a plain call
 * rather than any kind of routing — see `state/entity-modal.svelte.ts`. An instance opens the world
 * modal with the location attached, because "that instance" is a world plus a room, and that modal
 * is already the screen that knows how to say both.
 */
function openSupported(entry: DirectTarget): void {
  switch (entry.kind) {
    case "user":
      userModal.openUser(entry.id);
      return;
    case "world":
      worldModal.openWorld(entry.id);
      return;
    case "instance":
      worldModal.openWorld(entry.id, { location: entry.location });
      return;
    case "group":
      groupModal.openGroup(entry.id);
      return;
    default:
      // Unreachable: every caller checks `unsupportedReason` first. Kept because the kind union
      // will grow before the daemon grows the endpoints behind it.
      return;
  }
}

/** Opens a target, or says why this build cannot. */
function openTarget(entry: DirectTarget, host: CommandHost): void {
  const refusal = unsupportedReason(entry);
  if (refusal !== null) {
    host.notify("warning", `vrc.zip cannot open ${KIND_LABELS[entry.kind]}s`, refusal);
    return;
  }
  openSupported(entry);
}

/** The clipboard as text, or null once the user has been told why there is none. */
async function readClipboard(host: CommandHost): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    host.notify(
      "error",
      "vrc.zip could not read the clipboard",
      'The browser refused clipboard access to the page. Run one of the "Open a … by id" commands and paste into its prompt instead.',
    );
    return null;
  }
}

/** What the clipboard holds, when it is worth prefilling a prompt of this kind with. */
async function clipboardPrefill(kind: TargetKind | null): Promise<string> {
  try {
    const entry = parseTarget(await navigator.clipboard.readText());
    if (entry === null) return "";
    if (kind !== null && entry.kind !== kind) return "";
    return entry.location ?? entry.id;
  } catch {
    // No toast here: a prefill that could not happen is not an error, it is an empty box. The
    // clipboard command above is the one that has to explain itself, because it has nothing else
    // to do.
    return "";
  }
}

/**
 * Reads an argument typed under a heading that names one kind.
 *
 * The heading is evidence. "Open a user by id" plus a bare word is a user id typed by somebody who
 * knew what they were typing — VRChat's oldest accounts genuinely have no `usr_` prefix — so it is
 * taken at its word, and the daemon's 404 is the answer if it was wrong. What is *not* accepted is
 * an id that is unmistakably something else: "open this world as a user" has no reading.
 *
 * Returns the target, or the sentence explaining why there is none.
 */
function forcedTarget(value: string, kind: TargetKind): DirectTarget | string {
  const trimmed = value.trim();
  if (trimmed === "") return `Paste or type ${article(kind)} ${KIND_LABELS[kind]} id.`;

  const parsed = parseTarget(trimmed);
  if (parsed !== null) {
    if (parsed.kind === kind) return parsed;
    // A location under a "world" heading is not a mismatch, it is a location with a world in it.
    if (kind === "world" && parsed.kind === "instance") {
      return { kind: "world", id: parsed.id, location: null, supported: true };
    }
    return `That is ${article(parsed.kind)} ${KIND_LABELS[parsed.kind]} id, not ${article(kind)} ${KIND_LABELS[kind]} one.`;
  }

  if (/\s/.test(trimmed) || trimmed.includes("://")) {
    return `vrc.zip does not recognise that as ${article(kind)} ${KIND_LABELS[kind]} id or link.`;
  }
  if (kind === "instance") {
    return "An instance is a whole location: a world id, a colon, and the instance id — wrld_…:12345~region(eu).";
  }
  return { kind, id: trimmed, location: null, supported: true };
}

/** The `validate` half of `forcedTarget`, for the palette's live error line. */
function validator(kind: TargetKind): (value: string) => string | null {
  return (value) => {
    if (value.trim() === "") return null;
    const result = forcedTarget(value, kind);
    return typeof result === "string" ? result : null;
  };
}

interface PromptSpec {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly placeholder: string;
  readonly hint: string;
  readonly keywords: readonly string[];
  readonly open: (entry: DirectTarget) => void;
}

/** One "Open a … by id" prompt. Six of them differ only in the noun and where they land. */
function promptCommand(kind: TargetKind, spec: PromptSpec, host: CommandHost): CommandDefinition {
  return {
    id: spec.id,
    title: spec.title,
    subtitle: spec.subtitle,
    group: "Open",
    keywords: [...spec.keywords, "id", "paste", "link", "url", "open"],
    argument: {
      placeholder: spec.placeholder,
      hint: spec.hint,
      initial: () => clipboardPrefill(kind),
      validate: validator(kind),
    },
    run: (argument): void => {
      const result = forcedTarget(argument, kind);
      if (typeof result === "string") {
        host.notify("warning", `That is not ${article(kind)} ${KIND_LABELS[kind]} id`, result);
        return;
      }
      spec.open(result);
    },
  };
}

/**
 * Commands that exist only because of what is in the palette's own search box.
 *
 * This is the other half of the clipboard story — the half for a reader who already has the palette
 * open — and it needs no permission prompt at all, because the paste is the user's own keystroke.
 * A recognised id ranks above every registry command: somebody who just pasted `wrld_…` is not
 * searching for a title that happens to contain those letters.
 */
function directSource(query: string): CommandDefinition[] {
  const entry = parseTarget(query);
  if (entry === null) return [];

  const refusal = unsupportedReason(entry);
  if (refusal !== null) {
    // Listed and disabled rather than absent. A pasted avatar id that matches nothing at all looks
    // like the palette failed to read it; this says which of the two happened.
    return [
      {
        id: `open.pasted.${entry.kind}`,
        title: `vrc.zip cannot open ${KIND_LABELS[entry.kind]}s`,
        subtitle: refusal,
        group: "Open",
        enabled: (): boolean => false,
        run: (): void => {},
      },
    ];
  }

  const commands: CommandDefinition[] = [
    {
      id: `open.pasted.${entry.kind}`,
      title: describeTarget(entry),
      subtitle:
        entry.kind === "instance"
          ? "The world, with this instance's live occupancy"
          : "Recognised from what you pasted",
      group: "Open",
      run: (): void => {
        openSupported(entry);
      },
    },
  ];

  if (entry.kind === "instance") {
    // "What is this place" and "who is in this room right now" are different questions, and a
    // reader who pasted a location may have meant either.
    commands.push({
      id: "open.pasted.instance-world",
      title: `Open the world ${entry.id}`,
      subtitle: "The world record on its own, without this instance",
      group: "Open",
      run: (): void => {
        worldModal.openWorld(entry.id);
      },
    });
    commands.push({
      id: "open.pasted.join",
      title: "Bring a running client to this instance",
      subtitle: "Invites the client that is running to the location you pasted",
      group: "Open",
      // The same rule as every other join affordance: never launch a second client, and never
      // offer to travel to where a client is already standing. See `planJoin`.
      enabled: (): boolean => {
        const plan = planJoin(entry.location, app.sessions);
        return plan !== null && plan.kind !== "here";
      },
      run: (): void => {
        void requestJoin(entry.location);
      },
    });
  }

  if (entry.kind === "group") {
    commands.push({
      id: "open.pasted.group-screen",
      title: `Open the full group screen for ${entry.id}`,
      subtitle: "Members, posts, galleries and instances, on their own screen",
      group: "Open",
      run: (): void => {
        navigate("groups", entry.id);
      },
    });
  }

  return commands;
}

export function registerDirectCommands(host: CommandHost): () => void {
  const disposeSource = registerCommandSource(directSource);

  const disposeCommands = registerCommands([
    {
      id: "open.clipboard",
      title: "Open what is on the clipboard",
      subtitle: "A user, world, instance or group id, or a vrchat.com or vrchat:// link",
      group: "Open",
      keybinding: "Ctrl+Shift+V",
      keywords: ["paste", "clipboard", "id", "link", "url", "jump", "go to"],
      run: async (): Promise<void> => {
        const text = await readClipboard(host);
        if (text === null) return;
        const entry = parseTarget(text);
        if (entry === null) {
          host.notify(
            "info",
            "Nothing on the clipboard to open",
            "vrc.zip looked for a usr_, wrld_, grp_ or avtr_ id, a wrld_…:12345 location, or a vrchat.com or vrchat:// link, and found none.",
          );
          return;
        }
        openTarget(entry, host);
      },
    },

    promptCommand(
      "user",
      {
        id: "open.user",
        title: "Open a user by id",
        subtitle: "Their profile, groups, mutual friends and local history, from an id alone",
        placeholder: "usr_… or https://vrchat.com/home/user/usr_…",
        hint: "Prefilled from the clipboard when it holds a user id.",
        keywords: ["profile", "person", "friend", "usr"],
        open: (entry) => {
          userModal.openUser(entry.id);
        },
      },
      host,
    ),
    promptCommand(
      "world",
      {
        id: "open.world",
        title: "Open a world by id",
        subtitle: "The world record, its author, and its live instances",
        placeholder: "wrld_… or https://vrchat.com/home/world/wrld_…",
        hint: "A full location works too; its world half is what opens.",
        keywords: ["map", "place", "wrld"],
        open: (entry) => {
          worldModal.openWorld(entry.id);
        },
      },
      host,
    ),
    promptCommand(
      "instance",
      {
        id: "open.instance",
        title: "Open an instance by location",
        subtitle: "Occupancy, access type, region, and whether it is still open",
        placeholder: "wrld_…:12345~region(eu) or a vrchat:// launch link",
        hint: "The whole location: world id and instance id together.",
        keywords: ["room", "location", "join", "occupancy"],
        open: (entry) => {
          worldModal.openWorld(entry.id, { location: entry.location });
        },
      },
      host,
    ),
    promptCommand(
      "group",
      {
        id: "open.group",
        title: "Open a group by id",
        subtitle: "The group card, as a badge or a profile would open it",
        placeholder: "grp_… or https://vrchat.com/home/group/grp_…",
        hint: "For members, posts and instances, use the full group screen command.",
        keywords: ["grp", "community"],
        open: (entry) => {
          groupModal.openGroup(entry.id);
        },
      },
      host,
    ),
    promptCommand(
      "group",
      {
        id: "open.group-screen",
        title: "Open a group's full screen by id",
        subtitle: "Members, posts, galleries and instances — four paged lists, not a dialog",
        placeholder: "grp_… or a vrchat.com group link",
        hint: "The route a group card's full-screen control lands on.",
        keywords: ["grp", "members", "posts", "gallery"],
        open: (entry) => {
          navigate("groups", entry.id);
        },
      },
      host,
    ),

    {
      id: "open.anything",
      title: "Open any id or link",
      subtitle: "What it names — user, world, instance or group — decides where it opens",
      group: "Open",
      keywords: ["paste", "id", "link", "url", "anything", "go to"],
      argument: {
        placeholder: "usr_…, wrld_…, grp_…, a location, or a link",
        hint: "Prefilled from the clipboard when it holds something openable.",
        initial: () => clipboardPrefill(null),
        validate: (value) =>
          value.trim() === "" || parseTarget(value) !== null
            ? null
            : "vrc.zip does not recognise an id or a link in that.",
      },
      run: (argument): void => {
        const entry = parseTarget(argument);
        if (entry === null) {
          host.notify(
            "warning",
            "Nothing recognisable in that",
            "vrc.zip opens a usr_, wrld_ or grp_ id, a wrld_…:12345 location, or a vrchat.com or vrchat:// link.",
          );
          return;
        }
        openTarget(entry, host);
      },
    },

    /*
     * A game session is vrc.zip's own id rather than VRChat's, so it is not something `parseTarget`
     * could ever recognise out of a paste — but it is the id in every game-log URL, and the one
     * thing a reader copies out of this app to send to somebody else. It belongs on the same shelf.
     */
    {
      id: "open.session",
      title: "Open a game session by id",
      subtitle: "The parsed log for one VRChat client run",
      group: "Open",
      keywords: ["log", "gamelog", "session", "client"],
      argument: {
        placeholder: "The session id from a game log URL",
        hint: "vrc.zip's own id for one client run, not a VRChat id.",
      },
      run: (argument): void => {
        const id = argument.trim();
        if (id === "") return;
        navigate("gamelog", id);
      },
    },
  ]);

  return () => {
    disposeSource();
    disposeCommands();
  };
}
