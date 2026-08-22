<!--
  The game log: parsed lines from the VRChat clients' own log files.

  Live lines and stored rows identify their client the same way — by the store's session row id —
  so filtering to one client narrows *all* of it, history included.

  That was not always true, and the previous version of this comment asserted the opposite: it
  claimed the feed writer stored `session_id` as null on every row, and the filter therefore threw
  away every stored line whenever a client was selected. The claim was simply false — the column
  has always been populated (9,288 player-join rows in a real database, not one null). What was
  actually null was `sessionId` on *live* frames, which `frameToEvent` hardcoded. Fixing that one
  field is what lets the two be filtered together.

  ## The duplicates

  This screen used to show the same line over and over — six "Client quit" rows for one VRChat
  shutdown being the case that gave it away. That was not a rendering problem: the daemon really
  had six rows, one per daemon start, because the log watcher kept no persisted read position and
  replayed every log file from the top each time it came up. That is fixed at the source (migration
  007), the backlog is deleted, and a unique index stops it recurring.

  What remains here is the *display* half: `collapseRepeats` folds a run of genuinely identical
  adjacent lines into one row with a count, because a portal re-dropped nine times is nine real
  events and still only one thing a reader needs to see.

  ## The filters

  Kinds and text both narrow in the daemon. The old screen fetched a global page and kept whatever
  started with `gamelog.`, which meant a quiet second client looked empty and "load older" walked
  history it then discarded.
-->
<script lang="ts">
import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import EventRow from "$lib/components/EventRow.svelte";
import ScrollSentinel from "$lib/components/ScrollSentinel.svelte";
import SearchField from "$lib/components/SearchField.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import * as Alert from "$lib/components/ui/alert/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import { dateHeading, eventLabel, isVrMode, timeOfDay, vrModeLabel } from "$lib/format.ts";
import { hrefFor } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";
import { EventFeed } from "$lib/state/event-feed.svelte.ts";
import { eventKinds } from "$lib/state/event-kinds.svelte.ts";
import { prefs } from "$lib/state/prefs.svelte.ts";

let { sessionId = null }: { sessionId?: string | null } = $props();

/** bits-ui reads the empty string as "nothing selected", so "every client" needs a name. */
const ALL = "all";

/** `ALL` means every client. Otherwise the REST session id, as a string. */
let choice = $state(ALL);
let search = $state("");
/** Kinds the reader has ticked. Empty means every game-log kind. */
let picked = $state<string[]>([]);

/**
 * The game log is one family, always. It is passed as `families` rather than as a list of the
 * kinds this build knows about, so a `gamelog.` kind added by a newer daemon still appears here
 * instead of being silently filtered out by a hardcoded list.
 */
const feed = new EventFeed({
  base: { families: ["gamelog"] },
  live: () => app.liveEvents,
});

$effect(() => {
  if (sessionId !== null) choice = sessionId;
});

const selectedSession = $derived(
  app.sessions.find((session) => String(session.id) === choice) ?? null,
);

/*
 * The *id*, not the session object, is what the fetch depends on.
 *
 * `app.sessions` is replaced wholesale on every refresh, so `selectedSession` is a new object
 * reference each time even when nothing about the selection changed. A query keyed on the object
 * would refetch the first page — and throw away the reader's scroll position — every time a
 * session event ticked. A number compares by value and stays put. (`EventFeed.apply` compares
 * before it refetches, so this is belt as well as braces, but the number is what makes the
 * comparison meaningful.)
 */
const selectedSessionId = $derived(selectedSession?.id ?? null);

$effect(() => {
  feed.apply({
    ...(selectedSessionId === null ? {} : { sessionId: selectedSessionId }),
    ...(picked.length === 0 ? {} : { kinds: picked }),
    ...(search.trim() === "" ? {} : { search: search.trim() }),
  });
});

$effect(() => {
  eventKinds.ensure();
});

/*
 * Teardown, and nothing else. It reads nothing reactive on purpose, so it runs once and its
 * cleanup runs when the screen goes away — see the same split in `FeedScreen` for the bug that
 * comes of folding it in with a `$effect` that has dependencies.
 */
$effect(() => () => {
  feed.dispose();
});

/** Every `gamelog.` kind the store holds, commonest first, for the filter list. */
const availableKinds = $derived(eventKinds.kindsIn("gamelog"));

const triggerLabel = $derived(
  selectedSession === null ? "All clients" : app.sessionLabel(selectedSession),
);

const kindsLabel = $derived(
  picked.length === 0
    ? "All line kinds"
    : picked.length === 1
      ? eventLabel(picked[0] ?? "")
      : `${String(picked.length)} line kinds`,
);

const filtered = $derived(
  picked.length > 0 || search.trim() !== "" || selectedSessionId !== null,
);

const days = $derived.by(() => {
  const out: { heading: string; groups: typeof feed.visible }[] = [];
  for (const group of feed.visible) {
    const heading = dateHeading(group.event.ts);
    const last = out.at(-1);
    if (last !== undefined && last.heading === heading) last.groups.push(group);
    else out.push({ heading, groups: [group] });
  }
  return out;
});

function toggleKind(kind: string): void {
  picked = picked.includes(kind)
    ? picked.filter((entry) => entry !== kind)
    : [...picked, kind];
}

function clearFilters(): void {
  choice = ALL;
  picked = [];
  search = "";
}
</script>

<SectionHeader
  title="Game log"
  count={feed.rows.length}
  description="Lines vrc.zip parsed out of the VRChat log files"
>
  {#snippet actions()}
    <div class="flex items-center gap-2">
      <Switch
        id="gamelog-dense"
        size="sm"
        checked={prefs.denseFeed}
        onCheckedChange={(checked) => {
          prefs.setDenseFeed(checked);
        }}
      />
      <Label for="gamelog-dense" class="text-xs text-muted-foreground">Dense</Label>
    </div>
    <Select.Root type="single" bind:value={choice}>
      <Select.Trigger size="sm" class="w-56" aria-label="Filter by game client">
        {triggerLabel}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={ALL} label="All clients" />
        {#each app.sessions as session (session.id)}
          <Select.Item
            value={String(session.id)}
            label={`${app.sessionLabel(session)} (${vrModeLabel(session.vrMode)}, started ${timeOfDay(session.startedAt)})`}
          />
        {/each}
      </Select.Content>
    </Select.Root>
  {/snippet}
</SectionHeader>

<div
  class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2"
>
  <!--
    Multi-select rather than one-kind-at-a-time: "joins and leaves, nothing else" is the question
    people actually have about a log, and a single-choice control cannot express it. The counts are
    over the whole store, so a kind with rows is always offered even when none are on screen.
  -->
  <Select.Root type="multiple" bind:value={picked}>
    <Select.Trigger size="sm" class="w-48" aria-label="Filter by line kind">
      {kindsLabel}
    </Select.Trigger>
    <Select.Content>
      {#each availableKinds as entry (entry.kind)}
        <Select.Item
          value={entry.kind}
          label={`${eventLabel(entry.kind)} (${String(entry.count)})`}
        />
      {/each}
    </Select.Content>
  </Select.Root>

  {#if picked.length > 0}
    <!--
      The ticked kinds, spelled out. A collapsed trigger reading "3 line kinds" is a filter you
      cannot check at a glance, and an unnoticed filter is indistinguishable from missing data.
    -->
    <div class="flex flex-wrap items-center gap-1">
      {#each picked as kind (kind)}
        <button
          type="button"
          class="rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
          onclick={() => toggleKind(kind)}
          title="Stop filtering by this kind"
        >
          {eventLabel(kind)} ×
        </button>
      {/each}
    </div>
  {/if}

  <div class="ml-auto w-full sm:w-64">
    <SearchField
      bind:value={search}
      placeholder="Search players, worlds, reasons"
      label="Search the game log"
    />
  </div>
</div>

{#if selectedSession !== null}
  <div class="shrink-0 border-b border-border p-4">
    <Alert.Root>
      <Alert.Title class="flex flex-wrap items-center gap-x-3 gap-y-1">
        {app.sessionLabel(selectedSession)}
        <span class="text-xs font-normal text-muted-foreground">
          {isVrMode(selectedSession.vrMode) ? "Headset" : "Desktop"} · Started {timeOfDay(
            selectedSession.startedAt,
          )}
        </span>
      </Alert.Title>
      <Alert.Description>
        Showing this client's stored history and its live lines together.
        <a href={hrefFor("sessions")}>Open its session card</a>.
      </Alert.Description>
    </Alert.Root>
  </div>
{/if}

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if feed.phase === "error"}
    <div class="p-4">
      <ErrorNote message={feed.error ?? "The game log could not be loaded."} />
    </div>
  {:else if feed.phase === "loading" || feed.phase === "idle"}
    <div class="space-y-2 p-4" aria-busy="true">
      {#each [0, 1, 2, 3, 4, 5, 6] as index (index)}
        <Skeleton class="h-9 w-full" />
      {/each}
    </div>
  {:else if feed.isEmpty && !filtered}
    <EmptyState
      icon={ScrollTextIcon}
      title="No log lines yet"
      description="vrc.zip tails the VRChat log directory and parses joins, world changes, portals, and screenshots. Start the game and lines appear within a few seconds."
    >
      {#snippet action()}
        <Button variant="outline" href={hrefFor("settings")}>Check log directories</Button>
      {/snippet}
    </EmptyState>
  {:else if feed.isEmpty}
    <EmptyState
      icon={ScrollTextIcon}
      title="Nothing matches this filter"
      description="No parsed line matches, across the whole game-log history vrc.zip holds. The retention job trims the oldest ones."
    >
      {#snippet action()}
        <Button variant="outline" onclick={clearFilters}>Clear the filters</Button>
      {/snippet}
    </EmptyState>
  {:else}
    {#each days as day (day.heading)}
      <div
        class="sticky top-0 z-1 border-b border-border bg-background/90 px-4 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase backdrop-blur"
      >
        {day.heading}
      </div>
      <ul class="divide-y divide-border/50">
        {#each day.groups as group (group.event.id)}
          <EventRow
            event={group.event}
            dense={prefs.denseFeed}
            repeats={group.repeats}
            oldestTs={group.oldestTs}
          />
        {/each}
      </ul>
    {/each}

    {#if feed.moreError !== null}
      <div class="flex items-center justify-between gap-3 border-t border-border bg-muted/40 p-3">
        <p class="text-sm text-muted-foreground">{feed.moreError}</p>
        <Button variant="outline" size="sm" onclick={() => feed.retry()}>Try again</Button>
      </div>
    {:else if feed.loadingMore}
      <div class="space-y-2 p-4" aria-busy="true">
        <Skeleton class="h-9 w-full" />
        <Skeleton class="h-9 w-full" />
      </div>
    {:else if !feed.hasMore && !feed.hasUnrendered}
      <p class="p-4 text-center text-sm text-muted-foreground">
        That is every log line vrc.zip still holds. The retention job trims older ones.
      </p>
    {/if}

    <ScrollSentinel
      enabled={(feed.hasUnrendered || feed.hasMore) &&
        !feed.loadingMore &&
        feed.moreError === null}
      onVisible={() => feed.advance()}
    />
  {/if}
</div>
