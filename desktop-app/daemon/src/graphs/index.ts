/**
 * The graph runtime. See PLAN.md §Phase 4.
 *
 * `app.ts` constructs a {@link GraphEngine} with a {@link NodeProvider}; nothing else in the daemon
 * needs to know how a run works.
 */

export { GraphEngine, type GraphEngineOptions } from "./engine.ts";
export {
  BRANCH_TYPE,
  BUILTIN_NAMESPACE,
  ERROR_PORT,
  FOREACH_TYPE,
  INTRINSIC_DEFINITIONS,
  isIntrinsic,
  MISSED_RESUME_GRACE_MS,
  WAIT_ON_MISSED,
  WAIT_TYPE,
  type WaitOnMissed,
} from "./intrinsics.ts";
export { DEFAULT_GRAPH_LIMITS, type GraphLimits } from "./limits.ts";
export type {
  ArmRequest,
  ExecuteContext,
  NodeProvider,
  RunOutcome,
  RunState,
} from "./types.ts";
