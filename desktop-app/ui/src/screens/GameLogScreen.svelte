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
-->
<script lang="ts">
  import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
  import { api, describeError, type EventQuery, isAbort } from "$lib/api.ts";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import ErrorNote from "$lib/components/ErrorNote.svelte";
  import EventRow from "$lib/components/EventRow.svelte";
  import SectionHeader from "$lib/components/SectionHeader.svelte";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { type LiveEvent, mergeEvents, rowToEvent } from "$lib/events.ts";
  import {
    dateHeading,
    isVrMode,
    timeOfDay,
    vrModeLabel,
  } from "$lib/format.ts";
  import { hrefFor } from "$lib/router.ts";
  import { app } from "$lib/state/app.svelte.ts";
  import { prefs } from "$lib/state/prefs.svelte.ts";

  let { sessionId = null }: { sessionId?: string | null } = $props();

  const PAGE_SIZE = 300;

  /** bits-ui reads the empty string as "nothing selected", so "every client" needs a name. */
  const ALL = "all";

  let stored = $state<LiveEvent[]>([]);
  let loading = $state(true);
  let loadingMore = $state(false);
  let exhausted = $state(false);
  let error = $state<string | null>(null);
  /** `ALL` means every client. Otherwise the REST session id, as a string. */
  let choice = $state(ALL);

  const selected = $derived(choice === ALL ? "" : choice);

  $effect(() => {
    if (sessionId !== null) choice = sessionId;
  });

  $effect(() => {
    // Reading it here is what makes this effect re-run when the client filter changes; the daemon
    // returns a different page for each, so the fetch is part of the filter rather than a
    // one-time load.
    const query = storedQuery();
    const controller = new AbortController();
    loading = true;
    exhausted = false;

    void (async () => {
      try {
        const rows = await api.events(query, controller.signal);
        stored = rows
          .map(rowToEvent)
          .filter((event) => event.kind.startsWith("gamelog."));
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

  /*
   * The *id*, not the session object, is what the fetch depends on.
   *
   * `app.sessions` is replaced wholesale on every refresh, so `selectedSession` is a new object
   * reference each time even when nothing about the selection changed. An effect keyed on the
   * object would refetch the first page — and throw away the reader's scroll position — every time
   * a session event ticked. A number compares by value and stays put.
   */
  const selectedSessionId = $derived(selectedSession?.id ?? null);

  const liveLines = $derived(
    app.liveEvents.filter((event) => event.kind.startsWith("gamelog.")),
  );

  const all = $derived(mergeEvents(stored, liveLines));

  const visible = $derived(
    selectedSessionId === null
      ? all
      : all.filter((event) => event.sessionId === selectedSessionId),
  );

  const triggerLabel = $derived(
    selectedSession === null
      ? "All clients"
      : app.sessionLabel(selectedSession),
  );

  const days = $derived.by(() => {
    const out: { heading: string; events: LiveEvent[] }[] = [];
    for (const event of visible) {
      const heading = dateHeading(event.ts);
      const last = out.at(-1);
      if (last !== undefined && last.heading === heading)
        last.events.push(event);
      else out.push({ heading, events: [event] });
    }
    return out;
  });

  /**
   * The stored-history query for the current filter.
   *
   * Filtering by client happens **in the daemon**, not here. Fetching a global page and narrowing
   * it in JS means a busy instance's own history is whatever survives the last 300 rows across
   * every client — so a quiet second client looks empty, and "load older" walks history it then
   * throws away.
   */
  function storedQuery(before?: number): EventQuery {
    return {
      limit: PAGE_SIZE,
      ...(selectedSessionId === null ? {} : { sessionId: selectedSessionId }),
      ...(before === undefined ? {} : { before }),
    };
  }

  async function loadMore(): Promise<void> {
    const oldest = stored.at(-1);
    if (oldest === undefined || loadingMore || exhausted) return;
    loadingMore = true;
    try {
      const rows = await api.events(storedQuery(oldest.ts));
      stored = [
        ...stored,
        ...rows
          .map(rowToEvent)
          .filter((event) => event.kind.startsWith("gamelog.")),
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
      <Switch
        id="gamelog-dense"
        size="sm"
        checked={prefs.denseFeed}
        onCheckedChange={(checked) => {
          prefs.setDenseFeed(checked);
        }}
      />
      <Label for="gamelog-dense" class="text-xs text-muted-foreground"
        >Dense</Label
      >
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
  {#if error}
    <div class="p-4"><ErrorNote message={error} /></div>
  {/if}

  {#if loading}
    <div class="space-y-2 p-4">
      {#each [0, 1, 2, 3, 4, 5, 6] as index (index)}
        <Skeleton class="h-9 w-full" />
      {/each}
    </div>
  {:else if all.length === 0}
    <EmptyState
      icon={ScrollTextIcon}
      title="No log lines yet"
      description="vrc.zip tails the VRChat log directory and parses joins, world changes, portals, and screenshots. Start the game and lines appear within a few seconds."
    >
      {#snippet action()}
        <Button variant="outline" href={hrefFor("settings")}
          >Check log directories</Button
        >
      {/snippet}
    </EmptyState>
  {:else if visible.length === 0}
    <EmptyState
      icon={ScrollTextIcon}
      title="Nothing from this client yet"
      description="No parsed lines have been recorded for this client — neither in stored history nor since the page loaded."
    >
      {#snippet action()}
        <Button
          variant="outline"
          onclick={() => {
            choice = ALL;
          }}
        >
          Show every client
        </Button>
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
        {#each day.events as event (event.id)}
          <EventRow {event} dense={prefs.denseFeed} />
        {/each}
      </ul>
    {/each}

    {#if selected === ""}
      <div class="p-4 text-center">
        {#if exhausted}
          <p class="text-sm text-muted-foreground">
            That is every log line vrc.zip still holds. The retention job trims
            older ones.
          </p>
        {:else}
          <Button
            variant="outline"
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
