<!--
  The instance half of a location: `#42`, its access level, its region, and its occupancy where
  that happens to be known.

  Split from `WorldLink` because the two halves answer different questions and fail differently. A
  world is a permanent record that can be read from cache with nobody signed in; an instance is a
  live thing that closes, and every location string eventually points at one that has. So this
  renders what `parseLocation` can read out of the string itself — which needs no network at all and
  is therefore never wrong about the access level — and *adds* live counts only when something else
  has already paid for them.

  **This component still never fetches.** It renders whatever the resolver holds and nothing else.
  What changed is who asks: `LocationLine` now starts the lookup for a location that is live, so a
  list arrives with its counts already filling in rather than showing a number only on the rows
  somebody happened to point at. Opening the tooltip still asks too, and asks *urgently*, because a
  person waiting on the thing they just hovered must not sit behind a queue of background rows.

  An opaque location (`private`, `traveling`, `offline`, empty) has no instance to link to and
  renders as the prose `parseLocation` chose. That is `LocationLine`'s job in practice — this guard
  is here so the component is honest on its own.
-->
<script lang="ts">
import { Badge } from "$lib/components/ui/badge/index.js";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import { accessLabel, parseLocation } from "$lib/format.ts";
import { instanceInfo, instanceUnavailableText } from "$lib/state/instance-info.svelte.ts";
import { worldModal } from "$lib/state/world-modal.svelte.ts";
import { cn } from "$lib/utils.js";

let {
  location,
  accountId = null,
  class: className,
}: {
  location: string | null;
  accountId?: string | null;
  class?: string;
} = $props();

const parsed = $derived(parseLocation(location));

/** Pure: whatever a previous hover or an open modal already learned. Starts nothing. */
const entry = $derived(instanceInfo.entry(location, accountId));
const live = $derived(entry?.instance ?? null);

/**
 * `userCount / capacity`, and only when VRChat actually said both.
 *
 * Never a percentage and never a "busy"/"quiet" verdict: those would be this app's opinion printed
 * beside VRChat's facts, and at the age this snapshot can reach that opinion would often be wrong.
 */
const occupancy = $derived(
  live === null || live.userCount === null
    ? null
    : live.capacity === null
      ? String(live.userCount)
      : `${String(live.userCount)}/${String(live.capacity)}`,
);

const INTERACTIVE =
  "inline-flex cursor-pointer items-center gap-2 rounded-xs underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

function open(event: MouseEvent): void {
  if (parsed.worldId === null) return;
  event.stopPropagation();
  worldModal.openWorld(parsed.worldId, { location, accountId });
}
</script>

{#if parsed.opaque || parsed.worldId === null}
  <span class={cn("text-muted-foreground", className)}>{parsed.label}</span>
{:else}
  <Tooltip.Provider delayDuration={250}>
    <Tooltip.Root
      onOpenChange={(isOpen) => {
        // A person's own gesture, so it goes to the front of the queue. Already-answered and
        // already-queued locations are both cheap no-ops inside `ensure`.
        if (isOpen) instanceInfo.ensure(location, accountId, { urgent: true });
      }}
    >
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button {...props} type="button" class={cn(INTERACTIVE, className)} onclick={open}>
            {#if parsed.instanceId}
              <span class="tabular text-muted-foreground">{parsed.label}</span>
            {/if}
            <Badge variant="outline" class="tracking-wide uppercase">
              {accessLabel(parsed.access)}
            </Badge>
            {#if parsed.region}
              <span class="tracking-wide text-muted-foreground uppercase">{parsed.region}</span>
            {/if}
            {#if occupancy !== null}
              <span class="tabular text-muted-foreground">{occupancy}</span>
            {/if}
          </button>
        {/snippet}
      </Tooltip.Trigger>

      <Tooltip.Content class="max-w-xs flex-col items-stretch gap-1 px-3 py-2">
        <p class="font-medium">
          {parsed.instanceId === null ? "This world" : `Instance ${parsed.label}`}
        </p>
        <p class="opacity-80">
          {accessLabel(parsed.access)}{parsed.region ? ` · ${parsed.region.toUpperCase()}` : ""}
        </p>

        {#if live !== null}
          <p class="opacity-80">
            {live.userCount === null ? "Occupancy not reported" : `${live.userCount} here now`}
            {#if live.capacity !== null}<span> of {live.capacity}</span>{/if}
            {#if live.full}<span> · full</span>{/if}
            {#if live.queueEnabled}<span>
                · queue{live.queueSize === null ? "" : ` of ${live.queueSize}`}
              </span>{/if}
          </p>
        {:else if entry?.status === "loading"}
          <p class="opacity-80">Reading the instance…</p>
        {:else if entry?.status === "unavailable" && entry.reason !== null}
          <p class="opacity-80">{instanceUnavailableText(entry.reason)}</p>
        {:else if entry?.status === "error"}
          <p class="opacity-80">{entry.error}</p>
        {/if}

        <p class="opacity-60">Click for the full instance</p>
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
{/if}
