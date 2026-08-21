/**
 * The proxy's own credentials, and the shape rules that let a leak be detected mechanically.
 *
 * See PLAN.md §Phase 2 "Hard invariant". A real `auth` or `twoFactorAuth` cookie value must never
 * appear in any response on `:7774` or `:7775`, in any form. What the proxy hands a third-party app
 * is an **unrelated identifier** — not a wrapper around the real cookie, not an encrypted form of
 * it, nothing that could be turned back into a VRChat session by anyone who obtains it.
 *
 * VRChat issues `authcookie_<uuid>`; we issue `authcookie_<uuid>_vrczip`. The prefix keeps clients
 * that sanity-check it or parse the uuid working unchanged. The suffix is what earns its keep:
 *
 *  - the egress filter can tell ours from theirs **by shape alone**, with no table lookup on a path
 *    that runs on every response;
 *  - a vrc.zip token accidentally sent to `api.vrchat.cloud` is inert rather than a live session;
 *  - it is greppable in a user's logs when they are debugging.
 *
 * Only the **hash** is stored. The uuid *is* the secret, so a readable `grants` table would be a
 * table of live bearer credentials; `hashProxyToken` is the only thing the store ever sees.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

/** The suffix that marks a token as ours. */
export const VRCZIP_TOKEN_SUFFIX = "_vrczip";

/** What VRChat's own cookies — and therefore ours — start with. */
export const AUTHCOOKIE_PREFIX = "authcookie_";

/**
 * Any `authcookie_…` run, ours or VRChat's.
 *
 * Deliberately greedy over the character class that both shapes use, so a real token immediately
 * followed by our suffix cannot be split into a "ours-looking" prefix — the whole run is matched and
 * then classified. `authcookie_<uuid>` and `authcookie_<uuid>_vrczip` are both single matches.
 */
export const AUTHCOOKIE_PATTERN = /authcookie_[A-Za-z0-9_-]+/g;

/** A newly minted proxy credential: the plaintext to hand out, and the hash to store. */
export interface MintedToken {
  /** Given to the app exactly once. Never stored, never logged. */
  readonly token: string;
  readonly hash: string;
}

/** Mints `authcookie_<uuid>_vrczip` and its hash. */
export function mintProxyToken(): MintedToken {
  const token = `${AUTHCOOKIE_PREFIX}${randomUUID()}${VRCZIP_TOKEN_SUFFIX}`;
  return { token, hash: hashProxyToken(token) };
}

/**
 * The lookup key for a presented token.
 *
 * Plain SHA-256 rather than a password KDF on purpose: this is a 122-bit random value, not a
 * user-chosen secret, so there is nothing for a slow hash to defend against and it would put a
 * deliberate delay on the hot path of every proxied request.
 */
export function hashProxyToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** True for a value we minted. Shape only — says nothing about whether the grant is live. */
export function isProxyToken(value: string): boolean {
  return value.startsWith(AUTHCOOKIE_PREFIX) && value.endsWith(VRCZIP_TOKEN_SUFFIX);
}

/**
 * True for a value with VRChat's real cookie shape — an `authcookie_` run *without* our suffix.
 *
 * This is the predicate the egress filter is built on, and it is intentionally shape-based rather
 * than a lookup against the live cookie jars: a filter that only catches credentials it already
 * knows about would pass a token belonging to an account added a second ago, or one VRChat rotated
 * mid-request. Anything shaped like a real session is treated as one.
 */
export function looksLikeRealAuthCookie(value: string): boolean {
  return value.startsWith(AUTHCOOKIE_PREFIX) && !value.endsWith(VRCZIP_TOKEN_SUFFIX);
}

/** Constant-time comparison for two pairing codes or tokens of the same length. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * A six-digit pairing code, and its hash.
 *
 * Uniform over 000000–999999 — `randomUUID` is the wrong tool and `Math.random()` is worse, so this
 * takes a rejection-sampled draw from the CSPRNG. Six digits is 20 bits, which is only safe because
 * codes expire in minutes, are single-use, and attempts are counted per app identity.
 */
export function mintPairingCode(random: (max: number) => number = randomBelow): MintedToken {
  const code = String(random(1_000_000)).padStart(6, "0");
  return { token: code, hash: hashProxyToken(code) };
}

/** A uniform integer in `[0, max)` from the CSPRNG, by rejection sampling. */
function randomBelow(max: number): number {
  const bytes = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  for (;;) {
    crypto.getRandomValues(bytes);
    const value = bytes[0] ?? 0;
    if (value < limit) return value % max;
  }
}
