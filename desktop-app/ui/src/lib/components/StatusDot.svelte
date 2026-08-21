<!--
  Presence is never signalled by colour alone: the dot carries a title and every caller pairs it
  with the status word. Colour-blind users and greyscale screenshots both still read.

  The class names are written out in full rather than composed from the status string — Tailwind
  scans source text for literal class names, so `bg-{token}` would simply never be generated.
-->
<script lang="ts">
import type { FriendStatus } from "$lib/api.ts";
import { statusLabel } from "$lib/format.ts";

let { status, size = 8 }: { status: FriendStatus; size?: number } = $props();

const CLASSES: Record<FriendStatus, string> = {
  active: "bg-status-online",
  "join me": "bg-status-join-me",
  "ask me": "bg-status-ask-me",
  busy: "bg-status-busy",
  offline: "bg-status-offline",
};

const dotClass = $derived(CLASSES[status] ?? "bg-status-offline");
</script>

<span
  class="inline-block shrink-0 rounded-full {dotClass}"
  style="width: {size}px; height: {size}px"
  title={statusLabel(status)}
  aria-hidden="true"
></span>
