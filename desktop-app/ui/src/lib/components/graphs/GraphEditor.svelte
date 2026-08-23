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
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import EraserIcon from "@lucide/svelte/icons/eraser";
import PlayIcon from "@lucide/svelte/icons/play";
import SaveIcon from "@lucide/svelte/icons/save";
import TrashIcon from "@lucide/svelte/icons/trash-2";
import {
  AFTER_PORT,
  assignable,
  ERROR_PORT,
  isPortType,
  type NodeDefinition,
} from "@vrcz/plugin-api/nodes";
import type { GraphDocument, GraphEdge as WireEdge, GraphNode as WireNode } from "@vrcz/shared";
import {
  Background,
  Controls,
  type Connection,
  type Edge,
  type Node,
  type OnConnectEnd,
  SvelteFlow,
} from "@xyflow/svelte";
import "@xyflow/svelte/dist/style.css";
import {
  api,
  describeError,
  type Graph,
  type GraphMemoryEntry,
  type GraphRunSummary,
} from "$lib/api.ts";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import CanvasMenu, { type MenuItem } from "$lib/components/graphs/CanvasMenu.svelte";
import ConnectionPicker, {
  type PickerChoice,
} from "$lib/components/graphs/ConnectionPicker.svelte";
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
/** What is typed in the palette's search box. */
let paletteQuery = $state("");
/**
 * Palette groups the user has collapsed, and the ones that start that way.
 *
 * The API groups are hundreds of nodes across nineteen tags, so they start **closed**: a sidebar
 * that opens on two thousand pixels of endpoint names buries the eight categories an ordinary graph
 * is built from. Everything else starts open, because it is short and it is what people came for.
 */
let collapsed = $state<Record<string, boolean>>({});
/** What each node of this graph is remembering, so the inspector can offer to forget it. */
let memory = $state<GraphMemoryEntry[]>([]);
let running = $state(false);

/** The right-click menu: where, and what it offers. Null when nothing is open. */
let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

/**
 * A wire let go over empty canvas.
 *
 * `at` is in **flow** coordinates and `screen` is in the browser's, because the two are answering
 * different questions: the node is created where the wire ended on the canvas, and the picker is
 * drawn where the pointer is on the screen. Conflating them puts the menu in the wrong place at any
 * zoom but 1.
 */
let picking = $state<{
  screenX: number;
  screenY: number;
  at: { x: number; y: number };
  nodeId: string;
  portId: string;
  portType: string;
  side: "source" | "target";
} | null>(null);

function startsClosed(group: string): boolean {
  // A plugin's own groups start **open**: somebody who installed a plugin for its nodes should see
  // them. The generated API groups start closed because there are nineteen of them and hundreds of
  // entries, which would bury everything else.
  return group.startsWith("API: ") || group === "Pipeline";
}

function isCollapsed(group: string): boolean {
  return collapsed[group] ?? startsClosed(group);
}

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

/**
 * The palette, narrowed by what is typed.
 *
 * Matches the title, the description **and** the qualified id, because the three answer different
 * questions: somebody looking for "discord" reads the title, somebody looking for "webhook" is
 * describing what it does, and somebody who saw `vrcz/on-player-join` in an exported graph is
 * looking for a literal id. Groups with nothing left are dropped rather than shown empty.
 */
const searching = $derived(paletteQuery.trim() !== "");

const palette = $derived.by(() => {
  const query = paletteQuery.trim().toLowerCase();
  if (query === "") return graphs.palette;
  const terms = query.split(/\s+/);
  return graphs.palette
    .map((group) => ({
      owner: group.owner,
      types: group.types.filter((type) => {
        const haystack =
          `${type.definition.title} ${type.definition.description ?? ""} ${type.qualifiedId} ${type.definition.category ?? ""}`.toLowerCase();
        // Every word has to appear somewhere, so "send discord" finds the Discord action and
        // typing more words narrows rather than widens.
        return terms.every((term) => haystack.includes(term));
      }),
    }))
    .filter((group) => group.types.length > 0);
});

const selected = $derived(nodes.find((node) => node.id === selectedId) ?? null);
const selectedDefinition = $derived(definitionOf(selected));
const selectedMemory = $derived(
  selectedId === null ? null : (memory.find((entry) => entry.nodeId === selectedId) ?? null),
);

async function load(id: string): Promise<void> {
  loadError = null;
  try {
    const loaded = await api.graphs.get(id);
    graph = loaded;
    const stale = new Set(loaded.staleNodes);
    nodes = loaded.definition.nodes.map((node) => toFlowNode(node, stale.has(node.id)));
    edges = loaded.definition.edges.map(toFlowEdge);
    dirty = false;
    runs = await api.graphs.runs(id);
    memory = await api.graphs.memory(id);
  } catch (cause) {
    loadError = describeError(cause);
  }
}

function toFlowNode(node: WireNode, stale = false): Node {
  return {
    id: node.id,
    // One Svelte Flow node type for every vrc.zip node type: the card draws itself from the
    // definition, so registering twenty component types would be twenty identical components.
    type: "vrcz",
    position: { ...node.position },
    // No definition in here on purpose — the card resolves it live. See `GraphNodeCard.svelte`.
    data: { qualifiedId: node.type, config: { ...node.config }, stale },
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
    if (portId === ERROR_PORT) return "string";
    return definition.outputs.find((port) => port.id === portId)?.type ?? null;
  }
  if (definition.kind === "trigger") return null;
  // `after` carries no value, so it accepts anything: `json` is exactly that in this lattice.
  if (portId === AFTER_PORT) return "json";
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
  return assignable(source, target);
}

/**
 * Still one edge per input port — but the new wire **replaces** the old one rather than being
 * refused.
 *
 * The invariant is unchanged and it is the right one: two producers for one input has no defined
 * merge, and a graph that takes whichever arrived last behaves differently on a busy evening than
 * it does under test. What changed is what happens when you draw the second wire. Refusing it meant
 * finding and deleting the old edge first, which is two gestures for what is plainly one intention —
 * and the refusal looked identical to a type error, so "why will this not connect" had two very
 * different answers with one appearance.
 */
function onconnect(connection: Connection): void {
  dirty = true;
  const replaced = edges.filter(
    (edge) => !(edge.target === connection.target && edge.targetHandle === connection.targetHandle),
  );
  edges = [
    ...replaced,
    {
      id: `e${String(Date.now())}${String(edges.length)}`,
      source: connection.source,
      sourceHandle: connection.sourceHandle ?? null,
      target: connection.target,
      targetHandle: connection.targetHandle ?? null,
    },
  ];
}

/**
 * A wire let go somewhere that is not a handle.
 *
 * Opens the picker rather than doing nothing, which is what used to happen: the wire vanished and
 * the canvas looked exactly as it had, throwing away the two useful things the gesture said — this
 * port, and there.
 *
 * A drop over a *handle* is not this: `toHandle` is set and `onconnect` has already run, or the
 * connection was refused as illegal and reopening it as a question would be misleading.
 */
/*
 * `@xyflow/svelte` re-exports `OnConnectEnd` but not the `FinalConnectionState` it is built from, so
 * the parameter type is read off the handler type rather than imported. Naming it through the type
 * that *is* exported keeps this correct across a version bump either way.
 */
const onconnectend: OnConnectEnd = (event, state) => {
  if (!("fromHandle" in state) || state.fromHandle === null || state.toHandle !== null) return;
  const from = state.fromHandle;
  const side = from.type === "source" ? "source" : "target";
  const nodeId = from.nodeId;
  const portId = from.id ?? "";
  const type = portType(nodeId, portId, side);
  if (type === null) return;
  const pointer = "clientX" in event ? event : event.changedTouches[0];
  if (pointer === undefined) return;
  picking = {
    screenX: pointer.clientX,
    screenY: pointer.clientY,
    at: state.to ?? { x: 0, y: 0 },
    nodeId,
    portId,
    portType: type,
    side,
  };
};

/** Creates the chosen node where the wire was dropped, and wires it up in the same gesture. */
function pick(choice: PickerChoice): void {
  const request = picking;
  picking = null;
  if (request === null) return;
  const id = addNode(choice.qualifiedId, choice.definition, request.at);
  onconnect(
    request.side === "source"
      ? {
          source: request.nodeId,
          sourceHandle: request.portId,
          target: id,
          targetHandle: choice.portId,
        }
      : {
          source: id,
          sourceHandle: choice.portId,
          target: request.nodeId,
          targetHandle: request.portId,
        },
  );
}

function addNode(
  qualifiedId: string,
  definition: NodeDefinition,
  /** Where, in flow coordinates. The palette has no opinion; a dropped wire does. */
  at?: { x: number; y: number },
): string {
  const id = `n${String(Date.now())}${String(nodes.length)}`;
  nodes = [
    ...nodes,
    {
      id,
      type: "vrcz",
      // Dropped in the middle-ish rather than at the origin, and offset per node so a second add
      // does not land exactly on the first.
      position: at ?? { x: 120 + nodes.length * 60, y: 80 + nodes.length * 90 },
      data: { qualifiedId, config: defaultConfig(definition), stale: false },
    },
  ];
  selectedId = id;
  dirty = true;
  return id;
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

function removeNode(id: string): void {
  nodes = nodes.filter((node) => node.id !== id);
  edges = edges.filter((edge) => edge.source !== id && edge.target !== id);
  if (selectedId === id) selectedId = null;
  dirty = true;
}

function removeSelected(): void {
  if (selectedId !== null) removeNode(selectedId);
}

function removeEdge(id: string): void {
  edges = edges.filter((edge) => edge.id !== id);
  dirty = true;
}

/** What a node's context menu offers. The definition is only needed for the label. */
function nodeMenu(node: Node): MenuItem[] {
  const remembered = memory.find((entry) => entry.nodeId === node.id);
  return [
    { label: "Select", onSelect: () => (selectedId = node.id) },
    ...(remembered === undefined
      ? []
      : [
          {
            label: `Forget what it remembers (${String(remembered.entries)})`,
            onSelect: () => void forget(node.id),
          },
        ]),
    { label: "Delete node", danger: true, onSelect: () => removeNode(node.id) },
  ];
}

/**
 * Forgets what one node (or the whole graph) remembers.
 *
 * This is the reset behind `only the first time` and behind a cooldown holding a graph quiet. It
 * takes effect immediately and is **not** part of the save: it edits what the running graph
 * remembers, not the document on the canvas, and pairing it with an unsaved edit would make one
 * button mean two things.
 */
async function forget(nodeId: string | null): Promise<void> {
  saveError = null;
  try {
    await api.graphs.forget(graphId, nodeId);
    memory = await api.graphs.memory(graphId);
  } catch (cause) {
    saveError = describeError(cause);
  }
}

/**
 * Fires the manual trigger.
 *
 * Runs what is **saved**, not what is on the canvas, which is why an unsaved editor says so rather
 * than saving on the user's behalf: a canvas that saved itself to run once is a canvas that rewrote
 * an enabled graph without being asked.
 */
async function runNow(): Promise<void> {
  running = true;
  saveError = null;
  try {
    await api.graphs.runNow(graphId);
    runs = await api.graphs.runs(graphId);
  } catch (cause) {
    saveError = describeError(cause);
  } finally {
    running = false;
  }
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
  {#if graph !== null && graph.staleNodes.length > 0}
    <!--
      The migration prompt PLAN.md asks for, in the smallest honest form: the nodes whose type has
      moved since this graph was saved are marked on the canvas, and saving re-stamps them. It does
      not rewire anything — an automatic fix for "the ports changed" is a guess about intent.
    -->
    <Badge variant="destructive">
      {graph.staleNodes.length} node{graph.staleNodes.length === 1 ? "" : "s"} changed
    </Badge>
  {/if}
  <div class="ml-auto flex items-center gap-2">
    {#if selectedId !== null}
      <Button variant="ghost" size="sm" onclick={removeSelected}>
        <TrashIcon class="size-4" />
        Remove node
      </Button>
    {/if}
    <Button
      variant="secondary"
      size="sm"
      disabled={running}
      title={dirty ? "Runs the saved graph, not the unsaved canvas." : "Fires the manual trigger."}
      onclick={() => void runNow()}
    >
      <PlayIcon class="size-4" />
      Run now
    </Button>
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
    <aside class="flex w-56 shrink-0 flex-col border-r border-border">
      <div class="border-b border-border p-2">
        <Input
          bind:value={paletteQuery}
          placeholder="Search nodes"
          aria-label="Search nodes"
          onkeydown={(event: KeyboardEvent) => {
            // Escape clears rather than blurs: the box is the only thing between the user and a
            // palette they were reading, and clearing it puts that back in one key.
            if (event.key === "Escape") paletteQuery = "";
          }}
        />
      </div>
      <div class="flex-1 overflow-y-auto p-2">
      {#each palette as group (group.owner)}
        {@const shut = searching ? false : isCollapsed(group.owner)}
        <div class="mb-2">
          <!--
            A group header is a button, and searching forces every group open: a hit inside a
            collapsed group that stayed collapsed would read as "no results".
          -->
          <button
            class="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-accent"
            aria-expanded={!shut}
            onclick={() => (collapsed = { ...collapsed, [group.owner]: !shut })}
          >
            <ChevronRightIcon class="size-3 transition-transform {shut ? '' : 'rotate-90'}" />
            <span class="truncate">{group.owner}</span>
            <span class="ml-auto tabular-nums opacity-60">{group.types.length}</span>
          </button>
          {#if !shut}
            {#each group.types as type (type.qualifiedId)}
              <button
                class="w-full rounded px-2 py-1 pl-6 text-left text-sm hover:bg-accent"
                title={type.definition.description ?? type.qualifiedId}
                onclick={() => void addNode(type.qualifiedId, type.definition)}
              >
                {type.definition.title}
              </button>
            {/each}
          {/if}
        </div>
      {:else}
        <p class="px-2 py-4 text-xs text-muted-foreground">
          Nothing matches "{paletteQuery}".
        </p>
      {/each}
      </div>
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
        {onconnectend}
        onnodeclick={({ node }) => (selectedId = node.id)}
        onpaneclick={() => (selectedId = null)}
        onnodedragstop={() => (dirty = true)}
        onnodecontextmenu={({ node, event }) => {
          event.preventDefault();
          selectedId = node.id;
          menu = { x: event.clientX, y: event.clientY, items: nodeMenu(node) };
        }}
        onedgecontextmenu={({ edge, event }) => {
          event.preventDefault();
          menu = {
            x: event.clientX,
            y: event.clientY,
            items: [
              { label: "Delete connection", danger: true, onSelect: () => removeEdge(edge.id) },
            ],
          };
        }}
        colorMode={theme.current}
        fitView
        fitViewOptions={FIT_VIEW}
      >
        <Background />
        <Controls />
      </SvelteFlow>
      {#if menu !== null}
        <CanvasMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
      {/if}
      {#if picking !== null}
        <ConnectionPicker
          x={picking.screenX}
          y={picking.screenY}
          portType={picking.portType}
          side={picking.side}
          onpick={pick}
          onclose={() => (picking = null)}
        />
      {/if}
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

      {#if selected !== null && selectedMemory !== null}
        <!--
          Shown only where there is something to forget, which is why the daemon is asked what is
          stored rather than the definition being asked to declare it. A cooldown that has never
          fired has no rows and no button.
        -->
        <div class="mb-4 rounded border border-border p-2">
          <div class="text-xs text-muted-foreground">
            Remembering {selectedMemory.entries}
            {selectedMemory.entries === 1 ? "thing" : "things"}.
          </div>
          <Button
            class="mt-1"
            size="sm"
            variant="secondary"
            onclick={() => void forget(selected.id)}
          >
            <EraserIcon class="size-4" />
            Forget it
          </Button>
        </div>
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
