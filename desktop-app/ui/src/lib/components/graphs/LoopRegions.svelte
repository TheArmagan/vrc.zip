<!--
  The tinted region behind each loop's body.

  ## What it is for

  The engine has always known which nodes belong to a loop — the body is what `Item` reaches minus
  what `Done` reaches — and the canvas has never drawn it. So a graph with a `For each` in it looked
  exactly like a graph without one, and the single most important fact about those five nodes (they
  run forty times, not once) was something you had to work out by tracing wires.

  ## Pure decoration, deliberately

  `pointer-events: none` on everything here, and it is not an oversight. The region is not an object
  you can select, drag, or drop into: it is a *reading* of the wiring, recomputed whenever the wiring
  changes. Making it draggable would mean it owns membership, which would mean two answers to "is
  this node in the loop" — the box you dragged and the edges you drew — and the engine only honours
  one of them. It also means a click on empty canvas inside the tint still reaches the canvas, so
  double-clicking there opens the node picker exactly as it does anywhere else.

  ## Why a ViewportPortal

  Children of `<SvelteFlow>` are drawn in screen space, which is right for the controls and wrong for
  this: a region has to pan and zoom with the nodes it is drawn around. `ViewportPortal` is the flow's
  own way in to the transformed layer, at a z-index below the nodes and edges.
-->
<script lang="ts">
import { ViewportPortal } from "@xyflow/svelte";
import type { CanvasEdge, CanvasNode } from "$lib/graphs/loops.ts";
import { loopRegions } from "$lib/graphs/loops.ts";
import { graphRun } from "$lib/state/graph-run.svelte.ts";
import { graphs } from "$lib/state/graphs.svelte.ts";

let { nodes, edges }: { nodes: readonly CanvasNode[]; edges: readonly CanvasEdge[] } = $props();

const regions = $derived(loopRegions(nodes, edges));

/** The loop's own body line, so the region is labelled with what it iterates over. */
function labelFor(loopId: string): string {
  const node = nodes.find((entry) => entry.id === loopId);
  const title = node === undefined ? "For each" : (graphs.definition(node.type)?.title ?? "For each");
  const position = graphRun.loops.get(loopId);
  return position === undefined
    ? title
    : `${title}: item ${String(position.at)} of ${String(position.of)}`;
}
</script>

<!--
  The portal's own wrapper is a plain static `<div>`, so the regions inside it would resolve their
  `absolute` against whatever the flow happens to position next. Pinning it at the viewport origin
  makes "flow coordinates" mean flow coordinates.
-->
<ViewportPortal target="back" class="pointer-events-none absolute left-0 top-0">
  {#each regions as region (region.loopId)}
    <!--
      The tint deepens by one step per level of nesting, so an inner loop reads as inside rather
      than as beside. Two levels is where it stops being legible and three is where it stops being
      a good idea, which is why the opacity is clamped rather than multiplied indefinitely.
    -->
    {@const shade = Math.min(region.depth, 2)}
    <div
      class="pointer-events-none absolute rounded-lg border border-dashed"
      style="
        left: {region.x}px;
        top: {region.y}px;
        width: {region.width}px;
        height: {region.height}px;
        background: color-mix(in oklab, var(--node-control) {4 + shade * 4}%, transparent);
        border-color: color-mix(in oklab, var(--node-control) {30 + shade * 15}%, transparent);
      "
    >
      <div
        class="absolute left-2 top-1 text-[10px] font-medium"
        style="color: var(--node-control)"
      >
        {labelFor(region.loopId)}
      </div>
    </div>
  {/each}
</ViewportPortal>
