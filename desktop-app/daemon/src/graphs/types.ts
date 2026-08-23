/**
 * The runtime's own vocabulary: what the engine needs from the world, and what it keeps in a run.
 *
 * The engine is written against {@link NodeProvider} rather than against the plugin host, and that
 * is the seam that makes 4.2 testable before 4.3 exists: a fake provider is four methods, and the
 * engine cannot tell it from the real one. It is also what lets built-in nodes and plugin nodes be
 * the same thing to the engine — the composite provider is the only place that knows the difference.
 */

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import type { GraphNodeConfig } from "@vrcz/shared";

/**
 * `GraphNodeConfig` and `NodeConfigValues` must stay the same shape, and this is where that is
 * checked. `@vrcz/shared` cannot import `@vrcz/plugin-api` (the dependency runs the other way), so
 * the two are declared separately; the daemon is the one place that imports both. Assignability in
 * **both** directions, because a widening on either side is a drift.
 */
type _ConfigMirrorsForward = GraphNodeConfig extends NodeConfigValues ? true : never;
type _ConfigMirrorsBack = NodeConfigValues extends GraphNodeConfig ? true : never;
export const CONFIG_SHAPES_AGREE: _ConfigMirrorsForward & _ConfigMirrorsBack = true;

/** What the engine hands a trigger when it arms one instance of it. */
export interface ArmRequest {
  /** Unique per armed instance, so a `fire` can be attributed and a disarm can be targeted. */
  readonly instanceId: string;
  readonly graphId: string;
  readonly nodeId: string;
  readonly config: NodeConfigValues;
  /** Starts one run downstream of this trigger. Safe to call from any context; never throws. */
  fire(outputs: PortValues): void;
}

/**
 * What a node is told about the run it is executing in.
 *
 * `dryRun` and `accountId` are both here rather than in the config because neither is the author's
 * to type: dry-run is a property of the run (captured when it started, so arming a graph cannot
 * promote a rehearsal already in flight), and the acting account resolves per node against the
 * graph's default. An action that ignores `dryRun` is a bug in that action, and 4.3's built-ins are
 * where that stops being a matter of trust.
 */
export interface ExecuteContext {
  readonly graphId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly dryRun: boolean;
  /** The node's own account, else the graph's, else null. Null is normal, not an error. */
  readonly accountId: string | null;
}

/**
 * Where node types come from, as far as the engine is concerned.
 *
 * `definition` returning null is a **normal state**, not an error: a plugin that is stopped takes
 * its node types with it, and the graph that used them is paused rather than broken. See PLAN.md
 * §Phase 4 — paused and marked unavailable, never deleted.
 */
export interface NodeProvider {
  definition(type: string): NodeDefinition | null;
  arm(type: string, request: ArmRequest): Promise<void>;
  disarm(type: string, instanceId: string): Promise<void>;
  execute(
    type: string,
    inputs: PortValues,
    config: NodeConfigValues,
    context: ExecuteContext,
  ): Promise<PortValues>;
}

/**
 * A run, as it is written to `graph_runs.state` at every node boundary.
 *
 * Everything here has to survive `JSON.stringify` and a daemon restart, which is why it is plain
 * data and not a Map: a run parked on a `wait` may be reloaded by a different process.
 */
export interface RunState {
  /**
   * What each settled node produced, keyed by node id.
   *
   * A **missing key** on a port is the engine's one gating mechanism, and everything reuses it: a
   * condition that answered false records nothing, a branch records only the side it took, and a
   * node that failed onto its error port records only `error`. Downstream of an unproduced port is
   * dead, and a node with a dead input is skipped.
   */
  readonly outputs: Record<string, PortValues>;
  /** Settled as skipped. Distinct from absent, which means "not reached yet". */
  readonly skipped: string[];
  /** Node ids in execution order. Its length is the run-size ceiling's counter. */
  readonly executed: string[];
}

export type RunOutcome =
  | { readonly kind: "finished" }
  | { readonly kind: "waiting"; readonly resumeAt: number }
  | { readonly kind: "failed"; readonly node: string; readonly message: string };
