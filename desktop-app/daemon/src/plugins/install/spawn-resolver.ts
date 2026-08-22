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
 * Hard memory ceiling for a `--smol` plugin, imposed by the OS where the platform allows it.
 *
 * Above the supervisor's RSS watchdog on purpose: the watchdog is the *policy* — it notices a plugin
 * growing and kills it with a sentence the user can read — and this is the backstop for the
 * allocation the watchdog would not see between two ticks. A cap at or below the watchdog would turn
 * every watchdog kill into an opaque out-of-memory crash instead, so the two numbers move together.
 *
 * **256 MiB, halved from 512, and the floor underneath it is higher than it looks.** Measured on
 * Windows, where the Job Object caps *committed* memory rather than RSS:
 *
 * | Workload | Result |
 * |---|---|
 * | `bun --smol` + one `setInterval` | starts at 100 MiB, **fails at 90 MiB and below** (exit 9) |
 * | 5,000 retained user objects + per-tick string churn | ~116 MiB RSS; **dies at 100 MiB**, runs at 128 |
 *
 * So the runtime alone is most of a 100 MiB budget, and a plugin holding something as ordinary as a
 * friends list needs more than that before it has done anything interesting. A ceiling near the
 * floor does not produce a frugal plugin, it produces a plugin that cannot start — which is why the
 * tidier-looking numbers were measured and rejected rather than reasoned about.
 *
 * **There is no way to make JSC itself want less** — see PROGRESS.md §Gotchas. The OS cap is the
 * only real mechanism, which is what PLAN.md §Phase 3 said and why this constant exists at all.
 *
 * JSC grows to fill what it is given, so this is a ceiling rather than a reservation: the same idle
 * process sits at ~45 MiB RSS under a 100 MiB cap and ~106 MiB under a 128 MiB one. The number that
 * bounds ordinary use is the RSS watchdog in `supervisor.ts`, which is deliberately below this.
 */
export const SMOL_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/** The same backstop for a plugin whose manifest opted into `performance: "throughput"`. */
export const THROUGHPUT_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;

/**
 * How much larger the Linux ceiling has to be than the number above.
 *
 * **The two platforms do not cap the same quantity, and this is the whole reason this factor
 * exists.** A Windows job object caps *committed* memory, which is close enough to the figure a
 * human has in mind that the constants above can be that figure. Linux uses `RLIMIT_AS`, which caps
 * **virtual address space** — and JavaScriptCore reserves gigabytes of address space it never
 * touches, so a cap set at the intended RSS refuses allocations while the plugin is nowhere near
 * that much real memory. `limits.ts` says this in its own words: pass a generous multiple and let
 * the RSS watchdog enforce the number a user actually sees.
 *
 * 40x puts a `--smol` plugin at 4 GiB of address space, which is reservation-shaped rather than
 * usage-shaped. Applying the 100 MiB figure directly on Linux would almost certainly stop `bun`
 * starting at all, which is a broken plugin system rather than a tight one.
 *
 * **Unverified on a real Linux box** — this machine is Windows. See PROGRESS.md §Gotchas.
 */
export const RLIMIT_AS_HEADROOM_FACTOR = 40;

/**
 * The ceiling to actually hand the spawn, for the platform it will run on.
 *
 * Exported and platform-injectable so a test can ask what Linux would get without being on Linux.
 */
export function memoryLimitFor(
  smol: boolean,
  platform: NodeJS.Platform = process.platform,
): number {
  const intended = smol ? SMOL_MEMORY_LIMIT_BYTES : THROUGHPUT_MEMORY_LIMIT_BYTES;
  return platform === "linux" ? intended * RLIMIT_AS_HEADROOM_FACTOR : intended;
}

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
      memoryLimitBytes: memoryLimitFor(smol),
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
