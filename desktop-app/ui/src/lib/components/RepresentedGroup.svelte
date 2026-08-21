<!--
  The group a user has chosen to display beside their name.

  This is one badge, not a list row, because that is what it *is*: a single deliberate statement of
  affiliation, the same one VRChat prints next to their name in game. Drawing it as the first entry
  of a list would bury the one membership the user picked among the many they merely have — and the
  full list is one tab away anyway, where this group is pinned to the top.

  Most users represent nothing. There is no placeholder for that case: the caller simply does not
  render this, and the badge row closes up around the gap.

  Clicking opens the group card. It used to open vrchat.com in a browser tab, which was the honest
  answer while the daemon knew three fields about a group; `GroupModal` exists now, and the badge
  already holds a whole `UserGroup`, so it is handed over as the hint and the dialog paints its
  name, icon and banner before the fetch lands. vrchat.com is still one click further on, in the
  card's footer, for the members and posts vrc.zip does not hold.
-->
<script lang="ts">
import UsersIcon from "@lucide/svelte/icons/users";
import { imageUrl, type UserGroup } from "$lib/api.ts";
import { badgeVariants } from "$lib/components/ui/badge/index.js";
import { groupTag } from "$lib/format.ts";
import { groupModal } from "$lib/state/group-modal.svelte.ts";
import { cn } from "$lib/utils.js";

let {
  group,
  accountId = null,
  class: className,
}: {
  group: UserGroup;
  /** The account this was seen through; it decides `membershipStatus` and what is visible at all. */
  accountId?: string | null;
  class?: string;
} = $props();

const tag = $derived(groupTag(group.shortCode, group.discriminator));
const icon = $derived(imageUrl(group.iconUrl));
const title = $derived(`Represents ${group.name}${tag === null ? "" : ` (${tag})`}`);
</script>

<!--
  A real `<button>` wearing the badge's own classes rather than a `<Badge>` with a click handler:
  the badge component renders a `<span>` (or an `<a>`, given an `href`), and a `<span onclick>` is
  invisible to the keyboard and announced as text. `badgeVariants` is exported for exactly this.
-->
<button
  type="button"
  {title}
  class={cn(
    badgeVariants({ variant: "outline" }),
    "max-w-[18rem] cursor-pointer gap-1.5 pl-1 hover:bg-muted hover:text-muted-foreground",
    className,
  )}
  onclick={(event) => {
    // These badges sit inside rows that are themselves clickable in places, and opening the group
    // is the whole intent of the click, so it stops here.
    event.stopPropagation();
    groupModal.openGroup(group.id, { hint: group, accountId });
  }}
>
  {#if icon !== undefined}
    <!-- Decorative: the group is named in the same badge, one element to the right. -->
    <img
      src={icon}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      class="size-3.5 shrink-0 rounded-[3px] object-cover"
    />
  {:else}
    <UsersIcon class="shrink-0 text-muted-foreground" />
  {/if}

  <span class="min-w-0 truncate">{group.name}</span>

  {#if tag !== null}
    <span class="shrink-0 font-mono text-muted-foreground">{tag}</span>
  {/if}
</button>
