<!--
  The frame every screen sits inside.

  Layout order is load-bearing. The UNOFFICIAL marker is the first thing in the document and the
  keychain warning comes second, both above the chrome, both outside the scroll container. Screens
  scroll; the warnings do not, so no amount of scrolling ever puts them off screen.
-->
<script lang="ts">
import { CommandIcon, Moon02Icon, RefreshIcon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/svelte";
import type { Snippet } from "svelte";
import KeychainWarning from "$lib/components/KeychainWarning.svelte";
import UnofficialBadge from "$lib/components/UnofficialBadge.svelte";
import Sidebar from "$lib/components/Sidebar.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import type { RouteId } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";
import { theme } from "$lib/state/theme.svelte.ts";
import type { StreamState } from "$lib/stream.ts";

let {
  route,
  onOpenPalette,
  children,
}: { route: RouteId; onOpenPalette: () => void; children: Snippet } = $props();

const STREAM_TEXT: Record<StreamState, string> = {
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Reconnecting",
  closed: "Disconnected",
  unauthorized: "Token rejected",
};

const STREAM_DOT: Record<StreamState, string> = {
  connecting: "bg-status-ask-me animate-pulse",
  open: "bg-status-online",
  reconnecting: "bg-status-ask-me animate-pulse",
  closed: "bg-status-offline",
  unauthorized: "bg-status-busy",
};

const streamHint = $derived(
  app.streamState === "unauthorized"
    ? "The daemon rejected this window's session token. Relaunch vrc.zip from the tray to get a new one."
    : app.streamState === "open"
      ? "Events are arriving over the daemon's WebSocket."
      : "Not receiving live events. Screens fall back to what they last read.",
);

const rateLimit = $derived(app.status?.rateLimit ?? null);
</script>

<div class="flex h-full flex-col overflow-hidden bg-background text-foreground">
  <UnofficialBadge />
  {#if app.status?.degradedKeychain === true}
    <KeychainWarning />
  {/if}

  <header class="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
    <span class="font-mono text-[13px] font-semibold tracking-tight">vrc.zip</span>
    {#if app.status}
      <span class="tabular text-[11px] text-muted-foreground">v{app.status.version}</span>
    {/if}

    <div class="ml-auto flex items-center gap-3">
      {#if rateLimit && rateLimit.retryAfter !== null}
        <span
          class="tabular border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning"
          title="VRChat returned 429. The daemon is holding requests until the backoff lifts."
        >
          Rate limited
        </span>
      {:else if rateLimit}
        <span
          class="tabular hidden text-[11px] text-muted-foreground sm:inline"
          title="Requests per second the daemon allows itself across every account."
        >
          {rateLimit.limit}/s
        </span>
      {/if}

      <span
        class="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        title={streamHint}
      >
        <span
          class="inline-block size-2 rounded-full {STREAM_DOT[app.streamState]}"
          aria-hidden="true"
        ></span>
        {STREAM_TEXT[app.streamState]}
      </span>

      <Button
        variant="ghost"
        size="sm"
        onclick={onOpenPalette}
        class="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
        title="Command palette (Ctrl+Shift+P)"
      >
        <HugeiconsIcon icon={CommandIcon} size={13} />
        Commands
      </Button>

      <Button
        variant="ghost"
        size="icon"
        class="size-7"
        onclick={() => app.retry()}
        title="Re-read everything and reopen the event socket"
        aria-label="Refresh"
      >
        <HugeiconsIcon icon={RefreshIcon} size={14} />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        class="size-7"
        onclick={() => theme.toggle()}
        title={theme.current === "dark" ? "Switch to light" : "Switch to dark"}
        aria-label="Toggle theme"
      >
        <HugeiconsIcon icon={theme.current === "dark" ? Sun03Icon : Moon02Icon} size={14} />
      </Button>
    </div>
  </header>

  <div class="flex min-h-0 flex-1">
    <Sidebar current={route} />
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      {@render children()}
    </main>
  </div>
</div>
