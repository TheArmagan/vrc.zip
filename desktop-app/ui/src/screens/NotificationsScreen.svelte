<!--
  The VRChat notification inbox.

  Rows are never deleted, only marked seen. VRChat's `clear-notification` frame arrives with no
  content at all, so the daemon cannot know which rows it meant and refuses to guess. That is the
  right call, and it is why this screen filters on `seen` and defaults to hiding what has been
  read, instead of waiting for rows to vanish.

  ## What changed, and why

  **The filters were browser-side over a fixed window.** `GET /api/notifications` took no parameters
  and answered with fifty rows per account; "show read" and the account filter then narrowed *that*
  in JS. So both searched only the newest fifty, and the fifty-first notification on a busy account
  could not be reached from the UI at all. Every filter is now a query parameter, and paging is a
  `before` cursor with a scroll sentinel — the same shape as the feed and the game log.

  **Rows said less than the payload held.** A group announcement's title lives in `data.title` and
  was never shown; an invite's world lives in `data.worldId` and was never shown; a vote-to-kick
  read exactly like a friend request. `notification-details.ts` reads those, and a row expands to
  the full message and the raw payload for the ones that do not fit on a line.
-->
<script lang="ts">
import BellIcon from "@lucide/svelte/icons/bell";
import CheckIcon from "@lucide/svelte/icons/check";
import AccountFilter from "$lib/components/AccountFilter.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import NotificationRow from "$lib/components/NotificationRow.svelte";
import ScrollSentinel from "$lib/components/ScrollSentinel.svelte";
import SearchField from "$lib/components/SearchField.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import { dateHeading } from "$lib/format.ts";
import { notificationTypeLabel } from "$lib/notification-details.ts";
import { app } from "$lib/state/app.svelte.ts";
import { NotificationFeed } from "$lib/state/notification-feed.svelte.ts";
import { notificationTypes } from "$lib/state/notification-types.svelte.ts";
import { prefs } from "$lib/state/prefs.svelte.ts";

let showSeen = $state(false);
let accountFilter = $state("");
let search = $state("");
/** Types the reader has ticked. Empty means every type. */
let picked = $state<string[]>([]);

const feed = new NotificationFeed();

$effect(() => {
  feed.apply({
    ...(accountFilter === "" ? {} : { accountId: accountFilter }),
    ...(picked.length === 0 ? {} : { types: picked }),
    // Tri-state on the wire: absent shows both. "Show read" off means unread only, which is a
    // predicate the daemon can apply — not a `.filter()` over rows it already chose to send.
    ...(showSeen ? {} : { seen: false }),
    ...(search.trim() === "" ? {} : { search: search.trim() }),
  });
});

$effect(() => {
  notificationTypes.ensure();
});

/** Teardown only. See the same split in `FeedScreen` for why it is its own effect. */
$effect(() => () => {
  feed.dispose();
});

const unseenCount = $derived(app.unseenNotifications.length);
const filtered = $derived(
  picked.length > 0 || search.trim() !== "" || accountFilter !== "" || !showSeen,
);

const typesLabel = $derived(
  picked.length === 0
    ? "All types"
    : picked.length === 1
      ? notificationTypeLabel(picked[0] ?? "")
      : `${String(picked.length)} types`,
);

/** Day headings, computed once per render rather than per row. */
const days = $derived.by(() => {
  const out: { heading: string; items: typeof feed.visible }[] = [];
  for (const item of feed.visible) {
    const heading = dateHeading(item.ts);
    const last = out.at(-1);
    if (last !== undefined && last.heading === heading) last.items.push(item);
    else out.push({ heading, items: [item] });
  }
  return out;
});

function toggleType(type: string): void {
  picked = picked.includes(type) ? picked.filter((entry) => entry !== type) : [...picked, type];
}

function clearFilters(): void {
  picked = [];
  search = "";
  accountFilter = "";
  showSeen = true;
}

/**
 * Marks everything the *shell* knows is unread.
 *
 * Deliberately not "everything matching the filter": that could be thousands of rows the screen
 * has never loaded, and a button that fires an unbounded number of requests is not a button. The
 * shell's list is the newest few hundred, which is what "all" means to someone looking at a badge.
 */
async function markAllSeen(): Promise<void> {
  const pending = app.unseenNotifications.map((item) => item.id);
  await Promise.all(pending.map((id) => feed.markSeen(id)));
}
</script>

<SectionHeader
  title="Notifications"
  count={feed.rows.length}
  description={unseenCount === 0 ? "Nothing unread" : `${String(unseenCount)} unread`}
>
  {#snippet actions()}
    <div class="flex items-center gap-2">
      <Switch id="show-read" size="sm" bind:checked={showSeen} />
      <Label for="show-read" class="text-xs text-muted-foreground">Show read</Label>
    </div>
    <AccountFilter bind:value={accountFilter} />
    {#if unseenCount > 0}
      <Button size="sm" variant="outline" onclick={() => void markAllSeen()}>
        <CheckIcon />
        Mark all read
      </Button>
    {/if}
  {/snippet}
</SectionHeader>

<div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
  <Select.Root type="multiple" bind:value={picked}>
    <Select.Trigger size="sm" class="w-44" aria-label="Filter by notification type">
      {typesLabel}
    </Select.Trigger>
    <Select.Content>
      {#each notificationTypes.types as entry (entry.type)}
        <Select.Item
          value={entry.type}
          label={`${notificationTypeLabel(entry.type)} (${String(entry.count)})`}
        />
      {/each}
    </Select.Content>
  </Select.Root>

  {#if picked.length > 0}
    <div class="flex flex-wrap items-center gap-1">
      {#each picked as type (type)}
        <button
          type="button"
          class="rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
          onclick={() => toggleType(type)}
          title="Stop filtering by this type"
        >
          {notificationTypeLabel(type)} ×
        </button>
      {/each}
    </div>
  {/if}

  <div class="ml-auto w-full sm:w-64">
    <SearchField
      bind:value={search}
      placeholder="Search senders and messages"
      label="Search notifications"
    />
  </div>
</div>

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if feed.phase === "error"}
    <div class="p-4">
      <ErrorNote message={feed.error ?? "The inbox could not be loaded."} />
    </div>
  {:else if feed.phase === "loading" || feed.phase === "idle"}
    <div class="space-y-2 p-4" aria-busy="true">
      {#each [0, 1, 2, 3] as index (index)}
        <Skeleton class="h-16 w-full" />
      {/each}
    </div>
  {:else if feed.isEmpty && !filtered}
    <EmptyState
      icon={BellIcon}
      title="Your inbox is empty"
      description="Invites, friend requests, and group announcements land here as VRChat pushes them to the daemon."
    />
  {:else if feed.isEmpty && !showSeen && picked.length === 0 && search.trim() === ""}
    <EmptyState
      icon={CheckIcon}
      title="Everything is read"
      description="Read notifications are kept rather than deleted, because VRChat's clear signal does not say which ones it meant."
    >
      {#snippet action()}
        <Button
          variant="outline"
          onclick={() => {
            showSeen = true;
          }}
        >
          Show read notifications
        </Button>
      {/snippet}
    </EmptyState>
  {:else if feed.isEmpty}
    <EmptyState
      icon={BellIcon}
      title="Nothing matches this filter"
      description="No notification matches, across the whole inbox vrc.zip holds."
    >
      {#snippet action()}
        <Button variant="outline" onclick={clearFilters}>Clear the filters</Button>
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
        {#each day.items as item (item.id)}
          <NotificationRow
            {item}
            dense={prefs.denseFeed}
            onMarkSeen={(id) => void feed.markSeen(id)}
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
        <Skeleton class="h-16 w-full" />
      </div>
    {:else if !feed.hasMore && !feed.hasUnrendered}
      <p class="p-4 text-center text-sm text-muted-foreground">
        That is the whole inbox vrc.zip holds. Answering an invite or a friend request still happens
        in VRChat; this reads the inbox and tracks what you have read.
      </p>
    {/if}

    <ScrollSentinel
      enabled={(feed.hasUnrendered || feed.hasMore) && !feed.loadingMore && feed.moreError === null}
      onVisible={() => feed.advance()}
    />
  {/if}
</div>
