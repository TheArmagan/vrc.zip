<!--
  Presence is never signalled by colour alone: the dot carries a title and every caller pairs it
  with the status word. Colour-blind users and greyscale screenshots both still read.

  The class names are written out in full rather than composed from the status string — Tailwind
  scans source text for literal class names, so `bg-status-{token}` would never be generated.
-->
<script lang="ts">
import type { FriendStatus } from "$lib/api.ts";
import { statusLabel } from "$lib/format.ts";
import { cn } from "$lib/utils.js";

let {
  status,
  size = 8,
  class: className,
}: {
  status: FriendStatus;
  /** Edge length in px. Pass `null` to size the dot from `class` instead (e.g. `size-full`). */
  size?: number | null;
  class?: string;
} = $props();

const CLASSES: Readonly<Record<string, string>> = {
  active: "bg-status-online",
  "join me": "bg-status-join-me",
  "ask me": "bg-status-ask-me",
  busy: "bg-status-busy",
  offline: "bg-status-offline",
};

const dotClass = $derived(CLASSES[status] ?? "bg-status-offline");
</script>

<span
  class={cn("inline-block shrink-0 rounded-full", dotClass, className)}
  style={size === null ? undefined : `width: ${String(size)}px; height: ${String(size)}px`}
  title={statusLabel(status)}
  aria-hidden="true"
></span>
