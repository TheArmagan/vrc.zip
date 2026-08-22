<!--
  One instance of a world, as a selectable row in the world modal's Instances tab.

  The row is a real `<button>` rather than a clickable `<li>`: choosing an instance is the whole
  point of the row, so it should be one target, reachable from a keyboard, and announced as a
  control. The join affordance sits *outside* that button for the reason the feed rows learned —
  nesting one control inside another gives a click two answers.

  ## What the row is allowed to claim

  Only what vrc.zip can see. `friends` is who of your friends the presence cache puts in this room,
  which is a floor and never a total: a public instance with forty strangers and one friend reads
  as "1 friend here", and that is the honest number to print. The live occupancy is not shown here
  at all, because it would cost a request per row — it appears in the panel above once a row is
  selected, which is a person asking.
-->
<script lang="ts">
import HouseIcon from "@lucide/svelte/icons/house";
import UsersIcon from "@lucide/svelte/icons/users";
import { imageUrl, type WorldInstanceSummary } from "$lib/api.ts";
import JoinAffordance from "$lib/components/JoinAffordance.svelte";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "$lib/components/ui/avatar/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { accessLabel, initials, parseLocation } from "$lib/format.ts";

let {
  instance,
  selected,
  youAreHere,
  accountId = null,
  onSelect,
}: {
  instance: WorldInstanceSummary;
  selected: boolean;
  /** One of this machine's clients is standing in this instance. */
  youAreHere: boolean;
  accountId?: string | null;
  onSelect: (location: string) => void;
} = $props();

const parsed = $derived(parseLocation(instance.location));

/** At most four faces, because the row is one line and the rest are named in the count. */
const shown = $derived(instance.friends.slice(0, 4));
const overflow = $derived(instance.friends.length - shown.length);
</script>

<div
  class="flex items-center gap-2 border px-2 py-2 {selected
    ? 'border-primary/60 bg-muted/60'
    : 'border-border bg-transparent'}"
>
  <button
    type="button"
    class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    aria-current={selected ? "true" : undefined}
    onclick={() => onSelect(instance.location)}
  >
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="flex flex-wrap items-center gap-2">
        <span class="tabular text-sm font-medium">{parsed.label}</span>
        <Badge variant="outline" class="tracking-wide uppercase">
          {accessLabel(parsed.access)}
        </Badge>
        {#if parsed.region}
          <span class="text-xs tracking-wide text-muted-foreground uppercase">{parsed.region}</span>
        {/if}
        {#if youAreHere}
          <!--
            The one badge on this row that is not about other people. It is drawn from the game log,
            so it is a fact about this machine rather than something VRChat was asked.
          -->
          <Badge
            variant="outline"
            class="border-status-online/40 bg-status-online/10 text-status-online"
          >
            <HouseIcon />
            You are here
          </Badge>
        {/if}
      </span>

      <span class="flex min-w-0 items-center gap-2">
        {#if instance.friends.length > 0}
          <span class="flex -space-x-1.5">
            <!--
              Keyed by user id, which the daemon deduplicates across accounts before sending. A
              duplicate key is a hard runtime error in Svelte 5, not a repeated face.
            -->
            {#each shown as friend (friend.id)}
              <Avatar class="size-5 ring-1 ring-background">
                <AvatarImage src={imageUrl(friend.iconUrl)} alt="" loading="lazy" />
                <AvatarFallback class="text-[8px]">{initials(friend.displayName)}</AvatarFallback>
              </Avatar>
            {/each}
          </span>
          <span class="min-w-0 truncate text-xs text-muted-foreground">
            {instance.friends.map((friend) => friend.displayName).join(", ")}
          </span>
          {#if overflow > 0}
            <span class="tabular shrink-0 text-xs text-muted-foreground">+{overflow}</span>
          {/if}
        {:else}
          <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <UsersIcon class="size-3.5" />
            No friends here
          </span>
        {/if}
      </span>
    </div>
  </button>

  <JoinAffordance location={instance.location} {accountId} class="shrink-0 text-xs" />
</div>
