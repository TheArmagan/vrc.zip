<!--
  Friends, with presence that keeps up.

  Friend rows come from `GET /api/friends`, which reads the daemon's cache rather than VRChat. The
  pipeline pushes `friend.*` frames when anything moves, so the screen refetches on a bumped
  revision instead of polling. Sorting is by status first, because "who can I join right now" is
  the question this screen exists to answer.
-->
<script lang="ts">
import { Search01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/svelte";
import { api, describeError, type Friend, isAbort } from "$lib/api.ts";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import LocationLine from "$lib/components/LocationLine.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import StatusDot from "$lib/components/StatusDot.svelte";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { platformLabel, statusLabel } from "$lib/format.ts";
import { app } from "$lib/state/app.svelte.ts";

let friends = $state<Friend[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let query = $state("");
let accountFilter = $state("");

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

/** Join-me first, then the rest of the online statuses, then offline. */
const RANK: Readonly<Record<string, number>> = {
  "join me": 0,
  active: 1,
  "ask me": 2,
  busy: 3,
  offline: 4,
};

const visible = $derived.by(() => {
  const needle = query.trim().toLowerCase();
  return friends
    .filter(
      (friend) =>
        needle === "" ||
        friend.displayName.toLowerCase().includes(needle) ||
        (friend.statusDescription ?? "").toLowerCase().includes(needle),
    )
    .toSorted(
      (a, b) =>
        (RANK[a.status] ?? 5) - (RANK[b.status] ?? 5) ||
        a.displayName.localeCompare(b.displayName),
    );
});

const onlineCount = $derived(friends.filter((friend) => friend.status !== "offline").length);
</script>

<SectionHeader
  title="Friends"
  count={friends.length}
  description={`${String(onlineCount)} online right now`}
>
  {#snippet actions()}
    <div class="flex items-center gap-2">
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
      <div class="flex h-7 items-center gap-1.5 border border-border bg-input/30 px-2">
        <HugeiconsIcon icon={Search01Icon} size={12} class="text-muted-foreground" />
        <input
          bind:value={query}
          type="search"
          placeholder="Filter friends"
          aria-label="Filter friends"
          class="w-36 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
    </div>
  {/snippet}
</SectionHeader>

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if error}
    <div class="p-4"><ErrorNote message={error} /></div>
  {/if}

  {#if loading}
    <div class="space-y-px p-4">
      {#each [0, 1, 2, 3, 4, 5] as index (index)}
        <Skeleton class="h-12 w-full" />
      {/each}
    </div>
  {:else if app.accounts.length === 0}
    <EmptyState
      icon={UserGroupIcon}
      title="No accounts signed in"
      description="Friend presence comes from VRChat's pipeline socket, which needs a signed-in account. Add one and this fills in within seconds."
    />
  {:else if friends.length === 0}
    <EmptyState
      icon={UserGroupIcon}
      title="No friends cached yet"
      description="vrc.zip builds this list from the pipeline socket as friends come and go. If an account has just signed in, give it a moment."
    />
  {:else if visible.length === 0}
    <EmptyState
      icon={Search01Icon}
      title="Nothing matches that filter"
      description={`None of the ${String(friends.length)} cached friends match "${query}".`}
    />
  {:else}
    <ul class="divide-y divide-border">
      {#each visible as friend (friend.id)}
        {@const platform = platformLabel(friend.platform)}
        <li class="flex items-center gap-3 px-5 py-2.5">
          <StatusDot status={friend.status} size={9} />

          <div class="min-w-0 flex-1">
            <p class="truncate text-sm">{friend.displayName}</p>
            {#if friend.statusDescription}
              <p class="truncate text-[11px] text-muted-foreground">
                {friend.statusDescription}
              </p>
            {/if}
          </div>

          <div class="hidden min-w-0 flex-1 sm:block">
            {#if friend.status === "offline"}
              <p class="text-xs text-muted-foreground">
                {#if friend.lastSeenAt !== null}
                  Last seen <RelativeTime ts={friend.lastSeenAt} />
                {:else}
                  Offline
                {/if}
              </p>
            {:else}
              <LocationLine location={friend.location} />
            {/if}
          </div>

          <span class="w-20 shrink-0 text-right text-[11px] text-muted-foreground">
            {statusLabel(friend.status)}
          </span>

          <span class="tabular w-10 shrink-0 text-right text-[10px] text-muted-foreground">
            {platform ?? ""}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
