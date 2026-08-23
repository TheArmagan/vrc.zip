<!--
  Let go of a wire over empty canvas and this asks what you meant.

  ## Why it exists

  Dropping a connection on nothing used to do nothing, which is the least informative outcome a
  gesture can have: the wire vanishes and the canvas looks exactly as it did. The person doing it
  had already said two useful things — *this* port, and *there* — and both were thrown away.

  ## Why the list is filtered by the lattice rather than being the whole palette

  The whole palette at 376 entries is not an answer to "what goes here". Every entry offered has a
  port that would actually connect, checked with the same `assignable` the canvas and the daemon
  use, so choosing one cannot produce an edge the next save would refuse. The port that will be
  wired is named on the row, because a node with three inputs of the same type is a guess otherwise.

  Ordered by category, then title — the palette's own order, so the entry somebody half-remembers
  from the sidebar is where the sidebar would have put it.
-->
<script lang="ts">
import { AFTER_PORT, assignable, ERROR_PORT, isPortType } from "@vrcz/plugin-api/nodes";
import type { NodeDefinition, PortDefinition } from "@vrcz/plugin-api/nodes";
import { Input } from "$lib/components/ui/input/index.js";
import { graphs, type NodeType } from "$lib/state/graphs.svelte.ts";

/** One thing the picker can create: a node type, and which of its ports the wire lands on. */
export interface PickerChoice {
  readonly qualifiedId: string;
  readonly definition: NodeDefinition;
  readonly portId: string;
  readonly portLabel: string;
}

let {
  x,
  y,
  /** The type of the port the wire came from, already resolved. */
  portType,
  /** Which end the wire started at: a `source` needs a node with an input, and the reverse. */
  side,
  onpick,
  onclose,
}: {
  x: number;
  y: number;
  portType: string;
  side: "source" | "target";
  onpick: (choice: PickerChoice) => void;
  onclose: () => void;
} = $props();

let query = $state("");
let element = $state<HTMLDivElement | null>(null);
/*
 * Seeded from where the pointer was and clamped by the effect below once there is a box to measure.
 * The initial read is deliberate — this is a menu opened at a point, not one that follows it — which
 * is what the `state_referenced_locally` warning is about.
 */
// svelte-ignore state_referenced_locally
let left = $state(x);
// svelte-ignore state_referenced_locally
let top = $state(y);

/** How many rows are offered before the search box is the only way through. */
const LIMIT = 60;

$effect(() => {
  if (element === null) return;
  const box = element.getBoundingClientRect();
  left = Math.min(x, window.innerWidth - box.width - 8);
  top = Math.min(y, window.innerHeight - box.height - 8);
});

/**
 * The first port of `type` that would accept (or satisfy) the dragged one.
 *
 * First rather than best: there is no ranking that beats "the one the author will see named on the
 * row", and offering the same node three times because it has three `json` inputs would bury
 * everything else.
 */
function match(type: NodeType): PickerChoice | null {
  const definition = type.definition;
  if (side === "source") {
    // Dropped from an output: we need something that takes it. A trigger has no inputs at all.
    if (definition.kind === "trigger") return null;
    const port = definition.inputs.find((entry) => accepts(portType, entry));
    if (port !== undefined) {
      return {
        qualifiedId: type.qualifiedId,
        definition,
        portId: port.id,
        portLabel: port.label,
      };
    }
    // `after` carries no value and sequences a node, so it is a real answer when nothing else fits —
    // last, because "run this next" is rarely what somebody dragging a value port meant.
    return {
      qualifiedId: type.qualifiedId,
      definition,
      portId: AFTER_PORT,
      portLabel: "after",
    };
  }
  const port = definition.outputs.find((entry) => produces(entry, portType));
  if (port !== undefined) {
    return { qualifiedId: type.qualifiedId, definition, portId: port.id, portLabel: port.label };
  }
  // Every executable node has the implicit error port, which carries a string.
  if (definition.kind !== "trigger" && isPortType(portType) && assignable("string", portType)) {
    return { qualifiedId: type.qualifiedId, definition, portId: ERROR_PORT, portLabel: "error" };
  }
  return null;
}

function accepts(from: string, port: PortDefinition): boolean {
  if (!isPortType(from) || !isPortType(port.type)) return true;
  return assignable(from, port.type);
}

function produces(port: PortDefinition, into: string): boolean {
  if (!isPortType(into) || !isPortType(port.type)) return true;
  return assignable(port.type, into);
}

const choices = $derived.by(() => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows: { choice: PickerChoice; group: string }[] = [];
  for (const group of graphs.palette) {
    for (const type of group.types) {
      const choice = match(type);
      if (choice === null) continue;
      if (terms.length > 0) {
        const haystack =
          `${choice.definition.title} ${choice.definition.description ?? ""} ${type.qualifiedId}`.toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) continue;
      }
      rows.push({ choice, group: group.owner });
    }
  }
  return rows;
});
</script>

<svelte:window
  onkeydown={(event: KeyboardEvent) => {
    if (event.key === "Escape") onclose();
  }}
/>

<!--
  `pointerdown` on the backdrop rather than `click`: the canvas underneath starts a pan on pointer
  down, so a click-to-dismiss would drag the viewport out from under the menu before it closed.
-->
<div
  class="fixed inset-0 z-40"
  role="presentation"
  onpointerdown={onclose}
></div>

<div
  bind:this={element}
  class="fixed z-50 flex max-h-80 w-72 flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
  style="left: {left}px; top: {top}px;"
>
  <div class="border-b border-border p-2">
    <!-- svelte-ignore a11y_autofocus -- the gesture that opened this was a drag, so there is no
         keyboard focus to steal and typing immediately is the whole point. -->
    <Input bind:value={query} placeholder="What goes here?" aria-label="Find a node" autofocus />
    <p class="mt-1 text-xs text-muted-foreground">
      {side === "source" ? "Takes" : "Gives"}
      <span class="font-mono">{portType}</span>
    </p>
  </div>
  <div class="flex-1 overflow-y-auto p-1">
    {#each choices.slice(0, LIMIT) as row (row.choice.qualifiedId)}
      <button
        class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
        onclick={() => onpick(row.choice)}
      >
        <span>{row.choice.definition.title}</span>
        <span class="ml-1 text-xs text-muted-foreground">· {row.choice.portLabel}</span>
        <span class="block text-xs text-muted-foreground">{row.group}</span>
      </button>
    {:else}
      <p class="px-2 py-4 text-xs text-muted-foreground">
        Nothing here takes that.
      </p>
    {/each}
    {#if choices.length > LIMIT}
      <p class="px-2 py-2 text-xs text-muted-foreground">
        {choices.length - LIMIT} more. Type to narrow.
      </p>
    {/if}
  </div>
</div>
