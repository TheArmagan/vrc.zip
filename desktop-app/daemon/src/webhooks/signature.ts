/**
 * Webhook secrets and the signature that proves a delivery came from this daemon.
 *
 * The scheme is the boring one on purpose — `HMAC-SHA256` over `${timestamp}.${body}`, hex, in a
 * header, alongside the timestamp it was computed with. Boring because a receiver has to implement
 * the other half of it, usually in whatever language their integration is already written in, and
 * every deviation from the shape they have seen before is a chance to get it wrong silently.
 *
 * **The timestamp is inside the signed string, not merely beside it.** Signing the body alone would
 * let anyone who once observed a delivery replay it forever; with the timestamp covered, a receiver
 * that rejects old timestamps gets replay protection for free, and cannot be talked out of it by an
 * attacker rewriting the header — that would invalidate the signature.
 *
 * ## What is stored, and the honest limit of it
 *
 * Registration mints `whsec_<32 hex>` and returns it **once**. What the row holds is `sha256` of it,
 * and that hash is the HMAC key: signing needs a key it can reproduce, so a one-way hash of the
 * secret is as far as this can go while still being able to sign at all. So be precise about what it
 * buys, because it is easy to over-claim:
 *
 *  - it does **not** stop someone who can read the database from forging signatures. Nothing can:
 *    whatever the daemon can sign with, a reader of its state can sign with too.
 *  - it does stop the stored value being the string the user pasted into their receiving service's
 *    config — which they may well have reused — and it stops the column being a credential that
 *    authenticates anything *to* vrc.zip.
 *
 * The consequence for interoperability is the part to remember: a receiver verifies with
 * `HMAC(sha256(secret), …)`, not `HMAC(secret, …)`. {@link verifyWebhookSignature} is that half,
 * exported so there is one implementation to point documentation at.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Marks the value as a vrc.zip webhook secret — greppable in a user's config, like our tokens. */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

/**
 * The headers a delivery carries. Declared here rather than at the fetch call so the signer, the
 * sender, and any future docs generator read the same names.
 */
export const WEBHOOK_HEADERS = {
  /** Unique per attempt-set: the `webhook_deliveries` row id. Receivers deduplicate on this. */
  delivery: "x-vrczip-delivery",
  /** Shared by every webhook that matched the same event. */
  event: "x-vrczip-event",
  eventKind: "x-vrczip-event-kind",
  /** Unix ms, and covered by the signature. */
  timestamp: "x-vrczip-timestamp",
  /** `sha256=<hex>`. */
  signature: "x-vrczip-signature",
} as const;

/** A freshly minted secret: the plaintext to show once, and the key to store and sign with. */
export interface MintedWebhookSecret {
  /** Returned to the registrant exactly once. Never stored, never logged. */
  readonly secret: string;
  /** `sha256(secret)`. Goes in `webhooks.secret_hash` and is the HMAC key. */
  readonly keyHash: string;
}

export function mintWebhookSecret(): MintedWebhookSecret {
  const secret = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("hex")}`;
  return { secret, keyHash: webhookKeyHash(secret) };
}

/**
 * Derives the signing key from a secret.
 *
 * Plain SHA-256 rather than a password KDF, for the same reason `hashProxyToken` is: this is a
 * 256-bit random value, not a user-chosen one, so there is nothing for a slow hash to defend and it
 * would put a deliberate delay on a path that runs once per delivery attempt.
 */
export function webhookKeyHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** The exact string the HMAC covers. One function so the signer and the verifier cannot drift. */
export function signingPayload(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

/** `sha256=<hex>` over `${timestamp}.${body}`, keyed by `keyHash`. */
export function signWebhookBody(keyHash: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", keyHash).update(signingPayload(timestamp, body), "utf8");
  return `sha256=${mac.digest("hex")}`;
}

/**
 * The receiver's half, from the **plaintext** secret. Constant-time.
 *
 * Length is compared first because `timingSafeEqual` throws on a length mismatch rather than
 * returning false — which would turn a malformed header into a 500 instead of a rejection.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: number,
  body: string,
  presented: string,
): boolean {
  const expected = signWebhookBody(webhookKeyHash(secret), timestamp, body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
