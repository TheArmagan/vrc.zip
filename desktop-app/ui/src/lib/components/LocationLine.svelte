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

  ## Occupancy is read without being asked for

  The count beside an instance used to appear only after somebody hovered it, which meant a list of
  forty locations showed a number on the two rows that had been pointed at and nothing on the rest.
  That reads as missing data rather than as an unasked question, so this component now starts the
  lookup itself. `instance-info.svelte.ts` is what makes that affordable: `ensure` joins a queue
  that drains three at a time instead of opening a request per row.

  **`observedAt` is the one guard.** A location on a live surface — a friend's presence, a running
  client — is worth asking about every time. A location in the feed is a record of where somebody
  was, and instances close: sweeping a thousand rows of scrollback would spend a thousand requests
  to be told a thousand times that the instance is gone. So a row that knows *when* it saw the
  location passes that timestamp, and anything older than `LIVE_MS` is left to hover as before.
-->
<script lang="ts">
import { untrack } from "svelte";
import InstanceLink from "$lib/components/InstanceLink.svelte";
import JoinAffordance from "$lib/components/JoinAffordance.svelte";
import WorldLink from "$lib/components/WorldLink.svelte";
import { parseLocation } from "$lib/format.ts";
import { instanceInfo } from "$lib/state/instance-info.svelte.ts";

/**
 * How recently a location must have been observed for its occupancy to be read unprompted.
 *
 * Half an hour is chosen against how long instances last rather than against how long people
 * scroll: past it the likeliest answer is "closed", which is not worth a request to hear.
 */
const LIVE_MS = 30 * 60_000;

let {
  location,
  worldName = null,
  showJump = true,
  accountId = null,
  observedAt = null,
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
  /**
   * When this location was seen, for a row that is a record rather than live state. Null means
   * "right now", which is the truth on the friends list, the user modal and a running client.
   */
  observedAt?: number | null;
} = $props();

const parsed = $derived(parseLocation(location));

/**
 * Reads the occupancy without being asked to.
 *
 * `untrack` is load-bearing rather than tidy: `ensure` reads the resolver's `SvelteMap` to decide
 * whether it already has a fresh answer, and an untracked read would make this effect depend on
 * the very entry the request is about to write — so it would re-run on its own result, forever.
 * The same reason `WorldLink` untracks its `ensure`.
 */
$effect(() => {
  if (parsed.opaque || parsed.worldId === null) return;
  if (observedAt !== null && Date.now() - observedAt > LIVE_MS) return;
  const target = location;
  const account = accountId;
  untrack(() => {
    instanceInfo.ensure(target, account);
  });
});
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
