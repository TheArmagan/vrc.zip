<!--
  What the user sees instead of a blank page when nothing useful answers on /api.

  Two different failures land here and they need different words. `unreachable` means no server
  answered at all, which in production almost always means the daemon exited after the page loaded.
  `not-api` means something answered but it was not the control API, which happens when the bundle
  is served from the UI port while the control routes live on another one. Telling a user with the
  second problem to go restart a daemon that is running fine wastes their afternoon.
-->
<script lang="ts">
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import WifiOffIcon from "@lucide/svelte/icons/wifi-off";
import { Button } from "$lib/components/ui/button/index.js";
import * as Card from "$lib/components/ui/card/index.js";

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

<div class="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
  <div class="flex size-14 items-center justify-center border border-border bg-muted/40">
    {#if reason === "not-api"}
      <TriangleAlertIcon class="size-6 text-muted-foreground" />
    {:else}
      <WifiOffIcon class="size-6 text-muted-foreground" />
    {/if}
  </div>

  <div class="max-w-md space-y-2">
    {#if reason === "not-api"}
      <h1 class="text-lg font-semibold">Something answered, but it was not the vrc.zip API.</h1>
      <p class="text-sm text-muted-foreground">
        A request to <code class="bg-muted px-1 font-mono text-xs">/api/status</code> came back as
        the page itself rather than as data. The daemon is running. Its control API is just not
        reachable from the address this window was opened at.
      </p>
    {:else}
      <h1 class="text-lg font-semibold">The vrc.zip daemon isn't answering.</h1>
      <p class="text-sm text-muted-foreground">
        This window is still open, but nothing is listening on the local API. The daemon has
        probably exited, or it was restarted and is still coming up.
      </p>
    {/if}
  </div>

  <Button onclick={onRetry} disabled={retrying}>
    <RefreshCwIcon class={retrying ? "animate-spin" : ""} />
    {retrying ? "Reconnecting" : "Try again"}
  </Button>

  <Card.Root size="sm" class="w-full max-w-md text-left">
    <Card.Header>
      <Card.Title class="text-sm">
        {reason === "not-api" ? "What is going on" : "If it doesn't come back"}
      </Card.Title>
    </Card.Header>
    <Card.Content>
      {#if reason === "not-api"}
        <ol class="list-inside list-decimal space-y-2 text-xs text-muted-foreground">
          <li>
            The daemon binds three ports. The UI is on 7773 and the control API is on 7775, and a
            browser cannot reach across from one to the other.
          </li>
          <li>
            The daemon needs to serve the control routes on the UI port too, so the page can call
            them at its own origin.
          </li>
          <li>
            Until then, run the UI with
            <code class="bg-muted px-1 font-mono">bun run dev</code>
            from <code class="bg-muted px-1 font-mono">ui/</code>, which proxies /api to the control
            port.
          </li>
        </ol>
      {:else}
        <ol class="list-inside list-decimal space-y-2 text-xs text-muted-foreground">
          <li>Check the vrc.zip icon in the system tray. Start it from there if it is gone.</li>
          <li>
            From a terminal in the project, run
            <code class="bg-muted px-1 font-mono">bun run daemon</code>.
          </li>
          <li>
            Retrying reuses this window's session token. If it keeps failing after the daemon is
            back, relaunch from the tray to get a fresh one.
          </li>
        </ol>
      {/if}
    </Card.Content>
  </Card.Root>
</div>
