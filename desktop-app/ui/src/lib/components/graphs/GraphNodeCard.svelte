<!--
  One node on the canvas.

  Everything drawn here comes from the `NodeDefinition` the daemon handed over: the title, the ports
  and their types, and the body line. **The body is evaluated locally** with `evaluateNodeBody` —
  never an RPC into the plugin that contributed the node. Svelte Flow re-renders on every pan and
  zoom, so a per-frame call across a process boundary is not viable, and a saved graph has to draw
  correctly with every plugin process dead.

  A node whose type is not registered right now is drawn **greyed and named**, not hidden. Hiding it
  would remove the one fact that explains why the graph stopped working.

  ## What the card says before you read it

  Three things, and each replaced a line of text that used to be here:

  **A colour and an icon for the category**, taken from the same axis the palette groups by, so the
  sidebar and the canvas teach one taxonomy rather than two. See `lib/graphs/visuals.ts`.

  **A coloured dot per port**, hued by what the port carries and drawn hollow when it carries
  several of them. The type name used to sit beside every label as raw text — `json`, `list<friend>`
  — which made a nine-port node a wall of words in the one place a wall of words is least readable.
  It is a title attribute now: quiet until you hover the dot, which is when you are asking.

  **A dashed rule before the ports that fire afterwards.** `on error` is one; a `For each`'s `Done`
  and `Results` are the others. Those two mean "when the loop has finished", and drawing them flush
  against `Item` — which means "once per element" — was the single most confusing thing about the
  loop node. A rule between them says they are a different kind of answer.
-->
<script lang="ts">
import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
import { Handle, type NodeProps, Position, useUpdateNodeInternals } from "@xyflow/svelte";
import {
  AFTER_PORT,
  ERROR_PORT,
  evaluateNodeBody,
  visibleInputs,
  visibleOutputs,
} from "@vrcz/plugin-api/nodes";
import { FOREACH_AFTER_PORTS } from "@vrcz/shared";
import { iconFor } from "$lib/graphs/icons.ts";
import { familyColor, familyOf, isListPort, portColor } from "$lib/graphs/visuals.ts";
import { FOREACH_TYPE } from "$lib/graphs/loops.ts";
import { graphRun } from "$lib/state/graph-run.svelte.ts";
import { graphs } from "$lib/state/graphs.svelte.ts";

/**
 * What the editor puts in `node.data`. Deliberately **not** the definition.
 *
 * The definition is looked up here, live, because the catalogue arrives on its own schedule: a card
 * handed a definition at load time drew every node as "Unavailable" whenever the graph loaded first,
 * and stayed that way. Resolving on render also means a plugin starting later fixes its own nodes.
 *
 * `problem` is the one thing the editor knows and the definition cannot: a rule about where this
 * node sits relative to the others, which is a property of the graph rather than of the node type.
 */
interface GraphNodeData {
  readonly qualifiedId: string;
  readonly config: Readonly<Record<string, string | number | boolean>>;
  /** True when the saved definition hash no longer matches the registered one. */
  readonly stale: boolean;
  /** Set when this node breaks a loop rule, in the words the daemon would use. */
  readonly problem?: string | undefined;
  /**
   * The output ports that already have an edge, for a node whose outputs are chosen in the
   * inspector.
   *
   * The editor knows the edges and the card does not, so it is handed over the same way `problem` is.
   * It is a floor rather than a list: a slot with a wire in it is drawn whatever the config says,
   * because an edge feeding a port that is not on the card is a graph doing something with no way to
   * see that it is.
   */
  readonly wiredOutputs?: readonly string[] | undefined;
  /**
   * The same, for a node whose *inputs* are named in the inspector rather than counted.
   *
   * Only `Compose JSON` and anything like it gets this. A positionally variadic node needs none: its
   * floor is a count the editor writes back into the config.
   */
  readonly wiredInputs?: readonly string[] | undefined;
  [key: string]: unknown;
}

let { id, data, selected }: NodeProps = $props();

const node = $derived(data as unknown as GraphNodeData);
const type = $derived(graphs.nodeTypes.get(node.qualifiedId) ?? null);
const definition = $derived(type?.definition ?? null);
const owner = $derived(type?.owner ?? "vrcz");
const family = $derived(familyOf(definition?.category, owner));
const Icon = $derived(iconFor(definition?.category, owner));

/**
 * The inputs this instance draws, which is not always every input the type declares.
 *
 * `Compose text` declares twenty-six and shows three until somebody asks for more. See
 * `variadicInputs` in `@vrcz/plugin-api` for why the ports are all real and only the drawing varies.
 * The editor keeps the count above whatever is wired, so this can never hide a port with an edge.
 *
 * `wiredInputs` is the floor for the *other* mechanism, where each config row claims a port by name:
 * there is no count to raise, so the ids arrive the way `wiredOutputs` does. Empty for every node
 * that counts instead, which is all of them but `Compose JSON`.
 */
const inputs = $derived(
  definition === null ? [] : visibleInputs(definition, node.config, node.wiredInputs ?? []),
);
/**
 * The outputs this instance draws, which for an extractor is one per configured row.
 *
 * Same mechanism as the inputs and the same floor: `visibleOutputs` never hides a slot the editor
 * says is wired. A node with no `variadicOutputs` gets its declared outputs back unchanged, which is
 * every node that existed before the extractors did.
 */
const outputs = $derived(
  definition === null
    ? []
    : visibleOutputs(definition, node.config, node.wiredOutputs ?? []),
);
const body = $derived(
  definition?.body === undefined ? "" : evaluateNodeBody(definition.body, node.config, outputs),
);

/**
 * The outputs split into "what this produced" and "what happens afterwards".
 *
 * Only the loop has any in the second group today, and it is the reason the split exists at all.
 * Keyed on the type id rather than on a flag in `NodeDefinition`, because adding a field to the
 * definition would change the hash of every node that has one and mark every saved graph using them
 * stale — a redraw is not worth a migration.
 */
const afterPorts = $derived(
  node.qualifiedId === FOREACH_TYPE
    ? outputs.filter((port) => FOREACH_AFTER_PORTS.includes(port.id))
    : [],
);
const mainPorts = $derived(outputs.filter((port) => !afterPorts.includes(port)));

/**
 * Tell Svelte Flow when this card's set of handles changes.
 *
 * **Without this, the second row of an extractor draws a port nothing can be dragged out of.** Svelte
 * Flow measures a node's handles into `handleBounds` once and re-measures only when the node's
 * *dimensions* change. Our ports are added by config, not by code — a row added in the inspector puts
 * a new `<Handle>` on the card — and the card is a fixed width whose height is set by the taller of
 * its two columns. An extractor has two rows on the left (`run after` and `From`), so claiming the
 * second output slot adds a row to the right-hand column without making the card any taller. Nothing
 * changed size, nothing was re-measured, and a handle absent from `handleBounds` is a handle the
 * connection code cannot start a wire from. The first port worked because it was there at mount.
 *
 * `useUpdateNodeInternals` is the documented answer for exactly this — programmatically added
 * handles — and it forces the re-measure on the next frame. The signature is the ids in order, so it
 * fires when a port appears, disappears, or moves, and not on a relabel.
 */
const updateInternals = useUpdateNodeInternals();
const handleSignature = $derived(
  `${inputs.map((port) => port.id).join(",")}|${outputs.map((port) => port.id).join(",")}`,
);

$effect(() => {
  // Read it into the effect's dependencies first: `updateInternals` is a plain function and reading
  // nothing reactive inside would make this run once and never again. A `$derived` only propagates
  // when its value actually changed, so re-running *is* the signal — there is nothing to compare
  // against here, and comparing the signature with itself is a condition that is never true.
  void handleSignature;
  updateInternals(id);
});

/** Where the loop this card draws is up to, or null when it is not running. */
const position = $derived(graphRun.loops.get(id) ?? null);
const active = $derived(graphRun.active.has(id));

const executable = $derived(definition !== null && definition.kind !== "trigger");

/** A port dot: filled for one of something, hollow for several. */
function dotStyle(portType: string): string {
  const color = portColor(portType);
  return isListPort(portType)
    ? `width:10px;height:10px;border:2px solid ${color};background:var(--card);`
    : `width:10px;height:10px;border:1px solid ${color};background:${color};`;
}
</script>

<!--
  The explicit `text-xs` and the width are load-bearing: Svelte Flow's stylesheet sets its own font
  size on a node wrapper, so a card that only said `text-sm` inherited something much larger and
  every node overlapped its neighbour.
-->
<div
  class="w-56 rounded-md border bg-card text-xs text-card-foreground shadow-sm transition-shadow"
  class:border-primary={selected}
  class:shadow-md={selected || active}
  class:border-border={!selected}
  class:opacity-60={definition === null}
>
  <!--
    The category strip. Three pixels, and it is the first thing you see at any zoom.

    The card is deliberately **not** `overflow-hidden`, which is what a strip like this usually asks
    for: every port handle is positioned outside the card's edge, and clipping the card clipped all
    of them. So the strip rounds its own two corners instead.
  -->
  <div class="h-[3px] w-full rounded-t-[5px]" style="background: {familyColor(family)}"></div>

  <div class="flex items-start gap-2 border-b border-border px-3 py-2">
    <Icon class="mt-px size-4 shrink-0" style="color: {familyColor(family)}" />
    <div class="min-w-0 flex-1">
      <div class="truncate font-medium">
        {definition?.title ?? node.qualifiedId}
      </div>
      {#if definition === null}
        <!-- The honest sentence, rather than an empty box: its plugin is not running. -->
        <div class="truncate text-[11px] text-muted-foreground">
          Unavailable: {node.qualifiedId}
        </div>
      {:else if body !== ""}
        <div class="truncate text-[11px] text-muted-foreground">{body}</div>
      {/if}
    </div>
    {#if position !== null}
      <!--
        The live readout. Tabular figures so the number does not shuffle the badge sideways on every
        tick, which at two ticks a second is the difference between a counter and a jitter.
      -->
      <span
        class="shrink-0 rounded-sm px-1 py-px text-[10px] tabular-nums"
        style="background: {familyColor(family)}; color: var(--card)"
      >
        {position.at}/{position.of}
      </span>
    {/if}
  </div>

  {#if node.stale || node.problem !== undefined}
    <div
      class="flex items-start gap-1.5 border-b border-border bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive"
    >
      <CircleAlertIcon class="mt-px size-3 shrink-0" />
      <span>{node.problem ?? "This node type changed. Check its wiring."}</span>
    </div>
  {/if}

  <div class="flex justify-between gap-4 px-3 py-2 text-[11px]">
    <div class="flex min-w-0 flex-col gap-1.5">
      <!--
        The input every node has and none declares. It carries no value: an edge into it says
        "not until that one has run", which is the only way to sequence a node whose inputs all
        come from value literals — those have no path from the trigger otherwise.

        It reads "run after" rather than "after", which is what it said until the loop's own
        after-the-loop output was sitting three inches away also saying "after". One word for two
        opposite things on one screen is a collision, not a synonym.
      -->
      {#if executable}
        <div class="relative flex items-center gap-1.5 text-muted-foreground">
          <Handle
            type="target"
            position={Position.Left}
            id={AFTER_PORT}
            style="position:absolute;left:-6px;width:8px;height:8px;border:1px dashed var(--muted-foreground);background:var(--card);"
          />
          <span>run after</span>
        </div>
      {/if}
      {#each inputs as port (port.id)}
        <div class="relative flex items-center gap-1.5" title="{port.label}: {port.type}">
          <Handle
            type="target"
            position={Position.Left}
            id={port.id}
            style="position:absolute;left:-6px;{dotStyle(port.type)}"
          />
          <span class="truncate">{port.label}</span>
          {#if port.required === true}
            <span class="text-muted-foreground" aria-label="required">*</span>
          {/if}
        </div>
      {/each}
    </div>

    <div class="flex min-w-0 flex-col items-end gap-1.5">
      {#each mainPorts as port (port.id)}
        <div class="relative flex items-center gap-1.5" title="{port.label}: {port.type}">
          <span class="truncate">{port.label}</span>
          <Handle
            type="source"
            position={Position.Right}
            id={port.id}
            style="position:absolute;right:-6px;{dotStyle(port.type)}"
          />
        </div>
      {/each}
    </div>
  </div>

  {#if afterPorts.length > 0 || executable}
    <!--
      Everything below this rule happens after the node's own work: the loop's `Done` and `Results`
      when the iteration is over, and `on error` when it never finished at all.
    -->
    <div class="border-t border-dashed border-muted-foreground/40 px-3 py-2 text-[11px]">
      <div class="flex flex-col items-end gap-1.5">
        {#each afterPorts as port (port.id)}
          <div class="relative flex items-center gap-1.5" title="{port.label}: {port.type}">
            <span class="truncate text-muted-foreground">{port.label}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={port.id}
              style="position:absolute;right:-6px;{dotStyle(port.type)}"
            />
          </div>
        {/each}
        <!--
          The port every node has and no definition declares. It is produced only when the node
          throws, so wiring it is how an author says "tell me when this breaks" — and leaving it
          unwired is how they say "stop the run", which is the default.
        -->
        {#if executable}
          <div class="relative flex items-center gap-1.5 text-destructive" title="error: string">
            <span>on error</span>
            <Handle
              type="source"
              position={Position.Right}
              id={ERROR_PORT}
              style="position:absolute;right:-6px;width:9px;height:9px;border:1px solid var(--destructive);background:var(--card);"
            />
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
