/**
 * The graph list and the node catalogue.
 *
 * Two things with different lifetimes, and that is why they are one module rather than two: the
 * catalogue changes when a plugin starts or stops, the list changes when the user edits, and every
 * screen that shows either needs both — a graph card cannot name its trigger without the definition
 * that trigger came from.
 *
 * The editor itself does **not** live here. A canvas is a document being edited, with undo, dirty
 * state and a save that can fail; putting it in a module-level singleton would mean two open
 * editors sharing one draft. `GraphEditor.svelte` owns its own copy and this module owns the list.
 */

import type { NodeDefinition } from "@vrcz/plugin-api/nodes";
import type { GraphSummary } from "@vrcz/shared";
import { SvelteMap } from "svelte/reactivity";
import { api, describeError } from "$lib/api.ts";

/** A node type with its definition already narrowed, which is all any caller wants. */
export interface NodeType {
  readonly qualifiedId: string;
  readonly owner: string;
  readonly available: boolean;
  readonly definition: NodeDefinition;
}

class GraphsState {
  graphs = $state<GraphSummary[]>([]);
  /** By qualified id. A `SvelteMap` so a screen can look one up inside a `$derived`. */
  nodeTypes = new SvelteMap<string, NodeType>();
  loading = $state(false);
  error = $state<string | null>(null);
  loaded = $state(false);

  /**
   * Loads both, in parallel.
   *
   * A generation counter rather than an abort: two overlapping loads are the ordinary result of a
   * user pressing enable twice, and the loser has to be ignored rather than have its request torn
   * down — the second answer is the true one either way.
   */
  #generation = 0;

  async load(): Promise<void> {
    const generation = ++this.#generation;
    this.loading = true;
    try {
      const [graphs, types] = await Promise.all([api.graphs.list(), api.graphs.nodeTypes()]);
      if (generation !== this.#generation) return;
      this.graphs = graphs;
      this.nodeTypes.clear();
      for (const entry of types) {
        this.nodeTypes.set(entry.qualifiedId, {
          qualifiedId: entry.qualifiedId,
          owner: entry.owner,
          available: entry.available,
          definition: entry.definition as NodeDefinition,
        });
      }
      this.error = null;
      this.loaded = true;
    } catch (cause) {
      if (generation !== this.#generation) return;
      this.error = describeError(cause);
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  /** Replaces one row in place, so a toggle does not reorder the list under the cursor. */
  replace(summary: GraphSummary): void {
    this.graphs = this.graphs.map((graph) => (graph.id === summary.id ? summary : graph));
  }

  remove(graphId: string): void {
    this.graphs = this.graphs.filter((graph) => graph.id !== graphId);
  }

  /** The definition for a saved node's type, or null when its plugin is not running. */
  definition(qualifiedId: string): NodeDefinition | null {
    return this.nodeTypes.get(qualifiedId)?.definition ?? null;
  }

  /**
   * The palette, grouped by what a node *is* rather than by who owns it.
   *
   * Owner was the first grouping, and it stopped working the moment the built-in set passed three
   * hundred: everything vrc.zip ships has the same owner, so the whole palette was one group called
   * "Built in". A node's `category` is the useful axis — Triggers, Logic, Lists, Values, Send, and
   * one group per VRChat API tag. A plugin's nodes still group under the plugin, because there the
   * question genuinely is "whose is this".
   *
   * The order is fixed for the categories somebody uses while building an ordinary graph, then
   * everything else alphabetically. A palette that reorders itself as plugins come and go is one
   * where muscle memory never forms.
   */
  get palette(): { owner: string; types: NodeType[] }[] {
    const groups = new Map<string, NodeType[]>();
    for (const type of this.nodeTypes.values()) {
      const key = groupKeyFor(type);
      const list = groups.get(key);
      if (list === undefined) groups.set(key, [type]);
      else list.push(type);
    }
    return [...groups.entries()]
      .map(([owner, types]) => ({
        owner,
        types: [...types].sort((a, b) => a.definition.title.localeCompare(b.definition.title)),
      }))
      .sort((a, b) => rank(a.owner) - rank(b.owner) || a.owner.localeCompare(b.owner));
  }
}

/**
 * Which palette group a node belongs in.
 *
 * A built-in goes in its category. A plugin's node goes in **its plugin's** group — and in a
 * sub-group of it when the plugin declared a `category`, which is what `category` was always for
 * ("groups the node in the editor's palette"; the palette simply was not reading it). So a plugin
 * with twenty nodes can offer "acme.notes — Reading" and "acme.notes — Writing" rather than one
 * undifferentiated pile.
 *
 * The plugin id stays in the key whatever the plugin calls its group. That is the same rule the
 * sidebar follows for panels (decision 193): a group called "Reading" with no owner attached would
 * read as a feature of vrc.zip, and a plugin is not vrc.zip.
 */
function groupKeyFor(type: NodeType): string {
  if (type.owner === "vrcz") return type.definition.category ?? "Other";
  const category = type.definition.category?.trim() ?? "";
  return category === "" ? `${type.owner} (plugin)` : `${type.owner} — ${category}`;
}

/**
 * Where a group sits. Lower comes first.
 *
 * The named categories are the ones an ordinary graph is built from, in the order somebody works:
 * something happens, decide about it, shape the values, send something. The generated API groups
 * are hundreds of nodes deep and belong after all of that; plugins come last because they are
 * whoever the user installed.
 */
const GROUP_ORDER: readonly string[] = [
  "Triggers",
  "Logic",
  "Control",
  "Data",
  "Lists",
  // Two groups, not one, and the split is the point: `Collections` is a value on a wire and
  // `Stored data` is a named collection in a store somebody else can read. Next to each other in
  // the palette so the choice is visible, because it decides whether the answer survives a restart.
  "Collections",
  "Stored data",
  "Values",
  "Send",
  "VRChat",
];

function rank(group: string): number {
  const index = GROUP_ORDER.indexOf(group);
  if (index !== -1) return index;
  // A plugin's groups sort together at the end, whatever the plugin named them: both the bare
  // `(plugin)` form and the `owner — category` one carry the owner, which is what `—` detects.
  if (group.endsWith("(plugin)") || group.includes(" — ")) return GROUP_ORDER.length + 2;
  if (group.startsWith("API: ")) return GROUP_ORDER.length + 1;
  return GROUP_ORDER.length;
}

export const graphs = new GraphsState();
