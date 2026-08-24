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
  type ButtonRow,
  ERROR_PORT,
  isPortType,
  type NodeDefinition,
  parseButtonRows,
  parseSlotRows,
  type PortType,
  type SlotRow,
  slotRowLabel,
  visibleInputCount,
} from "@vrcz/plugin-api/nodes";
import type { GraphDocument, GraphEdge as WireEdge, GraphNode as WireNode } from "@vrcz/shared";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Connection,
  type Edge,
  type Node,
  type OnConnectEnd,
  SvelteFlow,
  type Viewport,
} from "@xyflow/svelte";
import "@xyflow/svelte/dist/style.css";
import { api, describeError, type Graph, type GraphMemoryEntry } from "$lib/api.ts";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import CanvasMenu, { type MenuItem } from "$lib/components/graphs/CanvasMenu.svelte";
import GraphNodeCard from "$lib/components/graphs/GraphNodeCard.svelte";
import LoopRegions from "$lib/components/graphs/LoopRegions.svelte";
import NodeDetails from "$lib/components/graphs/NodeDetails.svelte";
import NodePicker, {
  type PickerChoice,
  type PickerSource,
} from "$lib/components/graphs/NodePicker.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { defaultConfig } from "$lib/graphs/config.ts";
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH } from "$lib/graphs/details.ts";
import { iconFor } from "$lib/graphs/icons.ts";
import { loopProblems } from "$lib/graphs/loops.ts";
import { NodePreview } from "$lib/graphs/node-preview.svelte.ts";
import { familyColor, familyOf, isListPort, portColor } from "$lib/graphs/visuals.ts";
import { hrefFor } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";
import { graphRun } from "$lib/state/graph-run.svelte.ts";
import { graphs } from "$lib/state/graphs.svelte.ts";
import { prefs } from "$lib/state/prefs.svelte.ts";
import { theme } from "$lib/state/theme.svelte.ts";

let { graphId }: { graphId: string } = $props();

let graph = $state<Graph | null>(null);
let nodes = $state.raw<Node[]>([]);
let edges = $state.raw<Edge[]>([]);
let loadError = $state<string | null>(null);
let saveError = $state<string | null>(null);
let saving = $state(false);
let dirty = $state(false);
let selectedId = $state<string | null>(null);
/** Which node's secret field is being typed into, and what. Never read back from the daemon. */
let secretDraft = $state<Record<string, string>>({});
/**
 * What is typed in an extractor's field filter.
 *
 * One box for the whole inspector rather than one per row: it narrows a catalogue, and somebody
 * adding four fields off the same object is filtering for the same word each time.
 */
let fieldQuery = $state("");
/** What is typed in the palette's search box. */
let paletteQuery = $state("");
/** Which palette row the arrows are on, counted across every open group. */
let paletteActive = $state(0);
/** The rendered palette rows, so the highlighted one can be scrolled back into view. */
let paletteRows = $state.raw<(HTMLButtonElement | null)[]>([]);
/**
 * Palette groups the user has collapsed, and the ones that start that way.
 *
 * The API groups are hundreds of nodes across nineteen tags, so they start **closed**: a sidebar
 * that opens on two thousand pixels of endpoint names buries the eight categories an ordinary graph
 * is built from. Everything else starts open, because it is short and it is what people came for.
 */
let collapsed = $state<Record<string, boolean>>({});
/**
 * The detail card that appears when you stop on a palette row. See `node-preview.svelte.ts`.
 *
 * One per editor rather than a module singleton: the picker gets its own, and two lists sharing one
 * card would mean whichever was hovered last wins even after it closed.
 */
const preview = new NodePreview();
/** The palette's width, dragged by the handle on its right edge and remembered across sessions. */
let sidebarWidth = $state(prefs.graphSidebarWidth);
let resizing = $state(false);
/** The palette element, so a drag can measure the width from its own left edge rather than 0. */
let aside = $state<HTMLElement | null>(null);
/** What each node of this graph is remembering, so the inspector can offer to forget it. */
let memory = $state<GraphMemoryEntry[]>([]);
let running = $state(false);

/** The right-click menu: where, and what it offers. Null when nothing is open. */
let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

/**
 * The node picker: a wire let go over empty canvas, or a double-click on it.
 *
 * `at` is in **flow** coordinates and `screenX`/`screenY` are in the browser's, because the two
 * answer different questions: the node is created where the gesture landed on the canvas, and the
 * picker is drawn where the pointer is on the screen. Conflating them puts the menu in the wrong
 * place at any zoom but 1.
 *
 * `wire` is null for the double-click case — there is nothing attached, so the whole palette is
 * offered and picking one only creates a node.
 */
let picking = $state<{
  screenX: number;
  screenY: number;
  at: { x: number; y: number };
  wire: (PickerSource & { nodeId: string; portId: string }) | null;
} | null>(null);

/** The canvas element, so a double-click can be told from one on a node. */
let canvas = $state<HTMLDivElement | null>(null);
/** Bound so a double-click can be turned into a flow position without the flow's own context. */
let viewport = $state.raw<Viewport>({ x: 0, y: 0, zoom: 1 });

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
 * The live readout, for as long as this canvas is open and no longer.
 *
 * Returning the teardown from the effect is the whole contract: navigate away, and the polling
 * stops with the component. Nothing about a run costs anything when nobody is looking at it.
 */
$effect(() => {
  graphRun.watch(graphId);
  return () => graphRun.stop();
});

/* ---------------------------------------------------------------------------------------------- */
/* The presentation pass                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Everything drawn *about* the graph rather than stored in it: the loop warnings on cards, and the
 * colour of each wire.
 *
 * It is one effect rather than being computed inline because both `nodes` and `edges` are bound to
 * Svelte Flow, which owns them — a `$derived` copy would be a second array the flow does not know
 * about, and dragging a node would move the wrong one. So the pass writes back into the same arrays,
 * and it writes **only when something actually changed**: an effect that reads what it writes
 * settles on the first equal comparison instead of looping, and a canvas that rewrote its own node
 * array sixty times a second would fight every drag.
 *
 * It also depends on the catalogue, which arrives on its own schedule. A wire drawn before the
 * definitions load is grey and recolours itself the moment they land, rather than staying wrong.
 */
$effect(() => {
  // Read the catalogue explicitly: the styling below goes through helpers, and an effect only
  // re-runs for state it touched itself.
  void graphs.nodeTypes.size;
  applyProblems();
  applyVariadicFloors();
  applyWiredOutputs();
  applyEdgeStyles();
});

/**
 * Raises a variadic node's slot count to cover the wires already in it.
 *
 * A node like `Compose text` declares twenty-six inputs and draws as many as its `slots` field says.
 * Nothing stops that field from saying fewer than the graph is using — an import, a hand-edited
 * document, a slider dragged down — and the result would be an edge feeding a port that is not on
 * the card: a graph doing something with no way to see that it is.
 *
 * So the floor is enforced here rather than only where the slider moves, and it *rewrites the stored
 * value* instead of quietly drawing something else. The value is presentational — the daemon runs
 * every wired input regardless — so correcting it changes nothing about what the graph does, and
 * leaving it wrong would make the slider lie about where it is.
 */
function applyVariadicFloors(): void {
  let changed = false;
  const next = nodes.map((node) => {
    const data = node.data as {
      qualifiedId: string;
      config: Record<string, string | number | boolean>;
    };
    const definition = graphs.definition(data.qualifiedId);
    if (definition === null || definition.kind === "trigger") return node;
    const field = definition.variadicInputs;
    if (field === undefined) return node;
    /*
     * Only a numeric field gets the floor written back into it. A `buttons` field's value *is* the
     * list, and storing a port count over it would delete every button the author added — the
     * floor still applies when the ports are drawn, which is where `visibleInputCount` takes it.
     */
    const declared = definition.config?.find((entry) => entry.id === field);
    if (declared?.kind !== "number" && declared?.kind !== "slider") return node;
    const count = visibleInputCount(definition, data.config, wiredInputFloor(definition, node.id));
    if (data.config[field] === count) return node;
    changed = true;
    return { ...node, data: { ...node.data, config: { ...data.config, [field]: count } } };
  });
  if (changed) nodes = next;
}

/**
 * Tells each extractor card which of its output slots already has an edge.
 *
 * The card cannot work this out for itself — it is handed one node, and this is a fact about the
 * graph — so it arrives in `node.data` the same way `problem` does. It is a **floor**: `visibleOutputs`
 * draws a wired slot whatever the config rows say, so deleting the row that produced a value leaves
 * the port and its wire on screen to be dealt with, rather than hiding an edge that is still there.
 *
 * Only nodes that actually have slots are touched. Writing the key onto all of them would rebuild
 * every node's data object on every edge change for no gain.
 */
function applyWiredOutputs(): void {
  let changed = false;
  const next = nodes.map((node) => {
    const data = node.data as { qualifiedId: string; wiredOutputs?: readonly string[] };
    const definition = graphs.definition(data.qualifiedId);
    if (definition === null || definition.kind === "trigger") return node;
    if (definition.variadicOutputs === undefined) return node;
    const wired = [
      ...new Set(
        edges
          .filter((edge) => edge.source === node.id && edge.sourceHandle != null)
          .map((edge) => edge.sourceHandle as string),
      ),
    ].sort();
    const current = data.wiredOutputs ?? [];
    if (current.length === wired.length && current.every((id, i) => id === wired[i])) return node;
    changed = true;
    return { ...node, data: { ...node.data, wiredOutputs: wired } };
  });
  if (changed) nodes = next;
}

/** The one-based index of the last declared input with an edge in it, or 0 for none. */
function wiredInputFloor(definition: NodeDefinition, nodeId: string): number {
  if (definition.kind === "trigger") return 0;
  let floor = 0;
  for (const edge of edges) {
    if (edge.target !== nodeId || edge.targetHandle == null) continue;
    const index = definition.inputs.findIndex((port) => port.id === edge.targetHandle);
    if (index >= 0) floor = Math.max(floor, index + 1);
  }
  return floor;
}

/** Marks each node that breaks a loop rule, in the words the daemon would use at run time. */
function applyProblems(): void {
  const problems = new Map(
    loopProblems(canvasNodes, canvasEdges).map((problem) => [problem.nodeId, problem.message]),
  );
  const changed = nodes.some(
    (node) => (node.data as { problem?: string }).problem !== problems.get(node.id),
  );
  if (!changed) return;
  nodes = nodes.map((node) => {
    // `problem` is set to undefined rather than left off, so a warning that no longer applies
    // actually clears: spreading the old data would carry the stale key straight through.
    return { ...node, data: { ...node.data, problem: problems.get(node.id) } };
  });
}

/**
 * Colours each wire by what it carries, so a canvas of forty edges is readable without tracing one.
 *
 * The error port is the exception and it is drawn as one: dashed, in the destructive colour, because
 * "this is the path when it breaks" is not a kind of data, it is a different kind of edge.
 */
function applyEdgeStyles(): void {
  let changed = false;
  const next = edges.map((edge) => {
    const source = portType(edge.source, edge.sourceHandle ?? "", "source");
    const isError = edge.sourceHandle === ERROR_PORT;
    const style = isError
      ? "stroke: var(--destructive); stroke-width: 1.5; stroke-dasharray: 4 3;"
      : `stroke: ${source === null ? "var(--port-json)" : portColor(source)}; stroke-width: 1.75;`;
    if (edge.style === style) return edge;
    changed = true;
    return { ...edge, style };
  });
  if (changed) edges = next;
}

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

/**
 * The palette flattened to what is actually on screen, in the order it is drawn.
 *
 * The arrows walk *this*, not `palette` — a row inside a collapsed group is not something you can
 * arrow onto, and counting it would make the highlight skip invisibly past a dozen entries whenever
 * an API group happened to be shut.
 */
const paletteWalk = $derived.by(() => {
  const walk: { qualifiedId: string; definition: NodeDefinition; owner: string }[] = [];
  for (const group of palette) {
    if (!searching && isCollapsed(group.owner)) continue;
    for (const type of group.types) {
      walk.push({ qualifiedId: type.qualifiedId, definition: type.definition, owner: type.owner });
    }
  }
  return walk;
});

/** Back to the top whenever the list changes underneath, so Enter never adds a stale row. */
$effect(() => {
  void paletteQuery;
  paletteActive = 0;
});

$effect(() => {
  paletteRows[paletteActive]?.scrollIntoView({ block: "nearest" });
});

/**
 * Arrow through the palette from its search box, Enter to add.
 *
 * Focus stays in the box the whole way, so the arrows move a highlight rather than the focus ring —
 * moving focus into a list of four hundred buttons would take the caret out of a search somebody is
 * still typing. Escape clears the query rather than blurring: the box is the only thing between the
 * user and a palette they were reading.
 */
function onPaletteKey(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    paletteQuery = "";
    preview.hide();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = paletteWalk.length;
    if (count === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    paletteActive = (paletteActive + step + count) % count;
    // Arrowing is a deliberate act, so the detail card follows it with no delay. Read synchronously
    // rather than after a tick: arrowing does not change the list, so the buttons are already there.
    const moved = paletteWalk[paletteActive];
    if (moved !== undefined) preview.focus(paletteRows[paletteActive] ?? null, moved);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const row = paletteWalk[paletteActive];
    if (row !== undefined) void addNode(row.qualifiedId, row.definition);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* The palette's width                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Dragging the edge between the palette and the canvas.
 *
 * Pointer capture rather than window listeners, which is what makes the drag survive the pointer
 * crossing the canvas: `SvelteFlow` starts a pan on `pointerdown` anywhere in it, and without
 * capture the viewport would slide out from under a drag that strayed two pixels too far right.
 *
 * The width is written to `prefs` on release rather than on every move. A drag is sixty writes a
 * second and `localStorage` is synchronous.
 */
function startResize(event: PointerEvent): void {
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  resizing = true;
  preview.hide();
}

function onResizeMove(event: PointerEvent): void {
  if (!resizing || aside === null) return;
  sidebarWidth = clampSidebarWidth(event.clientX - aside.getBoundingClientRect().left);
}

function endResize(event: PointerEvent): void {
  if (!resizing) return;
  resizing = false;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  prefs.setGraphSidebarWidth(sidebarWidth);
}

/** Double-click the edge to put it back. The way out of a width somebody dragged and regretted. */
function resetWidth(): void {
  sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
  prefs.setGraphSidebarWidth(sidebarWidth);
}

/**
 * The separator is focusable, so it answers the arrows too.
 *
 * Not decoration: a drag is the one gesture in this editor that has no keyboard equivalent at all,
 * and a `separator` with `aria-valuenow` that ignores `ArrowLeft` is a lie told to a screen reader.
 */
function onResizeKey(event: KeyboardEvent): void {
  const step = event.shiftKey ? 48 : 16;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    sidebarWidth = clampSidebarWidth(sidebarWidth + (event.key === "ArrowRight" ? step : -step));
    prefs.setGraphSidebarWidth(sidebarWidth);
    return;
  }
  if (event.key === "Home") {
    event.preventDefault();
    resetWidth();
  }
}

/**
 * The canvas as the loop helpers want it: the node's *vrc.zip* type rather than Svelte Flow's.
 *
 * Every node on this canvas has the flow type `vrcz` — one component draws them all — so `node.type`
 * is the same string for a trigger and a loop, and anything asking "which of these is a For each"
 * has to reach into `data`. Doing that reach once, here, is what keeps it out of the three modules
 * that ask.
 *
 * `measured` is what Svelte Flow filled in after the card rendered. It is absent on the first frame,
 * which the region maths treats as "assume the standard card" rather than as zero — a region that
 * collapsed to a point for one frame flickers on every load.
 */
const canvasNodes = $derived(
  nodes.map((node) => ({
    id: node.id,
    type: (node.data as { qualifiedId: string }).qualifiedId,
    position: node.position,
    width: node.measured?.width,
    height: node.measured?.height,
  })),
);

const canvasEdges = $derived(
  edges.map((edge) => ({
    source: edge.source,
    sourceHandle: edge.sourceHandle ?? null,
    target: edge.target,
    targetHandle: edge.targetHandle ?? null,
  })),
);

const selected = $derived(nodes.find((node) => node.id === selectedId) ?? null);
const selectedDefinition = $derived(definitionOf(selected));
const selectedQualifiedId = $derived(
  selected === null ? null : (selected.data as { qualifiedId: string }).qualifiedId,
);
const selectedProblem = $derived(
  selected === null ? null : ((selected.data as { problem?: string }).problem ?? null),
);
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

/**
 * What to call a node in a sentence.
 *
 * Its type's title, falling back to the node id — which is what a run reports and is never nothing,
 * so a readout about a node whose plugin has stopped still says *which* node rather than blanking.
 */
function titleOf(nodeId: string): string {
  const node = nodes.find((entry) => entry.id === nodeId);
  if (node === undefined) return nodeId;
  return definitionOf(node)?.title ?? nodeId;
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
  if (!("fromHandle" in state) || state.fromHandle === null) return;
  if (state.toHandle !== null) {
    offerConversion(event, state.fromHandle, state.toHandle);
    return;
  }
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
    wire: { nodeId, portId, portType: type, side },
  };
};

/** One end of a wire, as Svelte Flow reports it when the drag ends over a handle. */
interface DroppedHandle {
  readonly nodeId: string;
  /** Optional rather than nullable, which is how Svelte Flow reports an unnamed handle. */
  readonly id?: string | null | undefined;
  readonly type: string;
}

/**
 * A wire let go over a handle it is not allowed to connect to.
 *
 * Until now this did nothing at all, and doing nothing was the wrong answer to the commonest edit
 * in the whole editor: dragging a `json` value into a `For each`'s List. The lattice refuses it on
 * purpose — `json` into a typed port is the unchecked cast that makes a type system decorative — and
 * the honest fix has always been an `As list` node in between. But "you must insert a node whose
 * name you do not know" is not something a refused wire can say, so the wire simply vanished and
 * the canvas looked exactly as it had.
 *
 * So the refusal now offers the conversion. The rule stays strict, the step stays visible on the
 * canvas afterwards, and the two gestures it used to take become one.
 */
function offerConversion(event: MouseEvent | TouchEvent, from: DroppedHandle, to: DroppedHandle): void {
  const source = from.type === "source" ? from : to;
  const target = from.type === "source" ? to : from;
  if (source.type === target.type) return;
  const fromType = portType(source.nodeId, source.id ?? "", "source");
  const toType = portType(target.nodeId, target.id ?? "", "target");
  if (fromType === null || toType === null) return;
  if (!isPortType(fromType) || !isPortType(toType)) return;
  // A legal wire has already been made by `onconnect`; there is nothing to convert.
  if (assignable(fromType, toType)) return;

  const bridges = conversionsBetween(fromType, toType);
  if (bridges.length === 0) return;
  const pointer = "clientX" in event ? event : event.changedTouches[0];
  if (pointer === undefined) return;

  menu = {
    x: pointer.clientX,
    y: pointer.clientY,
    items: bridges.map((bridge) => ({
      label: `Insert "${bridge.definition.title}" and wire it`,
      onSelect: () => {
        const id = addNode(bridge.qualifiedId, bridge.definition, between(source.nodeId, target.nodeId));
        onconnect({
          source: source.nodeId,
          sourceHandle: source.id ?? null,
          target: id,
          targetHandle: bridge.inputId,
        });
        onconnect({
          source: id,
          sourceHandle: bridge.outputId,
          target: target.nodeId,
          targetHandle: target.id ?? null,
        });
      },
    })),
  };
}

/** How many node types to offer as a conversion. More than a few is a palette, not a suggestion. */
const MAX_CONVERSIONS = 3;

/**
 * Node types that would turn a `from` into a `to` in one step.
 *
 * Searched rather than hardcoded to `As list`, because the same shape of dead end exists elsewhere
 * in the lattice and a table of special cases would go stale the first time a built-in is added.
 *
 * Ranked by **how few other ports it leaves dangling**, which is what makes the first row the right
 * one: `As list` takes one value and returns it as a list, while `Make a list` takes several and
 * would satisfy the wire just as well while leaving two empty inputs behind. Total ports first,
 * required ones second — a node with no required inputs is not simpler than one that needs the
 * single value you are already holding.
 */
function conversionsBetween(
  fromType: PortType,
  toType: PortType,
): { qualifiedId: string; definition: NodeDefinition; inputId: string; outputId: string }[] {
  const found = [];
  for (const type of graphs.nodeTypes.values()) {
    const definition = type.definition;
    if (definition.kind === "trigger") continue;
    const input = definition.inputs.find(
      (port) => isPortType(port.type) && assignable(fromType, port.type),
    );
    const output = definition.outputs.find(
      (port) => isPortType(port.type) && assignable(port.type, toType),
    );
    if (input === undefined || output === undefined) continue;
    found.push({
      qualifiedId: type.qualifiedId,
      definition,
      inputId: input.id,
      outputId: output.id,
      ports: definition.inputs.length,
      required: definition.inputs.filter((port) => port.required === true).length,
    });
  }
  return found
    .sort(
      (a, b) =>
        a.ports - b.ports ||
        a.required - b.required ||
        a.definition.title.localeCompare(b.definition.title),
    )
    .slice(0, MAX_CONVERSIONS);
}

/**
 * Roughly halfway between two nodes, which is where a step inserted between them belongs.
 *
 * Dropped a card's height below the midpoint rather than on it: a wire drawn right to left puts the
 * midpoint on top of one of the two nodes, and a new card landing under the cursor looks like it
 * replaced something.
 */
function between(sourceId: string, targetId: string): { x: number; y: number } {
  const a = nodes.find((node) => node.id === sourceId)?.position ?? { x: 0, y: 0 };
  const b = nodes.find((node) => node.id === targetId)?.position ?? { x: 0, y: 0 };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 150 };
}

/**
 * Double-clicking empty canvas offers the palette there.
 *
 * A native listener on the wrapper rather than a Svelte Flow prop, because there is no pane
 * double-click event — and the target check is what keeps it to *empty* canvas: a double-click on a
 * node is somebody selecting a word in its title, and on an input it is somebody editing.
 *
 * `zoomOnDoubleClick` is switched off for this. Two things on one gesture is one thing too many,
 * and the zoom is the one nobody was reaching for: the wheel and the controls both already do it.
 */
function onCanvasDoubleClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  // The pane is the element Svelte Flow puts under everything drawn on the canvas.
  if (target.closest(".svelte-flow__pane") === null) return;
  const box = canvas?.getBoundingClientRect();
  if (box === undefined) return;
  picking = {
    screenX: event.clientX,
    screenY: event.clientY,
    // Screen to flow by hand: `useSvelteFlow()` needs the flow's own context, which this component
    // is the parent of rather than inside. One subtraction and a divide is cheaper than wrapping
    // the whole editor in a provider to reach a helper.
    at: {
      x: (event.clientX - box.left - viewport.x) / viewport.zoom,
      y: (event.clientY - box.top - viewport.y) / viewport.zoom,
    },
    wire: null,
  };
}

/** Creates the chosen node where the gesture landed, and wires it up when a wire was attached. */
function pick(choice: PickerChoice): void {
  const request = picking;
  picking = null;
  if (request === null) return;
  const id = addNode(choice.qualifiedId, choice.definition, request.at);
  const wire = request.wire;
  if (wire === null || choice.portId === null) return;
  onconnect(
    wire.side === "source"
      ? { source: wire.nodeId, sourceHandle: wire.portId, target: id, targetHandle: choice.portId }
      : { source: id, sourceHandle: choice.portId, target: wire.nodeId, targetHandle: wire.portId },
  );
}

/**
 * Roughly what a card takes up, used only to place one.
 *
 * A guess rather than a measurement, because the node does not exist yet: Svelte Flow reports
 * `measured` after the card has rendered, and by then it has already been put somewhere. Being a
 * little out only shifts a new card by a few pixels, which is invisible next to landing off screen.
 */
const CARD = { width: 230, height: 120 };

/**
 * Where a node goes when the gesture that made it did not say.
 *
 * The palette and its Enter key have no position to offer, and the old answer was a fixed spot near
 * the graph's origin — which is *nowhere* the moment somebody has panned away from it. Adding a node
 * and seeing nothing appear is the bug: the node was there, several screens to the left.
 *
 * So the middle of whatever is on screen, in flow coordinates, and then stepped diagonally past
 * anything already sitting there. The step is what keeps a run of adds readable; without it four
 * nodes from the palette are one node with three hidden underneath it.
 */
function freeSpot(): { x: number; y: number } {
  const box = canvas?.getBoundingClientRect();
  const center =
    box === undefined
      ? { x: 120, y: 80 }
      : {
          x: (box.width / 2 - viewport.x) / viewport.zoom - CARD.width / 2,
          y: (box.height / 2 - viewport.y) / viewport.zoom - CARD.height / 2,
        };
  const step = 32;
  // Bounded: a canvas crowded enough to exhaust this wants the last offset, not a hang.
  for (let taken = 0; taken < 40; taken += 1) {
    const spot = { x: center.x + taken * step, y: center.y + taken * step };
    const occupied = nodes.some(
      (node) =>
        Math.abs(node.position.x - spot.x) < step && Math.abs(node.position.y - spot.y) < step,
    );
    if (!occupied) return spot;
  }
  return center;
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
      position: at ?? freeSpot(),
      data: { qualifiedId, config: defaultConfig(definition), stale: false },
    },
  ];
  selectedId = id;
  dirty = true;
  return id;
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

/**
 * Delete removes whatever is selected, and Svelte Flow has already done the removing by the time
 * this runs — the bound `nodes` and `edges` are the new ones. What is left is the bookkeeping only
 * this component knows about: the document is now different from what is on disk, and the inspector
 * may be pointing at something that no longer exists.
 *
 * **Delete, not Backspace.** Backspace is the default and it is the wrong default here: the
 * inspector is a column of text fields, and a Backspace that escaped one would delete the node
 * being configured. Svelte Flow does guard against input elements, but the safe key is the one
 * nobody types into a field by accident.
 */
function ondelete({ nodes: gone }: { nodes: Node[] }): void {
  dirty = true;
  if (selectedId !== null && gone.some((node) => node.id === selectedId)) selectedId = null;
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
    // The readout polls on its own; this is only so the panel updates on the same tick as the click.
    await graphRun.refresh();
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

/**
 * The rows of a `buttons` field, as the inspector edits them.
 *
 * Read back out of the stored string every time rather than kept in a draft: the config is the
 * truth, and a second copy would be a second thing to keep in step with undo, node switching and a
 * graph reloaded from disk.
 */
function buttonRowsOf(fieldId: string): ButtonRow[] {
  if (selected === null) return [];
  return parseButtonRows((selected.data as { config: Record<string, unknown> }).config[fieldId]);
}

/** Writes rows back. The value is JSON in a string; see the `buttons` kind in `@vrcz/plugin-api`. */
function setButtonRows(fieldId: string, rows: readonly ButtonRow[]): void {
  setConfig(fieldId, JSON.stringify(rows));
}

function addButtonRow(fieldId: string, max: number): void {
  const rows = buttonRowsOf(fieldId);
  if (rows.length >= max) return;
  /*
   * The id is what an activation reports back, so it has to be stable and unique for the life of
   * the node. Derived from the highest one already in use rather than from the row count: deleting
   * the middle row and adding another must not hand the new one an id a graph is already wired to.
   */
  let next = rows.length + 1;
  while (rows.some((row) => row.id === `b${String(next)}`)) next += 1;
  setButtonRows(fieldId, [
    ...rows,
    { id: `b${String(next)}`, label: "", action: "signal", argument: "" },
  ]);
}

function updateButtonRow(fieldId: string, index: number, patch: Partial<ButtonRow>): void {
  setButtonRows(
    fieldId,
    buttonRowsOf(fieldId).map((row, i) => (i === index ? { ...row, ...patch } : row)),
  );
}

function removeButtonRow(fieldId: string, index: number): void {
  setButtonRows(
    fieldId,
    buttonRowsOf(fieldId).filter((_, i) => i !== index),
  );
}

/* -------------------------------------------------------------------------------------------- */
/* The extractor rows: a `fields` or `paths` field                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * The rows of a `fields` or `paths` field, read back out of the stored string each time.
 *
 * Same rule as the button rows: the config is the truth, and a draft copy beside it would be a
 * second thing to keep in step with node switching, undo and a graph reloaded from disk.
 */
function slotRowsOf(fieldId: string): SlotRow[] {
  if (selected === null) return [];
  return parseSlotRows((selected.data as { config: Record<string, unknown> }).config[fieldId]);
}

function setSlotRows(fieldId: string, rows: readonly SlotRow[]): void {
  setConfig(fieldId, JSON.stringify(rows));
}

/**
 * The slots of one bank that no row has claimed, in the order the node declares them.
 *
 * Two banks, split by whether the port carries a list, because that is the one thing a slot's type
 * fixes and a field's shape decides. `skip` is the row being edited, so a row changing bank does not
 * count itself as the occupant of the slot it is leaving.
 */
function freeSlots(definition: NodeDefinition, list: boolean, rows: readonly SlotRow[]): string[] {
  if (definition.kind === "trigger") return [];
  const base = definition.variadicOutputsBase ?? 0;
  const taken = new Set(rows.map((row) => row.slot));
  return definition.outputs
    .slice(base)
    .filter((port) => isListPort(port.type) === list && !taken.has(port.id))
    .map((port) => port.id);
}

/**
 * Adds a row on the lowest free slot of the bank it needs, or does nothing when that bank is full.
 *
 * The lowest free one rather than the next by count: a row deleted from the middle frees its slot,
 * and handing that slot to the next row added is what keeps a node's ports from creeping down the
 * card as it is edited.
 */
function addSlotRow(fieldId: string, list: boolean): void {
  if (selectedDefinition === null) return;
  const rows = slotRowsOf(fieldId);
  const slot = freeSlots(selectedDefinition, list, rows)[0];
  if (slot === undefined) return;
  setSlotRows(fieldId, [...rows, { slot, path: "", label: "", list }]);
}

function updateSlotRow(fieldId: string, index: number, patch: Partial<SlotRow>): void {
  setSlotRows(
    fieldId,
    slotRowsOf(fieldId).map((row, i) => (i === index ? { ...row, ...patch } : row)),
  );
}

function removeSlotRow(fieldId: string, index: number): void {
  setSlotRows(
    fieldId,
    slotRowsOf(fieldId).filter((_, i) => i !== index),
  );
}

/**
 * Moves a row to the other bank, because what it holds changed.
 *
 * Picking a field that holds several of something, or ticking "several" by hand, changes which kind
 * of port the row needs — and a port has one type, so it has to be a different slot. **The row keeps
 * its old slot when the target bank is full**, which leaves the value on a `json` port rather than
 * refusing the edit: the runtime reads the slot's declared type, so what arrives is still correct,
 * and a `For each` downstream can take it through an `As list`.
 */
function reslotRow(fieldId: string, index: number, list: boolean): Partial<SlotRow> {
  if (selectedDefinition === null) return { list };
  const rows = slotRowsOf(fieldId);
  const row = rows[index];
  if (row === undefined) return { list };
  if (isListSlot(row.slot) === list) return { list };
  const slot = freeSlots(
    selectedDefinition,
    list,
    rows.filter((_, i) => i !== index),
  )[0];
  return slot === undefined ? { list } : { list, slot };
}

/** Whether a slot id belongs to the list bank, decided by the port rather than by the id's shape. */
function isListSlot(slot: string): boolean {
  const port = selectedDefinition?.outputs.find((entry) => entry.id === slot);
  return port !== undefined && isListPort(port.type);
}

/** Picking a field: it sets the path, names the port, and moves bank if the field holds a list. */
function pickField(
  fieldId: string,
  index: number,
  path: string,
  options: readonly { readonly value: string; readonly label: string; readonly list?: boolean }[],
): void {
  const option = options.find((entry) => entry.value === path);
  const list = option?.list === true;
  updateSlotRow(fieldId, index, {
    ...reslotRow(fieldId, index, list),
    path,
    // The catalogue's own name goes in as the label, which is what makes the override an override:
    // the port reads correctly straight away and the box is there for the times it does not.
    label: option?.label ?? path,
  });
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

/**
 * Ctrl+S, or Cmd+S.
 *
 * **`preventDefault` runs whether or not there is anything to save**, and that is the point of
 * handling it at all. The browser's own Ctrl+S offers to write the page to disk, which is never what
 * somebody in a node editor meant — so the shortcut is claimed for as long as this component is
 * mounted, and a press with nothing dirty is simply a no-op rather than a Save Page dialog.
 *
 * No input guard. Ctrl+S while the caret is in a config field is exactly when people reach for it,
 * and the daemon takes whole documents, so the field being mid-edit changes nothing about what gets
 * written.
 */
function onWindowKey(event: KeyboardEvent): void {
  if (event.key !== "s" && event.key !== "S") return;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  event.preventDefault();
  if (saving || !dirty) return;
  void save();
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

<svelte:window onkeydown={onWindowKey} />

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
    <Button
      size="sm"
      disabled={saving || !dirty}
      title="Ctrl+S"
      onclick={() => void save()}
    >
      <SaveIcon class="size-4" />
      Save
    </Button>
  </div>
</header>

{#if loadError !== null}
  <div class="p-4"><ErrorNote message={loadError} /></div>
{:else}
  <!-- `select-none` only while a drag is live: the cursor is over the canvas half the time and a
       drag that highlights every node title on the way is the usual tell of a hand-rolled splitter. -->
  <div class="flex min-h-0 flex-1" class:select-none={resizing}>
    <!-- The palette. Grouped by owner, built-ins first: two plugins both contributing a "Send"
         node is a flat list where nobody can tell whose is whose. -->
    <aside
      bind:this={aside}
      class="flex shrink-0 flex-col"
      style="width: {sidebarWidth}px"
    >
      <div class="border-b border-border p-2">
        <Input
          bind:value={paletteQuery}
          placeholder="Search nodes"
          aria-label="Search nodes"
          onkeydown={onPaletteKey}
          onblur={() => preview.hide()}
        />
      </div>
      <!--
        `onscroll` closes the detail card rather than moving it. The card is anchored to a rectangle
        measured when it opened, and a list scrolling underneath leaves it pointing at a row that is
        no longer there. The next `mouseenter` re-measures, which is one frame later at most.
      -->
      <div
        class="flex-1 overflow-y-auto p-2"
        role="presentation"
        onscroll={() => preview.hide()}
        onmouseleave={() => preview.hide()}
      >
      {#each palette as group (group.owner)}
        {@const shut = searching ? false : isCollapsed(group.owner)}
        <!-- Where this group's first row sits in `paletteWalk`. A lookup rather than a counter,
             because an `{#each}` body cannot carry state between iterations. -->
        {@const offset = shut ? -1 : paletteWalk.findIndex((row) => row.qualifiedId === group.types[0]?.qualifiedId)}
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
            {#each group.types as type, index (type.qualifiedId)}
              {@const position = offset + index}
              {@const Icon = iconFor(type.definition.category, type.owner)}
              <!--
                The same icon and the same hue the card will have once it is on the canvas, so the
                sidebar is a preview of the thing rather than a list of names that happen to match.
              -->
              <button
                bind:this={paletteRows[position]}
                class="flex w-full items-center gap-2 rounded px-2 py-1 pl-3 text-left text-sm hover:bg-accent {position ===
                paletteActive
                  ? 'bg-accent'
                  : ''}"
                onclick={() => void addNode(type.qualifiedId, type.definition)}
                onmouseenter={(event) => {
                  paletteActive = position;
                  // The whole node, beside the row. This replaced a `title` attribute holding the
                  // description: same information, half a second later, in the OS's own font, with
                  // nowhere to put the ports.
                  preview.hover(event.currentTarget, {
                    qualifiedId: type.qualifiedId,
                    definition: type.definition,
                    owner: type.owner,
                  });
                }}
              >
                <Icon
                  class="size-3.5 shrink-0"
                  style="color: {familyColor(familyOf(type.definition.category, type.owner))}"
                />
                <span class="truncate">{type.definition.title}</span>
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
      The palette's right edge, which is both the border and the grip.

      Four pixels wide and border-coloured, so at rest it reads as the rule it replaced — the `aside`
      gave up its `border-r` to this element rather than sitting beside one, because a separate
      border and a separate handle is two lines a pixel apart and one of them moves.
    -->
    <!--
      A focusable `separator` is the window-splitter pattern from ARIA itself: the role becomes
      interactive precisely when it is given a tabindex and a value, which is what it has here.
      Svelte's rule reads the role in isolation and cannot see that.

      Four pixels wide and sixteen pixels to grab: the `::after` overhangs both sides and is
      hit-tested as part of this element, so the line stays a line while the target is a target.
      A four-pixel grab zone is one every user misses at least once.
    -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="relative w-1 shrink-0 cursor-col-resize bg-border transition-colors after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:content-[''] hover:bg-primary focus-visible:bg-primary focus-visible:outline-none"
      class:bg-primary={resizing}
      role="separator"
      aria-orientation="vertical"
      aria-label="Palette width"
      aria-valuenow={sidebarWidth}
      tabindex="0"
      onpointerdown={startResize}
      onpointermove={onResizeMove}
      onpointerup={endResize}
      onpointercancel={endResize}
      ondblclick={resetWidth}
      onkeydown={onResizeKey}
    ></div>

    <!--
      `colorMode` is not decoration: Svelte Flow ships its own light and dark palettes, and without
      it the controls and the selection ring render white on a dark canvas.
    -->
    <!-- svelte-ignore a11y_no_static_element_interactions -- the double-click is a shortcut for
         something the palette on the left already does with a keyboard and a click. -->
    <div class="min-w-0 flex-1" bind:this={canvas} ondblclick={onCanvasDoubleClick}>
      <SvelteFlow
        bind:nodes
        bind:edges
        bind:viewport
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
        zoomOnDoubleClick={false}
        deleteKey={["Delete"]}
        {ondelete}
      >
        <!--
          Dots rather than the default lines, at a gap that matches the card's own rhythm: a ruled
          grid behind a canvas of rectangles reads as a second set of rectangles, and every wire
          crossing it picked up a stripe.
        -->
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls position="bottom-left" showLock={false} />
        <LoopRegions nodes={canvasNodes} edges={canvasEdges} />
      </SvelteFlow>
      {#if menu !== null}
        <CanvasMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
      {/if}
      {#if picking !== null}
        <NodePicker
          x={picking.screenX}
          y={picking.screenY}
          from={picking.wire}
          onpick={pick}
          onclose={() => (picking = null)}
        />
      {/if}
    </div>

    <!--
      Rendered here rather than inside the palette because it is `position: fixed` and has to escape
      the sidebar's `overflow-y-auto`, which would otherwise clip it to a 224-pixel column.
    -->
    {#if preview.current !== null}
      <NodeDetails
        qualifiedId={preview.current.qualifiedId}
        definition={preview.current.definition}
        owner={preview.current.owner}
        anchor={preview.current.anchor}
      />
    {/if}

    <aside class="w-72 shrink-0 overflow-y-auto border-l border-border p-3">
      {#if saveError !== null}
        <ErrorNote message={saveError} />
      {/if}

      {#if selected !== null && selectedDefinition !== null}
        {@const owner = graphs.nodeTypes.get(selectedQualifiedId ?? "")?.owner ?? "vrcz"}
        {@const Icon = iconFor(selectedDefinition.category, owner)}
        <!--
          The inspector's header, matching the card it is describing. A panel that names a node in
          plain text while the canvas draws it with a colour and an icon makes you check twice that
          you are editing the one you clicked.
        -->
        <div class="mb-3 flex items-start gap-2 border-b border-border pb-3">
          <Icon
            class="mt-0.5 size-4 shrink-0"
            style="color: {familyColor(familyOf(selectedDefinition.category, owner))}"
          />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">{selectedDefinition.title}</div>
            {#if selectedDefinition.category !== undefined}
              <div class="text-[11px] text-muted-foreground">{selectedDefinition.category}</div>
            {/if}
          </div>
        </div>
        {#if selectedDefinition.description !== undefined}
          <p class="mb-3 text-xs text-muted-foreground">{selectedDefinition.description}</p>
        {/if}
        {#if selectedProblem !== null}
          <!--
            The loop rules, said here as well as on the card: the card has room for one line, and
            this is where somebody who has selected the node is already looking.
          -->
          <div
            class="mb-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          >
            {selectedProblem}
          </div>
        {/if}

        {#if (selectedDefinition.config ?? []).length > 0}
          <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Settings
          </div>
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
            {:else if field.kind === "slider"}
              <!--
                The number is beside the track rather than only in a tooltip: this one governs how
                many ports the card has, and dragging it while watching the node grow is the whole
                interaction. A value that only appears on hover would mean looking in two places.
              -->
              {@const current = Number(
                (selected.data as { config: Record<string, unknown> }).config[field.id] ??
                  field.default ??
                  field.min,
              )}
              <div class="flex items-center gap-3">
                <input
                  id={`cfg-${field.id}`}
                  class="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step ?? 1}
                  value={current}
                  oninput={(event: Event) =>
                    setConfig(field.id, Number((event.currentTarget as HTMLInputElement).value))}
                />
                <span class="w-8 shrink-0 text-right text-sm tabular-nums">{current}</span>
              </div>
            {:else if field.kind === "account"}
              <!--
                A picker rather than a text box, because nobody types an account id. The blank
                option is the default and it means "the graph's own account", which is what almost
                every node wants — so it stays selectable even when accounts exist.

                An account the daemon no longer manages still shows its stored id rather than
                silently resetting to blank: quietly re-pointing a node at a different account is
                the one outcome worth avoiding here. The daemon checks the id again at run time.
              -->
              {@const stored = String(
                (selected.data as { config: Record<string, unknown> }).config[field.id] ?? "",
              )}
              <select
                id={`cfg-${field.id}`}
                class="rounded border border-input bg-background px-2 py-1 text-sm"
                value={stored}
                onchange={(event: Event) =>
                  setConfig(field.id, (event.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">The graph's account</option>
                {#each app.accounts as account (account.id)}
                  <option value={account.id}>{account.displayName}</option>
                {/each}
                {#if stored !== "" && !app.accounts.some((account) => account.id === stored)}
                  <option value={stored}>{stored} (not signed in)</option>
                {/if}
              </select>
            {:else if field.kind === "buttons"}
              <!--
                A row per button, added and removed by hand. The alternative was three fixed slots
                of label/action/argument, which is nine boxes — most of them empty — on every node
                that has one, and a number of buttons the schema decides instead of the author.

                The stored value is a JSON array in a string. A config value is
                `string | number | boolean` everywhere it travels, and widening that for one field
                would touch the wire type, the definition hash, the secret substitution and the
                validator. See the `buttons` kind in `@vrcz/plugin-api`.
              -->
              {@const rows = buttonRowsOf(field.id)}
              {@const max = field.max ?? 5}
              {@const actions = field.actions ?? [{ value: "signal", label: "Tell the graph" }]}
              <div class="flex flex-col gap-2">
                <!--
                  Keyed by index, not by id. The id is a text box now, so two rows can hold the same
                  one for as long as it takes to finish typing — and a duplicate key in an `{#each}`
                  is a hard runtime error in Svelte 5 rather than a warning.
                -->
                {#each rows as row, index (index)}
                  {@const chosen = actions.find((option) => option.value === row.action)}
                  {@const duplicate = rows.some((other, i) => i !== index && other.id === row.id)}
                  <div class="rounded border border-border p-2">
                    <div class="flex items-center gap-1">
                      <Input
                        class="h-7 text-sm"
                        placeholder="Button text"
                        value={row.label}
                        oninput={(event: Event) =>
                          updateButtonRow(field.id, index, {
                            label: (event.currentTarget as HTMLInputElement).value,
                          })}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        class="size-7 shrink-0"
                        title="Remove this button"
                        onclick={() => removeButtonRow(field.id, index)}
                      >
                        <TrashIcon class="size-4" />
                      </Button>
                    </div>
                    <select
                      class="mt-1 w-full rounded border border-input bg-background px-2 py-1 text-sm"
                      value={row.action}
                      onchange={(event: Event) =>
                        updateButtonRow(field.id, index, {
                          action: (event.currentTarget as HTMLSelectElement).value,
                        })}
                    >
                      {#each actions as option (option.value)}
                        <option value={option.value}>{option.label}</option>
                      {/each}
                    </select>
                    <!--
                      The name a press reports back, and the reason the row has three boxes rather
                      than two. A graph that wants to know *which* button was pressed reads this, so
                      leaving it as `b1` and `b2` would mean wiring a condition against a number
                      nobody chose. It is asked for only where a press actually arrives — a Dismiss
                      button is closed by Windows and never reaches the daemon.
                    -->
                    {#if chosen?.reportsPress !== false}
                      <Input
                        class="mt-1 h-7 text-sm"
                        placeholder="Called (accept, later, …)"
                        value={row.id}
                        oninput={(event: Event) =>
                          updateButtonRow(field.id, index, {
                            id: (event.currentTarget as HTMLInputElement).value,
                          })}
                      />
                      {#if duplicate}
                        <!--
                          A warning rather than a refusal: the box has to be typeable through a
                          state where two rows briefly match. The daemon keeps the first and drops
                          the rest, which is what this says out loud.
                        -->
                        <span class="text-xs text-destructive">
                          Another button is called this. Only the first one will fire.
                        </span>
                      {/if}
                    {/if}
                    <!--
                      The argument box appears only for an action that takes one. An always-present
                      box beside "Tell the graph" would be asking a question with no answer.
                    -->
                    {#if chosen?.argumentLabel !== undefined}
                      <Input
                        class="mt-1 h-7 text-sm"
                        placeholder={chosen.placeholder ?? chosen.argumentLabel}
                        value={row.argument}
                        oninput={(event: Event) =>
                          updateButtonRow(field.id, index, {
                            argument: (event.currentTarget as HTMLInputElement).value,
                          })}
                      />
                    {/if}
                  </div>
                {/each}
                {#if rows.length < max}
                  <Button size="sm" variant="secondary" onclick={() => addButtonRow(field.id, max)}>
                    Add a button
                  </Button>
                {:else}
                  <span class="text-xs text-muted-foreground">
                    {max} is as many as Windows will show.
                  </span>
                {/if}
              </div>
            {:else if field.kind === "fields" || field.kind === "paths"}
              <!--
                One row per output port. This is the only field that decides what a node *gives*,
                which is why the row carries its slot: deleting the first of six rows must not
                re-point the five wires below it at a different value.

                The two kinds differ only in how the path is entered — a picker over the catalogue
                the node declared, or a box to type one into. Everything else is shared: a name for
                the port, a "several" flag deciding which bank of slots the row lands on, and the
                remove button.
              -->
              {@const rows = slotRowsOf(field.id)}
              {@const options = field.kind === "fields" ? field.options : []}
              {@const roomForValue = freeSlots(selectedDefinition, false, rows).length}
              {@const roomForList = freeSlots(selectedDefinition, true, rows).length}
              <div class="flex flex-col gap-2">
                {#if field.kind === "fields" && options.length > 8}
                  <!--
                    Above the rows, because it changes what every picker below it offers. A user has
                    forty-four fields and a plain dropdown of forty-four is a scroll nobody reads.
                  -->
                  <Input
                    class="h-7 text-sm"
                    placeholder="Filter the {options.length} fields"
                    value={fieldQuery}
                    oninput={(event: Event) =>
                      (fieldQuery = (event.currentTarget as HTMLInputElement).value)}
                  />
                {/if}
                <!--
                  Keyed by index. A slot is unique across rows, but only once a row *has* one, and a
                  duplicate key in an `{#each}` is a hard runtime error in Svelte 5 rather than a
                  warning.
                -->
                {#each rows as row, index (index)}
                  {@const port = selectedDefinition.outputs.find((entry) => entry.id === row.slot)}
                  <div class="rounded border border-border p-2">
                    <div class="flex items-center gap-1">
                      {#if field.kind === "fields"}
                        <!--
                          A search box in front of a select, because the catalogue is forty-four
                          fields for a user and a plain dropdown of forty-four is a scroll nobody
                          reads. Typing narrows it; the select is still the thing that picks.
                        -->
                        <select
                          class="h-7 min-w-0 flex-1 rounded border border-input bg-background px-1 text-sm"
                          value={row.path}
                          onchange={(event: Event) =>
                            pickField(
                              field.id,
                              index,
                              (event.currentTarget as HTMLSelectElement).value,
                              options,
                            )}
                        >
                          <option value="">Pick a field</option>
                          {#each options.filter((option) => fieldQuery === "" || option.value.toLowerCase().includes(fieldQuery.toLowerCase())) as option (option.value)}
                            <option value={option.value}>
                              {option.label}{option.list === true ? " (several)" : ""}
                            </option>
                          {/each}
                          {#if row.path !== "" && !options.some((option) => option.value === row.path)}
                            <!-- A path from an older spec, or a hand-edited document. Kept
                                 selectable rather than silently reset to blank. -->
                            <option value={row.path}>{row.path} (not in this version)</option>
                          {/if}
                        </select>
                      {:else}
                        <Input
                          class="h-7 text-sm"
                          placeholder={field.placeholder ?? "user.displayName"}
                          value={row.path}
                          oninput={(event: Event) =>
                            updateSlotRow(field.id, index, {
                              path: (event.currentTarget as HTMLInputElement).value,
                            })}
                        />
                      {/if}
                      <Button
                        size="icon"
                        variant="ghost"
                        class="size-7 shrink-0"
                        title="Remove this value"
                        onclick={() => removeSlotRow(field.id, index)}
                      >
                        <TrashIcon class="size-4" />
                      </Button>
                    </div>
                    <!--
                      The port's name. Blank means derive it, which is the normal case — the picker
                      writes the field's own name in, and clearing the box falls back to the last
                      segment of the path. The placeholder shows whichever it currently is, so the
                      box always says what the port on the card is called.
                    -->
                    <Input
                      class="mt-1 h-7 text-sm"
                      placeholder={slotRowLabel(row)}
                      value={row.label}
                      oninput={(event: Event) =>
                        updateSlotRow(field.id, index, {
                          label: (event.currentTarget as HTMLInputElement).value,
                        })}
                    />
                    <div class="mt-1 flex items-center justify-between gap-2">
                      {#if field.kind === "paths"}
                        <!--
                          Nothing knows whether a hand-typed path lands on a list, so the author
                          says. Ticked, the row moves to a `list<json>` port, which is the one a
                          For each will take.
                        -->
                        <label class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={row.list}
                            onchange={(event: Event) =>
                              updateSlotRow(
                                field.id,
                                index,
                                reslotRow(
                                  field.id,
                                  index,
                                  (event.currentTarget as HTMLInputElement).checked,
                                ),
                              )}
                          />
                          several
                        </label>
                      {:else}
                        <span></span>
                      {/if}
                      <!--
                        Which port this row is. Worth showing: an exported document names it, and it
                        is how somebody reads a wire in a diff back to a row in this list.
                      -->
                      <span class="font-mono text-[10px] text-muted-foreground">
                        {row.slot}{port === undefined ? " (no such port)" : `: ${port.type}`}
                      </span>
                    </div>
                  </div>
                {/each}
                <div class="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={roomForValue === 0}
                    onclick={() => addSlotRow(field.id, false)}
                  >
                    Add a value
                  </Button>
                  {#if field.kind === "paths"}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={roomForList === 0}
                      onclick={() => addSlotRow(field.id, true)}
                    >
                      Add a list
                    </Button>
                  {/if}
                </div>
                {#if roomForValue === 0 && roomForList === 0}
                  <span class="text-xs text-muted-foreground">
                    Every port on this node is in use. Wire a second one from the same value.
                  </span>
                {/if}
              </div>
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
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          In flight
        </div>
        {#if graphRun.runs.length === 0}
          <p class="text-xs text-muted-foreground">Nothing running.</p>
        {:else}
          {#each graphRun.runs as run (run.id)}
            <div class="mb-2 rounded border border-border p-2 text-xs">
              <div class="flex items-center gap-2">
                <Badge variant="secondary">{run.status}</Badge>
                {#if run.dryRun}<Badge variant="outline">rehearsal</Badge>{/if}
              </div>
              <div class="mt-1 text-muted-foreground">
                started <RelativeTime ts={run.startedAt} />
                {#if run.resumeAt !== null}
                  , resumes <RelativeTime ts={run.resumeAt} />
                {/if}
              </div>
              {#if run.currentNode !== null}
                <div class="mt-1 truncate text-muted-foreground">
                  at {titleOf(run.currentNode)}
                </div>
              {/if}
              {#each run.loops as loop (loop.nodeId)}
                <!--
                  The same number the card shows, in words, for somebody reading the panel rather
                  than looking at the canvas.
                -->
                <div class="mt-1 tabular-nums text-muted-foreground">
                  {titleOf(loop.nodeId)}: item {loop.at} of {loop.of}
                </div>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </aside>
  </div>
{/if}
