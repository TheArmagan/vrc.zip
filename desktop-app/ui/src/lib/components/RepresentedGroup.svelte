<!--
  The group a user has chosen to display beside their name.

  This is one badge, not a list row, because that is what it *is*: a single deliberate statement of
  affiliation, the same one VRChat prints next to their name in game. Drawing it as the first entry
  of a list would bury the one membership the user picked among the many they merely have — and the
  full list is one tab away anyway, where this group is pinned to the top.

  Most users represent nothing. There is no placeholder for that case: the caller simply does not
  render this, and the badge row closes up around the gap.

  Clicking opens the group on vrchat.com. vrc.zip has no group screen and is not growing one for
  three fields it already shows here, so the honest destination is the page that has the rest.
-->
<script lang="ts">
import UsersIcon from "@lucide/svelte/icons/users";
import { imageUrl, type UserGroup } from "$lib/api.ts";
import { Badge } from "$lib/components/ui/badge/index.js";
import { groupLink, groupTag } from "$lib/format.ts";
import { cn } from "$lib/utils.js";

let {
  group,
  class: className,
}: {
  group: UserGroup;
  class?: string;
} = $props();

const tag = $derived(groupTag(group.shortCode, group.discriminator));
const icon = $derived(imageUrl(group.iconUrl));
const title = $derived(
  `Represents ${group.name}${tag === null ? "" : ` (${tag})`} — opens on vrchat.com`,
);
</script>

<Badge
  variant="outline"
  href={groupLink(group.id)}
  target="_blank"
  rel="noreferrer noopener"
  {title}
  class={cn("max-w-[18rem] gap-1.5 pl-1", className)}
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
</Badge>
