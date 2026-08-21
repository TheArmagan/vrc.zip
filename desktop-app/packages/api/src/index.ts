/**
 * `@vrcz/api` — the generated VRChat client and route table.
 *
 * **Everything under `src/generated/` is codegen output and is committed, never hand-edited.**
 * Regenerate with `bun run codegen` from the workspace root; the spec is pinned by hash, so codegen
 * fails loudly rather than silently picking up a changed upstream. See PLAN.md §1.1.
 */

export {
  BASE_URL,
  ROUTES,
  type Route,
  routeByOperationId,
  SPEC_VERSION,
} from "./generated/routes.ts";
