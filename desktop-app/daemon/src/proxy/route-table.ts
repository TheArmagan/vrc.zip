/**
 * Matching a request against the generated route table.
 *
 * The table is codegen output from the pinned spec (`packages/api/src/generated/routes.ts`), so
 * scope coverage cannot silently drift when the spec updates — a new operation arrives with a scope
 * or the codegen test fails. This module is the read side: given a method and a path, which
 * operation is it, and therefore which scope does it need.
 *
 * **Matching is exact-segment, never a catch-all.** PLAN.md §1.8 is specific about why: an unknown
 * path has to fall through to VRChat's real 404 shape rather than being answered by a handler that
 * has to guess what it was. A path that matches nothing here is a path the mirror does not serve,
 * and saying so in VRChat's own words is the byte-faithful answer.
 *
 * Two templates can match the same concrete path — `/users/{userId}` and `/users/active` both match
 * `/users/active` — and VRChat resolves that the way every router does, by preferring the literal.
 * `match` sorts literals ahead of parameters segment by segment so the same request lands on the
 * same operation here as it would upstream.
 */

import { ROUTES, type Route } from "@vrcz/api";
import type { Scope } from "@vrcz/shared";

/** A route plus the path parameters the match pulled out of the request. */
export interface RouteMatch {
  readonly route: Route;
  readonly params: Readonly<Record<string, string>>;
}

interface CompiledSegment {
  /** Present for a segment that is one literal string. */
  readonly literal?: string;
  /** Present otherwise: anchored, with one capture group per parameter, in order. */
  readonly pattern?: RegExp;
  readonly names?: readonly string[];
}

interface CompiledRoute {
  readonly route: Route;
  readonly segments: readonly CompiledSegment[];
  /** How many segments are literal. Higher wins, so `/worlds/active` beats `/worlds/{worldId}`. */
  readonly literals: number;
}

const BY_METHOD = new Map<string, CompiledRoute[]>();

for (const route of ROUTES) {
  const segments = splitPath(route.pathTemplate).map(compileSegment);
  const compiled: CompiledRoute = {
    route,
    segments,
    literals: segments.filter((segment) => segment.literal !== undefined).length,
  };
  const method = route.method.toUpperCase();
  const existing = BY_METHOD.get(method);
  if (existing === undefined) BY_METHOD.set(method, [compiled]);
  else existing.push(compiled);
}

// Sorted once, at module load: the specific-beats-generic rule is a property of the table, not
// something to re-derive per request on the proxy's hot path.
for (const routes of BY_METHOD.values()) {
  routes.sort((a, b) => b.literals - a.literals);
}

/**
 * Compiles one path segment.
 *
 * **A segment is not always either a literal or a single parameter.** The spec has
 * `/instances/{worldId}:{instanceId}` — two parameters and a separator inside one segment — which
 * is exactly the shape a "starts with `{`, ends with `}`" test gets wrong: it reads the whole thing
 * as one parameter named `worldId}:{instanceId`. Compiling a regex per segment handles both cases
 * with one rule rather than a special case that has to be remembered.
 */
function compileSegment(segment: string): CompiledSegment {
  if (!segment.includes("{")) return { literal: segment };

  const names: string[] = [];
  let pattern = "";
  let index = 0;
  while (index < segment.length) {
    const open = segment.indexOf("{", index);
    if (open < 0) {
      pattern += escapeRegex(segment.slice(index));
      break;
    }
    const close = segment.indexOf("}", open);
    if (close < 0) {
      // An unbalanced brace is not a parameter; treat the rest as literal text.
      pattern += escapeRegex(segment.slice(index));
      break;
    }
    pattern += escapeRegex(segment.slice(index, open));
    names.push(segment.slice(open + 1, close));
    // Non-greedy, and never matching the separator that follows it: `{worldId}:{instanceId}` has to
    // split `wrld_x:12345` at the *last* colon-delimited boundary the template describes, and a
    // greedy first group would swallow the separator and leave the second empty.
    pattern += "(.+?)";
    index = close + 1;
  }

  return { pattern: new RegExp(`^${pattern}$`), names };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The operation a request maps to, or null.
 *
 * `path` is the path **as VRChat sees it** — `/users/usr_x`, with the `/api/1` prefix already
 * removed. Trailing slashes and an empty path are normalised the way a router does.
 */
export function matchRoute(method: string, path: string): RouteMatch | null {
  const candidates = BY_METHOD.get(method.toUpperCase());
  if (candidates === undefined) return null;

  const parts = splitPath(path);
  for (const candidate of candidates) {
    if (candidate.segments.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < parts.length; i += 1) {
      const template = candidate.segments[i];
      const actual = parts[i] ?? "";
      if (template === undefined) {
        matched = false;
        break;
      }

      if (template.literal !== undefined) {
        if (template.literal !== actual) {
          matched = false;
          break;
        }
        continue;
      }

      // An empty segment is not a value. `/users//friends` must not match `/users/{userId}/…` with
      // an empty id and then be forwarded upstream as a malformed path.
      const found = actual === "" ? null : (template.pattern?.exec(actual) ?? null);
      if (found === null) {
        matched = false;
        break;
      }
      for (let n = 0; n < (template.names?.length ?? 0); n += 1) {
        const name = template.names?.[n];
        const value = found[n + 1];
        if (name !== undefined && value !== undefined) params[name] = decodeSegment(value);
      }
    }
    if (matched) return { route: candidate.route, params };
  }
  return null;
}

/** The scope a request needs, or null if it maps to no operation. */
export function scopeFor(method: string, path: string): Scope | null {
  return matchRoute(method, path)?.route.scope ?? null;
}

/**
 * Operations denied on every port regardless of granted scopes.
 *
 * `PUT /users/{userId}/delete` and `DELETE /auth/twofactorauth` are the two PLAN.md §Enforcement
 * names by hand: account deletion and disabling 2FA are not things a third-party app should be able
 * to do through a convenience proxy, at any scope, with any consent. The flag rides on the route
 * table so the list is data rather than a condition someone has to remember to write.
 */
export function isHardDenied(method: string, path: string): boolean {
  return matchRoute(method, path)?.route.hardDenied ?? false;
}

function splitPath(path: string): string[] {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? [] : trimmed.split("/");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape is not ours to repair; the raw segment is what upstream would receive.
    return segment;
  }
}
