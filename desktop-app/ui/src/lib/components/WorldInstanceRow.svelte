<!--
  One instance of a world, as a selectable row in the world modal's Instances tab.

  ## Two controls, side by side, never nested

  The row has three jobs — select this instance, join it, and open one of the people in it — and a
  control cannot contain another control. So the selecting `<button>` covers the identity line only,
  the join affordance sits beside it, and the friends are their own `UserName` buttons on a second
  line *outside* the selecting button.

  The first version put the friends' names inside the selecting button as plain text, which made
  them unclickable and, worse, unreachable: a `<button>` inside a `<button>` is invalid markup that
  browsers resolve by dropping one of them. Naming a person and then refusing to open them is the
  one thing this row must not do, because every other list in the app does open them.

  ## What the row is allowed to claim

  `userCount` is VRChat's own head count and is the honest number when there is one. `friends` is a
  *floor*, never a total: a public room with forty strangers and one friend in it has one friend
  vrc.zip can see. Where VRChat gave no count the row says nothing rather than printing the friend
  count as though it were the occupancy.
-->
<script lang="ts">
import { untrack } from "svelte";
import HouseIcon from "@lucide/svelte/icons/house";
import UsersIcon from "@lucide/svelte/icons/users";
import { instanceInfo } from "$lib/state/instance-info.svelte.ts";
import { imageUrl, type WorldInstanceSummary } from "$lib/api.ts";
import JoinAffordance from "$lib/components/JoinAffordance.svelte";
import UserName from "$lib/components/UserName.svelte";
import { Avatar, AvatarFallback, AvatarImage } from "$lib/components/ui/avatar/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { accessLabel, initials, parseLocation } from "$lib/format.ts";

let {
  instance,
  selected,
  youAreHere,
  accountsConsulted,
  accountId = null,
  onSelect,
}: {
  instance: WorldInstanceSummary;
  selected: boolean;
  /** One of this machine's clients is standing in this instance. */
  youAreHere: boolean;
  /** How many signed-in accounts were asked, so "some of them" can be told from "all of them". */
  accountsConsulted: number;
  accountId?: string | null;
  onSelect: (location: string) => void;
} = $props();

const parsed = $derived(parseLocation(instance.location));

/*
 * Each row reads its own instance record, for the name and the live head count.
 *
 * The world record's `instances` gives a count only for the instances VRChat chose to list, and
 * nothing at all for a room revealed by a friend's presence — so without this the count is missing
 * on exactly the rows this app knows most about. It also carries `displayName`, which is the only
 * source of "Movie Night" rather than "#12345".
 *
 * Safe to start from render because `instance-info.svelte.ts` queues: `ensure` joins a queue that
 * drains three at a time, dedupes identical locations, caches for `FRESH_MS`, and latches a closed
 * instance so it is never asked about twice. `untrack` because `ensure` reads the resolver's map to
 * decide, and a tracked read would make this effect re-run on its own result.
 */
$effect(() => {
  const location = instance.location;
  const account = accountId;
  untrack(() => {
    instanceInfo.ensure(location, account);
  });
});

/** Pure reads. They start nothing, so a list of collapsed rows costs a map lookup each. */
const live = $derived(instanceInfo.entry(instance.location, accountId)?.instance ?? null);

/** The name somebody gave this room, or null. Never the instance number dressed up as a name. */
const customName = $derived(live?.displayName ?? null);

/**
 * The head count, preferring the instance's own over the world record's.
 *
 * The instance record is the fresher and more specific of the two: the world's `instances` array is
 * a snapshot taken when the world was read, and this was read for this room.
 */
const userCount = $derived(live?.userCount ?? instance.userCount);
const capacity = $derived(live?.capacity ?? null);

/**
 * True when VRChat listed this instance for *some* of your accounts and not others.
 *
 * Only interesting when it is a real difference: with one account signed in, "listed for 1 account"
 * is noise. A genuine split is a fact about access rather than about the room — a friends-only
 * instance is listed for an account that may enter it and withheld from one that may not.
 */
const partial = $derived(
  instance.seenByAccountIds.length > 0 && instance.seenByAccountIds.length < accountsConsulted,
);
</script>

<div
  class="space-y-1.5 border px-2 py-2 {selected
    ? 'border-primary/60 bg-muted/60'
    : 'border-border bg-transparent'}"
>
  <div class="flex items-center gap-2">
    <button
      type="button"
      class="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-2 text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-current={selected ? "true" : undefined}
      onclick={() => onSelect(instance.location)}
    >
      {#if customName !== null}
        <!--
          The name wins the heading and the number stays beside it: two people comparing rooms need
          the number, and somebody who was told to meet in "Movie Night" needs the name.
        -->
        <span class="min-w-0 truncate text-sm font-medium">{customName}</span>
        <span class="tabular text-xs text-muted-foreground">{parsed.label}</span>
      {:else}
        <span class="tabular text-sm font-medium">{parsed.label}</span>
      {/if}
      <Badge variant="outline" class="tracking-wide uppercase">
        {accessLabel(parsed.access)}
      </Badge>
      {#if parsed.region}
        <span class="text-xs tracking-wide text-muted-foreground uppercase">{parsed.region}</span>
      {/if}

      {#if userCount !== null}
        <!--
          A real head count, never `friends.length` — that is a floor, and printing it here would
          say a public room with forty strangers in it holds one person.
        -->
        <span class="tabular inline-flex items-center gap-1 text-xs text-muted-foreground">
          <UsersIcon class="size-3.5" />
          {userCount}{#if capacity !== null}<span class="opacity-70">/{capacity}</span>{/if}
        </span>
      {/if}

      {#if youAreHere}
        <!--
          Read off this machine's game log, so it is a fact about this computer rather than
          something VRChat was asked.
        -->
        <Badge
          variant="outline"
          class="border-status-online/40 bg-status-online/10 text-status-online"
        >
          <HouseIcon />
          You are here
        </Badge>
      {/if}
    </button>

    <JoinAffordance location={instance.location} {accountId} class="shrink-0 text-xs" />
  </div>

  {#if instance.friends.length > 0}
    <!--
      Outside the selecting button, so each person is a real control that opens their card. Every
      friend is listed rather than the first few: the list is bounded by how many of your friends
      are in one room, and a "+3 more" would be three people you were told about and cannot open.
    -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pl-0.5">
      {#each instance.friends as friend (friend.id)}
        <span class="flex min-w-0 items-center gap-1.5">
          <!-- alt="" deliberately: the name is the next element, so announcing both reads it twice. -->
          <Avatar class="size-5 shrink-0">
            <AvatarImage src={imageUrl(friend.iconUrl)} alt="" loading="lazy" />
            <AvatarFallback class="text-[8px]">{initials(friend.displayName)}</AvatarFallback>
          </Avatar>
          <UserName
            userId={friend.id}
            name={friend.displayName}
            {accountId}
            class="max-w-[12rem] truncate text-xs"
          />
        </span>
      {/each}
    </div>
  {/if}

  {#if partial}
    <p class="text-xs text-muted-foreground">
      VRChat listed this for {instance.seenByAccountIds.length} of your {accountsConsulted} accounts.
    </p>
  {/if}
</div>
