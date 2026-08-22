/**
 * The content-addressed artifact store: `plugins/<id>/<sha256>.js`.
 *
 * PLAN.md §"Install-time compilation": *"Content-address the artifact (`plugins/<id>/<sha256>.js`)
 * and verify the hash on every load."* Both halves are here, and the second one is the half that
 * carries the weight. Writing a file under its own hash proves nothing on its own — the name is
 * chosen by the writer. What makes it a property is that **nothing loads a bundle without hashing it
 * first**, so a file edited on disk after install cannot be run under the name it was installed as.
 *
 * Three consequences of the layout, each deliberate:
 *
 * - **An update does not overwrite.** A new version is a new hash and therefore a new file, and the
 *   old one stays until something prunes it. That is what makes a rollback a rename rather than a
 *   rebuild, and it is why {@link pruneArtifacts} is a separate, explicit call.
 * - **A reinstall of identical source is a no-op.** Same bytes, same hash, same path; the write is
 *   skipped and the caller is told it was already there.
 * - **The hash is the store's key too.** `plugins.bundle_hash` holds it, so "which file does this
 *   installed plugin run" has exactly one answer and it is checkable.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pluginDir } from "../../paths.ts";

/** Lowercase hex SHA-256 of the artifact's bytes. The file's own name, minus `.js`. */
export function hashBundle(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Where a bundle with this hash lives. Pure — says nothing about whether it is there. */
export function artifactPath(pluginId: string, hash: string, env?: NodeJS.ProcessEnv): string {
  return join(pluginDir(pluginId, env), `${hash}.js`);
}

export interface WrittenArtifact {
  readonly hash: string;
  readonly path: string;
  /** False when a file with this hash was already on disk — a reinstall of identical source. */
  readonly written: boolean;
}

/**
 * Writes a bundle under its own hash.
 *
 * Temp file plus rename, for the same reason the runtime fetcher does it: a daemon that dies
 * mid-write must not leave a truncated file sitting at a path whose name promises a hash it does not
 * have. The rename is atomic within a directory on every filesystem this runs on.
 */
export function writeArtifact(
  pluginId: string,
  bytes: Uint8Array,
  env?: NodeJS.ProcessEnv,
): WrittenArtifact {
  const hash = hashBundle(bytes);
  const directory = pluginDir(pluginId, env);
  const path = join(directory, `${hash}.js`);
  mkdirSync(directory, { recursive: true });

  if (existingSize(path) === bytes.byteLength) {
    // Same name means same hash means same bytes. The size check is only to rule out a truncated
    // leftover; a full file at this path cannot be anything else.
    return { hash, path, written: false };
  }

  const temporary = join(directory, `.${hash}.${String(process.pid)}.tmp`);
  try {
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up, which is the outcome we wanted either way.
    }
    throw error;
  }
  return { hash, path, written: true };
}

export type ArtifactLoad =
  | { readonly ok: true; readonly path: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly detail: string };

/**
 * Resolves an installed bundle and verifies its hash. **This is the load path.**
 *
 * Called before every spawn, not once at install. Reading and hashing a bundle is a few hundred
 * microseconds against a process launch, so caching the verdict would trade the entire property for
 * nothing measurable — and the verdict is exactly the thing an attacker wants cached.
 *
 * Returns a result rather than throwing, because "this plugin's file is not what we installed" is
 * something the management page has to *say*, and a plugin that fails here must not take the daemon's
 * boot down with it.
 *
 * Synchronous, and that is a contract rather than a convenience: `PluginRegistry.spawnFor` is a
 * synchronous function, and an async verifier would have to be called somewhere else — which is how
 * a load path ends up with a verified copy and an unverified one. One implementation, on the path
 * every spawn already takes.
 */
export function loadArtifact(
  pluginId: string,
  expectedHash: string,
  env?: NodeJS.ProcessEnv,
): ArtifactLoad {
  const path = artifactPath(pluginId, expectedHash, env);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    return {
      ok: false,
      detail: `The installed files for ${pluginId} are missing. Reinstalling the plugin should fix that.`,
    };
  }

  const actual = hashBundle(bytes);
  if (actual !== expectedHash) {
    // The file is named by a hash and does not have it, so something rewrote it after install. That
    // is not a corruption message, it is a tampering message, and it should read like one.
    return {
      ok: false,
      detail: `The installed code for ${pluginId} has changed since it was installed and will not be run. Expected ${expectedHash}, found ${actual}. Reinstall the plugin from a source you trust.`,
    };
  }
  return { ok: true, path, bytes };
}

/**
 * Deletes every artifact for a plugin except the one named.
 *
 * Explicit rather than automatic on install, because "the old artifact is still there" is the thing
 * that makes a rollback cheap, and a pipeline that swept it away would have removed that quietly.
 * Returns how many files it removed.
 */
export function pruneArtifacts(
  pluginId: string,
  keepHash: string,
  env?: NodeJS.ProcessEnv,
): number {
  const directory = pluginDir(pluginId, env);
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".js") || entry === `${keepHash}.js`) continue;
    try {
      unlinkSync(join(directory, entry));
      removed += 1;
    } catch {
      // A file we cannot delete is a file we leave. Pruning is housekeeping, not correctness.
    }
  }
  return removed;
}

/** Size of an existing file, or -1. Never throws, so a missing file is a normal answer. */
function existingSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/** Removes a plugin's whole artifact directory. Its *data* directory is deliberately not touched. */
export function removeArtifacts(pluginId: string, env?: NodeJS.ProcessEnv): void {
  rmSync(pluginDir(pluginId, env), { recursive: true, force: true });
}
