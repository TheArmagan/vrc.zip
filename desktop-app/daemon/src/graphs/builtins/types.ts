/**
 * What a node the daemon itself owns looks like.
 *
 * A plugin's node is a definition in the registry plus a handler in another process. A built-in is
 * both halves in one object, because there is no process boundary to keep them apart — and the
 * definition is still a real {@link NodeDefinition}, registered into the same `NodeRegistry`, so the
 * palette, `checkEdge` and the run loader ask exactly one place. Decision 206 chose that over a
 * second registry precisely so no consumer has to know which kind of node it is holding.
 */

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import type { ExecuteContext } from "../types.ts";

/** A trigger's side of an arming, without the plugin RPC. */
export interface BuiltinArmRequest {
  readonly instanceId: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly config: NodeConfigValues;
  fire(outputs: PortValues): void;
}

export interface BuiltinNode {
  readonly definition: NodeDefinition;
  /** Actions and conditions. Absent for a trigger, which arms instead. */
  execute?(
    inputs: PortValues,
    config: NodeConfigValues,
    context: ExecuteContext,
  ): PortValues | Promise<PortValues>;
  /**
   * Triggers. Return a teardown, or `undefined` for one with nothing to tear down.
   *
   * `undefined` rather than `void` in the union: a `void` member says "ignore whatever comes back",
   * which is the opposite of the contract here — the return value is the disarm, and dropping it
   * would leave a bus subscription live for a graph the user switched off.
   */
  arm?(request: BuiltinArmRequest): (() => void) | undefined | Promise<(() => void) | undefined>;
}

/** A node's qualified id: `vrcz/<definition id>`. */
export function builtinId(definition: NodeDefinition, namespace: string): string {
  return `${namespace}/${definition.id}`;
}
