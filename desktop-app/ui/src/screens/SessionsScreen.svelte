<!--
  Live sessions: every VRChat client running on this machine, and one of them in full.

  This is the screen that has to carry the accounts-are-not-sessions distinction, because it is the
  only place both sets are visible at once. Two clients running means two entries in the rail, both
  always on screen, both one click from being the focused one. A client vrc.zip cannot attribute
  gets an entry too, labelled "Unlinked client" with a way to add the account, because a client
  running under an unmanaged account is an ordinary thing and not an error to hide.

  ## Why a rail and a focus pane rather than a grid of cards

  The grid this replaced gave each client an equal, small box with a roster clipped to about six
  rows. That is the wrong shape for the question people actually bring here — "who is in the room
  with me" — in a game where forty people in one instance is unremarkable. Focus mode gives the
  roster the full height of the window while the rail keeps every other client permanently visible,
  so nothing about the layout can imply there is only one client. PLAN.md §1.9 is emphatic on that
  point and it is the one property this rewrite was not allowed to lose.

  Selection lives in the URL (`#/sessions/<id>`), so a focused client survives a reload and can be
  linked to. An id that no longer names a running client falls back to the first one rather than
  rendering an empty pane — clients come and go while the tab is open.
-->
<script lang="ts">
import { untrack } from "svelte";
import HeadsetIcon from "@lucide/svelte/icons/headset";
import MonitorIcon from "@lucide/svelte/icons/monitor";
import UserPlusIcon from "@lucide/svelte/icons/user-plus";
import EmptyState from "$lib/components/EmptyState.svelte";
import LocationLine from "$lib/components/LocationLine.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import SessionRoster from "$lib/components/SessionRoster.svelte";
import UserName from "$lib/components/UserName.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { duration, isVrMode, shortId, timeOfDay, vrModeLabel } from "$lib/format.ts";
import { hrefFor } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";
import { clock } from "$lib/state/clock.svelte.ts";
import { liveSessions } from "$lib/state/live-sessions.svelte.ts";
import { worldNames } from "$lib/state/world-names.svelte.ts";

let {
  /** The trailing route segment: `#/sessions/12` -> `"12"`. Null when none was given. */
  sessionId = null,
}: { sessionId?: string | null } = $props();

$effect(() => clock.subscribe());

const merged = $derived(liveSessions.merge(app.sessions));
const loading = $derived(app.phase === "loading" || app.phase === "idle");

/*
 * Derived rather than stored, on purpose. A `$state` selection would have to be reconciled every
 * time a client starts or quits, and the failure mode of getting that wrong is a blank pane with
 * no explanation. Reading it out of the route each render means the fallback is structural.
 */
const focused = $derived(
  merged.find((entry) => String(entry.session.id) === sessionId) ?? merged[0] ?? null,
);

/*
 * The rail's world names.
 *
 * A rail entry is an `<a>`, so it cannot hold a `WorldLink` — a button inside an anchor is invalid
 * markup and a click target with two answers. It reads the same resolver directly instead, which
 * is also why this is worth doing at all: the client the user is *looking at* gets its name from
 * the game log, but a client that entered its world before vrc.zip started has only the id.
 */
$effect(() => {
  const targets = merged.map((entry) => entry.session);
  // Tracked: the list of clients and their worlds. Untracked: the resolver's own cache, which
  // `ensure` reads and would otherwise re-run this effect on every name that lands.
  untrack(() => {
    for (const session of targets) worldNames.ensure(session.currentWorldId, session.accountId);
  });
});

const focusedAccount = $derived(
  focused === null ? null : app.accountById(focused.session.accountId),
);

const RAIL_BASE =
  "flex w-56 shrink-0 flex-col gap-1 border border-transparent px-3 py-2 text-left transition-colors md:w-auto";
const RAIL_ON = "border-border bg-muted/60";
const RAIL_OFF = "hover:bg-muted/40";
</script>

<SectionHeader
  title="Live sessions"
  count={app.sessions.length}
  description={app.sessions.length === 1
    ? "One VRChat game client is running on this machine"
    : `${String(app.sessions.length)} VRChat game clients are running on this machine`}
/>

{#if loading}
  <div class="flex min-h-0 flex-1">
    <div class="hidden w-72 shrink-0 space-y-2 border-r border-border p-3 md:block">
      {#each [0, 1] as index (index)}
        <Skeleton class="h-16 w-full" />
      {/each}
    </div>
    <div class="min-w-0 flex-1 space-y-3 p-4">
      <Skeleton class="h-6 w-56" />
      <Skeleton class="h-4 w-72" />
      <Skeleton class="h-64 w-full" />
    </div>
  </div>
{:else if focused === null}
  <div class="min-h-0 flex-1 overflow-y-auto">
    <EmptyState
      icon={MonitorIcon}
      title="No VRChat client is running"
      description="vrc.zip watches the VRChat log directory. Start the game and a client appears here within a few seconds, whether or not the account is one vrc.zip manages."
    >
      {#snippet action()}
        <Button variant="outline" size="sm" href={hrefFor("settings")}>
          Check log directories
        </Button>
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="flex min-h-0 flex-1 flex-col md:flex-row">
    <!--
      The rail. Horizontal on a narrow window and vertical from `md` up, but never collapsed into a
      dropdown: a picker that hides the second client is exactly the "there is only one" implication
      this screen exists to refuse.
    -->
    <nav
      aria-label="Running VRChat clients"
      class="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 md:w-72 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0"
    >
      {#each merged as entry (entry.session.id)}
        {@const session = entry.session}
        {@const selected = session.id === focused.session.id}
        {@const parsedName =
          entry.worldName ??
          worldNames.get(session.currentWorldId)?.name ??
          shortId(session.currentWorldId, 16)}
        <a
          href={hrefFor("sessions", String(session.id))}
          aria-current={selected ? "true" : undefined}
          class="{RAIL_BASE} {selected ? RAIL_ON : RAIL_OFF}"
        >
          <span class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-sm font-medium">
              {app.sessionLabel(session)}
            </span>
            {#if isVrMode(session.vrMode)}
              <HeadsetIcon class="size-3.5 shrink-0 text-muted-foreground" aria-label="VR" />
            {:else}
              <MonitorIcon class="size-3.5 shrink-0 text-muted-foreground" aria-label="Desktop" />
            {/if}
          </span>
          <span class="truncate text-xs text-muted-foreground">
            {session.currentLocation === null ? "At the menu" : parsedName}
          </span>
          <span class="tabular text-xs text-muted-foreground">
            {entry.players === null
              ? "roster not observed"
              : `${String(entry.players.length)} in the room`}
            · up {duration(clock.now - session.startedAt)}
          </span>
        </a>
      {/each}

      {#if app.unlinkedSessions.length > 0}
        <p class="px-3 py-2 text-xs text-muted-foreground">
          {app.unlinkedSessions.length} of these
          {app.unlinkedSessions.length === 1 ? "clients is" : "clients are"} unlinked, which is separate
          from the {app.accounts.length}
          {app.accounts.length === 1 ? "account" : "accounts"} on the Accounts screen.
        </p>
      {/if}
    </nav>

    <!-- The focused client, full height. -->
    <section class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="shrink-0 space-y-2 border-b border-border px-4 py-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <!--
            The heading is a user only when the client is linked to an account. An unlinked
            client's label is either the name the log reported (no id ever accompanies it) or the
            words "Unlinked client", and neither is something to open a profile for.
          -->
          <h2 class="min-w-0 truncate text-base font-semibold tracking-tight">
            <UserName
              userId={focused.session.accountId}
              name={app.sessionLabel(focused.session)}
              accountId={focused.session.accountId}
              class="max-w-full truncate"
            />
          </h2>
          <Badge variant="outline">
            {#if isVrMode(focused.session.vrMode)}
              <HeadsetIcon />
            {:else}
              <MonitorIcon />
            {/if}
            {vrModeLabel(focused.session.vrMode)}
          </Badge>
          <p class="tabular text-xs text-muted-foreground">
            Started {timeOfDay(focused.session.startedAt)}, up {duration(clock.now - focused.session.startedAt)}
          </p>
          <div class="ml-auto">
            <Button variant="outline" size="sm" href={hrefFor("gamelog", String(focused.session.id))}>
              Open game log
            </Button>
          </div>
        </div>

        {#if focused.session.currentLocation === null}
          <p class="text-sm text-muted-foreground">
            No instance yet. The client is at the menu or still loading.
          </p>
        {:else}
          <!--
            This client is already standing here, so `planJoin` shows no affordance at all for it —
            the old "Jump" link launched a second client into the instance the first was already
            in. With a second client running the affordance comes back as "Invite me" and moves
            that one here instead.
          -->
          <LocationLine
            location={focused.session.currentLocation}
            worldName={focused.worldName}
            accountId={focused.session.accountId}
          />
        {/if}

        {#if focusedAccount === null}
          <div
            class="flex flex-wrap items-center gap-3 bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          >
            <span class="min-w-0 flex-1">
              This client is signed into an account vrc.zip does not manage, so there is no presence
              or friend data for it — and nobody to ask VRChat about this instance through.
            </span>
            <Button variant="outline" size="xs" href={hrefFor("login")}>
              <UserPlusIcon />
              Add it
            </Button>
          </div>
        {/if}
      </div>

      <!--
        Keyed on the session id so switching clients rebuilds the roster rather than carrying one
        client's search text and sort over onto another's list.
      -->
      {#key focused.session.id}
        <SessionRoster session={focused.session} players={focused.players} />
      {/key}
    </section>
  </div>
{/if}
