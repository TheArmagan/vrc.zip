<!--
  One node on the canvas.

  Everything drawn here comes from the `NodeDefinition` the daemon handed over: the title, the ports
  and their types, and the body line. **The body is evaluated locally** with `evaluateNodeBody` —
  never an RPC into the plugin that contributed the node. Svelte Flow re-renders on every pan and
  zoom, so a per-frame call across a process boundary is not viable, and a saved graph has to draw
  correctly with every plugin process dead.

  A node whose type is not registered right now is drawn **greyed and named**, not hidden. Hiding it
  would remove the one fact that explains why the graph stopped working.
-->
<script lang="ts">
import { Handle, type NodeProps, Position } from "@xyflow/svelte";
import { evaluateNodeBody } from "@vrcz/plugin-api/nodes";
import { graphs } from "$lib/state/graphs.svelte.ts";

/**
 * What the editor puts in `node.data`. Deliberately **not** the definition.
 *
 * The definition is looked up here, live, because the catalogue arrives on its own schedule: a card
 * handed a definition at load time drew every node as "Unavailable" whenever the graph loaded first,
 * and stayed that way. Resolving on render also means a plugin starting later fixes its own nodes.
 */
interface GraphNodeData {
  readonly qualifiedId: string;
  readonly config: Readonly<Record<string, string | number | boolean>>;
  /** True when the saved definition hash no longer matches the registered one. */
  readonly stale: boolean;
  [key: string]: unknown;
}

let { data, selected }: NodeProps = $props();

const node = $derived(data as unknown as GraphNodeData);
const definition = $derived(graphs.definition(node.qualifiedId));
const inputs = $derived(
  definition === null || definition.kind === "trigger" ? [] : definition.inputs,
);
const outputs = $derived(definition?.outputs ?? []);
const body = $derived(
  definition?.body === undefined ? "" : evaluateNodeBody(definition.body, node.config, outputs),
);
</script>

<!--
  The explicit `text-xs` and the width are load-bearing: Svelte Flow's stylesheet sets its own font
  size on a node wrapper, so a card that only said `text-sm` inherited something much larger and
  every node overlapped its neighbour.
-->
<div
  class="w-52 rounded-md border bg-card text-xs text-card-foreground shadow-sm"
  class:border-primary={selected}
  class:border-border={!selected}
  class:opacity-60={definition === null}
>
  <div class="border-b border-border px-3 py-2">
    <div class="text-xs font-medium">
      {definition?.title ?? node.qualifiedId}
    </div>
    {#if definition === null}
      <!-- The honest sentence, rather than an empty box: its plugin is not running. -->
      <div class="text-[11px] text-muted-foreground">Unavailable — {node.qualifiedId}</div>
    {:else if node.stale}
      <div class="text-[11px] text-destructive">This node type changed. Check its wiring.</div>
    {:else if body !== ""}
      <div class="text-[11px] text-muted-foreground">{body}</div>
    {/if}
  </div>

  <div class="flex justify-between gap-3 px-3 py-2 text-[11px]">
    <div class="flex flex-col gap-1">
      {#each inputs as port (port.id)}
        <div class="relative flex items-center gap-1">
          <Handle
            type="target"
            position={Position.Left}
            id={port.id}
            style="position:absolute;left:-16px;"
          />
          <span>{port.label}</span>
          <span class="text-muted-foreground">{port.type}</span>
        </div>
      {/each}
    </div>
    <div class="flex flex-col items-end gap-1">
      {#each outputs as port (port.id)}
        <div class="relative flex items-center gap-1">
          <span class="text-muted-foreground">{port.type}</span>
          <span>{port.label}</span>
          <Handle
            type="source"
            position={Position.Right}
            id={port.id}
            style="position:absolute;right:-16px;"
          />
        </div>
      {/each}
      <!--
        The port every node has and no definition declares. It is produced only when the node
        throws, so wiring it is how an author says "tell me when this breaks" — and leaving it
        unwired is how they say "stop the run", which is the default.
      -->
      {#if definition !== null && definition.kind !== "trigger"}
        <div class="relative flex items-center gap-1 text-destructive">
          <span>on error</span>
          <Handle
            type="source"
            position={Position.Right}
            id="error"
            style="position:absolute;right:-16px;"
          />
        </div>
      {/if}
    </div>
  </div>
</div>
