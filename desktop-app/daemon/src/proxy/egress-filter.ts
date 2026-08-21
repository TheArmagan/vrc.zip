/**
 * The egress filter. PLAN.md §Phase 2 "Hard invariant — the real VRChat credentials never leave
 * the daemon."
 *
 * This exists because **byte-faithful passthrough leaks credentials by default.** Copying upstream
 * status and headers is the correct behaviour for every header except the ones carrying a session,
 * and the places it goes wrong are not obvious: an upstream `Set-Cookie`, the `token` field in
 * `GET /auth`'s body, VRChat's own `{"err":…,"authToken":"…"}` pipeline error frame, and error
 * bodies that echo request context.
 *
 * So the rule is not "remember to strip it at each call site". It runs on **every** response from
 * the port, including responses from code written later by someone who has not read any of this,
 * and it **fails closed**: a hit is a 500 with an empty body and a loud error log. A credential
 * leak must never be the quiet outcome.
 *
 * **It wraps the fetch handler rather than being Hono middleware, and that is not a style choice.**
 * Assigning `c.res` inside a middleware makes Hono copy the *previous* response's headers onto the
 * new one — `Set-Cookie` explicitly and by name — so a middleware that strips a cookie hands back a
 * response with the cookie still on it. Wrapping the handler puts the filter outside the framework,
 * where nothing can merge anything back, and it also covers Hono's own 404 and error responses,
 * which never reach a route's middleware chain at all.
 *
 * Two things it deliberately does *not* do:
 *
 *  - It does not consult the live cookie jars. A filter that only catches credentials it already
 *    knows about passes the token of an account added a second ago. Detection is by *shape* —
 *    `authcookie_…` without our `_vrczip` suffix — so an unknown real session is caught too.
 *  - It does not rewrite. Redacting in place would turn a leak into a subtly wrong response that
 *    looks fine, and the failure this guards against is exactly the one nobody notices.
 */

import { AUTHCOOKIE_PATTERN, looksLikeRealAuthCookie } from "../security/proxy-tokens.ts";

/** Where a credential was found. Reported to the log, never to the client. */
export interface EgressViolation {
  readonly where: "header" | "body";
  /** The offending header's name, or `"body"`. Never the value — see `onViolation`. */
  readonly detail: string;
}

/** The request a violation happened on, for the log line. */
export interface EgressRequestContext {
  readonly method: string;
  readonly path: string;
}

export interface EgressFilterOptions {
  /**
   * Called on a hit, before the 500 goes out. This is the loud part; the client learns nothing.
   *
   * Receives no credential material. A logger that printed the token would recreate the leak in the
   * log file, which is the one place PLAN.md's leak table says tokens are redacted at the logger
   * rather than at the call site.
   */
  readonly onViolation?: (violation: EgressViolation, request: EgressRequestContext) => void;
  /**
   * Bodies at or below this many bytes are buffered and scanned whole. Larger ones stream through
   * a chunked scanner instead — see `scanStream`.
   */
  readonly maxBufferedBytes?: number;
}

/** Default buffering cap. Comfortably above every JSON response VRChat returns. */
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Headers dropped from every proxied response unconditionally.
 *
 * `Set-Cookie` is the important one and it is **stripped, never rewritten**: if a grant needs a
 * cookie set, the proxy emits its own afterwards. Passing one through — even after editing the
 * value — means the correctness of the whole invariant rests on the edit being right every time.
 * Stripping unconditionally also covers cookies that are not credentials today and become them in
 * some future VRChat release.
 *
 * The rest are hop-by-hop headers, which describe one connection and are wrong to copy onto
 * another regardless of what they carry.
 */
export const STRIPPED_RESPONSE_HEADERS = [
  "set-cookie",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

/** Removes the headers no proxied response may carry. Mutates and returns `headers`. */
export function stripResponseHeaders(headers: Headers): Headers {
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  return headers;
}

/** True if `text` contains anything shaped like a real VRChat session cookie. */
export function containsRealCredential(text: string): boolean {
  // `matchAll` rather than `test`: the pattern is global, and a global regex used with `test`
  // carries `lastIndex` between calls — the classic way a scanner starts skipping every other hit.
  for (const match of text.matchAll(AUTHCOOKIE_PATTERN)) {
    if (looksLikeRealAuthCookie(match[0])) return true;
  }
  return false;
}

/** The first offending header's name, or null. Header names are safe to report; values never are. */
export function scanHeaders(headers: Headers): string | null {
  for (const [name, value] of headers) {
    if (containsRealCredential(value)) return name;
  }
  return null;
}

/**
 * Applies the filter to one response. Exported for tests and for the pipeline mirror, which needs
 * the same scan over frames rather than over an HTTP response.
 *
 * The body is reconstructed from the exact bytes read — never re-encoded through `c.json()` — so
 * byte fidelity survives the scan.
 */
export async function filterResponse(
  response: Response,
  context: EgressRequestContext,
  options: EgressFilterOptions = {},
): Promise<Response> {
  const limit = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const headers = stripResponseHeaders(new Headers(response.headers));

  const offendingHeader = scanHeaders(headers);
  if (offendingHeader !== null) {
    options.onViolation?.({ where: "header", detail: offendingHeader }, context);
    return failClosed();
  }

  // 204/304 and friends carry no body, and constructing one for them throws.
  if (response.body === null) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const declared = Number.parseInt(headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > limit) {
    const scanned = scanStream(response.body, () => {
      options.onViolation?.({ where: "body", detail: "body" }, context);
    });
    return new Response(scanned, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const bytes = await response.arrayBuffer();
  if (containsRealCredential(decode(bytes))) {
    options.onViolation?.({ where: "body", detail: "body" }, context);
    return failClosed();
  }

  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** A fetch handler, as `Bun.serve` and `Hono#fetch` both shape one. */
export type FetchHandler = (request: Request, ...rest: never[]) => Response | Promise<Response>;

/**
 * Wraps a fetch handler so every response it produces passes the filter. This is how the proxy and
 * control ports mount it — see the module comment for why it is not middleware.
 */
export function guardEgress(
  handler: FetchHandler,
  options: EgressFilterOptions = {},
): FetchHandler {
  return async function egressGuarded(request: Request): Promise<Response> {
    const response = await handler(request);
    let path = request.url;
    try {
      path = new URL(request.url).pathname;
    } catch {
      // A request line we cannot parse is still a request that produced a response worth scanning.
    }
    return filterResponse(response, { method: request.method, path }, options);
  };
}

/** 500, empty body, nothing that hints at what was caught. */
function failClosed(): Response {
  return new Response(null, { status: 500 });
}

/**
 * Bytes as text for scanning.
 *
 * latin1 rather than utf8: every byte maps to exactly one character, so a token split across a
 * multi-byte sequence cannot be mangled into something the pattern misses, and a body that is not
 * valid UTF-8 does not turn into replacement characters mid-scan. The token alphabet is ASCII, so
 * nothing is lost.
 */
function decode(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes as ArrayBuffer).toString("latin1");
}

/**
 * Scans a body too large to buffer, chunk by chunk, and destroys the stream on a hit.
 *
 * A response this big has already had its status and headers sent, so the 500 is not available any
 * more — aborting mid-body is what failing closed looks like from here. The client sees a destroyed
 * transfer, which is the correct outcome and is unmistakably an error rather than a short read.
 *
 * `carry` keeps the tail of each chunk so a token straddling a chunk boundary is still found.
 */
function scanStream(
  body: ReadableStream<Uint8Array>,
  onHit: () => void,
): ReadableStream<Uint8Array> {
  /** Longer than `authcookie_` + a uuid + `_vrczip`, so no match can span three chunks. */
  const OVERLAP = 128;
  let carry = "";

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = carry + decode(chunk);
        if (containsRealCredential(text)) {
          onHit();
          controller.error(new Error("egress filter: real credential in a streamed response body"));
          return;
        }
        carry = text.slice(-OVERLAP);
        controller.enqueue(chunk);
      },
    }),
  );
}
