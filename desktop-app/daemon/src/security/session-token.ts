import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The UI session token. See PLAN.md §1.8.
 *
 * 32 random bytes, hex-encoded. It is written into `state.json` (mode 0600) and handed to the
 * browser through the launch URL's `?token=` parameter, so it has to survive a round trip through
 * a URL and a shell — hex, not base64, avoids every escaping question at the cost of 32 characters
 * nobody reads.
 *
 * There is no expiry and no rotation within a run: the token's lifetime is the daemon's, and a
 * restart mints a new one. Anything longer-lived belongs in the grant token store (Phase 2), not
 * here.
 */

export const SESSION_TOKEN_BYTES = 32;

/** Hex length of a well-formed token. Two characters per byte. */
export const SESSION_TOKEN_LENGTH = SESSION_TOKEN_BYTES * 2;

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("hex");
}

export function isWellFormedSessionToken(value: string): boolean {
  return value.length === SESSION_TOKEN_LENGTH && /^[0-9a-f]+$/.test(value);
}

/**
 * Constant-time comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the length, so both sides
 * are hashed to a fixed width first. Comparing digests rather than the raw strings also means a
 * caller-supplied value of any shape — empty, enormous, non-hex — takes the same path.
 */
export function sessionTokensMatch(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
