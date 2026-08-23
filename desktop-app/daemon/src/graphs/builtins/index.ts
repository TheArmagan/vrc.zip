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
import {
  actionNodes,
  type GraphFetch,
  type GraphNotify,
  type GraphSocialActions,
} from "./actions.ts";
import { apiNodes, type GraphApiCall } from "./api.ts";
import { collectionNodes } from "./collections.ts";
import { dataStoreNodes, type GraphDataStore } from "./data-store.ts";
import { operatorNodes } from "./operators.ts";
import { type GraphReads, resolverNodes } from "./resolvers.ts";
import { shapingNodes } from "./shaping.ts";
import { signalNodes } from "./signals.ts";
import { type GraphStateStore, statefulNodes } from "./stateful.ts";
import { triggerNodes } from "./triggers.ts";
import { type BuiltinArmRequest, type BuiltinNode, builtinId } from "./types.ts";
import { valueNodes } from "./values.ts";

export type { GraphInviteTarget, GraphNotify, GraphSocialActions } from "./actions.ts";
export type { GraphApiCall, GraphApiRequest, GraphApiResponse } from "./api.ts";
export type { GraphDataStore } from "./data-store.ts";
export type { GraphReads } from "./resolvers.ts";
export type { GraphStateStore } from "./stateful.ts";
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
  /**
   * The outbound social actions. Absent leaves the VRChat nodes in the palette but unable to send,
   * which is the honest state for a daemon with no account manager behind it — and they say so
   * rather than pretending.
   */
  readonly social?: GraphSocialActions | undefined;
  /** Injected so a test can answer an outbound POST without a network. */
  readonly fetch?: GraphFetch;
  /**
   * Raises an OS notification, for the desktop node.
   *
   * Absent leaves the node in the palette failing with a sentence, like the resolvers: "this build
   * cannot notify" and "your machine showed nothing" are different problems, and a node that
   * vanished would make a saved graph draw a hole with no explanation.
   */
  readonly notify?: GraphNotify | undefined;
  /**
   * VRChat reads and the game log, for the resolver nodes.
   *
   * Absent leaves them in the palette and failing with a sentence. That is better than hiding them:
   * a node that vanished would make a saved graph draw a hole with no explanation.
   */
  readonly reads?: GraphReads | undefined;
  /**
   * Where the cooldown and counter nodes remember things. Absent drops both from the set — unlike
   * the resolvers, a stateful node with nowhere to write cannot even fail usefully.
   */
  readonly state?: GraphStateStore | undefined;
  /**
   * The named stores, for the `store-*` nodes.
   *
   * Absent drops them, like the stateful nodes above and for the same reason: a `Map: set` with
   * nowhere to write cannot even fail usefully — it would report having saved something that was
   * never there to read back.
   */
  readonly data?: GraphDataStore | undefined;
  /**
   * Calls one VRChat operation, for the generated API nodes.
   *
   * Absent leaves all 286 of them in the palette, each failing with a sentence. Hiding them would
   * be worse: a saved graph naming one would draw a hole with no explanation.
   */
  readonly api?: GraphApiCall | undefined;
}

export function createBuiltinNodes(deps: BuiltinNodeDeps = {}): BuiltinNodes {
  const intrinsics: BuiltinNode[] = [...INTRINSIC_DEFINITIONS.values()].map((definition) => ({
    definition,
  }));
  const bus = deps.bus;
  const clock = deps.now === undefined ? {} : { now: deps.now };
  const triggers = bus === undefined ? [] : triggerNodes({ bus, ...clock });
  const signals =
    bus === undefined
      ? []
      : signalNodes({
          bus,
          ...clock,
          ...(deps.state === undefined ? {} : { state: deps.state }),
        });
  const actions =
    bus === undefined
      ? []
      : actionNodes({
          bus,
          ...clock,
          ...(deps.social === undefined ? {} : { social: deps.social }),
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(deps.notify === undefined ? {} : { notify: deps.notify }),
        });
  const clockFn = deps.now ?? Date.now;
  const stateful = deps.state === undefined ? [] : statefulNodes(deps.state, clockFn);
  const stored = deps.data === undefined ? [] : dataStoreNodes(deps.data);
  return new BuiltinNodes([
    ...intrinsics,
    ...triggers,
    ...shapingNodes(),
    ...collectionNodes(),
    ...operatorNodes(clockFn),
    ...valueNodes(clockFn),
    ...resolverNodes(deps.reads),
    ...stateful,
    ...stored,
    ...actions,
    ...signals,
    // Last, so a hand-written node with the same id would win the map. None does today — the
    // generated ids are all `api-` prefixed — but the ordering states which is the floor.
    ...apiNodes(deps.api),
  ]);
}
