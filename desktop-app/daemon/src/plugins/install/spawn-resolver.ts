/**
 * The load path: turns an installed row into "run this exact file", or refuses.
 *
 * `PluginRegistry` takes a `spawnFor(pluginId)` callback and deliberately knows nothing about how a
 * bundle is found. This is the implementation of that callback, and it is where PLAN.md's *"verify
 * the hash on every load"* actually happens — on every spawn, every restart, every daemon boot, not
 * once at install.
 *
 * Two things it is careful about:
 *
 * **A refusal is not silence.** `spawnFor` returning `null` gets the registry's generic "could not
 * find this plugin's installed files", which is the right sentence for a missing file and the wrong
 * one for a modified one. {@link SpawnResolverOptions.onRefused} carries the real reason out so the
 * management page can say *tampering* when that is what happened.
 *
 * **It reads the manifest that was accepted at install**, not one off disk. `plugins.manifest` holds
 * the JSON as it was validated, so a plugin cannot change its own `performance` mode — which spends
 * the user's memory and is part of the consent hash — by editing a file after the fact.
 */

import { parseManifest } from "@vrcz/plugin-api";
import type { Store } from "../../store/index.ts";
import type { TransportSpawnOptions } from "../transport.ts";
import { loadArtifact } from "./artifact.ts";

/**
 * Hard address-space ceiling for a `--smol` plugin, imposed by the OS where the platform allows it.
 *
 * Above the supervisor's 256 MiB RSS watchdog on purpose: the watchdog is the *policy* — it notices
 * a plugin growing and kills it with a sentence the user can read — and this is the backstop for the
 * allocation the watchdog would not see between two ticks. A cap at the same number would turn every
 * watchdog kill into an opaque out-of-memory crash instead.
 */
export const SMOL_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

/** The same backstop for a plugin whose manifest opted into `performance: "throughput"`. */
export const THROUGHPUT_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;

export interface SpawnResolverOptions {
  readonly store: Store;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Why a plugin will not be started, when it will not be. Called with a complete sentence.
   *
   * The hash mismatch is the case this exists for: a file that no longer matches the hash it was
   * installed under is the one failure here that a user has to act on.
   */
  readonly onRefused?: (pluginId: string, detail: string) => void;
}

export type SpawnFor = (
  pluginId: string,
) => Omit<TransportSpawnOptions, "pluginId" | "helloTimeoutMs"> | null;

/** Builds the `spawnFor` the registry is constructed with. */
export function createSpawnResolver(options: SpawnResolverOptions): SpawnFor {
  const refuse = (pluginId: string, detail: string): null => {
    options.onRefused?.(pluginId, detail);
    return null;
  };

  return (pluginId) => {
    const row = options.store.getPlugin(pluginId);
    if (row === null) return refuse(pluginId, `${pluginId} is not installed.`);

    const loaded = loadArtifact(pluginId, row.bundle_hash, options.env);
    if (!loaded.ok) return refuse(pluginId, loaded.detail);

    const smol = performanceOf(row.manifest) !== "throughput";
    return {
      bundlePath: loaded.path,
      smol,
      memoryLimitBytes: smol ? SMOL_MEMORY_LIMIT_BYTES : THROUGHPUT_MEMORY_LIMIT_BYTES,
    };
  };
}

/**
 * The stored manifest's `performance` mode, defaulting to `"smol"` if the row cannot be read.
 *
 * Defaulting rather than failing, because a stored manifest that no longer parses is a migration
 * bug on our side and the user's plugin should still run — in the *smaller* of the two modes, which
 * is the direction that cannot spend memory nobody agreed to.
 */
function performanceOf(manifestJson: string): "smol" | "throughput" {
  try {
    const parsed = parseManifest(JSON.parse(manifestJson));
    return parsed.ok ? parsed.manifest.performance : "smol";
  } catch {
    return "smol";
  }
}
