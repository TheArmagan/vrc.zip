<!--
  The feed: everything that happened, newest first, across every account.

  Two sources feed one list. `GET /api/events` is the history, and the socket is everything since
  the page loaded. The daemon writes rows on a 250ms batch timer, so the same event really can be
  in both, and `mergeEvents` de-duplicates on (kind, timestamp, subject) rather than on id.

  ## What changed here, and why

  **Filtering moved into the query.** The family tabs used to be a `.filter()` over the page the
  daemon had already picked, and the tab list itself was counted from that page. Both were wrong in
  the same direction: a family tab showed only what that family contributed to the newest 150 rows,
  and a family with thousands of stored events was offered no tab at all once its rows aged out of
  the window. Families are now a `families=` parameter, kinds a `kinds=` one, and the tab list
  comes from `GET /api/event-kinds`, which describes the store rather than the window.

  **Loading is incremental in both directions.** `EventFeed` pages history on a `before` cursor and
  renders a growing window of what it holds, so the DOM carries what the reader has scrolled past
  rather than every row ever fetched.

  **Runs of identical rows are collapsed to one with a count.** A friend whose connection flaps
  produces a dozen genuine `friend.online` events; printing all twelve is what makes a feed
  unreadable. See `collapseRepeats` for the two rules that keep that honest.
-->
<script lang="ts">
import ActivityIcon from "@lucide/svelte/icons/activity";
import AccountFilter from "$lib/components/AccountFilter.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import EventRow from "$lib/components/EventRow.svelte";
import ScrollSentinel from "$lib/components/ScrollSentinel.svelte";
import SearchField from "$lib/components/SearchField.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import { dateHeading, familyLabel } from "$lib/format.ts";
import { app } from "$lib/state/app.svelte.ts";
import { EventFeed } from "$lib/state/event-feed.svelte.ts";
import { eventKinds } from "$lib/state/event-kinds.svelte.ts";
import { prefs } from "$lib/state/prefs.svelte.ts";

/** bits-ui reads the empty string as "nothing selected", so the "everything" tab needs a name. */
const ALL = "all";

let tab = $state(ALL);
let accountFilter = $state("");
let search = $state("");

const feed = new EventFeed({ live: () => app.liveEvents });

/**
 * The filter set, handed to the feed whenever it changes.
 *
 * `apply` compares before it refetches, so running this effect on every tick is deliberate and
 * cheap — the screen says what it wants and the feed decides whether that is news.
 */
$effect(() => {
  feed.apply({
    ...(accountFilter === "" ? {} : { accountId: accountFilter }),
    ...(tab === ALL ? {} : { families: [tab] }),
    ...(search.trim() === "" ? {} : { search: search.trim() }),
  });
});

$effect(() => {
  eventKinds.ensure();
});

/*
 * Teardown, and nothing else. It reads nothing reactive on purpose, so it runs once and its
 * cleanup runs when the screen goes away.
 *
 * These two were one effect, and the bug that produced was worth writing down: `ensure()` reads
 * `eventKinds.loaded`, so the effect re-ran the moment the catalogue arrived — and re-running an
 * effect runs its cleanup first, which aborted the feed's in-flight first page. The abort landed
 * after the response headers, so it surfaced not as an abort but as a half-read body: "The daemon
 * sent a response this build cannot read", on every load.
 */
$effect(() => () => {
  feed.dispose();
});

const families = $derived(eventKinds.families);
/** The tab bar earns its space only when there is more than one thing to choose between. */
const showTabs = $derived(families.length > 1);

/** Day headings, computed once per render rather than per row. */
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

const filtered = $derived(tab !== ALL || search.trim() !== "" || accountFilter !== "");

/** The selected tab *is* a family name, not a kind — no parsing, just the "everything" case. */
const selectedFamily = $derived(tab === ALL ? null : tab);
</script>

<SectionHeader
  title="Feed"
  count={feed.rows.length}
  description="Newest first, every account"
>
  {#snippet actions()}
    <div class="flex items-center gap-2">
      <Switch
        id="feed-dense"
        size="sm"
        checked={prefs.denseFeed}
        onCheckedChange={(checked) => {
          prefs.setDenseFeed(checked);
        }}
      />
      <Label for="feed-dense" class="text-xs text-muted-foreground">Dense</Label>
    </div>
    <AccountFilter bind:value={accountFilter} />
  {/snippet}
</SectionHeader>

<div
  class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2"
>
  {#if showTabs}
    <div class="min-w-0 flex-1 overflow-x-auto">
      <Tabs.Root bind:value={tab}>
        <Tabs.List variant="line" aria-label="Filter by event kind">
          <Tabs.Trigger value={ALL}>All</Tabs.Trigger>
          {#each families as entry (entry.name)}
            <Tabs.Trigger value={entry.name}>
              {familyLabel(entry.name)}
              <Badge variant="secondary" class="tabular">{entry.count}</Badge>
            </Tabs.Trigger>
          {/each}
        </Tabs.List>
      </Tabs.Root>
    </div>
  {/if}

  <!--
    The search runs in the daemon, over the whole stored history rather than the loaded page. That
    is the difference between a filter and a highlighter, and it is why this sits beside the tabs
    rather than inside the list.
  -->
  <div class="w-full sm:w-64">
    <SearchField
      bind:value={search}
      placeholder="Search names, worlds, messages"
      label="Search the feed"
    />
  </div>
</div>

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if feed.phase === "error"}
    <div class="p-4">
      <ErrorNote message={feed.error ?? "The feed could not be loaded."} />
    </div>
  {:else if feed.phase === "loading" || feed.phase === "idle"}
    <div class="space-y-2 p-4" aria-busy="true">
      {#each [0, 1, 2, 3, 4, 5, 6, 7] as index (index)}
        <Skeleton class="h-10 w-full" />
      {/each}
    </div>
  {:else if feed.isEmpty && !filtered}
    <EmptyState
      icon={ActivityIcon}
      title="Nothing has happened yet"
      description="The feed fills as VRChat pushes events to the daemon: friends coming online, invites arriving, players joining the instance your client is in."
    />
  {:else if feed.isEmpty}
    <EmptyState
      icon={ActivityIcon}
      title="Nothing matches this filter"
      description={selectedFamily === null
        ? "No stored event matches that search, across the whole history vrc.zip holds."
        : `No ${familyLabel(selectedFamily).toLowerCase()} event matches, across the whole history vrc.zip holds.`}
    >
      {#snippet action()}
        <Button
          variant="outline"
          onclick={() => {
            tab = ALL;
            search = "";
            accountFilter = "";
          }}
        >
          Clear the filters
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    {#each days as day (day.heading)}
      <div
        class="sticky top-0 z-[1] border-b border-border bg-background/90 px-4 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase backdrop-blur"
      >
        {day.heading}
      </div>
      <ul class="divide-y divide-border/50">
        <!--
          Keyed on the id of the newest event in the run. Live rows carry synthetic negative ids
          and stored rows carry row ids, so the two never collide — which matters, because a
          duplicate key is a hard runtime error in Svelte 5 rather than a warning.
        -->
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
        <Skeleton class="h-10 w-full" />
        <Skeleton class="h-10 w-full" />
      </div>
    {:else if !feed.hasMore && !feed.hasUnrendered}
      <p class="p-4 text-center text-sm text-muted-foreground">
        That is everything vrc.zip has recorded. Older events are trimmed by the retention job.
      </p>
    {/if}

    <!--
      One tripwire drives both halves: it renders more of what is loaded first, and only asks the
      daemon for another page once the window has caught up. Disabled while a page is in flight or
      failed, so an exhausted list at the bottom of the viewport does not re-fire forever.
    -->
    <ScrollSentinel
      enabled={(feed.hasUnrendered || feed.hasMore) &&
        !feed.loadingMore &&
        feed.moreError === null}
      onVisible={() => feed.advance()}
    />
  {/if}
</div>
