import { BASE_URL } from "@vrcz/api";
import type { CookieJar } from "../accounts/cookie-jar.ts";
import { parseRetryAfter, type RateClass, type RateLimiter } from "./rate-limiter.ts";
import type { RequestMeter } from "./request-meter.ts";
import { USER_AGENT_HEADER } from "./user-agent.ts";

/**
 * The one path to VRChat. See PLAN.md §1.4.
 *
 * **Nothing in the daemon calls `fetch` against VRChat directly.** Every request goes through here,
 * which is what makes "nothing reaches VRChat without passing the rate limiter" a structural
 * property rather than a convention people have to remember.
 */

export interface RequestContext {
  readonly accountId: string;
  readonly jar: CookieJar;
  readonly userAgent: string;
  readonly limiter: RateLimiter;
  /** Overridden in tests to point at the recorded-fixture server. */
  readonly baseUrl?: string;
  /**
   * Called on a 401. Returns true if the caller re-authenticated and the request is worth retrying.
   *
   * The **per-account re-auth mutex lives in the implementation of this hook**, not here, so that
   * ten concurrent 401s queue behind one login instead of racing into ten. See PLAN.md §1.3.
   */
  readonly onUnauthorized?: () => Promise<boolean>;
  /**
   * Injected for tests and for the recorded-fixture server. Narrower than `typeof fetch` on
   * purpose: we only ever call it with a string URL, and the global's extra `preconnect` property
   * would otherwise force every test double to fake something it never uses.
   */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * Counts what actually goes out. Optional so a test needs no meter, and absent means unmetered
   * rather than unsent — nothing here fails because nobody is watching.
   */
  readonly meter?: RequestMeter | undefined;
  /**
   * The grant this request is being made for, when a third-party app asked for it.
   *
   * Set by the pass-through and nowhere else. It is what makes "which app is eating the budget" a
   * question with an answer, which PLAN.md §Phase 3 names as the sharpest edge in the system: the
   * user gets rate-limited for an app's behaviour and blames vrc.zip.
   */
  readonly grantId?: string | undefined;
}

export interface RequestOptions extends Omit<RequestInit, "headers"> {
  readonly headers?: Record<string, string>;
  /**
   * Basic-auth login only. Sent *instead of* the cookie jar, because the login flow must not
   * present stale cookies alongside a fresh credential.
   */
  readonly basicAuth?: { readonly username: string; readonly password: string };
  /**
   * Which VRChat rate ceiling this call is charged against. Defaults to `"api"`.
   *
   * `"file"` is for the image/file tier, which has its own far larger per-IP allowance. Getting
   * this wrong is not a small inefficiency: a screen full of avatars charged to the API bucket
   * queues presence and friend polling behind pictures.
   */
  readonly rateClass?: RateClass;
}

/** How many times a single call may be re-sent after a 429. */
const MAX_429_RETRIES = 5;

export class VrcHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? `VRChat API returned ${status}`, options);
    this.name = "VrcHttpError";
  }
}

/**
 * VRChat's Basic auth is `base64(urlencode(username):urlencode(password))`.
 *
 * The percent-encoding is not optional and not cosmetic: a password containing `:` would otherwise
 * split the credential in the wrong place, and one containing non-ASCII would encode
 * inconsistently. `encodeURIComponent` leaves `!'()*` alone, which is fine — VRChat accepts them.
 */
export function basicAuthHeader(username: string, password: string): string {
  const encoded = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `Basic ${Buffer.from(encoded, "utf8").toString("base64")}`;
}

/**
 * Performs one request with rate limiting, 429 backoff, cookie handling, and a single 401 re-auth.
 *
 * Returns the `Response` as-is — status and headers untouched — because the proxy in Phase 2 must
 * forward it byte-for-byte. Callers that want a parsed body ask for one explicitly.
 */
export async function vrcFetch(
  ctx: RequestContext,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const doFetch = ctx.fetch ?? fetch;
  const base = ctx.baseUrl ?? BASE_URL;
  const url = path.startsWith("http") ? path : `${base}${path}`;

  let retriedAuth = false;

  for (let attempt = 0; ; attempt++) {
    await ctx.limiter.acquire(ctx.accountId, options.rateClass ?? "api");

    // After the limiter, before the send: this counts requests that are actually going out, which is
    // what a "requests per second" reading has to mean. Counting before `acquire` would report the
    // rate the daemon *wanted*, and the gap between the two is exactly what the limiter is for. A
    // 429 retry passes here again, and should — it is another request that really left.
    ctx.meter?.record({
      accountId: ctx.accountId,
      ...(ctx.grantId === undefined ? {} : { grantId: ctx.grantId }),
    });

    const headers = new Headers(options.headers);

    // The User-Agent is ours, always. A caller cannot override it — on the proxy path a downstream
    // app's UA is used for identity only and must never reach VRChat, so traffic is attributed to
    // the thing actually making it. See PLAN.md §Phase 2 Enforcement.
    headers.set(USER_AGENT_HEADER, ctx.userAgent);
    headers.set("Accept", headers.get("Accept") ?? "application/json");

    if (options.basicAuth) {
      // Deliberately no cookies: a login must not present a stale session alongside a fresh
      // credential, or VRChat may answer for the session instead of the credential.
      headers.set(
        "Authorization",
        basicAuthHeader(options.basicAuth.username, options.basicAuth.password),
      );
    } else {
      const cookie = ctx.jar.header();
      if (cookie !== undefined) headers.set("Cookie", cookie);
    }

    const response = await doFetch(url, { ...options, headers });

    // Absorb cookies before any branching — a 401 response can still carry a rotated cookie.
    ctx.jar.applyResponse(response.headers);

    if (response.status === 429) {
      ctx.limiter.record429(parseRetryAfter(response.headers.get("Retry-After")));
      if (attempt < MAX_429_RETRIES) {
        // The body must be consumed or the connection leaks.
        await response.arrayBuffer().catch(() => undefined);
        continue;
      }
      return response;
    }

    if (response.status === 401 && !retriedAuth && ctx.onUnauthorized) {
      retriedAuth = true;
      await response.arrayBuffer().catch(() => undefined);
      if (await ctx.onUnauthorized()) continue;
      // Re-auth declined or failed. Fall through with the original 401 rather than looping.
      return response;
    }

    ctx.limiter.recordSuccess();
    return response;
  }
}

/** `vrcFetch` plus JSON parsing, for the daemon's own calls. Throws on a non-2xx. */
export async function vrcFetchJson<T>(
  ctx: RequestContext,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await vrcFetch(ctx, path, options);
  const text = await response.text();

  if (!response.ok) {
    throw new VrcHttpError(response.status, text);
  }

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new VrcHttpError(response.status, text, "VRChat returned a non-JSON body", { cause });
  }
}
