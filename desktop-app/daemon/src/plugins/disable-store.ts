/**
 * `PluginDisableStore` against the real database.
 *
 * The supervisor holds its disabled state in memory and treats that as authoritative for the
 * session; this exists so the *next* process starts in the same place. An auto-disable that did not
 * survive a daemon restart would be a crash loop with extra steps — the plugin comes back enabled,
 * crashes five more times, gets disabled again, and repeats for as long as the daemon is restarted.
 *
 * **Every method is synchronous and returns void, and that is a requirement rather than a
 * convenience.** PLAN.md promises disable is instant and always succeeds, so `disable()` may not
 * await anything — and a store that could block would put the one control the user is promised will
 * work behind whatever the disk is doing. `bun:sqlite` is synchronous, one row, no joins, so the
 * honest implementation happens to be the fast one; a store that genuinely needed I/O would have to
 * queue and return, which is why the interface is shaped this way rather than returning promises.
 */

import type { Store } from "../store/index.ts";
import type { DisableRecord, PluginDisableStore } from "./supervisor.ts";

/**
 * Reasons worth remembering across a restart.
 *
 * `spawn-failed` is deliberately absent. A file locked by a virus scanner, a bundle mid-write, a
 * disk that was briefly not there — these are conditions that pass, and permanently disabling a
 * plugin because the machine was busy once would be the daemon punishing the user for its own bad
 * timing. It still stops *this* run; it just does not outlive it.
 */
const STICKY: ReadonlySet<DisableRecord["reason"]> = new Set([
  "user",
  "crash-loop",
  "protocol-mismatch",
]);

export function createPluginDisableStore(store: Store): PluginDisableStore {
  return {
    load(pluginId: string): DisableRecord | null {
      const row = store.getPlugin(pluginId);
      if (row === null || row.disabled_at === null) return null;
      return {
        pluginId,
        // Widened at the boundary rather than trusted: the column is TEXT, and a row written by a
        // newer build may carry a reason this one has never heard of. Falling back to `user` is the
        // conservative reading — it keeps the plugin off and offers the user the "turn it back on"
        // affordance, rather than treating an unrecognised reason as no reason at all.
        reason: isReason(row.disabled_by) ? row.disabled_by : "user",
        detail: row.disabled_reason ?? "Disabled.",
        at: row.disabled_at,
      };
    },

    save(record: DisableRecord): void {
      if (!STICKY.has(record.reason)) return;
      // A plugin the store has never seen cannot be disabled durably, and that is fine rather than
      // an error: the supervisor's in-memory state still holds for this session, and there is no
      // installed row for a future session to read.
      if (store.getPlugin(record.pluginId) === null) return;
      store.disablePlugin(record.pluginId, record.at, record.reason, record.detail);
    },

    clear(pluginId: string): void {
      if (store.getPlugin(pluginId) === null) return;
      store.enablePlugin(pluginId);
    },
  };
}

function isReason(value: string | null): value is DisableRecord["reason"] {
  return (
    value === "user" ||
    value === "crash-loop" ||
    value === "protocol-mismatch" ||
    value === "spawn-failed"
  );
}
