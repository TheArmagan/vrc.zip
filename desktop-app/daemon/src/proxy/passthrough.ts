import type { Route } from "@vrcz/api";
import type { Scope } from "@vrcz/shared";
import { type RequestContext, vrcFetch } from "../net/request.ts";
import { hashProxyToken } from "../security/proxy-tokens.ts";
import type { GrantRow } from "../store/types.ts";
import { invalidCredentials, missingCredentials, vrczipError } from "./vrchat-shapes.ts";

/**
 * The mirror's pass-through path. PLAN.md §Phase 2, §2.7.
 *
 * Everything downstream of the login handshake ends up here: an operation the route table knows,
 * a grant that says the app may call it, and then the account's own request pipeline. The upstream
 * `Response` is returned **as-is** — status, headers, and body untouched — because "byte-identical
 * to VRChat" is the mirror's entire contract, and `c.json()` would re-encode the body and lose it.
 *
 * Four rules, in the order they are applied, and each of them is a `PLAN.md` invariant:
 *
 *  1. **A hard denial is a hard denial**, scopes notwithstanding. `PUT /users/{id}/delete` and
 *     `DELETE /auth/twofactorauth` are never reachable through the mirror by any grant.
 *  2. **An operation the spec marks unauthenticated needs no grant.** `GET /config` is the one that
 *     matters in practice: a VRChat client fetches it *before* it logs in, so requiring a grant here
 *     would deadlock every real client against the handshake it has not run yet.
 *  3. **Otherwise a grant is required, and it must carry the operation's scope.** A missing scope is
 *     a 403 naming it, in vrc.zip's own error shape rather than an invented VRChat one.
 *  4. **The request is re-originated, never relayed.** The app's cookies, `User-Agent`, `Origin` and
 *     everything else it sent are discarded; the daemon substitutes the bound account's real jar and
 *     vrc.zip's own honest UA. What VRChat sees is a vrc.zip request, because that is what it is.
 */

/** The slice of the store the pass-through touches. */
export interface PassthroughGrantStore {
  grantByTokenHash(hash: string): GrantRow | null;
  touchGrant(id: string, at: number): void;
}

export interface PassthroughDeps {
  readonly grants: PassthroughGrantStore;
  /**
   * The bound account's request context, or null when that account is not currently signed in.
   *
   * A context rather than a fetch function because it is what carries the rate limiter, the cookie
   * jar, and the 401 re-auth hook — the three things that make "nothing reaches VRChat except
   * through an Account" true rather than aspirational.
   */
  readonly context: (accountId: string) => RequestContext | null;
  /**
   * A context bound to no account, for the operations the spec marks unauthenticated.
   *
   * Its own empty cookie jar, deliberately: sending a signed-in account's session to an endpoint
   * that does not need one would tie a public call to a real user for no reason. Null before
   * first-run setup, when there is no honest User-Agent to send and so nothing may go out at all.
   */
  readonly anonymousContext: () => RequestContext | null;
  readonly now?: (() => number) | undefined;
}

/**
 * Request headers forwarded upstream. Everything absent from this list is dropped.
 *
 * An allowlist rather than a blocklist, because the failure directions are not symmetric: a header
 * we forget to forward is a feature that does not work, and a header we forget to *strip* can be a
 * credential or a fingerprint reaching VRChat on the user's behalf. `Cookie`, `Authorization`,
 * `User-Agent` and `Origin` are conspicuously absent and must stay that way — the first three are
 * substituted by the request pipeline and the last describes an app's page, not this request.
 */
const FORWARDED_HEADERS = [
  "content-type",
  "accept",
  "accept-language",
  "if-none-match",
  "if-modified-since",
  "range",
] as const;

/** Methods that may not carry a request body, per `fetch`. */
const BODILESS = new Set(["GET", "HEAD"]);

/**
 * Methods the no-grant path is allowed to cover.
 *
 * **The spec's `security` list is not a safety judgement and must not be treated as one.** In
 * v1.20.8 both `POST /auth/register` and `POST /worlds` carry `security: []`, so reading that field
 * alone would let an app *create a world* through the mirror with no grant, no consent sheet, and no
 * scope. VRChat would reject the sessionless request, which makes it a hole in intent rather than in
 * effect — and a hole in intent is the kind that stops being harmless the moment the spec is
 * regenerated. Requiring a grant for anything that is not a read closes it once for every operation,
 * including ones added later.
 */
const UNAUTHENTICATED_METHODS = new Set(["GET", "HEAD"]);

export interface PassthroughRequest {
  readonly method: string;
  /** VRChat-relative, query included: `/users/usr_x?n=10`. */
  readonly path: string;
  readonly headers: Headers;
  /** The body, already read. Null for `GET`/`HEAD`. */
  readonly body: ArrayBuffer | null;
}

export async function passthrough(
  route: Route,
  request: PassthroughRequest,
  deps: PassthroughDeps,
): Promise<Response> {
  const now = deps.now ?? Date.now;

  if (route.hardDenied) {
    return vrczipError(
      403,
      "hard_denied",
      `${route.operationId} is never available through the vrc.zip mirror, with any scope.`,
      { operationId: route.operationId },
    );
  }

  const authorized = authorize(route, request, deps);
  if (authorized instanceof Response) return authorized;

  const context =
    authorized.grant === null ? deps.anonymousContext() : deps.context(authorized.grant.account_id);

  if (context === null) {
    return vrczipError(
      503,
      "account_offline",
      authorized.grant === null
        ? "vrc.zip has not finished first-run setup, so it cannot talk to VRChat yet."
        : "The account this app is bound to is not signed in to vrc.zip right now.",
    );
  }

  if (authorized.grant !== null) deps.grants.touchGrant(authorized.grant.id, now());

  const upstream = await vrcFetch(context, request.path, {
    method: request.method,
    headers: forwardedHeaders(request.headers),
    // Files have their own far larger per-IP ceiling. Charging an avatar to the API bucket queues
    // presence and friend polling behind pictures; see PLAN.md §1.4.
    rateClass: route.tag === "files" ? "file" : "api",
    ...(BODILESS.has(request.method.toUpperCase()) || request.body === null
      ? {}
      : { body: request.body }),
  });

  return withDecodedBodyHeaders(upstream);
}

/**
 * Drops `Content-Encoding` and `Content-Length` when the body underneath them has already been
 * decoded, which on this path it always has been.
 *
 * **`fetch` decompresses transparently and then keeps the headers describing the compressed form.**
 * VRChat gzips nearly everything, so a passed-through response arrives at the app announcing
 * `Content-Encoding: gzip` over plain JSON, with a `Content-Length` counting the *compressed* bytes.
 * A client that believes either one is broken twice over: its decompressor fails on data that was
 * never compressed, and its reader truncates the body at the shorter length. This is what VRCX
 * reports as an unsupported compression method.
 *
 * Stripping is the right repair rather than re-compressing, and asking VRChat for `identity` would
 * be worse than both: the egress filter has to *scan* every response body for a leaked credential,
 * and it cannot see inside a gzip stream. Decoded bodies are what make that check meaningful, so the
 * decode is a feature and only the headers were ever wrong.
 *
 * Untouched when there is no `Content-Encoding`, so an uncompressed response really is passed
 * through as the same object.
 */
function withDecodedBodyHeaders(response: Response): Response {
  if (!response.headers.has("content-encoding")) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  // Now wrong by the same act, and the server recomputes it from the body it actually sends.
  headers.delete("content-length");
  // `response.body` by reference: the bytes are handed on, never re-encoded.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The grant this request may act under, `null` for an unauthenticated operation, or a refusal. */
function authorize(
  route: Route,
  request: PassthroughRequest,
  deps: PassthroughDeps,
): { grant: GrantRow | null } | Response {
  // `security: []` in the spec means VRChat itself serves this without a session — but only a read
  // gets the benefit of that. See `UNAUTHENTICATED_METHODS`.
  if (route.security.length === 0 && UNAUTHENTICATED_METHODS.has(route.method.toUpperCase())) {
    // **Never refused, only downgraded.** A public read is upgraded to the bound account when the
    // caller presents a grant that carries the route's scope, and falls back to anonymous otherwise.
    //
    // Both directions matter, and images are where both show up at once. VRCX renders avatars from
    // `<img>` tags whose cookie jar never saw the login, so demanding a grant made every picture a
    // 401 — that is the downgrade. But an image the account can see and the public cannot needs the
    // session, so a caller that *does* present one should get it — that is the upgrade. Refusing
    // would break the first case; using the account unconditionally would let an app without
    // `files:read` see private content through a route that skips the scope check.
    return { grant: optionalGrant(route, request, deps) };
  }

  const token = authCookie(request.headers.get("cookie"));
  if (token === null) return missingCredentials();

  const grant = deps.grants.grantByTokenHash(hashProxyToken(token));
  // Revocation is enforced in SQL, so a revoked grant simply does not come back — see §2.1. An
  // unknown token and a revoked one are the same answer on purpose: distinguishing them tells an
  // app whether a token it holds was *ever* valid.
  if (grant === null) return invalidCredentials();

  const granted = parseScopes(grant.scopes);
  if (!granted.includes(route.scope)) {
    // vrc.zip's own shape, not a VRChat error. VRChat has no scope concept, so inventing an error
    // it would never send is a worse lie than admitting the proxy is the one talking.
    return vrczipError(
      403,
      "missing_scope",
      `This app's grant does not include the "${route.scope}" scope, which ${route.operationId} requires. Log in again requesting it.`,
      { operationId: route.operationId, requiredScope: route.scope, grantedScopes: granted },
    );
  }

  return { grant };
}

/** A grant good enough to act under on a public read, or null to go anonymous. */
function optionalGrant(
  route: Route,
  request: PassthroughRequest,
  deps: PassthroughDeps,
): GrantRow | null {
  const token = authCookie(request.headers.get("cookie"));
  if (token === null) return null;

  const grant = deps.grants.grantByTokenHash(hashProxyToken(token));
  if (grant === null) return null;

  // The scope is still checked, because the account's session is what makes private content
  // visible. An app without it is not refused — it simply sees what anyone would.
  return parseScopes(grant.scopes).includes(route.scope) ? grant : null;
}

/** The `auth` cookie's value out of a `Cookie` header, or null. */
export function authCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "auth") {
      const value = part.slice(eq + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

function parseScopes(raw: string): Scope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter((s) => typeof s === "string") as Scope[]) : [];
  } catch {
    // A grant row we cannot read is a grant that authorises nothing, which fails closed.
    return [];
  }
}

function forwardedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}
