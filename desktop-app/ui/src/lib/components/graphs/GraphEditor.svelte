<!--
  The canvas.

  Three things worth knowing before changing anything here:

  **Type checking happens twice, and this is the fast half.** `isValidConnection` runs `assignable`
  from `@vrcz/plugin-api` — the same function the daemon runs — so an illegal edge is refused while
  the wire is still attached to the cursor. The daemon checks again on save, because the frontend is
  a client and clients lie. Both halves reading the same function is what keeps them from drifting.

  **Save is explicit.** A canvas that autosaved would rewrite an enabled graph on every pixel of
  drag, and there is no version history to undo that with. The dirty marker is the promise that
  nothing has changed on disk yet.

  **A node draws from its definition, never from an RPC.** See `GraphNodeCard.svelte`.

  The inspector on the right edits the selected node's config. A `secret` field is write-only: it
  posts to its own route and is never read back, so the box is always empty and says so.
-->
<script lang="ts">
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import SaveIcon from "@lucide/svelte/icons/save";
import TrashIcon from "@lucide/svelte/icons/trash-2";
import { assignable, isPortType, type NodeDefinition } from "@vrcz/plugin-api/nodes";
import type { GraphDocument, GraphEdge as WireEdge, GraphNode as WireNode } from "@vrcz/shared";
import {
  Background,
  Controls,
  type Connection,
  type Edge,
  type Node,
  SvelteFlow,
} from "@xyflow/svelte";
import "@xyflow/svelte/dist/style.css";
import { api, describeError, type Graph, type GraphRunSummary } from "$lib/api.ts";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import GraphNodeCard from "$lib/components/graphs/GraphNodeCard.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { hrefFor } from "$lib/router.ts";
import { graphs } from "$lib/state/graphs.svelte.ts";
import { theme } from "$lib/state/theme.svelte.ts";

let { graphId }: { graphId: string } = $props();

let graph = $state<Graph | null>(null);
let nodes = $state.raw<Node[]>([]);
let edges = $state.raw<Edge[]>([]);
let runs = $state<GraphRunSummary[]>([]);
let loadError = $state<string | null>(null);
let saveError = $state<string | null>(null);
let saving = $state(false);
let dirty = $state(false);
let selectedId = $state<string | null>(null);
/** Which node's secret field is being typed into, and what. Never read back from the daemon. */
let secretDraft = $state<Record<string, string>>({});

const nodeTypes = { vrcz: GraphNodeCard };

/**
 * `maxZoom: 1` is the whole point of this object.
 *
 * `fitView` on its own scales *up* to fill the pane, so a graph with three nodes opened at roughly
 * 2x and every label looked enormous — the node stylesheet was innocent. Capping at 1:1 means a
 * node is drawn at the size it was designed at, and a small graph simply sits in the middle of the
 * canvas rather than being blown up to fill it.
 */
const FIT_VIEW = { maxZoom: 1, padding: 0.25 };

$effect(() => {
  if (!graphs.loaded) void graphs.load();
});

$effect(() => {
  void load(graphId);
});

const selected = $derived(nodes.find((node) => node.id === selectedId) ?? null);
const selectedDefinition = $derived(definitionOf(selected));

async function load(id: string): Promise<void> {
  loadError = null;
  try {
    const loaded = await api.graphs.get(id);
    graph = loaded;
    nodes = loaded.definition.nodes.map(toFlowNode);
    edges = loaded.definition.edges.map(toFlowEdge);
    dirty = false;
    runs = await api.graphs.runs(id);
  } catch (cause) {
    loadError = describeError(cause);
  }
}

function toFlowNode(node: WireNode): Node {
  return {
    id: node.id,
    // One Svelte Flow node type for every vrc.zip node type: the card draws itself from the
    // definition, so registering twenty component types would be twenty identical components.
    type: "vrcz",
    position: { ...node.position },
    // No definition in here on purpose — the card resolves it live. See `GraphNodeCard.svelte`.
    data: { qualifiedId: node.type, config: { ...node.config }, stale: false },
  };
}

/** The definition for a node on the canvas, or null while the catalogue is still loading. */
function definitionOf(node: Node | null): NodeDefinition | null {
  if (node === null) return null;
  return graphs.definition((node.data as { qualifiedId: string }).qualifiedId);
}

function toFlowEdge(edge: WireEdge): Edge {
  return {
    id: edge.id,
    source: edge.from.node,
    sourceHandle: edge.from.port,
    target: edge.to.node,
    targetHandle: edge.to.port,
  };
}

/** The port type of one end of a would-be edge, or null when it cannot be resolved. */
function portType(nodeId: string, portId: string, side: "source" | "target"): string | null {
  const definition = definitionOf(nodes.find((entry) => entry.id === nodeId) ?? null);
  if (definition === null) return null;
  if (side === "source") {
    // The implicit error port, which no definition declares and every executable node has.
    if (portId === "error") return "string";
    return definition.outputs.find((port) => port.id === portId)?.type ?? null;
  }
  if (definition.kind === "trigger") return null;
  return definition.inputs.find((port) => port.id === portId)?.type ?? null;
}

/**
 * The editor's half of "type checking happens twice".
 *
 * Unknown types pass rather than fail: a node whose plugin is stopped has no definition to check
 * against, and refusing every edge to it would make a graph impossible to repair while the plugin
 * that broke it is down. The daemon takes the same position on save.
 */
function isValidConnection(connection: Connection | Edge): boolean {
  const source = portType(connection.source, connection.sourceHandle ?? "", "source");
  const target = portType(connection.target, connection.targetHandle ?? "", "target");
  if (source === null || target === null) return true;
  if (!isPortType(source) || !isPortType(target)) return true;
  if (connection.source === connection.target) return false;
  // One edge per input port: two producers for one input has no defined merge, and a graph that
  // takes whichever arrived last behaves differently on a busy evening than it does under test.
  const occupied = edges.some(
    (edge) => edge.target === connection.target && edge.targetHandle === connection.targetHandle,
  );
  return !occupied && assignable(source, target);
}

function onconnect(connection: Connection): void {
  dirty = true;
  edges = [
    ...edges,
    {
      id: `e${String(Date.now())}${String(edges.length)}`,
      source: connection.source,
      sourceHandle: connection.sourceHandle ?? null,
      target: connection.target,
      targetHandle: connection.targetHandle ?? null,
    },
  ];
}

function addNode(qualifiedId: string, definition: NodeDefinition): void {
  const id = `n${String(Date.now())}${String(nodes.length)}`;
  nodes = [
    ...nodes,
    {
      id,
      type: "vrcz",
      // Dropped in the middle-ish rather than at the origin, and offset per node so a second add
      // does not land exactly on the first.
      position: { x: 120 + nodes.length * 60, y: 80 + nodes.length * 90 },
      data: { qualifiedId, config: defaultConfig(definition), stale: false },
    },
  ];
  selectedId = id;
  dirty = true;
}

function defaultConfig(definition: NodeDefinition): Record<string, string | number | boolean> {
  const config: Record<string, string | number | boolean> = {};
  for (const field of definition.config ?? []) {
    // A secret has no default and never carries one: its value lives in the credential store.
    if (field.kind === "secret") continue;
    if ("default" in field && field.default !== undefined) config[field.id] = field.default;
  }
  return config;
}

function removeSelected(): void {
  if (selectedId === null) return;
  const id = selectedId;
  nodes = nodes.filter((node) => node.id !== id);
  edges = edges.filter((edge) => edge.source !== id && edge.target !== id);
  selectedId = null;
  dirty = true;
}

function setConfig(fieldId: string, value: string | number | boolean): void {
  if (selectedId === null) return;
  const id = selectedId;
  nodes = nodes.map((node) =>
    node.id === id
      ? { ...node, data: { ...node.data, config: { ...(node.data as { config: object }).config, [fieldId]: value } } }
      : node,
  );
  dirty = true;
}

function toDocument(): GraphDocument {
  return {
    nodes: nodes.map((node) => {
      const data = node.data as { qualifiedId: string; config: Record<string, never> };
      return {
        id: node.id,
        type: data.qualifiedId,
        position: { x: node.position.x, y: node.position.y },
        config: data.config,
      };
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      from: { node: edge.source, port: edge.sourceHandle ?? "" },
      to: { node: edge.target, port: edge.targetHandle ?? "" },
    })),
  };
}

async function save(): Promise<void> {
  saving = true;
  saveError = null;
  try {
    const saved = await api.graphs.update(graphId, { definition: toDocument() });
    graph = saved;
    dirty = false;
    graphs.replace({ ...saved });
  } catch (cause) {
    // The daemon answers with every broken edge named, so this is shown whole rather than trimmed.
    saveError = describeError(cause);
  } finally {
    saving = false;
  }
}

async function saveSecret(fieldId: string): Promise<void> {
  if (selectedId === null) return;
  const value = secretDraft[`${selectedId}:${fieldId}`] ?? "";
  saveError = null;
  try {
    await api.graphs.setSecret(graphId, selectedId, fieldId, value);
    secretDraft = { ...secretDraft, [`${selectedId}:${fieldId}`]: "" };
  } catch (cause) {
    saveError = describeError(cause);
  }
}
</script>

<header class="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
  <Button variant="ghost" size="sm" href={hrefFor("graphs")}>
    <ArrowLeftIcon class="size-4" />
    Graphs
  </Button>
  <div class="font-medium">{graph?.name ?? "…"}</div>
  {#if graph !== null && !graph.armed}
    <Badge variant="outline">Rehearsing</Badge>
  {/if}
  {#if dirty}
    <Badge variant="secondary">Unsaved</Badge>
  {/if}
  <div class="ml-auto flex items-center gap-2">
    {#if selectedId !== null}
      <Button variant="ghost" size="sm" onclick={removeSelected}>
        <TrashIcon class="size-4" />
        Remove node
      </Button>
    {/if}
    <Button size="sm" disabled={saving || !dirty} onclick={() => void save()}>
      <SaveIcon class="size-4" />
      Save
    </Button>
  </div>
</header>

{#if loadError !== null}
  <div class="p-4"><ErrorNote message={loadError} /></div>
{:else}
  <div class="flex min-h-0 flex-1">
    <!-- The palette. Grouped by owner, built-ins first: two plugins both contributing a "Send"
         node is a flat list where nobody can tell whose is whose. -->
    <aside class="w-56 shrink-0 overflow-y-auto border-r border-border p-2">
      {#each graphs.palette as group (group.owner)}
        <div class="mb-3">
          <div class="px-2 py-1 text-xs font-medium text-muted-foreground">
            {group.owner === "vrcz" ? "Built in" : group.owner}
          </div>
          {#each group.types as type (type.qualifiedId)}
            <button
              class="w-full rounded px-2 py-1 text-left text-sm hover:bg-accent"
              onclick={() => addNode(type.qualifiedId, type.definition)}
            >
              {type.definition.title}
            </button>
          {/each}
        </div>
      {/each}
    </aside>

    <!--
      `colorMode` is not decoration: Svelte Flow ships its own light and dark palettes, and without
      it the controls and the selection ring render white on a dark canvas.
    -->
    <div class="min-w-0 flex-1">
      <SvelteFlow
        bind:nodes
        bind:edges
        {nodeTypes}
        {isValidConnection}
        {onconnect}
        onnodeclick={({ node }) => (selectedId = node.id)}
        onpaneclick={() => (selectedId = null)}
        onnodedragstop={() => (dirty = true)}
        colorMode={theme.current}
        fitView
        fitViewOptions={FIT_VIEW}
      >
        <Background />
        <Controls />
      </SvelteFlow>
    </div>

    <aside class="w-72 shrink-0 overflow-y-auto border-l border-border p-3">
      {#if saveError !== null}
        <ErrorNote message={saveError} />
      {/if}

      {#if selected !== null && selectedDefinition !== null}
        <div class="mb-2 text-sm font-medium">{selectedDefinition.title}</div>
        {#if selectedDefinition.description !== undefined}
          <p class="mb-3 text-xs text-muted-foreground">{selectedDefinition.description}</p>
        {/if}

        {#each selectedDefinition.config ?? [] as field (field.id)}
          <div class="mb-3 flex flex-col gap-1">
            <label class="text-xs font-medium" for={`cfg-${field.id}`}>{field.label}</label>
            {#if field.kind === "secret"}
              <!-- Write-only: the box starts empty because nothing reads a secret back, here or
                   anywhere. Saving an empty value clears it. -->
              <Input
                id={`cfg-${field.id}`}
                type="password"
                placeholder="Stored securely, never shown"
                value={secretDraft[`${selected.id}:${field.id}`] ?? ""}
                oninput={(event: Event) =>
                  (secretDraft = {
                    ...secretDraft,
                    [`${selected.id}:${field.id}`]: (event.currentTarget as HTMLInputElement).value,
                  })}
              />
              <Button size="sm" variant="secondary" onclick={() => void saveSecret(field.id)}>
                Save secret
              </Button>
            {:else if field.kind === "boolean"}
              <input
                id={`cfg-${field.id}`}
                type="checkbox"
                checked={(selected.data as { config: Record<string, unknown> }).config[
                  field.id
                ] === true}
                onchange={(event: Event) =>
                  setConfig(field.id, (event.currentTarget as HTMLInputElement).checked)}
              />
            {:else if field.kind === "select"}
              <select
                id={`cfg-${field.id}`}
                class="rounded border border-input bg-background px-2 py-1 text-sm"
                value={String(
                  (selected.data as { config: Record<string, unknown> }).config[field.id] ?? "",
                )}
                onchange={(event: Event) =>
                  setConfig(field.id, (event.currentTarget as HTMLSelectElement).value)}
              >
                {#each field.options as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            {:else}
              <Input
                id={`cfg-${field.id}`}
                type={field.kind === "number" || field.kind === "duration" ? "number" : "text"}
                value={String(
                  (selected.data as { config: Record<string, unknown> }).config[field.id] ?? "",
                )}
                oninput={(event: Event) => {
                  const raw = (event.currentTarget as HTMLInputElement).value;
                  setConfig(
                    field.id,
                    field.kind === "number" || field.kind === "duration" ? Number(raw) : raw,
                  );
                }}
              />
            {/if}
            {#if field.description !== undefined}
              <span class="text-xs text-muted-foreground">{field.description}</span>
            {/if}
          </div>
        {/each}
      {:else}
        <p class="text-sm text-muted-foreground">
          Pick a node from the palette, then select it to configure it.
        </p>
      {/if}

      <!--
        The run inspector. Only runs that have *not* finished live in `graph_runs`; a completed run
        is an event in the feed, which is where its history belongs.
      -->
      <div class="mt-6">
        <div class="mb-2 text-xs font-medium text-muted-foreground">In flight</div>
        {#if runs.length === 0}
          <p class="text-xs text-muted-foreground">Nothing running.</p>
        {:else}
          {#each runs as run (run.id)}
            <div class="mb-2 rounded border border-border p-2 text-xs">
              <div class="flex items-center gap-2">
                <Badge variant="secondary">{run.status}</Badge>
                {#if run.dryRun}<Badge variant="outline">rehearsal</Badge>{/if}
              </div>
              <div class="mt-1 text-muted-foreground">
                started <RelativeTime ts={run.startedAt} />
                {#if run.resumeAt !== null}
                  · resumes <RelativeTime ts={run.resumeAt} />
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </aside>
  </div>
{/if}
