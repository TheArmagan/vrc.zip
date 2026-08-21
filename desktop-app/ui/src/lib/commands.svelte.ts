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
  | "Navigation"
  | "Accounts"
  | "Sessions"
  | "Friends"
  | "Feed"
  | "Instant actions"
  | "Application";

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
  readonly run: () => void | Promise<void>;
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

export function isCommandEnabled(command: RegisteredCommand): boolean {
  return command.enabled === undefined || command.enabled();
}

/** Runs a command by id. Unknown or disabled ids are a no-op, never a throw. */
export async function runCommand(id: string): Promise<void> {
  const command = registry.get(id);
  if (command === undefined || !isCommandEnabled(command)) return;
  try {
    await command.run();
  } catch (error) {
    console.error(`[commands] "${id}" failed`, error);
  }
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

export function searchCommands(query: string): CommandMatch[] {
  const commands = listCommands();
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return commands.map((command) => ({ command, hits: [], score: 0 }));
  }
  const matches: CommandMatch[] = [];
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
