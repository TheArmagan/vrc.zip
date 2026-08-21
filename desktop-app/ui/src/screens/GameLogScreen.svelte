<!--
  The game log: parsed lines from the VRChat clients' own log files.

  One caveat is written into the screen rather than hidden, because it changes what the filter can
  do. The daemon's feed writer stores `session_id` as null on every row, so a stored `gamelog.*`
  event does not know which client produced it. Live frames do carry the log watcher's session id.
  Filtering to one client therefore narrows to what has arrived over the socket, and the screen
  says so instead of quietly showing a short list.
-->
<script lang="ts">
import { FileScriptIcon } from "@hugeicons/core-free-icons";
import { api, describeError, isAbort } from "$lib/api.ts";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import EventRow from "$lib/components/EventRow.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { type LiveEvent, mergeEvents, rowToEvent } from "$lib/events.ts";
import { dateHeading, isVrMode, timeOfDay, vrModeLabel } from "$lib/format.ts";
import { hrefFor } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";
import { liveSessions } from "$lib/state/live-sessions.svelte.ts";
import { prefs } from "$lib/state/prefs.svelte.ts";

let { sessionId = null }: { sessionId?: string | null } = $props();

const PAGE_SIZE = 300;

let stored = $state<LiveEvent[]>([]);
let loading = $state(true);
let loadingMore = $state(false);
let exhausted = $state(false);
let error = $state<string | null>(null);
/** Empty string means every client. Otherwise the REST session id, as a string. */
let selected = $state("");

$effect(() => {
  if (sessionId !== null) selected = sessionId;
});

$effect(() => {
  const controller = new AbortController();
  loading = true;
  exhausted = false;

  void (async () => {
    try {
      const rows = await api.events({ limit: PAGE_SIZE }, controller.signal);
      stored = rows.map(rowToEvent).filter((event) => event.kind.startsWith("gamelog."));
      exhausted = rows.length < PAGE_SIZE;
      error = null;
    } catch (cause) {
      if (isAbort(cause)) return;
      error = describeError(cause);
    } finally {
      loading = false;
    }
  })();

  return () => {
    controller.abort();
  };
});

const selectedSession = $derived(
  app.sessions.find((session) => String(session.id) === selected) ?? null,
);

const selectedStreamId = $derived(
  selectedSession === null ? null : liveSessions.streamIdFor(selectedSession),
);

const liveLines = $derived(
  app.liveEvents.filter((event) => event.kind.startsWith("gamelog.")),
);

const all = $derived(mergeEvents(stored, liveLines));

const visible = $derived(
  selected === ""
    ? all
    : all.filter((event) => event.live && event.streamSessionId === selectedStreamId),
);

const days = $derived.by(() => {
  const out: { heading: string; events: LiveEvent[] }[] = [];
  for (const event of visible) {
    const heading = dateHeading(event.ts);
    const last = out.at(-1);
    if (last !== undefined && last.heading === heading) last.events.push(event);
    else out.push({ heading, events: [event] });
  }
  return out;
});

async function loadMore(): Promise<void> {
  const oldest = stored.at(-1);
  if (oldest === undefined || loadingMore || exhausted) return;
  loadingMore = true;
  try {
    const rows = await api.events({ limit: PAGE_SIZE, before: oldest.ts });
    stored = [
      ...stored,
      ...rows.map(rowToEvent).filter((event) => event.kind.startsWith("gamelog.")),
    ];
    exhausted = rows.length < PAGE_SIZE;
  } catch (cause) {
    error = describeError(cause);
  } finally {
    loadingMore = false;
  }
}
</script>

<SectionHeader
  title="Game log"
  count={visible.length}
  description="Lines vrc.zip parsed out of the VRChat log files"
>
  {#snippet actions()}
    <div class="flex items-center gap-2">
      <label class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={prefs.denseFeed}
          onchange={(event) => {
            prefs.setDenseFeed(event.currentTarget.checked);
          }}
          class="size-3.5 accent-primary"
        />
        Dense
      </label>
      <select
        bind:value={selected}
        aria-label="Filter by game client"
        class="h-7 border border-border bg-input/30 px-2 text-xs outline-none
               focus-visible:border-ring"
      >
        <option value="">All clients</option>
        {#each app.sessions as session (session.id)}
          <option value={String(session.id)}>
            {app.sessionLabel(session)} ({vrModeLabel(session.vrMode)}, started {timeOfDay(
              session.startedAt,
            )})
          </option>
        {/each}
      </select>
    </div>
  {/snippet}
</SectionHeader>

{#if selectedSession !== null}
  <div
    class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/30 px-5 py-2
           text-[11px] text-muted-foreground"
  >
    <span class="font-medium text-foreground">{app.sessionLabel(selectedSession)}</span>
    <span>{isVrMode(selectedSession.vrMode) ? "Headset" : "Desktop"}</span>
    <span>Started {timeOfDay(selectedSession.startedAt)}</span>
    <a class="underline underline-offset-2" href={hrefFor("sessions")}>Open its session card</a>
    <span class="w-full">
      Stored history has no client attached to it, so this view shows only lines that arrived over
      the live socket since this page loaded.
    </span>
  </div>
{/if}

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if error}
    <div class="p-4"><ErrorNote message={error} /></div>
  {/if}

  {#if loading}
    <div class="space-y-px p-4">
      {#each [0, 1, 2, 3, 4, 5, 6] as index (index)}
        <Skeleton class="h-8 w-full" />
      {/each}
    </div>
  {:else if all.length === 0}
    <EmptyState
      icon={FileScriptIcon}
      title="No log lines yet"
      description="vrc.zip tails the VRChat log directory and parses joins, world changes, portals, and screenshots. Start the game and lines appear within a few seconds."
    >
      {#snippet action()}
        <Button variant="outline" size="sm" href={hrefFor("settings")}>
          Check log directories
        </Button>
      {/snippet}
    </EmptyState>
  {:else if visible.length === 0}
    <EmptyState
      icon={FileScriptIcon}
      title="Nothing from this client yet"
      description={selectedStreamId === null
        ? "vrc.zip has not matched this client to a live log stream, so it cannot attribute lines to it yet. The next line the client writes will do it."
        : "This client has written no parsed lines since the page loaded."}
    >
      {#snippet action()}
        <Button
          variant="outline"
          size="sm"
          onclick={() => {
            selected = "";
          }}
        >
          Show every client
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    {#each days as day (day.heading)}
      <div
        class="sticky top-0 z-[1] border-b border-border bg-background/90 px-5 py-1
               text-[11px] font-medium text-muted-foreground backdrop-blur"
      >
        {day.heading}
      </div>
      <ul class="divide-y divide-border/50">
        {#each day.events as event (event.id)}
          <EventRow {event} dense={prefs.denseFeed} />
        {/each}
      </ul>
    {/each}

    {#if selected === ""}
      <div class="p-4 text-center">
        {#if exhausted}
          <p class="text-xs text-muted-foreground">
            That is every log line vrc.zip still holds. The retention job trims older ones.
          </p>
        {:else}
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onclick={() => void loadMore()}
          >
            {loadingMore ? "Loading" : "Load older lines"}
          </Button>
        {/if}
      </div>
    {/if}
  {/if}
</div>
