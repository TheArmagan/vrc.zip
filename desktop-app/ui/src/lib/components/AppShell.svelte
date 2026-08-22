<!--
  The frame every screen sits inside.

  Layout order is load-bearing. The UNOFFICIAL marker is the first thing in the document and the
  keychain warning comes second, both above the chrome, both outside the scroll container. Screens
  scroll; the warnings do not, so no amount of scrolling ever puts them off screen.
-->
<script lang="ts">
  import CommandIcon from "@lucide/svelte/icons/command";
  import MoonIcon from "@lucide/svelte/icons/moon";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import SunIcon from "@lucide/svelte/icons/sun";
  import type { Snippet } from "svelte";
  import KeychainWarning from "$lib/components/KeychainWarning.svelte";
  import Sparkline from "$lib/components/Sparkline.svelte";
  import UnofficialBadge from "$lib/components/UnofficialBadge.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import { rates } from "$lib/state/rates.svelte.ts";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import type { RouteId } from "$lib/router.ts";
  import { app } from "$lib/state/app.svelte.ts";
  import { theme } from "$lib/state/theme.svelte.ts";
  import type { StreamState } from "$lib/stream.ts";

  let {
    route,
    onOpenPalette,
    children,
  }: { route: RouteId; onOpenPalette: () => void; children: Snippet } =
    $props();

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

  <Tooltip.Provider delayDuration={200}>
    <header
      class="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4"
    >
      <span class="font-mono text-sm font-semibold tracking-tight">vrc.zip</span
      >
      {#if app.status}
        <Badge variant="outline" class="tabular">v{app.status.version}</Badge>
      {/if}

      <div class="ml-auto flex items-center gap-2">
        {#if rateLimit && rateLimit.retryAfter !== null}
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Badge class="tabular bg-warning text-warning-foreground"
                >Rate limited</Badge
              >
            </Tooltip.Trigger>
            <Tooltip.Content>
              VRChat returned 429. The daemon is holding requests until the
              backoff lifts.
            </Tooltip.Content>
          </Tooltip.Root>
        {:else if rateLimit}
          <Tooltip.Root>
            <Tooltip.Trigger class="hidden items-center gap-2 sm:flex">
              <!--
                Ten minutes of load behind the current reading. This used to render `limit` — a
                constant off the daemon's configuration — as though it were a measurement, so it
                said the same number whether the daemon was idle or saturated.

                Deliberately no `max={rates.limit}` on the chart: against an 80/s ceiling a real 3/s
                reading sits in the bottom 4% of the box and renders as a flat line. The absolute
                magnitude is the number to its right; the picture is for the shape.
              -->
              <Sparkline
                values={rates.total}
                height={14}
                class="w-14"
                label="Requests per second over the last ten minutes"
              />
              <span class="tabular text-xs text-muted-foreground"
                >{rates.current}/{rates.limit}/s</span
              >
            </Tooltip.Trigger>
            <Tooltip.Content>
              {rates.current} requests in the last second, against the {rates.limit}/s
              the daemon allows itself across every account. Peak in the last ten minutes:
              {rates.peak}/s.
            </Tooltip.Content>
          </Tooltip.Root>
        {/if}

        <Tooltip.Root>
          <Tooltip.Trigger>
            <span class="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                class="inline-block size-2 rounded-full {STREAM_DOT[
                  app.streamState
                ]}"
                aria-hidden="true"
              ></span>
              {STREAM_TEXT[app.streamState]}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Content>{streamHint}</Tooltip.Content>
        </Tooltip.Root>

        <Separator orientation="vertical" class="h-5" />

        <Button
          variant="ghost"
          size="sm"
          onclick={onOpenPalette}
          class="text-muted-foreground"
          title="Command palette (Ctrl+Shift+P)"
        >
          <CommandIcon />
          Commands
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          onclick={() => app.retry()}
          title="Re-read everything and reopen the event socket"
          aria-label="Refresh"
        >
          <RefreshCwIcon />
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          onclick={() => theme.toggle()}
          title={theme.current === "dark"
            ? "Switch to light"
            : "Switch to dark"}
          aria-label="Toggle theme"
        >
          {#if theme.current === "dark"}
            <SunIcon />
          {:else}
            <MoonIcon />
          {/if}
        </Button>
      </div>
    </header>
  </Tooltip.Provider>

  <div class="flex min-h-0 flex-1">
    <Sidebar current={route} />
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      {@render children()}
    </main>
  </div>
</div>
