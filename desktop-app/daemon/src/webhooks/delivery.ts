/**
 * One attempt at one delivery, and the schedule that decides when the next one happens.
 *
 * This is the only place in the daemon that makes an outbound HTTP request to a host the *user*
 * named, so it is written defensively in four specific ways, each of which is a real failure mode
 * rather than a precaution:
 *
 * 1. **Redirects are not followed — a 3xx is a failure.** Following one would re-open every check
 *    `url.ts` performed at registration: a public endpoint that 302s to `http://192.168.1.1/` is an
 *    SSRF with extra steps, and `fetch` will happily walk it. `redirect: "manual"` makes the 3xx an
 *    ordinary response, which is then treated as a failed attempt. The user's fix is to register the
 *    address the redirect points at, which is a fix that goes through validation.
 * 2. **Every attempt has a hard timeout.** A receiver that accepts the connection and never answers
 *    would otherwise hold a delivery — and, because deliveries for one webhook are serialised, that
 *    webhook's entire queue — open forever.
 * 3. **The response body is read to a cap and then discarded.** Nothing here needs it except the
 *    first line of an error message, and an endpoint that answers a webhook with a gigabyte is a
 *    trivially available way to make the daemon eat memory.
 * 4. **Nothing about the response is trusted.** The status decides the outcome; the body only ever
 *    becomes a truncated `last_error` string.
 */

import { jitter } from "../net/jitter.ts";
import { signWebhookBody, WEBHOOK_HEADERS } from "./signature.ts";

/** The injectable fetch seam. Narrower than `typeof fetch` so a test double is a two-line function. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AttemptOptions {
  readonly url: string;
  /** `webhooks.secret_hash` — the HMAC key. See `signature.ts`. */
  readonly keyHash: string;
  /** The exact stored bytes. Never re-rendered on a retry. */
  readonly body: string;
  readonly deliveryId: string;
  readonly eventId: string;
  readonly eventKind: string;
  /** Unix ms, and covered by the signature. */
  readonly timestamp: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly userAgent: string;
  readonly fetch: FetchLike;
}

/**
 * The outcome of one attempt.
 *
 * `permanent` is the third state that keeps the queue honest: most failures are worth retrying, but
 * some are the endpoint telling us to stop, and burning eight attempts over ten minutes on a `410
 * Gone` is work nobody wanted done.
 */
export interface AttemptResult {
  readonly ok: boolean;
  /** Null when the attempt never got a response at all — a timeout, a refused connection, DNS. */
  readonly status: number | null;
  readonly error: string | null;
  /** True when retrying could not possibly help. Dead-letters the row immediately. */
  readonly permanent: boolean;
}

/** How much of a failing response's body is kept as an error message. Enough to see a stack trace's
 * first line, not enough to be a place to store data. */
const ERROR_EXCERPT_LENGTH = 200;

/**
 * Statuses that mean "never send here again".
 *
 * `410 Gone` is the one HTTP actually defines that way, and `404` is not on the list on purpose —
 * a receiver that deployed a broken route and fixed it five minutes later is a far more common story
 * than one that meant `404` as "unsubscribe me".
 */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([410]);

export async function attemptDelivery(options: AttemptOptions): Promise<AttemptResult> {
  const signature = signWebhookBody(options.keyHash, options.timestamp, options.body);

  // Our own controller rather than `AbortSignal.timeout`, so the timer is one we clear — an
  // un-cleared timeout per delivery is a handle that keeps the process alive at shutdown.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await options.fetch(options.url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": options.userAgent,
        [WEBHOOK_HEADERS.delivery]: options.deliveryId,
        [WEBHOOK_HEADERS.event]: options.eventId,
        [WEBHOOK_HEADERS.eventKind]: options.eventKind,
        [WEBHOOK_HEADERS.timestamp]: String(options.timestamp),
        [WEBHOOK_HEADERS.signature]: signature,
      },
      body: options.body,
    });

    const status = response.status;

    if (status >= 200 && status < 300) {
      await drain(response, options.maxResponseBytes);
      return { ok: true, status, error: null, permanent: false };
    }

    // A 3xx reaches here only because `redirect: "manual"` made it an ordinary response. See (1).
    if (status >= 300 && status < 400) {
      await drain(response, options.maxResponseBytes);
      const target = response.headers.get("location") ?? "(no location)";
      return {
        ok: false,
        status,
        error: `redirect refused: ${status} to ${target.slice(0, ERROR_EXCERPT_LENGTH)}`,
        permanent: true,
      };
    }

    const excerpt = await drain(response, options.maxResponseBytes);
    return {
      ok: false,
      status,
      error: `HTTP ${status}${excerpt === "" ? "" : `: ${excerpt}`}`,
      permanent: PERMANENT_STATUSES.has(status),
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      status: null,
      error: aborted ? `timed out after ${options.timeoutMs}ms` : describe(error),
      permanent: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads at most `limit` bytes and cancels the rest, returning a short text excerpt.
 *
 * Cancelling rather than letting the body finish is the part that matters: an un-consumed,
 * un-cancelled body holds the connection open, and a *consumed* one on a hostile endpoint is
 * unbounded.
 */
async function drain(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (body === null) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= limit) break;
    }
  } catch {
    // A body that fails mid-read tells us nothing we act on; the status already decided the outcome.
  } finally {
    await reader.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset);
    offset += chunk.byteLength;
    if (offset >= total) break;
  }

  return new TextDecoder().decode(joined.subarray(0, limit)).slice(0, ERROR_EXCERPT_LENGTH).trim();
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, ERROR_EXCERPT_LENGTH);
  return String(error).slice(0, ERROR_EXCERPT_LENGTH);
}

export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly random?: () => number;
}

/**
 * How long to wait after `attempts` failed attempts.
 *
 * Exponential from the base, capped, and **jittered** — the cap and the jitter are both load-bearing
 * for the same reason they are in `RateLimiter`: a receiver that just came back up should not be met
 * by every queued delivery from every webhook at the same instant, and an uncapped doubling parks a
 * delivery for hours over a blip.
 *
 * The jitter is added on top rather than spread around the base (`base + random*base*0.25`), so a
 * retry is never *earlier* than the schedule says. Backing off less than intended is the one
 * direction that turns a struggling endpoint into a hammered one.
 */
export function backoffDelay(attempts: number, options: BackoffOptions): number {
  const exponential = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempts - 1));
  const spread =
    options.random === undefined ? { spread: 0.25 } : { spread: 0.25, random: options.random };
  return Math.min(Math.round(options.maxMs * 1.25), jitter(exponential, spread));
}
