<!--
  Friends, with presence that keeps up.

  Friend rows come from `GET /api/friends`, which reads the daemon's cache rather than VRChat. The
  pipeline pushes `friend.*` frames when anything moves, so the screen refetches on a bumped
  revision instead of polling. Sorting is by status first, because "who can I join right now" is
  the question this screen exists to answer.
-->
<script lang="ts">
import SearchIcon from "@lucide/svelte/icons/search";
import UsersIcon from "@lucide/svelte/icons/users";
import { api, describeError, type Friend, imageUrl, isAbort } from "$lib/api.ts";
import AccountFilter from "$lib/components/AccountFilter.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import LocationLine from "$lib/components/LocationLine.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import StatusDot from "$lib/components/StatusDot.svelte";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from "$lib/components/ui/avatar/index.js";
import * as InputGroup from "$lib/components/ui/input-group/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { initials, platformLabel, statusLabel } from "$lib/format.ts";
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

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if error}
    <div class="p-4"><ErrorNote message={error} /></div>
  {/if}

  {#if loading}
    <div class="space-y-2 p-4">
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
      description={`None of the ${String(friends.length)} cached friends match "${query}".`}
    />
  {:else}
    <ul class="divide-y divide-border">
      {#each visible as friend (friend.id)}
        {@const platform = platformLabel(friend.platform)}
        <li class="flex items-center gap-3 px-4 py-3">
          <!--
            alt="" on purpose: the display name is right there in the next column, so a screen
            reader announcing the icon as well would just read the name twice. The presence dot
            is aria-hidden for the same reason — the status word is spelled out further along
            the row, so colour is never the only signal.
          -->
          <Avatar class="size-9">
            <AvatarImage src={imageUrl(friend.iconUrl)} alt="" loading="lazy" />
            <AvatarFallback class="text-xs">{initials(friend.displayName)}</AvatarFallback>
            <AvatarBadge class="bg-transparent ring-background">
              <StatusDot status={friend.status} size={null} class="size-full" />
            </AvatarBadge>
          </Avatar>

          <div class="min-w-0 flex-1">
            <p class="truncate text-sm">{friend.displayName}</p>
            {#if friend.statusDescription}
              <p class="truncate text-xs text-muted-foreground">{friend.statusDescription}</p>
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
              <!--
                The account filter is the only thing that says which of your accounts this
                friend was seen through, and that is what decides which running client gets
                invited when more than one is up. Empty filter means "all accounts", so there
                is no context and `planJoin` falls back to the single running client.
              -->
              <LocationLine
                location={friend.location}
                accountId={accountFilter === "" ? null : accountFilter}
              />
            {/if}
          </div>

          <span class="w-24 shrink-0 text-right text-xs text-muted-foreground">
            {statusLabel(friend.status)}
          </span>

          <span class="tabular w-12 shrink-0 text-right text-xs text-muted-foreground">
            {platform ?? ""}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
