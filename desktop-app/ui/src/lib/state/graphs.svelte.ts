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
   * The palette, grouped by owner with the built-ins first.
   *
   * Grouped rather than flat for the same reason the plugin sidebar is: two plugins contributing a
   * node called "Send" is a list where nobody can tell whose is whose.
   */
  get palette(): { owner: string; types: NodeType[] }[] {
    const groups = new Map<string, NodeType[]>();
    for (const type of this.nodeTypes.values()) {
      const list = groups.get(type.owner);
      if (list === undefined) groups.set(type.owner, [type]);
      else list.push(type);
    }
    return [...groups.entries()]
      .map(([owner, types]) => ({
        owner,
        types: [...types].sort((a, b) => a.definition.title.localeCompare(b.definition.title)),
      }))
      .sort((a, b) =>
        a.owner === "vrcz" ? -1 : b.owner === "vrcz" ? 1 : a.owner.localeCompare(b.owner),
      );
  }
}

export const graphs = new GraphsState();
