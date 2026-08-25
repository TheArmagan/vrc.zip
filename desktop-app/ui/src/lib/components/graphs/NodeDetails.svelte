<!--
  What a node is, drawn beside the row you stopped on.

  The palette had one line per node: an icon and a title clipped at 224 pixels, with the description
  hidden in a `title` attribute the OS drew half a second later in its own font. That is enough to
  recognise a node you already know and no help at all with the four hundred you do not — which is
  the case the palette exists for.

  ## What it shows, and what it deliberately does not

  The title in full, the qualified id, the description, and **every port the node will actually have
  once it is on the canvas** — including `run after` and `on error`, which no definition declares and
  every executable card draws. See `detailPorts` for why leaving those out would be a lie.

  Not the config fields. Those are questions the inspector asks *after* the node exists, and a
  preview that listed them would be answering "what will I have to fill in" rather than "what is
  this" — and it would push the ports, which are the reason somebody is reading this, off the bottom.

  ## Positioning

  `placeDetails` decides; this measures. Beside the row, flipped to the other side when there is no
  room, pinned to the margin when neither side fits. The card renders once with its position
  unresolved and is invisible for that frame: an unplaced card at (0, 0) is a flash in the corner of
  the screen on every hover, which is worse than a frame of nothing.

  It is `pointer-events-none` throughout. This is a thing that appears because you hovered something
  else, so it must never eat the click you were about to make on the row underneath it.
-->
<script lang="ts">
import type { NodeDefinition } from "@vrcz/plugin-api/nodes";
import { type Box, detailPorts, placeDetails } from "$lib/graphs/details.ts";
import { iconFor } from "$lib/graphs/icons.ts";
import { familyColor, familyOf, portDotStyle } from "$lib/graphs/visuals.ts";

let {
  qualifiedId,
  definition,
  owner,
  anchor,
}: {
  qualifiedId: string;
  definition: NodeDefinition;
  owner: string;
  anchor: Box;
} = $props();

let element = $state<HTMLDivElement | null>(null);
let placed = $state<{ left: number; top: number } | null>(null);

const family = $derived(familyOf(definition.category, owner));
const Icon = $derived(iconFor(definition.category, owner));
const ports = $derived(detailPorts(qualifiedId, definition));

/**
 * Measure, then place.
 *
 * The dependencies are listed deliberately: the card is re-placed when the row changes *or* when
 * the node changes, because a taller card for a nine-port node placed with the previous one's
 * height hangs off the bottom of the window.
 */
$effect(() => {
  void anchor;
  void qualifiedId;
  if (element === null) return;
  const box = element.getBoundingClientRect();
  placed = placeDetails(
    anchor,
    { width: box.width, height: box.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
});
</script>

<div
  bind:this={element}
  class="pointer-events-none fixed z-50 w-72 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
  class:invisible={placed === null}
  style="left: {placed?.left ?? 0}px; top: {placed?.top ?? 0}px;"
  role="tooltip"
>
  <!-- The same three-pixel category strip the card on the canvas wears, so the preview and the
       thing it previews are recognisably one object. -->
  <div class="h-[3px] w-full" style="background: {familyColor(family)}"></div>

  <div class="flex items-start gap-2 px-3 pt-2.5 pb-2">
    <Icon class="mt-0.5 size-4 shrink-0" style="color: {familyColor(family)}" />
    <div class="min-w-0 flex-1">
      <!-- Wraps. The whole reason this panel exists is that the row could not show the whole name. -->
      <div class="text-sm leading-snug font-medium">{definition.title}</div>
      <div class="mt-0.5 font-mono text-[10px] break-all text-muted-foreground">{qualifiedId}</div>
    </div>
  </div>

  {#if definition.description !== undefined && definition.description !== ""}
    <p class="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
      {definition.description}
    </p>
  {/if}

  {#each [{ title: "Takes", rows: ports.inputs }, { title: "Gives", rows: ports.outputs }] as section (section.title)}
    {#if section.rows.length > 0}
      <div class="border-t border-border px-3 py-2">
        <div class="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {section.title}
        </div>
        <div class="flex flex-col gap-1.5">
          {#each section.rows as port (port.id)}
            <div class="flex items-baseline gap-2">
              <!--
                The three roles are drawn as three dots, matching the canvas exactly: a hued dot for
                a value, dashed for the sequencing ports that carry nothing, and the destructive
                outline for the error port.
              -->
              {#if port.role === "value"}
                <span
                  class="mt-1 shrink-0 rounded-full"
                  style={portDotStyle(port.type, "var(--popover)")}
                  aria-hidden="true"
                ></span>
              {:else if port.role === "sequence"}
                <span
                  class="mt-1 size-2.5 shrink-0 rounded-full border border-dashed border-muted-foreground bg-popover"
                  aria-hidden="true"
                ></span>
              {:else}
                <span
                  class="mt-1 size-2.5 shrink-0 rounded-full border border-destructive bg-popover"
                  aria-hidden="true"
                ></span>
              {/if}
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-1.5 text-[11px]">
                  <span class:text-destructive={port.role === "error"}>{port.label}</span>
                  {#if port.typeLabel !== ""}
                    <!-- The readable name, not the wire type: a `user` badge beside a port called
                         `User` reads as a user object, and it has only ever been an id. -->
                    <span class="truncate font-mono text-[10px] text-muted-foreground"
                      >{port.typeLabel}</span
                    >
                  {/if}
                  {#if port.required === true}
                    <span class="text-[10px] text-muted-foreground">required</span>
                  {/if}
                </div>
                {#if port.description !== undefined && port.description !== ""}
                  <div class="text-[10px] leading-snug text-muted-foreground">
                    {port.description}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
          {#if section.title === "Takes" && ports.moreInputs > 0}
            <!-- "This one can take more" is a fact nobody finds any other way, and twenty-three
                 empty slots would teach less than the sentence does. -->
            <p class="text-[10px] text-muted-foreground">
              {ports.moreInputs} more slots, on a slider in the inspector.
            </p>
          {/if}
        </div>
      </div>
    {/if}
  {/each}
</div>
