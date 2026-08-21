<!--
  One VRChat location, rendered honestly.

  A location string is the app's densest piece of data: it can be a world plus an instance plus an
  access level plus a region, or it can be one of five words meaning "nowhere you can follow". The
  two cases look nothing alike, so they render differently rather than forcing "Private world" into
  a layout designed for `wrld_… #42 · Friends · us`.

  This is the single component every location in the app passes through — the feed, the game log,
  the user modal, the friends list and the live-sessions header all render it — which is why the
  world and instance halves are components of their own rather than markup here. Fixing the name of
  a world in `WorldLink` fixes it in all five places at once, and neither half can drift from the
  other's idea of what a location is, because both read the same `parseLocation`.

  The join affordance is unchanged and lives in `JoinAffordance`: a self-invite when a client is
  already running, `vrchat://` only when none is. That decision was fixed once already and moving it
  into its own file is the only thing that happened to it here.
-->
<script lang="ts">
import InstanceLink from "$lib/components/InstanceLink.svelte";
import JoinAffordance from "$lib/components/JoinAffordance.svelte";
import WorldLink from "$lib/components/WorldLink.svelte";
import { parseLocation } from "$lib/format.ts";

let {
  location,
  worldName = null,
  showJump = true,
  accountId = null,
}: {
  location: string | null;
  /**
   * A name the caller already had, in practice from the game log's `Entering Room:` line. It wins
   * over anything fetched: it is the name of the world this row actually saw, and it costs nothing.
   */
  worldName?: string | null;
  showJump?: boolean;
  /**
   * The account this location was seen through — a session's own account, or the friend list's
   * account filter. It decides which running client gets moved when several are up (see
   * `planJoin`) and whose credentials the world and instance lookups spend.
   */
  accountId?: string | null;
} = $props();

const parsed = $derived(parseLocation(location));
</script>

<div class="flex min-w-0 flex-wrap items-center gap-2 text-xs">
  {#if parsed.opaque}
    <!-- `private`, `traveling`, `offline`, empty: there is nothing to link to, so nothing links. -->
    <span class="text-muted-foreground">{parsed.label}</span>
  {:else}
    <!--
      `min-w-0 truncate` is on the link itself rather than a wrapper, because that is the element
      `text-overflow` can apply to. A world with a very long name clips at the row's edge and stays
      readable in full in its tooltip.
    -->
    <WorldLink
      worldId={parsed.worldId}
      name={worldName}
      {location}
      {accountId}
      class="min-w-0 max-w-full truncate text-sm font-medium text-foreground"
    />
    <InstanceLink {location} {accountId} />
    <JoinAffordance {location} {accountId} enabled={showJump} />
  {/if}
</div>
