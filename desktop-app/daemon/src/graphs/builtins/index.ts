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
  type GraphOpenLink,
  type GraphSocialActions,
} from "./actions.ts";
import { apiNodes, type GraphApiCall } from "./api.ts";
import { collectionNodes } from "./collections.ts";
import { composeNodes } from "./compose.ts";
import { dataStoreNodes, type GraphDataStore } from "./data-store.ts";
import { extractNodes } from "./extract.ts";
import { type GraphLaunchVrchat, type GraphSelf, meNodes } from "./me.ts";
import { operatorNodes } from "./operators.ts";
import { type GraphReads, resolverNodes } from "./resolvers.ts";
import { shapingNodes } from "./shaping.ts";
import { signalNodes } from "./signals.ts";
import { type GraphStateStore, statefulNodes } from "./stateful.ts";
import { type TriggerContext, triggerNodes } from "./triggers.ts";
import { type BuiltinArmRequest, type BuiltinNode, builtinId } from "./types.ts";
import { valueNodes } from "./values.ts";

export type {
  GraphInviteTarget,
  GraphNotify,
  GraphOpenLink,
  GraphSocialActions,
} from "./actions.ts";
export type { GraphApiCall, GraphApiRequest, GraphApiResponse } from "./api.ts";
export type { GraphDataStore } from "./data-store.ts";
export type {
  GraphAccountSummary,
  GraphFavoriteKind,
  GraphGameState,
  GraphLaunchVrchat,
  GraphModeration,
  GraphSelf,
} from "./me.ts";
export type { GraphReads } from "./resolvers.ts";
export type { GraphStateStore } from "./stateful.ts";
export type { TriggerContext } from "./triggers.ts";
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
   * Opens a link in the browser, for the link node and for a notification button that carries one.
   *
   * Absent for the same reason and with the same result as `notify`: the node stays in the palette
   * and says the build cannot open links, rather than leaving a hole in a saved graph.
   */
  readonly openLink?: GraphOpenLink | undefined;
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
  /**
   * Acting on the user's **own** account, for the Me nodes.
   *
   * Absent leaves all of them in the palette failing with a sentence, like the resolvers and for the
   * same reason: a node that vanished would make a saved graph draw a hole with no explanation.
   */
  readonly self?: GraphSelf | undefined;
  /**
   * Opening a `vrchat://` link, for `Show an instance in VRChat`.
   *
   * Absent leaves the one node unable to open anything. That is the honest state for a daemon with
   * no desktop under it, and it is separate from `self` because it is a different machine entirely:
   * everything else here reaches VRChat's API, and this reaches the operating system.
   */
  readonly launch?: GraphLaunchVrchat | undefined;
  /**
   * What a trigger asks about the world at the moment it fires: where the running client is, and
   * whether somebody is a friend.
   *
   * Absent leaves the ports that need it unset and the filters that need it **open** — a build that
   * cannot tell who is a friend fires for everybody rather than silently for nobody. Both answers
   * are required to be synchronous and free; see `TriggerContext` for why that is load-bearing.
   */
  readonly triggerContext?: TriggerContext | undefined;
}

export function createBuiltinNodes(deps: BuiltinNodeDeps = {}): BuiltinNodes {
  const intrinsics: BuiltinNode[] = [...INTRINSIC_DEFINITIONS.values()].map((definition) => ({
    definition,
  }));
  const bus = deps.bus;
  const clock = deps.now === undefined ? {} : { now: deps.now };
  const triggers =
    bus === undefined
      ? []
      : triggerNodes({
          bus,
          ...clock,
          ...(deps.triggerContext === undefined ? {} : { context: deps.triggerContext }),
        });
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
          ...(deps.openLink === undefined ? {} : { openLink: deps.openLink }),
        });
  const clockFn = deps.now ?? Date.now;
  /*
   * The Me nodes, which need the bus for their rehearsal notes like every other action.
   *
   * `state` doubles as the invisible/restore pair's memory: it is the same table, the same seam and
   * the same shape the cooldown uses, so there is nothing here for a second store to be.
   */
  const me =
    bus === undefined
      ? []
      : meNodes({
          bus,
          ...clock,
          ...(deps.self === undefined ? {} : { self: deps.self }),
          ...(deps.launch === undefined ? {} : { launch: deps.launch }),
          ...(deps.state === undefined ? {} : { memory: deps.state }),
        });
  const stateful = deps.state === undefined ? [] : statefulNodes(deps.state, clockFn);
  const stored = deps.data === undefined ? [] : dataStoreNodes(deps.data);
  return new BuiltinNodes([
    ...intrinsics,
    ...triggers,
    ...shapingNodes(),
    ...extractNodes(),
    ...collectionNodes(),
    ...composeNodes(),
    ...operatorNodes(clockFn),
    ...valueNodes(clockFn),
    ...resolverNodes(deps.reads),
    ...stateful,
    ...stored,
    ...actions,
    ...me,
    ...signals,
    // Last, so a hand-written node with the same id would win the map. None does today — the
    // generated ids are all `api-` prefixed — but the ordering states which is the floor.
    ...apiNodes(deps.api),
  ]);
}
