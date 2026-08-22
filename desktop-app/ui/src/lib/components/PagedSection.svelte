<!--
  One paged list, with everything that surrounds it: the first-page skeleton, the empty state, the
  failure note, the rows, the scroll tripwire, and the quieter reporting for a page that failed
  after some rows were already on screen.

  The group screen has four of these and they differ only in what a row looks like, so the row is a
  snippet and the rest is here. Writing the surroundings four times is how three of them end up
  subtly worse than the first.

  ## Why `forbidden` is a first-class state and not an error

  Most VRChat groups will not show their member list to a non-member, and the honest answer is a
  403. That is a rule about who may look, not a failure of the app, and the two want different
  words: an error invites a retry that cannot possibly work, while "membership required" tells the
  reader something true about the group. The tab still renders either way — a tab that vanishes
  when it 403s reads as a bug in vrc.zip, and a reader who can see the group perfectly well on
  vrchat.com would be right to distrust an app that silently drops it.
-->
<script lang="ts" generics="T extends { readonly id: string }">
import type { LucideIcon } from "@lucide/svelte";
import type { Snippet } from "svelte";
import FailureNote from "$lib/components/FailureNote.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import ScrollSentinel from "$lib/components/ScrollSentinel.svelte";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import type { PagedList } from "$lib/state/paged.svelte.ts";

let {
  list,
  row,
  icon,
  emptyTitle,
  emptyDescription,
  titles,
  bodies,
  skeletonRows = 6,
}: {
  list: PagedList<T>;
  /** How one row draws. The only thing that differs between the four tabs. */
  row: Snippet<[T]>;
  icon?: LucideIcon | undefined;
  emptyTitle: string;
  emptyDescription: string;
  /** Failure headings, keyed by `LoadFailure`. See `FailureNote` for the fallback rule. */
  titles: Readonly<Record<string, string>>;
  bodies: Readonly<Record<string, string>>;
  skeletonRows?: number;
} = $props();
</script>

{#if list.phase === "idle" || list.phase === "loading"}
  <!--
    Skeleton rows rather than a spinner: the height is roughly right, so the list does not jump when
    the first page lands, and a reader can see that what is coming is a list of things.
  -->
  <div class="space-y-2" aria-busy="true">
    {#each Array.from({ length: skeletonRows }) as _, index (index)}
      <Skeleton class="h-14 w-full" />
    {/each}
  </div>
{:else if list.phase === "error"}
  <!--
    No retry on `forbidden`. Membership is not something a second request acquires, and a button
    that cannot work is worse than no button: it invites the reader to conclude the app is broken
    rather than that the group is closed. `exactOptionalPropertyTypes` means the prop has to be
    genuinely absent rather than passed as `undefined`, hence two branches instead of a ternary.
  -->
  {#if list.failure === "forbidden"}
    <FailureNote failure="forbidden" {titles} {bodies} message={list.error} />
  {:else}
    <FailureNote
      failure={list.failure ?? "other"}
      {titles}
      {bodies}
      message={list.error}
      onRetry={() => list.retry()}
    />
  {/if}
{:else if list.isEmpty}
  {#if icon === undefined}
    <EmptyState title={emptyTitle} description={emptyDescription} />
  {:else}
    <EmptyState {icon} title={emptyTitle} description={emptyDescription} />
  {/if}
{:else}
  <ul class="space-y-2">
    <!--
      Keyed by id, and `PagedList` guarantees those are unique: offset paging over a list that is
      being mutated upstream repeats rows, and a duplicate key takes the whole `{#each}` down in
      Svelte 5 rather than warning.
    -->
    {#each list.items as item (item.id)}
      <li>{@render row(item)}</li>
    {/each}
  </ul>

  {#if list.moreError !== null}
    <!--
      A later page failed while earlier ones are on screen. Quiet and inline, with a retry: the rows
      already here are still good, and replacing them with a full-page error would throw away
      everything that did load.
    -->
    <div class="mt-3 flex items-center justify-between gap-3 border border-border bg-muted/40 p-3">
      <p class="text-sm text-muted-foreground">{list.moreError}</p>
      <button
        type="button"
        class="text-sm underline underline-offset-4 hover:text-foreground"
        onclick={() => list.retry()}
      >
        Try again
      </button>
    </div>
  {:else if list.loadingMore}
    <div class="mt-3 space-y-2" aria-busy="true">
      <Skeleton class="h-14 w-full" />
    </div>
  {/if}

  <!--
    Disabled once the list is exhausted or a page is in flight, so an exhausted list at the bottom
    of the viewport does not sit there re-firing the observer forever. `loadMore` guards re-entry
    itself as well; this just avoids the wasted calls.
  -->
  <ScrollSentinel
    enabled={list.hasMore && !list.loadingMore && list.moreError === null}
    onVisible={() => list.loadMore()}
  />
{/if}
