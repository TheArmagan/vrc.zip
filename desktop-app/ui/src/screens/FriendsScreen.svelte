<!--
  Friends, with presence that keeps up.

  Friend rows come from `GET /api/friends`, which reads the daemon's cache rather than VRChat. The
  pipeline pushes `friend.*` frames when anything moves, so the screen refetches on a bumped
  revision instead of polling.

  ## Why this list is not paged, and is still windowed

  Unlike the feed, the whole friend list arrives in one response — it is a presence cache, not
  history, and every row of it is live state that the pipeline can change at any moment. Paging it
  on a cursor would mean a page that goes stale the moment somebody logs in.

  So the *fetch* stays whole and the *render* is windowed: `LIST_STEP` rows at a time, grown by the
  scroll sentinel. A four-thousand-friend account put four thousand avatars, status dots and hover
  cards in the DOM at once, which is the same cost the feed had and the same fix.

  ## What the controls are for

  Sorting by status answers "who can I join right now", which is what this screen is for. The
  status filter and the sort selector exist because that is not the *only* question: "who did I
  used to play with" wants offline friends sorted by when they were last seen, and neither was
  reachable before. Headings group the result so a long list stays scannable.
-->
<script lang="ts">
import SearchIcon from "@lucide/svelte/icons/search";
import UsersIcon from "@lucide/svelte/icons/users";
import { api, describeError, type Friend, type FriendStatus, isAbort } from "$lib/api.ts";
import AccountFilter from "$lib/components/AccountFilter.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import FriendRow from "$lib/components/FriendRow.svelte";
import ScrollSentinel from "$lib/components/ScrollSentinel.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as InputGroup from "$lib/components/ui/input-group/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import { parseLocation, statusLabel } from "$lib/format.ts";
import { app } from "$lib/state/app.svelte.ts";

let friends = $state<Friend[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let query = $state("");
let accountFilter = $state("");

/** `all`, `online` (anything but offline), or one exact status. */
let group = $state("all");
let sort = $state<"status" | "name" | "seen">("status");

/** How many rows render at once, grown by the sentinel. See the note at the top. */
const LIST_STEP = 80;
let renderLimit = $state(LIST_STEP);

$effect(() => {
  // Both are read so the effect re-runs when the filter changes and when a friend frame lands.
  const account = accountFilter;
  void app.friendsRevision;

  const controller = new AbortController();
  void (async () => {
    try {
      friends = await api.friends(account === "" ? undefined : account, controller.signal);
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

/**
 * The render window resets whenever the *result* changes, not whenever the list does.
 *
 * Keyed on the controls rather than on `friends`, deliberately: a friend coming online replaces the
 * array, and resetting the window on that would yank a reader back to the top of the list every
 * time anybody's status changed.
 */
$effect(() => {
  void [query, accountFilter, group, sort];
  renderLimit = LIST_STEP;
});

/** Join-me first, then the rest of the online statuses, then offline. */
const RANK: Readonly<Record<string, number>> = {
  "join me": 0,
  active: 1,
  "ask me": 2,
  busy: 3,
  offline: 4,
};

/*
 * Where your own clients are standing right now.
 *
 * From the game log, not from VRChat: `sessions.current_location` is written by the log watcher as
 * the client writes `Joining wrld_…`, which is the only source that knows what *this machine* is
 * doing. Several clients can be up at once, so it is a set rather than a location.
 */
const myLocations = $derived(
  new Set(
    app.sessions
      .map((session) => session.currentLocation)
      .filter((location): location is string => location !== null && location !== ""),
  ),
);

/** True for a friend standing in an instance one of your clients is also in. */
function isHere(friend: Friend): boolean {
  return friend.location !== null && friend.location !== "" && myLocations.has(friend.location);
}

/**
 * True for a friend in a *place*, as against merely online.
 *
 * `parseLocation` calls `private`, `offline`, `traveling` and the empty string opaque: VRChat is
 * saying there is somewhere, but not where. Those are not "in a world" for this purpose, because
 * the question this section answers is "who could I be standing next to in a minute".
 */
function isInWorld(friend: Friend): boolean {
  return friend.status !== "offline" && !parseLocation(friend.location).opaque;
}

/** The statuses offered as tabs, with counts, so a filter is never a dead chip. */
const counts = $derived.by(() => {
  const byStatus = new Map<string, number>();
  for (const friend of friends) {
    byStatus.set(friend.status, (byStatus.get(friend.status) ?? 0) + 1);
  }
  return byStatus;
});

const onlineCount = $derived(friends.filter((friend) => friend.status !== "offline").length);

const statusTabs = $derived(
  (["join me", "active", "ask me", "busy", "offline"] as FriendStatus[])
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => ({ status, count: counts.get(status) ?? 0 })),
);

const hereCount = $derived(friends.filter(isHere).length);
const inWorldCount = $derived(friends.filter(isInWorld).length);

const matching = $derived.by(() => {
  const needle = query.trim().toLowerCase();
  return friends.filter((friend) => {
    if (group === "online" && friend.status === "offline") return false;
    if (group === "same-world" && !isHere(friend)) return false;
    if (group === "in-world" && !isInWorld(friend)) return false;
    if (
      group !== "all" &&
      group !== "online" &&
      group !== "same-world" &&
      group !== "in-world" &&
      friend.status !== group
    ) {
      return false;
    }
    if (needle === "") return true;
    // Name and status message. Not the location: it is a `wrld_…` id nobody types, and matching it
    // would make a search for "us" hit every friend in a US region.
    return (
      friend.displayName.toLowerCase().includes(needle) ||
      (friend.statusDescription ?? "").toLowerCase().includes(needle)
    );
  });
});

const visible = $derived.by(() =>
  matching.toSorted((a, b) => {
    if (sort === "name") return a.displayName.localeCompare(b.displayName);
    if (sort === "seen") {
      // Never seen sorts last rather than as "infinitely long ago" — an unknown is not a fact
      // about when somebody was last around.
      const left = a.lastSeenAt ?? -1;
      const right = b.lastSeenAt ?? -1;
      return right - left || a.displayName.localeCompare(b.displayName);
    }
    return (
      (RANK[a.status] ?? 5) - (RANK[b.status] ?? 5) || a.displayName.localeCompare(b.displayName)
    );
  }),
);

const windowed = $derived(visible.slice(0, renderLimit));
const hasUnrendered = $derived(visible.length > renderLimit);

/**
 * Section headings, and only when sorting by status.
 *
 * Under any other sort the rows are not grouped by status at all, so a heading would be a lie
 * about what follows it.
 *
 * "In your world" is pinned above the status groups rather than mixed into them, because it is the
 * one answer nobody has to act on: those friends are already standing next to you. It cannot be
 * derived from status — a friend in your instance shows as `active` like every other online
 * friend — so without a section of its own the fact is simply not on the screen anywhere.
 */
const sections = $derived.by(() => {
  if (sort !== "status") return [{ heading: null, rows: windowed }];

  // Built from the remainder and then prepended, rather than by special-casing the run inside one
  // loop: the pinned section is not a status group, and letting it be the "previous heading" a
  // status group could append into is how a subtle grouping bug gets in.
  const byStatus: { heading: string | null; rows: Friend[] }[] = [];
  for (const friend of windowed) {
    if (isHere(friend)) continue;
    const heading = statusLabel(friend.status);
    const last = byStatus.at(-1);
    if (last !== undefined && last.heading === heading) last.rows.push(friend);
    else byStatus.push({ heading, rows: [friend] });
  }

  const here = windowed.filter(isHere);
  return here.length === 0 ? byStatus : [{ heading: "In your world", rows: here }, ...byStatus];
});

const SORT_LABELS: Readonly<Record<string, string>> = {
  status: "Sort by status",
  name: "Sort by name",
  seen: "Sort by last seen",
};

function clearFilters(): void {
  query = "";
  group = "all";
}
</script>

<SectionHeader
  title="Friends"
  count={friends.length}
  description={`${String(onlineCount)} online right now`}
>
  {#snippet actions()}
    <Select.Root type="single" bind:value={sort}>
      <Select.Trigger size="sm" class="w-40" aria-label="Sort friends">
        {SORT_LABELS[sort] ?? "Sort"}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="status" label="Sort by status" />
        <Select.Item value="name" label="Sort by name" />
        <Select.Item value="seen" label="Sort by last seen" />
      </Select.Content>
    </Select.Root>
    <AccountFilter bind:value={accountFilter} />
    <InputGroup.Root class="h-8 w-52">
      <InputGroup.Addon>
        <SearchIcon />
      </InputGroup.Addon>
      <InputGroup.Input
        bind:value={query}
        name="filter"
        type="search"
        placeholder="Filter friends"
        aria-label="Filter friends"
        class="h-8 text-sm"
      />
    </InputGroup.Root>
  {/snippet}
</SectionHeader>

{#if statusTabs.length > 1}
  <!-- `overflow-y-hidden` for the reason in `FeedScreen`: one axis set makes the other `auto`. -->
  <div class="shrink-0 overflow-x-auto overflow-y-hidden border-b border-border px-4 py-2">
    <Tabs.Root bind:value={group}>
      <Tabs.List variant="line" aria-label="Filter by presence">
        <Tabs.Trigger value="all">
          All
          <Badge variant="secondary" class="tabular">{friends.length}</Badge>
        </Tabs.Trigger>
        <Tabs.Trigger value="online">
          Online
          <Badge variant="secondary" class="tabular">{onlineCount}</Badge>
        </Tabs.Trigger>
        <!--
          Offered only when there is something behind them. "In your world" needs a client running
          and a friend in it; a tab that can never match anything is worse than no tab, because
          clicking it looks like the list broke.
        -->
        {#if hereCount > 0}
          <Tabs.Trigger value="same-world">
            In your world
            <Badge variant="secondary" class="tabular">{hereCount}</Badge>
          </Tabs.Trigger>
        {/if}
        {#if inWorldCount > 0}
          <Tabs.Trigger value="in-world">
            In a world
            <Badge variant="secondary" class="tabular">{inWorldCount}</Badge>
          </Tabs.Trigger>
        {/if}
        {#each statusTabs as entry (entry.status)}
          <Tabs.Trigger value={entry.status}>
            {statusLabel(entry.status)}
            <Badge variant="secondary" class="tabular">{entry.count}</Badge>
          </Tabs.Trigger>
        {/each}
      </Tabs.List>
    </Tabs.Root>
  </div>
{/if}

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if error}
    <div class="p-4"><ErrorNote message={error} /></div>
  {/if}

  {#if loading}
    <div class="space-y-2 p-4" aria-busy="true">
      {#each [0, 1, 2, 3, 4, 5] as index (index)}
        <Skeleton class="h-14 w-full" />
      {/each}
    </div>
  {:else if app.accounts.length === 0}
    <EmptyState
      icon={UsersIcon}
      title="No accounts signed in"
      description="Friend presence comes from VRChat's pipeline socket, which needs a signed-in account. Add one and this fills in within seconds."
    />
  {:else if friends.length === 0}
    <EmptyState
      icon={UsersIcon}
      title="No friends cached yet"
      description="vrc.zip builds this list from the pipeline socket as friends come and go. If an account has just signed in, give it a moment."
    />
  {:else if visible.length === 0}
    <EmptyState
      icon={SearchIcon}
      title="Nothing matches that filter"
      description={`None of the ${String(friends.length)} cached friends match.`}
    >
      {#snippet action()}
        <Button variant="outline" onclick={clearFilters}>Clear the filters</Button>
      {/snippet}
    </EmptyState>
  {:else}
    {#each sections as section, index (section.heading ?? index)}
      {#if section.heading !== null}
        <div
          class="sticky top-0 z-[1] border-b border-border bg-background/90 px-4 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase backdrop-blur"
        >
          {section.heading}
        </div>
      {/if}
      <ul class="divide-y divide-border">
        {#each section.rows as friend (friend.id)}
          <FriendRow {friend} accountId={accountFilter === "" ? null : accountFilter} />
        {/each}
      </ul>
    {/each}

    {#if hasUnrendered}
      <p class="p-4 text-center text-sm text-muted-foreground">
        Showing {windowed.length} of {visible.length}. Keep scrolling for the rest.
      </p>
    {/if}

    <!--
      Nothing to fetch here — the whole list is already in memory — so the sentinel only ever grows
      the render window. It stops firing once everything is on screen.
    -->
    <ScrollSentinel
      enabled={hasUnrendered}
      onVisible={() => {
        renderLimit += LIST_STEP;
      }}
    />
  {/if}
</div>
