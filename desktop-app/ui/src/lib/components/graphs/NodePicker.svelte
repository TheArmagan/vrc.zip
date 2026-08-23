<!--
  "What goes here?" — the palette, asked at a point on the canvas.

  ## Two gestures, one component

  Let go of a wire over empty canvas, or double-click empty canvas, and this opens where the pointer
  is. The difference is one prop:

    `from` set     a wire is attached. Only node types with a port that would actually connect are
                   offered, and picking one creates the node *and* the edge.
    `from` null    nothing is attached. The whole palette, and picking one just creates the node.

  One component rather than two because everything except the filter is the same — the search box,
  the clamp into the viewport, the backdrop, the ordering — and two copies of that is two places for
  the keyboard handling to drift.

  ## Why the connected case filters by the lattice

  The whole palette at 400-odd entries is not an answer to "what goes here". Every entry offered has
  a port that would connect, checked with the same `assignable` the canvas and the daemon use, so
  choosing one cannot produce an edge the next save would refuse. The port that will be wired is
  named on the row, because a node with three inputs of the same type is a guess otherwise.

  Ordered by category then title — the palette's own order, so the entry somebody half-remembers
  from the sidebar is where the sidebar would have put it.

  ## Keyboard

  Type, arrow to it, Enter. The box keeps focus the whole way — the arrows move a *highlight* rather
  than the focus ring, because moving focus into the list would take the caret out of the search box
  and end the sentence somebody was still typing. Enter takes the highlighted row, which is the first
  one until you move, so the common case is two keys and no pointer at all.
-->
<script lang="ts">
import { AFTER_PORT, assignable, ERROR_PORT, isPortType } from "@vrcz/plugin-api/nodes";
import type { NodeDefinition, PortDefinition } from "@vrcz/plugin-api/nodes";
import { Input } from "$lib/components/ui/input/index.js";
import { graphs, type NodeType } from "$lib/state/graphs.svelte.ts";

/** Which end a wire was dragged from, and what it carries. Null when nothing is attached. */
export interface PickerSource {
  readonly portType: string;
  /** A `source` needs a node with an input to land in, and the reverse. */
  readonly side: "source" | "target";
}

/** One thing the picker can create: a node type, and which of its ports the wire lands on. */
export interface PickerChoice {
  readonly qualifiedId: string;
  readonly definition: NodeDefinition;
  /** Null when the picker was opened with no wire attached — there is nothing to connect. */
  readonly portId: string | null;
  readonly portLabel: string;
}

let {
  x,
  y,
  from = null,
  onpick,
  onclose,
}: {
  x: number;
  y: number;
  from?: PickerSource | null;
  onpick: (choice: PickerChoice) => void;
  onclose: () => void;
} = $props();

let query = $state("");
let element = $state<HTMLDivElement | null>(null);
let search = $state<HTMLInputElement | null>(null);
/** Which row the arrows are on. An index rather than an id, so it survives the list changing. */
let active = $state(0);
/** The rendered rows, so the highlighted one can be scrolled back into view. */
let rows = $state.raw<(HTMLButtonElement | null)[]>([]);
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

/*
 * Focused here rather than with the `autofocus` attribute, which did not take: both gestures that
 * open this are pointer gestures, and the browser had just moved focus as part of the drag or the
 * double-click. Typing immediately is the whole point of the box, so it is claimed explicitly.
 */
$effect(() => {
  search?.focus();
});

/** Back to the top whenever the list changes underneath, so Enter never takes a stale row. */
$effect(() => {
  void query;
  active = 0;
});

$effect(() => {
  rows[active]?.scrollIntoView({ block: "nearest" });
});

/**
 * Arrow to a row, Enter to take it.
 *
 * Handled on the input rather than on the list because that is where focus is and where it stays.
 * `preventDefault` on the arrows stops the caret jumping to the ends of the query while you are
 * moving down the list — the browser's own meaning for those keys inside a text field.
 */
function onSearchKey(event: KeyboardEvent): void {
  const visible = choices.slice(0, LIMIT);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (visible.length === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    // Wraps, because a list this long is quicker to reach from the other end and there is nothing
    // below the last row to fall into.
    active = (active + step + visible.length) % visible.length;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const row = visible[active];
    if (row !== undefined) onpick(row.choice);
  }
}

/**
 * The first port of `type` that would accept (or satisfy) the dragged one.
 *
 * First rather than best: there is no ranking that beats "the one the author will see named on the
 * row", and offering the same node three times because it has three `json` inputs would bury
 * everything else.
 */
function match(type: NodeType, source: PickerSource): PickerChoice | null {
  const definition = type.definition;
  if (source.side === "source") {
    // Dropped from an output: we need something that takes it. A trigger has no inputs at all.
    if (definition.kind === "trigger") return null;
    const port = definition.inputs.find((entry) => accepts(source.portType, entry));
    if (port !== undefined) {
      return { qualifiedId: type.qualifiedId, definition, portId: port.id, portLabel: port.label };
    }
    // `after` carries no value and sequences a node, so it is a real answer when nothing else fits —
    // last, because "run this next" is rarely what somebody dragging a value port meant.
    return { qualifiedId: type.qualifiedId, definition, portId: AFTER_PORT, portLabel: "after" };
  }
  const port = definition.outputs.find((entry) => produces(entry, source.portType));
  if (port !== undefined) {
    return { qualifiedId: type.qualifiedId, definition, portId: port.id, portLabel: port.label };
  }
  // Every executable node has the implicit error port, which carries a string.
  if (
    definition.kind !== "trigger" &&
    isPortType(source.portType) &&
    assignable("string", source.portType)
  ) {
    return { qualifiedId: type.qualifiedId, definition, portId: ERROR_PORT, portLabel: "error" };
  }
  return null;
}

function accepts(fromType: string, port: PortDefinition): boolean {
  if (!isPortType(fromType) || !isPortType(port.type)) return true;
  return assignable(fromType, port.type);
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
      const choice =
        from === null
          ? { qualifiedId: type.qualifiedId, definition: type.definition, portId: null, portLabel: "" }
          : match(type, from);
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
<div class="fixed inset-0 z-40" role="presentation" onpointerdown={onclose}></div>

<div
  bind:this={element}
  class="fixed z-50 flex max-h-80 w-72 flex-col rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
  style="left: {left}px; top: {top}px;"
>
  <div class="border-b border-border p-2">
    <Input
      bind:ref={search}
      bind:value={query}
      placeholder={from === null ? "Add a node" : "What goes here?"}
      aria-label="Find a node"
      onkeydown={onSearchKey}
    />
    {#if from !== null}
      <p class="mt-1 text-xs text-muted-foreground">
        {from.side === "source" ? "Takes" : "Gives"}
        <span class="font-mono">{from.portType}</span>
      </p>
    {/if}
  </div>
  <div class="flex-1 overflow-y-auto p-1">
    {#each choices.slice(0, LIMIT) as row, index (row.choice.qualifiedId)}
      <button
        bind:this={rows[index]}
        class="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent {index === active
          ? 'bg-accent'
          : ''}"
        onclick={() => onpick(row.choice)}
        onmouseenter={() => (active = index)}
      >
        <span>{row.choice.definition.title}</span>
        {#if row.choice.portId !== null}
          <span class="ml-1 text-xs text-muted-foreground">· {row.choice.portLabel}</span>
        {/if}
        <span class="block text-xs text-muted-foreground">{row.group}</span>
      </button>
    {:else}
      <p class="px-2 py-4 text-xs text-muted-foreground">
        {from === null ? `Nothing matches "${query}".` : "Nothing here takes that."}
      </p>
    {/each}
    {#if choices.length > LIMIT}
      <p class="px-2 py-2 text-xs text-muted-foreground">
        {choices.length - LIMIT} more. Type to narrow.
      </p>
    {/if}
  </div>
</div>
