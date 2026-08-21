<!--
  One line of the feed.

  Payloads are VRChat's own shapes forwarded verbatim, so this renders what it can find and says
  nothing when it finds nothing. A row never invents a subject, and a kind this build has never
  seen still gets a readable label and a place in the list rather than being dropped.
-->
<script lang="ts">
import type { EventFamily } from "$lib/api.ts";
import { familyOf } from "$lib/api.ts";
import LocationLine from "$lib/components/LocationLine.svelte";
import type { LiveEvent } from "$lib/events.ts";
import { eventLabel, payloadText, shortId, subjectName, timeOfDay } from "$lib/format.ts";

let { event, dense = false }: { event: LiveEvent; dense?: boolean } = $props();

/** A left rule per family, so a long scroll is scannable without reading a single label. */
const FAMILY_RULE: Record<EventFamily, string> = {
  friend: "border-l-status-online",
  notification: "border-l-status-join-me",
  gamelog: "border-l-status-ask-me",
  session: "border-l-primary",
  user: "border-l-status-join-me",
  group: "border-l-chart-3",
  instance: "border-l-chart-3",
  account: "border-l-chart-4",
  pipeline: "border-l-chart-4",
  economy: "border-l-chart-5",
  content: "border-l-chart-5",
  other: "border-l-border",
};

const family = $derived(familyOf(event.kind));
const who = $derived(subjectName(event.payload));
const detail = $derived(payloadText(event.payload));
const subjectFallback = $derived(
  who === null && event.subjectId !== null ? shortId(event.subjectId, 12) : null,
);
</script>

<li
  class="flex gap-3 border-l-2 {FAMILY_RULE[family]} pr-5 pl-4 {dense ? 'py-1' : 'py-2'}
         hover:bg-muted/40"
>
  <span class="tabular w-12 shrink-0 pt-px text-[11px] text-muted-foreground">
    {timeOfDay(event.ts)}
  </span>

  <div class="min-w-0 flex-1">
    <p class="flex flex-wrap items-baseline gap-x-2 text-[13px]">
      <span class="font-medium">{eventLabel(event.kind)}</span>
      {#if who}
        <span class="text-muted-foreground">{who}</span>
      {:else if subjectFallback}
        <span class="font-mono text-[11px] text-muted-foreground">{subjectFallback}</span>
      {/if}
      {#if event.live}
        <span class="text-[10px] tracking-wide text-status-online uppercase">live</span>
      {/if}
    </p>

    {#if detail && detail !== who}
      <p class="truncate text-xs text-muted-foreground">{detail}</p>
    {/if}

    {#if event.location}
      <LocationLine location={event.location} showJump={false} />
    {/if}
  </div>

  <span
    class="hidden w-24 shrink-0 truncate text-right font-mono text-[10px] text-muted-foreground md:block"
    title={event.kind}
  >
    {event.kind}
  </span>
</li>
