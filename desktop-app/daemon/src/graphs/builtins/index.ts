/**
 * The node types vrc.zip ships itself.
 *
 * They register into the same `NodeRegistry` as a plugin's, under the reserved `vrcz` namespace and
 * exempt from the manifest-declaration check — decision 206, and the reason is that every consumer
 * (the palette, `checkEdge`, the run loader) then asks exactly one place.
 *
 * The **intrinsics** are here too, with no handler. `wait`, `branch` and `foreach` are executed by
 * the engine rather than dispatched, but they still have to appear in the palette and type-check
 * like everything else, so their definitions are registered and their execution is intercepted
 * upstream. A call reaching {@link BuiltinNodes.execute} for one of them is a bug in the engine,
 * which is what the error says.
 */

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import type { EventBus } from "../../bus/event-bus.ts";
import { BUILTIN_NAMESPACE, INTRINSIC_DEFINITIONS } from "../intrinsics.ts";
import type { ExecuteContext } from "../types.ts";
import { shapingNodes } from "./shaping.ts";
import { triggerNodes } from "./triggers.ts";
import { type BuiltinArmRequest, type BuiltinNode, builtinId } from "./types.ts";

export type { BuiltinArmRequest, BuiltinNode } from "./types.ts";

export class BuiltinNodes {
  readonly #nodes = new Map<string, BuiltinNode>();
  /** Teardowns from armed triggers, by instance id. */
  readonly #armed = new Map<string, () => void>();

  constructor(nodes: readonly BuiltinNode[]) {
    for (const node of nodes) this.#nodes.set(builtinId(node.definition, BUILTIN_NAMESPACE), node);
  }

  /** Every definition, for registration into the shared registry. */
  definitions(): NodeDefinition[] {
    return [...this.#nodes.values()].map((node) => node.definition);
  }

  has(type: string): boolean {
    return this.#nodes.has(type);
  }

  definition(type: string): NodeDefinition | null {
    return this.#nodes.get(type)?.definition ?? null;
  }

  async execute(
    type: string,
    inputs: PortValues,
    config: NodeConfigValues,
    context: ExecuteContext,
  ): Promise<PortValues> {
    const node = this.#nodes.get(type);
    if (node?.execute === undefined) {
      throw new Error(`${type} has no handler: the engine should have run it itself.`);
    }
    return await node.execute(inputs, config, context);
  }

  async arm(type: string, request: BuiltinArmRequest): Promise<void> {
    const node = this.#nodes.get(type);
    if (node?.arm === undefined) throw new Error(`${type} is not a trigger.`);
    const teardown = await node.arm(request);
    if (typeof teardown === "function") this.#armed.set(request.instanceId, teardown);
  }

  async disarm(_type: string, instanceId: string): Promise<void> {
    const teardown = this.#armed.get(instanceId);
    this.#armed.delete(instanceId);
    teardown?.();
    await Promise.resolve();
  }
}

/**
 * Every built-in, assembled.
 *
 * Split by what a node *is*, not by what it is called: the shaping nodes are pure and the actions
 * all have a side effect and a dry-run branch, and keeping the two apart is what stops a "shaping"
 * node from quietly doing something.
 */
export interface BuiltinNodeDeps {
  /**
   * The bus, for the triggers.
   *
   * Optional so a test of the pure half needs no daemon around it. A set built without one has no
   * triggers at all rather than triggers that never fire — a node in the palette that cannot work
   * is worse than one that is not offered.
   */
  readonly bus?: EventBus | undefined;
  readonly now?: (() => number) | undefined;
}

export function createBuiltinNodes(deps: BuiltinNodeDeps = {}): BuiltinNodes {
  const intrinsics: BuiltinNode[] = [...INTRINSIC_DEFINITIONS.values()].map((definition) => ({
    definition,
  }));
  const triggers =
    deps.bus === undefined
      ? []
      : triggerNodes({ bus: deps.bus, ...(deps.now === undefined ? {} : { now: deps.now }) });
  return new BuiltinNodes([...intrinsics, ...triggers, ...shapingNodes()]);
}
