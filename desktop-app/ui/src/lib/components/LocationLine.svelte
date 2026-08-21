<!--
  One VRChat location, rendered honestly.

  A location string is the app's densest piece of data: it can be a world plus an instance plus an
  access level plus a region, or it can be one of five words meaning "nowhere you can follow". The
  two cases look nothing alike, so they render differently rather than forcing "Private world" into
  a layout designed for `wrld_… #42 · Friends · us`.
-->
<script lang="ts">
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import { Badge } from "$lib/components/ui/badge/index.js";
import { accessLabel, launchLink, parseLocation, shortId } from "$lib/format.ts";

let {
  location,
  worldName = null,
  showJump = true,
}: { location: string | null; worldName?: string | null; showJump?: boolean } = $props();

const parsed = $derived(parseLocation(location));
const jump = $derived(showJump ? launchLink(location) : null);
</script>

<div class="flex min-w-0 flex-wrap items-center gap-2 text-xs">
  {#if parsed.opaque}
    <span class="text-muted-foreground">{parsed.label}</span>
  {:else}
    <span class="truncate text-sm font-medium text-foreground" title={location ?? undefined}>
      {worldName ?? shortId(parsed.worldId, 14)}
    </span>
    {#if parsed.instanceId}
      <span class="tabular text-muted-foreground">{parsed.label}</span>
    {/if}
    <Badge variant="outline" class="tracking-wide uppercase">{accessLabel(parsed.access)}</Badge>
    {#if parsed.region}
      <span class="tracking-wide text-muted-foreground uppercase">{parsed.region}</span>
    {/if}
    {#if jump}
      <a
        href={jump}
        class="inline-flex items-center text-muted-foreground underline underline-offset-4 hover:text-foreground"
        title="Open this instance in VRChat"
      >
        Jump
        <ChevronRightIcon class="size-3.5" />
      </a>
    {/if}
  {/if}
</div>
