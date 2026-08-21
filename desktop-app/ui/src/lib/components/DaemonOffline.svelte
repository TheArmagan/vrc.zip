<!--
  What the user sees instead of a blank page when nothing answers on /api.

  The UI is served *by* the daemon in production, so reaching this screen at all almost always
  means the daemon stopped after the page loaded. In dev it means the Vite proxy has nothing to
  proxy to. Both cases get the same three things: what happened, what to do, and a retry that
  does not require reloading and losing the session token.
-->
<script lang="ts">
import PlugZap from "@lucide/svelte/icons/plug-zap";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import Button from "./ui/Button.svelte";

let { onRetry, retrying = false }: { onRetry: () => void; retrying?: boolean } = $props();
</script>

<div class="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
  <div class="rounded-full border border-border bg-muted/40 p-4 text-muted-foreground">
    <PlugZap size={26} />
  </div>

  <div class="max-w-md space-y-2">
    <h1 class="text-base font-semibold">The vrc.zip daemon isn't answering.</h1>
    <p class="text-sm text-muted-foreground">
      This window is still open, but nothing is listening on the local API. The daemon has
      probably exited, or it was restarted and is still coming up.
    </p>
  </div>

  <Button onclick={onRetry} disabled={retrying}>
    <RefreshCw size={15} class={retrying ? "animate-spin" : ""} />
    {retrying ? "Reconnecting…" : "Try again"}
  </Button>

  <div class="w-full max-w-md rounded-lg border border-border bg-card p-4 text-left">
    <p class="mb-2 text-xs font-medium text-muted-foreground">If it doesn't come back</p>
    <ol class="space-y-1.5 text-xs text-muted-foreground">
      <li>1. Check the vrc.zip icon in the system tray — start it from there if it's gone.</li>
      <li>
        2. From a terminal in the project, run
        <code class="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">bun run daemon</code>.
      </li>
      <li>
        3. Retrying reuses this window's session token. If it keeps failing after the daemon is
        back, relaunch from the tray to get a fresh one.
      </li>
    </ol>
  </div>
</div>
