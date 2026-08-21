<!--
  Live sessions: one card per VRChat client running on this machine.

  This is the screen that has to carry the accounts-are-not-sessions distinction, because it is the
  only place both sets are visible at once. Two clients running means two cards, side by side, even
  when both are signed into accounts vrc.zip already knows. A client vrc.zip cannot attribute gets
  a card too, labelled "Unlinked client" with a way to add the account, because a client running
  under an unmanaged account is an ordinary thing and not an error to hide.
-->
<script lang="ts">
import HeadsetIcon from "@lucide/svelte/icons/headset";
import MonitorIcon from "@lucide/svelte/icons/monitor";
import UserPlusIcon from "@lucide/svelte/icons/user-plus";
import EmptyState from "$lib/components/EmptyState.svelte";
import LocationLine from "$lib/components/LocationLine.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Card from "$lib/components/ui/card/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
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
        <Card.Root size="sm">
          <Card.Header>
            <Skeleton class="h-5 w-40" />
            <Skeleton class="h-4 w-56" />
          </Card.Header>
          <Card.Content>
            <Skeleton class="h-24 w-full" />
          </Card.Content>
        </Card.Root>
      {/each}
    </div>
  {:else if merged.length === 0}
    <EmptyState
      icon={MonitorIcon}
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
        <Card.Root size="sm">
          <Card.Header class="border-b">
            <Card.Title class="truncate text-sm">{app.sessionLabel(session)}</Card.Title>
            <Card.Description class="tabular text-xs">
              Started {timeOfDay(session.startedAt)}, up {duration(clock.now - session.startedAt)}
            </Card.Description>
            <Card.Action>
              <Badge variant="outline">
                {#if vr}
                  <HeadsetIcon />
                {:else}
                  <MonitorIcon />
                {/if}
                {vrModeLabel(session.vrMode)}
              </Badge>
            </Card.Action>
          </Card.Header>

          {#if account === null}
            <Card.Content>
              <div
                class="flex flex-wrap items-center gap-3 bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
              >
                <span class="min-w-0 flex-1">
                  This client is signed into an account vrc.zip does not manage, so there is no
                  presence or friend data for it.
                </span>
                <Button variant="outline" size="xs" href={hrefFor("login")}>
                  <UserPlusIcon />
                  Add it
                </Button>
              </div>
            </Card.Content>
          {/if}

          <Card.Content class="space-y-2">
            <p class="text-xs tracking-wide text-muted-foreground uppercase">Instance</p>
            {#if session.currentLocation === null}
              <p class="text-sm text-muted-foreground">
                No instance yet. The client is at the menu or still loading.
              </p>
            {:else}
              <LocationLine location={session.currentLocation} worldName={entry.worldName} />
            {/if}
          </Card.Content>

          <Separator />

          <Card.Content class="min-h-0 flex-1 space-y-2">
            <div class="flex items-baseline gap-2">
              <p class="text-xs tracking-wide text-muted-foreground uppercase">In the room</p>
              {#if entry.players !== null}
                <Badge variant="secondary" class="tabular">{entry.players.length}</Badge>
              {/if}
            </div>

            {#if entry.players === null}
              <p class="text-sm text-muted-foreground">
                Not observed yet. The roster is built from join and leave lines, so it fills in from
                the next player who moves.
              </p>
            {:else if entry.players.length === 0}
              <p class="text-sm text-muted-foreground">
                Nobody has joined since vrc.zip started watching this client.
              </p>
            {:else}
              <!--
                A plain scroll pane rather than `ScrollArea`: the roster has no fixed height, and
                the bits-ui viewport is `size-full`, which resolves to nothing against a parent
                that is only `max-h`. The app styles native scrollbars in `app.css`, so this looks
                the same either way.
              -->
              <ul class="max-h-44 divide-y divide-border/60 overflow-y-auto">
                {#each entry.players as player (player.displayName)}
                  <li class="flex items-baseline gap-3 py-1.5 text-sm">
                    <span class="min-w-0 flex-1 truncate">{player.displayName}</span>
                    <span class="tabular shrink-0 text-xs text-muted-foreground">
                      {timeOfDay(player.joinedAt)}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          </Card.Content>

          <Card.Footer class="border-t">
            <Button
              variant="ghost"
              size="sm"
              href={hrefFor("gamelog", String(session.id))}
              class="-mx-3 text-muted-foreground"
            >
              Open game log
            </Button>
          </Card.Footer>
        </Card.Root>
      {/each}
    </div>

    {#if app.unlinkedSessions.length > 0}
      <p class="mt-4 text-sm text-muted-foreground">
        {app.unlinkedSessions.length} of these
        {app.unlinkedSessions.length === 1 ? "clients is" : "clients are"} unlinked. That is separate
        from the {app.accounts.length}
        {app.accounts.length === 1 ? "account" : "accounts"} on the Accounts screen.
      </p>
    {/if}
  {/if}
</div>
