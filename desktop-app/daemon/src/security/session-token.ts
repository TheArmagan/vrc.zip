import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readStateFile } from "./state-file.ts";

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
 *
 * The one exception is dev mode — see `resolveSessionToken` below. It is opt-in precisely because
 * per-boot rotation is the security property that keeps this token's blast radius bounded.
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

// --- dev-mode reuse ---------------------------------------------------------

/**
 * Forces token reuse regardless of how the process was started.
 *
 * Needed because the `--watch` detection below reads the *current* process's flags, which a test —
 * or a supervisor that spawns the daemon itself — has no way to set.
 */
export const STABLE_SESSION_TOKEN_ENV = "VRCZIP_STABLE_TOKEN";

/**
 * The Bun flags that mean "this process will be restarted on every file save".
 *
 * Empirically (Bun 1.4.0, Windows): `process.execArgv` is `["--watch"]` / `["--hot"]` and keeps
 * that value across every reload, while `Bun.argv` and `process.argv` contain only the interpreter
 * and the entry file, and Bun sets no `BUN_*` environment variable for either mode. `execArgv` is
 * therefore the only honest signal, and it is a reliable one.
 */
const WATCH_FLAGS = new Set(["--watch", "--hot"]);

/**
 * Is the daemon running in dev mode, where a stable token is worth more than rotation?
 *
 * `execArgv` is a parameter rather than a direct read so tests can state the mode they mean instead
 * of inheriting whatever flags the test runner happens to have been started with.
 */
export function stableSessionTokenRequested(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): boolean {
  const flag = env[STABLE_SESSION_TOKEN_ENV]?.toLowerCase();
  if (flag === "1" || flag === "true") return true;
  return execArgv.some((arg) => WATCH_FLAGS.has(arg));
}

export interface ResolvedSessionToken {
  readonly token: string;
  /** True when `token` came out of the previous run's `state.json` rather than the RNG. */
  readonly reused: boolean;
  /** True when dev mode is on, whether or not there was anything worth reusing. */
  readonly stable: boolean;
}

/**
 * The token for this run: fresh by default, the previous run's under `--watch` / `--hot` / the env
 * var.
 *
 * Reuse exists for one reason — under `bun --watch` every save restarts the daemon, and a rotated
 * token invalidates the developer's open browser tab and any `curl` they had saved. It stays opt-in
 * because a token that silently outlives its process is a credential with no expiry, and shipping
 * that by accident is exactly the failure this guard is shaped to prevent.
 *
 * A stored token is only trusted if it still has the shape `sessionTokensMatch` expects; a
 * truncated or hand-edited `state.json` gets a fresh token rather than a weak one.
 */
export async function resolveSessionToken(
  options: { readonly env?: NodeJS.ProcessEnv; readonly execArgv?: readonly string[] } = {},
): Promise<ResolvedSessionToken> {
  const stable = stableSessionTokenRequested(
    options.env ?? process.env,
    options.execArgv ?? process.execArgv,
  );
  if (!stable) return { token: generateSessionToken(), reused: false, stable: false };

  const previous = await readStateFile(options.env);
  const stored = previous?.sessionToken;
  if (stored !== undefined && isWellFormedSessionToken(stored)) {
    return { token: stored, reused: true, stable: true };
  }
  return { token: generateSessionToken(), reused: false, stable: true };
}
