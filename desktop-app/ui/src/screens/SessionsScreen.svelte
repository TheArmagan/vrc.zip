<!--
  Live sessions: one card per VRChat client running on this machine.

  This is the screen that has to carry the accounts-are-not-sessions distinction, because it is the
  only place both sets are visible at once. Two clients running means two cards, side by side, even
  when both are signed into accounts vrc.zip already knows. A client vrc.zip cannot attribute gets
  a card too, labelled "Unlinked client" with a way to add the account, because a client running
  under an unmanaged account is an ordinary thing and not an error to hide.
-->
<script lang="ts">
import {
  ComputerIcon,
  MonitorDotIcon,
  UserAdd01Icon,
  UserGroupIcon,
  VirtualRealityVr01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import LocationLine from "$lib/components/LocationLine.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { duration, isVrMode, timeOfDay, vrModeLabel } from "$lib/format.ts";
import { hrefFor } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";
import { clock } from "$lib/state/clock.svelte.ts";
import { liveSessions } from "$lib/state/live-sessions.svelte.ts";

$effect(() => clock.subscribe());

const merged = $derived(liveSessions.merge(app.sessions));
const loading = $derived(app.phase === "loading" || app.phase === "idle");
</script>

<SectionHeader
  title="Live sessions"
  count={app.sessions.length}
  description="VRChat game clients running on this machine right now"
/>

<div class="min-h-0 flex-1 overflow-y-auto p-4">
  {#if loading}
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {#each [0, 1] as index (index)}
        <div class="space-y-3 border border-border bg-card p-4">
          <Skeleton class="h-5 w-40" />
          <Skeleton class="h-3 w-56" />
          <Skeleton class="h-24 w-full" />
        </div>
      {/each}
    </div>
  {:else if merged.length === 0}
    <EmptyState
      icon={ComputerIcon}
      title="No VRChat client is running"
      description="vrc.zip watches the VRChat log directory. Start the game and a card appears here within a few seconds, whether or not the account is one vrc.zip manages."
    >
      {#snippet action()}
        <Button variant="outline" size="sm" href={hrefFor("settings")}>
          Check log directories
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {#each merged as entry (entry.session.id)}
        {@const session = entry.session}
        {@const account = app.accountById(session.accountId)}
        {@const vr = isVrMode(session.vrMode)}
        <article class="flex flex-col border border-border bg-card">
          <header class="flex items-start gap-2 border-b border-border px-4 py-3">
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-sm font-semibold">
                {app.sessionLabel(session)}
              </h2>
              <p class="tabular mt-0.5 text-[11px] text-muted-foreground">
                Started {timeOfDay(session.startedAt)}, up {duration(
                  clock.now - session.startedAt,
                )}
              </p>
            </div>
            <Badge variant="outline" class="shrink-0 gap-1 text-[10px]">
              <HugeiconsIcon icon={vr ? VirtualRealityVr01Icon : MonitorDotIcon} size={12} />
              {vrModeLabel(session.vrMode)}
            </Badge>
          </header>

          {#if account === null}
            <div
              class="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2
                     text-[11px] text-muted-foreground"
            >
              <span class="min-w-0 flex-1">
                This client is signed into an account vrc.zip does not manage, so there is no
                presence or friend data for it.
              </span>
              <Button
                variant="outline"
                size="sm"
                href={hrefFor("login")}
                class="h-6 shrink-0 gap-1 px-2 text-[11px]"
              >
                <HugeiconsIcon icon={UserAdd01Icon} size={12} />
                Add it
              </Button>
            </div>
          {/if}

          <div class="border-b border-border px-4 py-3">
            <p class="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">Instance</p>
            {#if session.currentLocation === null}
              <p class="text-xs text-muted-foreground">
                No instance yet. The client is at the menu or still loading.
              </p>
            {:else}
              <LocationLine location={session.currentLocation} worldName={entry.worldName} />
            {/if}
          </div>

          <div class="min-h-0 flex-1 px-4 py-3">
            <div class="mb-1.5 flex items-baseline gap-2">
              <p class="text-[11px] tracking-wide text-muted-foreground uppercase">In the room</p>
              {#if entry.players !== null}
                <span class="tabular text-[11px] text-muted-foreground">
                  {entry.players.length}
                </span>
              {/if}
            </div>

            {#if entry.players === null}
              <p class="text-xs text-muted-foreground">
                Not observed yet. The roster is built from join and leave lines, so it fills in
                from the next player who moves.
              </p>
            {:else if entry.players.length === 0}
              <p class="text-xs text-muted-foreground">
                Nobody has joined since vrc.zip started watching this client.
              </p>
            {:else}
              <ul class="max-h-44 space-y-0.5 overflow-y-auto">
                {#each entry.players as player (player.displayName)}
                  <li class="flex items-baseline gap-2 text-xs">
                    <HugeiconsIcon
                      icon={UserGroupIcon}
                      size={11}
                      class="shrink-0 translate-y-px text-muted-foreground"
                    />
                    <span class="min-w-0 flex-1 truncate">{player.displayName}</span>
                    <span class="tabular shrink-0 text-[10px] text-muted-foreground">
                      {timeOfDay(player.joinedAt)}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <footer class="border-t border-border px-4 py-2">
            <Button
              variant="ghost"
              size="sm"
              href={hrefFor("gamelog", String(session.id))}
              class="h-6 px-2 text-[11px] text-muted-foreground"
            >
              Open game log
            </Button>
          </footer>
        </article>
      {/each}
    </div>

    {#if app.unlinkedSessions.length > 0}
      <p class="mt-4 text-xs text-muted-foreground">
        {app.unlinkedSessions.length} of these
        {app.unlinkedSessions.length === 1 ? "clients is" : "clients are"} unlinked. That is separate
        from the {app.accounts.length}
        {app.accounts.length === 1 ? "account" : "accounts"} on the Accounts screen.
      </p>
    {/if}
  {/if}
</div>
