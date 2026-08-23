/**
 * Where the graph engine gets its node types from.
 *
 * The engine is written against `NodeProvider` and knows nothing about plugins; this is the adapter
 * that makes plugin-contributed nodes look like any other node to it — the same posture as every
 * other module in `wiring/`, which exists so the subsystems stay unaware of each other.
 *
 * It also closes the loop `nodes.fire` has been waiting on since 3.10. A plugin calls `fire()` with
 * the instance id it was armed with; the host raises `onNodeFire`; {@link PluginNodeProvider.onFire}
 * looks the instance up and calls the engine's callback for it. Until Phase 4 that seam was wired to
 * nothing, which is why a plugin written against `fire()` in 3.10 starts working here with no change
 * to the plugin.
 */

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import type { JsonValue } from "@vrcz/shared";
import type { BuiltinNodes } from "../graphs/builtins/index.ts";
import type { ArmRequest, ExecuteContext, NodeProvider } from "../graphs/index.ts";
import type { PluginHost } from "./plugin-host.ts";

export interface PluginNodeProviderOptions {
  /** Absent for a daemon built without plugins, which is a normal configuration. */
  readonly host?: PluginHost | undefined;
  /** The node types the daemon owns. Always present; a daemon with no built-ins has no graphs. */
  readonly builtins: BuiltinNodes;
}

export class PluginNodeProvider implements NodeProvider {
  readonly #host: PluginHost | undefined;
  readonly #builtins: BuiltinNodes;

  /**
   * Armed instances, by the id the plugin was given.
   *
   * The map is the *only* thing that can turn a `nodes.fire` back into a graph, which is what makes
   * a fire for an instance that was already disarmed a no-op rather than a run of something the user
   * switched off. A plugin holding a stale id cannot start anything.
   */
  readonly #armed = new Map<string, ArmRequest>();

  constructor(options: PluginNodeProviderOptions) {
    this.#host = options.host;
    this.#builtins = options.builtins;
  }

  definition(type: string): NodeDefinition | null {
    return this.#builtins.definition(type) ?? this.#host?.nodeType(type)?.definition ?? null;
  }

  async arm(type: string, request: ArmRequest): Promise<void> {
    // Registered before the call, not after: a trigger is free to fire from inside its own arming,
    // and an instance that is not in the map yet would have that first fire silently dropped.
    this.#armed.set(request.instanceId, request);
    try {
      if (this.#builtins.has(type)) await this.#builtins.arm(type, request);
      else await this.#requireHost().armNode(type, request.instanceId, request.config);
    } catch (error) {
      this.#armed.delete(request.instanceId);
      throw error;
    }
  }

  async disarm(type: string, instanceId: string): Promise<void> {
    this.#armed.delete(instanceId);
    // Best effort past this point. The instance is gone from the map either way, so a trigger that
    // cannot be told — because its plugin already died, which is the common case — starts nothing.
    if (this.#builtins.has(type)) await this.#builtins.disarm(type, instanceId);
    else await this.#requireHost().disarmNode(type, instanceId);
  }

  async execute(
    type: string,
    inputs: PortValues,
    config: NodeConfigValues,
    context: ExecuteContext,
  ): Promise<PortValues> {
    if (this.#builtins.has(type)) {
      return await this.#builtins.execute(type, inputs, config, context);
    }
    return await this.#requireHost().executeNode(type, inputs, config);
  }

  /** The `onNodeFire` seam's other end. Unknown instance ids are dropped, deliberately. */
  onFire(event: { pluginId: string; instanceId: string; outputs: JsonValue }): void {
    const armed = this.#armed.get(event.instanceId);
    if (armed === undefined) return;
    armed.fire(asPortValues(event.outputs));
  }

  #requireHost(): PluginHost {
    if (this.#host === undefined) {
      throw new Error("This daemon cannot run plugin nodes: it was built without a plugin host.");
    }
    return this.#host;
  }
}

/**
 * A fire's payload as ports.
 *
 * A plugin may answer with anything JSON, and a non-object carries no ports — which downstream
 * reads as every edge from the trigger being dead. That is the honest shape for "it fired but said
 * nothing", and it keeps a malformed fire from failing a run the user cannot debug.
 */
function asPortValues(outputs: JsonValue): PortValues {
  return typeof outputs === "object" && outputs !== null && !Array.isArray(outputs) ? outputs : {};
}
