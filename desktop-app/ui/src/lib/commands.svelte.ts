/**
 * The command registry.
 *
 * Built in Phase 1 with nothing but built-in commands in it, because retrofitting a registry
 * onto screens that already own their own buttons is far worse than carrying an empty one:
 * every action added between now and plugins would have to be found and rewritten. Plugins in
 * Phase 4 register through exactly this function; so does every screen today.
 *
 * The store is a `SvelteMap`, so the palette re-renders when a screen mounts and contributes
 * commands. (A plain `Map` inside `$state` is not reactive — `$state` proxies plain objects and
 * arrays only.)
 */

import { SvelteMap } from "svelte/reactivity";

export type CommandGroup =
  /** Direct access: an id or a link goes in, the thing it names opens. */
  | "Open"
  | "Navigation"
  | "Accounts"
  | "Sessions"
  | "Friends"
  | "Feed"
  | "Notifications"
  | "App access"
  | "Instant actions"
  | "Data"
  | "Application"
  /**
   * One group **per plugin**, named `"<plugin name> (Plugin)"`.
   *
   * Not one shared "Plugins" group, and the difference matters once more than one is installed: a
   * user hunting for something they added is remembering *which plugin it came with*, and a single
   * bucket makes them read every plugin's commands to find one plugin's. The `(Plugin)` suffix is
   * what keeps the group from being mistaken for a built-in section — everything else in this
   * palette is vrc.zip, and these are somebody else's code.
   *
   * A template literal type rather than `string`, so a typo'd group in *built-in* code is still a
   * compile error while a plugin's name can be anything.
   */
  | `${string} (Plugin)`;

/**
 * A command that needs something typed before it can run.
 *
 * The palette does not run it on Enter; it swaps its input for this one, and only the second Enter
 * runs the command with what was typed. `initial` is what makes the clipboard commands feel like
 * one keystroke rather than three: the prompt opens with the pasted id already in it, so Enter is
 * usually the whole interaction.
 */
export interface CommandArgument {
  readonly placeholder: string;
  /** One line under the input. What a good value looks like. */
  readonly hint?: string;
  /** Prefills the input. Async because the only good source of a prefill is the clipboard. */
  readonly initial?: () => string | Promise<string>;
  /** An error sentence for a value that cannot work, or null. Runs on every keystroke. */
  readonly validate?: (value: string) => string | null;
}

export interface CommandDefinition {
  /** Stable, namespaced, unique: `friends.invite`, `plugin.<id>.<action>`. */
  readonly id: string;
  /** Sentence case, imperative. This is what the palette lists and filters on. */
  readonly title: string;
  readonly group: CommandGroup;
  /** Optional second line in the palette — the argument, target, or a one-line explanation. */
  readonly subtitle?: string;
  /**
   * `"Ctrl+Shift+P"`, `"Ctrl+K"`, `"Alt+1"`. Matched case-insensitively against the physical
   * key. A command with no binding is palette-only.
   */
  readonly keybinding?: string;
  /**
   * Whether the command currently applies. Unavailable commands are shown greyed rather than
   * hidden — a command that vanishes is indistinguishable from one that never existed, and the
   * user has no way to learn why it is not there.
   */
  readonly enabled?: () => boolean;
  /** Extra words to match on that are not in the title (aliases, VRChat jargon). */
  readonly keywords?: readonly string[];
  /** Present when the command needs an argument. Absent for the ordinary act-now command. */
  readonly argument?: CommandArgument;
  /** The argument, or `""` for a command that takes none. Most implementations ignore it. */
  readonly run: (argument: string) => void | Promise<void>;
}

export interface RegisteredCommand extends CommandDefinition {
  /** Monotonic; ties in the palette's ranking break toward the earlier registration. */
  readonly seq: number;
}

const registry = new SvelteMap<string, RegisteredCommand>();
let nextSeq = 0;

/** Registers one command and returns its disposer. Call the disposer in an `$effect` cleanup. */
export function registerCommand(definition: CommandDefinition): () => void {
  if (registry.has(definition.id)) {
    // A duplicate id means two owners think they control the same action; last write wins is a
    // silent bug, so say it out loud and keep the first.
    console.warn(`[commands] duplicate id "${definition.id}" ignored`);
    return () => {};
  }
  nextSeq += 1;
  registry.set(definition.id, { ...definition, seq: nextSeq });
  return () => {
    registry.delete(definition.id);
  };
}

/** Registers a batch and returns a single disposer for all of them. */
export function registerCommands(definitions: readonly CommandDefinition[]): () => void {
  const disposers = definitions.map(registerCommand);
  return () => {
    for (const dispose of disposers) dispose();
  };
}

export function listCommands(): RegisteredCommand[] {
  return [...registry.values()].sort((a, b) => a.seq - b.seq);
}

export function getCommand(id: string): RegisteredCommand | undefined {
  return registry.get(id);
}

export function isCommandEnabled(command: CommandDefinition): boolean {
  return command.enabled === undefined || command.enabled();
}

/**
 * Runs a command object. Disabled commands are a no-op and a throwing one is logged, never
 * propagated — a command is a leaf of the UI, and the palette has already closed by the time it
 * runs, so there is nothing left to catch it.
 */
export async function execute(command: CommandDefinition, argument = ""): Promise<void> {
  if (command.enabled !== undefined && !command.enabled()) return;
  try {
    await command.run(argument);
  } catch (error) {
    console.error(`[commands] "${command.id}" failed`, error);
  }
}

/** Runs a registered command by id. Unknown ids are a no-op, never a throw. */
export async function runCommand(id: string, argument = ""): Promise<void> {
  const command = registry.get(id);
  if (command === undefined) return;
  await execute(command, argument);
}

// ---------------------------------------------------------------------------
// Command sources
// ---------------------------------------------------------------------------

/**
 * Commands that only exist for a particular query.
 *
 * The registry holds what the build can always do. A source answers "what can be done with *this
 * text*" — pasting `wrld_…:12345` into the palette has to offer to open that instance, and there
 * is no way to have registered a command for an id nobody had seen yet. Sources run on every
 * keystroke, so they must be pure and cheap: parse the string, return nothing or a command or two.
 *
 * Their results are never registered, so ids may repeat between keystrokes and nothing has to be
 * torn down. They are ranked above everything in the registry, because a reader who just pasted an
 * id is not looking for a fuzzy title match on it.
 */
export type CommandSource = (query: string) => readonly CommandDefinition[];

const sources = new Set<CommandSource>();

export function registerCommandSource(source: CommandSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

// ---------------------------------------------------------------------------
// Keybindings
// ---------------------------------------------------------------------------

interface ParsedBinding {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly key: string;
}

function parseBinding(binding: string): ParsedBinding {
  const parts = binding.split("+").map((part) => part.trim().toLowerCase());
  return {
    ctrl: parts.includes("ctrl") || parts.includes("cmd") || parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    key: parts.at(-1) ?? "",
  };
}

/**
 * Uses `event.code` rather than `event.key` so bindings survive Shift (which turns `p` into
 * `P`) and non-US layouts where the printed character moves but the physical key does not.
 */
function eventKeyToken(event: KeyboardEvent): string {
  if (event.code.startsWith("Key")) return event.code.slice(3).toLowerCase();
  if (event.code.startsWith("Digit")) return event.code.slice(5);
  return event.key.toLowerCase();
}

/** True when the keystroke belongs to whatever the user is typing into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Finds the command bound to a keystroke, or null. Does not run it. */
export function matchKeybinding(event: KeyboardEvent): RegisteredCommand | null {
  const token = eventKeyToken(event);
  const ctrl = event.ctrlKey || event.metaKey;
  for (const command of registry.values()) {
    if (command.keybinding === undefined) continue;
    const binding = parseBinding(command.keybinding);
    if (
      binding.key === token &&
      binding.ctrl === ctrl &&
      binding.shift === event.shiftKey &&
      binding.alt === event.altKey
    ) {
      return command;
    }
  }
  return null;
}

/** Renders a binding for display: `Ctrl+Shift+P` -> `["Ctrl", "Shift", "P"]`. */
export function formatBinding(binding: string): string[] {
  return binding.split("+").map((part) => {
    const trimmed = part.trim();
    if (trimmed.length === 1) return trimmed.toUpperCase();
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  });
}

// ---------------------------------------------------------------------------
// Palette matching
// ---------------------------------------------------------------------------

export interface CommandMatch {
  readonly command: RegisteredCommand;
  /** Indices into `command.title` that matched, for highlighting. */
  readonly hits: readonly number[];
  readonly score: number;
}

/**
 * Subsequence match with a bonus for consecutive characters and for hits at word boundaries,
 * which is what makes `fs` find "Filter sessions" ahead of "Friends".
 */
function fuzzy(haystack: string, needle: string): { hits: number[]; score: number } | null {
  const hits: number[] = [];
  let score = 0;
  let cursor = 0;
  let streak = 0;
  const lower = haystack.toLowerCase();
  for (const char of needle) {
    const index = lower.indexOf(char, cursor);
    if (index === -1) return null;
    hits.push(index);
    const previous = index === 0 ? " " : (lower[index - 1] ?? " ");
    if (index === 0) score += 8;
    else if (previous === " " || previous === "-" || previous === ".") score += 6;
    streak = index === cursor && cursor !== 0 ? streak + 1 : 0;
    score += streak * 3 + 1;
    cursor = index + 1;
  }
  // Shorter titles that matched are better targets than long ones that happened to contain it.
  score -= Math.floor(haystack.length / 12);
  return { hits, score };
}

/** Above every fuzzy score, so a recognised paste heads the list whatever else matched. */
const SOURCE_SCORE = 10_000;

function sourceMatches(query: string): CommandMatch[] {
  const matches: CommandMatch[] = [];
  let offset = 0;
  for (const source of sources) {
    for (const definition of source(query)) {
      offset += 1;
      matches.push({
        command: { ...definition, seq: -offset },
        hits: [],
        score: SOURCE_SCORE - offset,
      });
    }
  }
  return matches;
}

export function searchCommands(query: string): CommandMatch[] {
  const commands = listCommands();
  const dynamic = sourceMatches(query);
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...dynamic, ...commands.map((command) => ({ command, hits: [], score: 0 }))];
  }
  const matches: CommandMatch[] = [...dynamic];
  for (const command of commands) {
    const direct = fuzzy(command.title, needle);
    if (direct !== null) {
      matches.push({ command, hits: direct.hits, score: direct.score + 20 });
      continue;
    }
    // Group and keywords are searchable but never highlighted, so they rank below title hits.
    const secondary = [command.group, command.subtitle ?? "", ...(command.keywords ?? [])].join(
      " ",
    );
    const indirect = fuzzy(secondary, needle);
    if (indirect !== null) matches.push({ command, hits: [], score: indirect.score });
  }
  return matches.sort((a, b) => b.score - a.score || a.command.seq - b.command.seq);
}
