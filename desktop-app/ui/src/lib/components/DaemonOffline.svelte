<!--
  What the user sees instead of a blank page when nothing useful answers on /api.

  Two different failures land here and they need different words. `unreachable` means no server
  answered at all, which in production almost always means the daemon exited after the page loaded.
  `not-api` means something answered but it was not the control API, which happens when the bundle
  is served from the UI port while the control routes live on another one. Telling a user with the
  second problem to go restart a daemon that is running fine wastes their afternoon.
-->
<script lang="ts">
import { CellularNetworkOfflineIcon, RefreshIcon, Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/svelte";
import { Button } from "$lib/components/ui/button/index.js";

let {
  onRetry,
  retrying = false,
  reason = "unreachable",
}: {
  onRetry: () => void;
  retrying?: boolean;
  reason?: "unreachable" | "not-api";
} = $props();
</script>

<div class="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
  <div class="border border-border bg-muted/40 p-4 text-muted-foreground">
    <HugeiconsIcon
      icon={reason === "not-api" ? Alert02Icon : CellularNetworkOfflineIcon}
      size={26}
    />
  </div>

  <div class="max-w-md space-y-2">
    {#if reason === "not-api"}
      <h1 class="text-base font-semibold">Something answered, but it was not the vrc.zip API.</h1>
      <p class="text-sm text-muted-foreground">
        A request to <code class="bg-muted px-1 font-mono text-xs">/api/status</code> came back as
        the page itself rather than as data. The daemon is running. Its control API is just not
        reachable from the address this window was opened at.
      </p>
    {:else}
      <h1 class="text-base font-semibold">The vrc.zip daemon isn't answering.</h1>
      <p class="text-sm text-muted-foreground">
        This window is still open, but nothing is listening on the local API. The daemon has
        probably exited, or it was restarted and is still coming up.
      </p>
    {/if}
  </div>

  <Button onclick={onRetry} disabled={retrying}>
    <HugeiconsIcon icon={RefreshIcon} size={15} class={retrying ? "animate-spin" : ""} />
    {retrying ? "Reconnecting" : "Try again"}
  </Button>

  <div class="w-full max-w-md border border-border bg-card p-4 text-left">
    {#if reason === "not-api"}
      <p class="mb-2 text-xs font-medium text-muted-foreground">What is going on</p>
      <ol class="space-y-1.5 text-xs text-muted-foreground">
        <li>
          1. The daemon binds three ports. The UI is on 7773 and the control API is on 7775, and a
          browser cannot reach across from one to the other.
        </li>
        <li>
          2. The daemon needs to serve the control routes on the UI port too, so the page can call
          them at its own origin.
        </li>
        <li>
          3. Until then, run the UI with
          <code class="bg-muted px-1 py-0.5 font-mono text-[11px]">bun run dev</code>
          from <code class="bg-muted px-1 py-0.5 font-mono text-[11px]">ui/</code>, which proxies
          /api to the control port.
        </li>
      </ol>
    {:else}
      <p class="mb-2 text-xs font-medium text-muted-foreground">If it doesn't come back</p>
      <ol class="space-y-1.5 text-xs text-muted-foreground">
        <li>1. Check the vrc.zip icon in the system tray. Start it from there if it is gone.</li>
        <li>
          2. From a terminal in the project, run
          <code class="bg-muted px-1 py-0.5 font-mono text-[11px]">bun run daemon</code>.
        </li>
        <li>
          3. Retrying reuses this window's session token. If it keeps failing after the daemon is
          back, relaunch from the tray to get a fresh one.
        </li>
      </ol>
    {/if}
  </div>
</div>
