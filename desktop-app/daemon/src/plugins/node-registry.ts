/**
 * Plugin-contributed node types: what a plugin has registered, and the calls that register them.
 *
 * PLAN.md §"Node type registration" gives one `NodeDefinition` three consumers — the Svelte Flow
 * editor, the graph runtime, and the type checker. **Two of those three exist here**; the editor is
 * Phase 4's, and decision 182 scoped this step to registration, the runtime and the checker rather
 * than pulling the canvas forward. So this file is where a definition lands, is validated, and is
 * held for whoever asks.
 *
 * ## Registered at runtime, declared in the manifest
 *
 * A plugin declares node *ids* in `contributes.nodes` and registers the real definition when it
 * activates. Both halves matter and they answer different questions:
 *
 *  - The manifest's list is what the host knows **without running the plugin** — enough for a saved
 *    graph to say "this node type comes from a plugin that is currently disabled" rather than
 *    showing a hole.
 *  - The registration carries the ports, the config schema and the body template, none of which can
 *    live in a manifest without duplicating the source of truth.
 *
 * **A registration whose id is not declared is refused.** `manifest.md` says checking the two lists
 * agree is the install pipeline's job and that the pipeline does not do it; the pipeline cannot, in
 * fact — the definitions only exist once the plugin runs. Here both halves are in hand, so here is
 * where it is checked.
 *
 * ## Definitions die with the process, declarations do not
 *
 * Same rule as panels, for the same reason: a node type whose plugin is not running cannot execute,
 * and a graph referencing it must be **paused and marked unavailable, never deleted** (PLAN.md
 * §Manifest). Keeping the declaration while dropping the definition is exactly what lets the graph
 * editor say which of those two it is looking at.
 */

import {
  AFTER_PORT,
  assignable,
  defineMethod,
  ERROR_PORT,
  type ErasedMethod,
  isPortType,
  isTriggerDefinition,
  type MethodDefinition,
  type NodeDefinition,
  type PortType,
  RESERVED_NODE_NAMESPACE,
  validateNodeDefinition,
} from "@vrcz/plugin-api";
import { isJsonObject, type JsonValue } from "@vrcz/shared";
import { DispatchError } from "./dispatcher.ts";
import type { GatedMethodTable } from "./scope-gate.ts";

/** How many node types one plugin may register. The manifest's own cap on declared nodes. */
export const MAX_NODES_PER_PLUGIN = 64;

/** One registered node type, as the graph editor and runtime see it. */
export interface RegisteredNode {
  readonly pluginId: string;
  /** Globally unique: `<pluginId>/<node id>`, which is what a saved graph stores. */
  readonly qualifiedId: string;
  readonly definition: NodeDefinition;
  readonly registeredAt: number;
}

export interface NodeRegistryOptions {
  /**
   * The node ids a plugin declared in its manifest.
   *
   * A function rather than a snapshot because the registry outlives any one plugin's install, and
   * reading it per registration keeps "what was declared" a fact about the row rather than a copy
   * that can go stale after an update.
   */
  readonly declaredNodes: (pluginId: string) => readonly string[];
  readonly now?: () => number;
}

export class NodeRegistry {
  readonly #nodes = new Map<string, Map<string, RegisteredNode>>();
  readonly #declared: (pluginId: string) => readonly string[];
  readonly #now: () => number;

  constructor(options: NodeRegistryOptions) {
    this.#declared = options.declaredNodes;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Every node type currently registered, across every running plugin. */
  list(): RegisteredNode[] {
    return [...this.#nodes.values()].flatMap((owned) => [...owned.values()]);
  }

  listFor(pluginId: string): RegisteredNode[] {
    return [...(this.#nodes.get(pluginId)?.values() ?? [])];
  }

  get(qualifiedId: string): RegisteredNode | null {
    const [pluginId] = qualifiedId.split("/", 1);
    if (pluginId === undefined) return null;
    return this.#nodes.get(pluginId)?.get(qualifiedId) ?? null;
  }

  /**
   * Registers a node type the **host** owns, under the reserved namespace.
   *
   * Exempt from the manifest-declaration check and from nothing else: same map, same qualified ids,
   * same `checkEdge`. Decision 206 chose one registry over two precisely so that every consumer —
   * the editor's palette, the type checker, the run loader — asks a single place and never has to
   * know which kind of node it is holding.
   */
  registerBuiltin(definition: NodeDefinition): RegisteredNode {
    return this.#insert(RESERVED_NODE_NAMESPACE, definition);
  }

  register(pluginId: string, definition: NodeDefinition): RegisteredNode {
    if (pluginId === RESERVED_NODE_NAMESPACE) {
      throw new DispatchError(
        "E_BAD_REQUEST",
        `"${RESERVED_NODE_NAMESPACE}" is reserved for vrc.zip's own node types. A saved graph names a node type by "<owner>/<id>", so a plugin claiming it could shadow a built-in on somebody else's machine.`,
      );
    }
    if (!this.#declared(pluginId).includes(definition.id)) {
      throw new DispatchError(
        "E_BAD_REQUEST",
        `"${definition.id}" is not in this plugin's contributes.nodes. Declare it in the manifest, which is what lets a saved graph name it while the plugin is stopped.`,
      );
    }
    return this.#insert(pluginId, definition);
  }

  #insert(pluginId: string, definition: NodeDefinition): RegisteredNode {
    let owned = this.#nodes.get(pluginId);
    if (owned === undefined) {
      owned = new Map();
      this.#nodes.set(pluginId, owned);
    }
    const qualifiedId = `${pluginId}/${definition.id}`;
    // The cap is per owner and the host is an owner like any other, but it is not a plugin: the
    // sentence would be nonsense for a built-in, and a daemon that shipped more than 64 of its own
    // node types has a design problem no error message will fix.
    if (
      pluginId !== RESERVED_NODE_NAMESPACE &&
      !owned.has(qualifiedId) &&
      owned.size >= MAX_NODES_PER_PLUGIN
    ) {
      throw new DispatchError(
        "E_TOO_LARGE",
        `A plugin may register ${MAX_NODES_PER_PLUGIN} node types.`,
      );
    }

    const entry: RegisteredNode = {
      pluginId,
      qualifiedId,
      definition,
      registeredAt: this.#now(),
    };
    owned.set(qualifiedId, entry);
    return entry;
  }

  /** Drops everything a plugin registered. Called when it stops, however it stopped. */
  clear(pluginId: string): void {
    this.#nodes.delete(pluginId);
  }
}

/**
 * Whether an edge is legal: `from`'s output type into `to`'s input type.
 *
 * A thin wrapper over `assignable` so the daemon has one name for the check and Phase 4's runtime
 * does not reach into `@vrcz/plugin-api` for it directly. PLAN.md is explicit that this runs
 * **twice on purpose** — in the editor for instant feedback, and again here on save and at each
 * execution boundary, because the frontend is a client and clients lie.
 */
export function edgeAllowed(from: PortType, to: PortType): boolean {
  return assignable(from, to);
}

/**
 * Type-checks one edge between two registered nodes, by port id.
 *
 * Returns the reason it was refused, or null when it is legal. A sentence rather than a boolean
 * because every refusal here is one a *user* sees while wiring a graph, and "incompatible" without
 * the two types named is a dead end.
 */
export function checkEdge(
  registry: NodeRegistry,
  from: { nodeType: string; portId: string },
  to: { nodeType: string; portId: string },
): string | null {
  const source = registry.get(from.nodeType);
  const target = registry.get(to.nodeType);
  if (source === null) return `${from.nodeType} is not a registered node type.`;
  if (target === null) return `${to.nodeType} is not a registered node type.`;

  /*
   * The two implicit ports, which no definition declares and every node has.
   *
   * `after` accepts anything, because it carries no value — it exists so a node can be ordered
   * behind another one. `error` carries the message a throw produced, which is a `string`.
   *
   * Handling them here rather than in each caller is the point: the engine has supported both since
   * the walk was written, and a save-time check that did not know about them refused graphs the
   * runtime would have run perfectly. That is precisely the drift `checkEdge` exists to prevent.
   */
  if (to.portId === AFTER_PORT) return null;

  const output =
    from.portId === ERROR_PORT
      ? { id: ERROR_PORT, label: "on error", type: "string" as const }
      : source.definition.outputs.find((port) => port.id === from.portId);
  if (output === undefined) return `${from.nodeType} has no output called "${from.portId}".`;

  const inputs = isTriggerDefinition(target.definition) ? [] : target.definition.inputs;
  const input = inputs.find((port) => port.id === to.portId);
  if (input === undefined) {
    return isTriggerDefinition(target.definition)
      ? `${to.nodeType} is a trigger: it starts a graph and takes no inputs.`
      : `${to.nodeType} has no input called "${to.portId}".`;
  }

  if (!edgeAllowed(output.type, input.type)) {
    return `A ${output.type} cannot flow into a ${input.type}.`;
  }
  return null;
}

function nodeMethod<Params, Result extends JsonValue | undefined>(
  definition: Omit<MethodDefinition<Params, Result>, "scope" | "capability" | "cost">,
): ErasedMethod {
  return defineMethod({ scope: null, capability: null, cost: 0, ...definition });
}

export interface NodeMethodDeps {
  readonly nodes: NodeRegistry;
  /**
   * A trigger instance fired.
   *
   * Phase 4's runtime is what listens; until it exists this is a seam rather than a no-op, so that
   * a plugin written against `fire()` today behaves identically the day the graph runtime lands.
   */
  readonly onFire?: (event: { pluginId: string; instanceId: string; outputs: JsonValue }) => void;
}

/**
 * The `nodes.*` table.
 *
 * No scope and no capability, for the same reason `ui.*` has none: registering a node type is a
 * plugin describing what it can do, not doing it. **Authority is checked when the node runs** —
 * whatever the node's handler calls goes through the same gate as any other plugin call, so a node
 * cannot become a way to reach a scope its plugin was not granted.
 */
export function createNodeMethods(deps: NodeMethodDeps): GatedMethodTable {
  return {
    "nodes.register": {
      account: "none",
      method: nodeMethod<NodeDefinition, { qualifiedId: string }>({
        parse: (raw) => {
          if (!isJsonObject(raw)) throw new DispatchError("E_BAD_REQUEST", "Expected an object.");
          const result = validateNodeDefinition(raw.definition);
          if (!result.ok) {
            throw new DispatchError(
              "E_BAD_REQUEST",
              `definition is not a valid node type: ${result.issues
                .map((issue) => `${issue.path} ${issue.message}`)
                .join("; ")}`,
            );
          }
          return { ok: true, value: result.definition };
        },
        handle: async (definition, ctx) => ({
          qualifiedId: deps.nodes.register(ctx.grant.pluginId, definition).qualifiedId,
        }),
      }),
    },

    "nodes.fire": {
      account: "none",
      method: nodeMethod<{ instanceId: string; outputs: JsonValue }, null>({
        parse: (raw) => {
          if (!isJsonObject(raw)) throw new DispatchError("E_BAD_REQUEST", "Expected an object.");
          const instanceId = raw.instanceId;
          if (typeof instanceId !== "string" || instanceId === "") {
            throw new DispatchError(
              "E_BAD_REQUEST",
              "instanceId must name the armed trigger instance this fire belongs to.",
            );
          }
          return { ok: true, value: { instanceId, outputs: raw.outputs ?? null } };
        },
        handle: async ({ instanceId, outputs }, ctx) => {
          deps.onFire?.({ pluginId: ctx.grant.pluginId, instanceId, outputs });
          return null;
        },
      }),
    },
  };
}

/** Re-exported so a caller does not have to know which package the port vocabulary lives in. */
export { isPortType };
