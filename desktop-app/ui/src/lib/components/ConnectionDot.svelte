<!--
  The account-side twin of `StatusDot`. Kept separate on purpose: an account's *connection* (does
  the daemon hold a live pipeline socket for it?) and a friend's *presence* (is that person in
  VRChat right now?) are different facts, and one shared component would quietly invite screens to
  treat them as the same thing.
-->
<script lang="ts">
import type { AccountConnection } from "$lib/api.ts";
import { connectionLabel } from "$lib/format.ts";

let { connection, size = 8 }: { connection: AccountConnection; size?: number } = $props();

const CLASSES: Record<AccountConnection, string> = {
  connected: "bg-status-online",
  connecting: "bg-status-ask-me animate-pulse",
  disconnected: "bg-status-offline",
  "needs-2fa": "bg-status-busy",
};
</script>

<span
  class="inline-block shrink-0 rounded-full {CLASSES[connection]}"
  style="width: {size}px; height: {size}px"
  title={connectionLabel(connection)}
  aria-hidden="true"
></span>
