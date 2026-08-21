<!--
  The feed: everything that happened, newest first, across every account.

  Two sources feed one list. `GET /api/events` is the history, and the socket is everything since
  the page loaded. The daemon writes rows on a 250ms batch timer, so the same event really can be
  in both, and `mergeEvents` de-duplicates on (kind, timestamp, subject) rather than on id.

  Filtering is by family (`friend`, `gamelog`, …) rather than by exact kind. The daemon's `kind`
  query parameter is an exact match with no prefix support, so family filtering happens here.
-->
<script lang="ts">
import { Activity03Icon } from "@hugeicons/core-free-icons";
import { api, describeError, EVENT_FAMILIES, familyOf, isAbort } from "$lib/api.ts";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import EventRow from "$lib/components/EventRow.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { type LiveEvent, mergeEvents, rowToEvent } from "$lib/events.ts";
import { dateHeading, familyLabel } from "$lib/format.ts";
import { app } from "$lib/state/app.svelte.ts";
import { prefs } from "$lib/state/prefs.svelte.ts";

const PAGE_SIZE = 150;

let stored = $state<LiveEvent[]>([]);
let loading = $state(true);
let loadingMore = $state(false);
let exhausted = $state(false);
let error = $state<string | null>(null);
let family = $state("");
let accountFilter = $state("");

$effect(() => {
  const account = accountFilter;
  const controller = new AbortController();
  loading = true;
  exhausted = false;

  void (async () => {
    try {
      const rows = await api.events(
        { limit: PAGE_SIZE, ...(account === "" ? {} : { accountId: account }) },
        controller.signal,
      );
      stored = rows.map(rowToEvent);
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

const live = $derived(
  app.liveEvents.filter(
    (event) => accountFilter === "" || event.accountId === accountFilter,
  ),
);

const merged = $derived(mergeEvents(stored, live));
const visible = $derived(
  family === "" ? merged : merged.filter((event) => familyOf(event.kind) === family),
);

/** Day headings, computed once per render rather than per row. */
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

/** Only families that actually occur are offered, so the filter row is never a wall of dead chips. */
const presentFamilies = $derived.by(() => {
  const counts = new Map<string, number>();
  for (const event of merged) {
    const key = familyOf(event.kind);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return EVENT_FAMILIES.filter((name) => counts.has(name)).map((name) => ({
    name,
    count: counts.get(name) ?? 0,
  }));
});

async function loadMore(): Promise<void> {
  const oldest = stored.at(-1);
  if (oldest === undefined || loadingMore || exhausted) return;
  loadingMore = true;
  try {
    const rows = await api.events({
      limit: PAGE_SIZE,
      before: oldest.ts,
      ...(accountFilter === "" ? {} : { accountId: accountFilter }),
    });
    stored = [...stored, ...rows.map(rowToEvent)];
    exhausted = rows.length < PAGE_SIZE;
  } catch (cause) {
    error = describeError(cause);
  } finally {
    loadingMore = false;
  }
}
</script>

<SectionHeader title="Feed" count={visible.length} description="Newest first, every account">
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
      {#if app.accounts.length > 1}
        <select
          bind:value={accountFilter}
          aria-label="Filter by account"
          class="h-7 border border-border bg-input/30 px-2 text-xs outline-none
                 focus-visible:border-ring"
        >
          <option value="">All accounts</option>
          {#each app.accounts as account (account.id)}
            <option value={account.id}>{account.displayName}</option>
          {/each}
        </select>
      {/if}
    </div>
  {/snippet}
</SectionHeader>

{#if presentFamilies.length > 1}
  <div
    class="flex flex-wrap items-center gap-1 border-b border-border px-5 py-2"
    role="group"
    aria-label="Filter by event kind"
  >
    <button
      type="button"
      onclick={() => {
        family = "";
      }}
      aria-pressed={family === ""}
      class="border px-2 py-0.5 text-[11px] {family === ''
        ? 'border-primary bg-primary text-primary-foreground'
        : 'border-border text-muted-foreground hover:bg-muted'}"
    >
      All {merged.length}
    </button>
    {#each presentFamilies as entry (entry.name)}
      <button
        type="button"
        onclick={() => {
          family = entry.name;
        }}
        aria-pressed={family === entry.name}
        class="border px-2 py-0.5 text-[11px] {family === entry.name
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-muted'}"
      >
        {familyLabel(entry.name)}
        <span class="tabular opacity-70">{entry.count}</span>
      </button>
    {/each}
  </div>
{/if}

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if error}
    <div class="p-4"><ErrorNote message={error} /></div>
  {/if}

  {#if loading}
    <div class="space-y-px p-4">
      {#each [0, 1, 2, 3, 4, 5, 6, 7] as index (index)}
        <Skeleton class="h-9 w-full" />
      {/each}
    </div>
  {:else if merged.length === 0}
    <EmptyState
      icon={Activity03Icon}
      title="Nothing has happened yet"
      description="The feed fills as VRChat pushes events to the daemon: friends coming online, invites arriving, players joining the instance your client is in."
    />
  {:else if visible.length === 0}
    <EmptyState
      icon={Activity03Icon}
      title={`No ${familyLabel(family).toLowerCase()} events`}
      description="Nothing of that kind is in the loaded window. Clear the filter, or load more history."
    />
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

    <div class="p-4 text-center">
      {#if exhausted}
        <p class="text-xs text-muted-foreground">
          That is everything vrc.zip has recorded. Older events are trimmed by the retention job.
        </p>
      {:else}
        <Button variant="outline" size="sm" disabled={loadingMore} onclick={() => void loadMore()}>
          {loadingMore ? "Loading" : "Load older events"}
        </Button>
      {/if}
    </div>
  {/if}
</div>
