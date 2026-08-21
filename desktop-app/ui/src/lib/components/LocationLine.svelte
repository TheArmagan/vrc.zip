<!--
  One VRChat location, rendered honestly.

  A location string is the app's densest piece of data: it can be a world plus an instance plus an
  access level plus a region, or it can be one of five words meaning "nowhere you can follow". The
  two cases look nothing alike, so they render differently rather than forcing "Private world" into
  a layout designed for `wrld_… #42 · Friends · us`.
-->
<script lang="ts">
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/svelte";
import { accessLabel, launchLink, parseLocation, shortId } from "$lib/format.ts";

let {
  location,
  worldName = null,
  showJump = true,
}: { location: string | null; worldName?: string | null; showJump?: boolean } = $props();

const parsed = $derived(parseLocation(location));
const jump = $derived(showJump ? launchLink(location) : null);
</script>

<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
  {#if parsed.opaque}
    <span class="text-muted-foreground">{parsed.label}</span>
  {:else}
    <span class="truncate font-medium text-foreground" title={location ?? undefined}>
      {worldName ?? shortId(parsed.worldId, 14)}
    </span>
    {#if parsed.instanceId}
      <span class="tabular text-muted-foreground">{parsed.label}</span>
    {/if}
    <span
      class="border border-border px-1 py-px text-[10px] tracking-wide text-muted-foreground uppercase"
    >
      {accessLabel(parsed.access)}
    </span>
    {#if parsed.region}
      <span class="text-[10px] tracking-wide text-muted-foreground uppercase">{parsed.region}</span>
    {/if}
    {#if jump}
      <a
        href={jump}
        class="inline-flex items-center gap-0.5 text-muted-foreground underline
               underline-offset-2 hover:text-foreground"
        title="Open this instance in VRChat"
      >
        Jump
        <HugeiconsIcon icon={ArrowRight01Icon} size={12} />
      </a>
    {/if}
  {/if}
</div>
