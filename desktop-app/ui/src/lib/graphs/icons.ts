/**
 * The icon for a node, resolved from the name `visuals.ts` hands back.
 *
 * Separate from `visuals.ts` because that module is plain data and unit-testable without a
 * renderer, and this one imports eleven Svelte components. Keeping the split means a test can
 * assert that a `Stored data` node is an archive without mounting anything.
 *
 * Every icon is imported statically rather than resolved dynamically: Vite can only see through a
 * literal import, and a dynamic one would ship the whole of Lucide to a user who has nine node
 * categories on screen.
 */

import ArchiveIcon from "@lucide/svelte/icons/archive";
import CircleDotIcon from "@lucide/svelte/icons/circle-dot";
import DatabaseIcon from "@lucide/svelte/icons/database";
import GlobeIcon from "@lucide/svelte/icons/globe";
import HashIcon from "@lucide/svelte/icons/hash";
import LayersIcon from "@lucide/svelte/icons/layers";
import ListIcon from "@lucide/svelte/icons/list";
import PuzzleIcon from "@lucide/svelte/icons/puzzle";
import RepeatIcon from "@lucide/svelte/icons/repeat";
import SendIcon from "@lucide/svelte/icons/send";
import SplitIcon from "@lucide/svelte/icons/split";
import ZapIcon from "@lucide/svelte/icons/zap";
import type { Component } from "svelte";
import { iconNameFor } from "./visuals.ts";

const ICONS: Record<string, Component> = {
  archive: ArchiveIcon,
  database: DatabaseIcon,
  globe: GlobeIcon,
  hash: HashIcon,
  layers: LayersIcon,
  list: ListIcon,
  puzzle: PuzzleIcon,
  repeat: RepeatIcon,
  send: SendIcon,
  split: SplitIcon,
  zap: ZapIcon,
};

/** The icon component for a node's category and owner. Never null — unknown falls to a dot. */
export function iconFor(category: string | undefined, owner: string): Component {
  return ICONS[iconNameFor(category, owner)] ?? CircleDotIcon;
}
