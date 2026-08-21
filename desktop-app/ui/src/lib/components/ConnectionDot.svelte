<!--
  The account-side twin of `StatusDot`. Kept separate on purpose: an account's *connection* (does
  the daemon hold a live pipeline socket for it?) and a friend's *presence* (is that person in
  VRChat right now?) are different facts, and one shared component would quietly invite screens to
  treat them as the same thing.
-->
<script lang="ts">
import type { AccountConnection } from "$lib/api.ts";
import { connectionLabel } from "$lib/format.ts";
import { cn } from "$lib/utils.js";

let {
  connection,
  size = 8,
  class: className,
}: {
  connection: AccountConnection;
  /** Edge length in px. Pass `null` to size the dot from `class` instead (e.g. `size-full`). */
  size?: number | null;
  class?: string;
} = $props();

const CLASSES: Record<AccountConnection, string> = {
  connected: "bg-status-online",
  connecting: "bg-status-ask-me animate-pulse",
  disconnected: "bg-status-offline",
  "needs-2fa": "bg-status-busy",
};
</script>

<span
  class={cn("inline-block shrink-0 rounded-full", CLASSES[connection], className)}
  style={size === null ? undefined : `width: ${String(size)}px; height: ${String(size)}px`}
  title={connectionLabel(connection)}
  aria-hidden="true"
></span>
