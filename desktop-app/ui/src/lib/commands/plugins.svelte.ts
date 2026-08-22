/**
 * Plugin-contributed palette commands.
 *
 * A plugin declares commands in its manifest; this turns each into a registry entry whose `run`
 * asks the daemon to invoke it. The plugin decides what that means — it may draw a panel, show a
 * toast, or do something invisible.
 *
 * ## Why they are registered rather than answered by a source
 *
 * A `CommandSource` answers "what can be done with *this text*", which is right for an id somebody
 * pasted and wrong here: a plugin's commands exist whether or not anyone has typed anything, and
 * they should be findable by scrolling the palette rather than only by guessing their name.
 *
 * ## A stopped plugin keeps its commands, greyed
 *
 * `enabled` is false rather than the command being withheld, which is the registry's own posture
 * (see `CommandDefinition.enabled`): a command that vanishes is indistinguishable from one that
 * never existed, and someone hunting for the thing they installed deserves to find it and be told
 * it is stopped.
 */

import { api } from "$lib/api.ts";
import {
  type CommandDefinition,
  registerCommands,
} from "$lib/commands.svelte.ts";
import type { CommandContribution } from "$lib/state/plugin-contributions.svelte.ts";

export interface PluginCommandDeps {
  /** The registry's channel back to the user. Failures have to be visible. */
  readonly notify: (
    level: "info" | "success" | "warning" | "error",
    title: string,
    detail?: string,
  ) => void;
}

/** Turns one contribution into a registry entry. Exported for the tests. */
export function toCommandDefinition(
  contribution: CommandContribution,
  deps: PluginCommandDeps,
): CommandDefinition {
  return {
    // The namespace `commands.svelte.ts` reserved for this from the start: `plugin.<id>.<action>`.
    id: `plugin.${contribution.pluginId}.${contribution.commandId}`,
    title: contribution.title,
    group: `${contribution.pluginName} (Plugin)`,
    subtitle: contribution.description ?? contribution.pluginName,
    // Searchable by the plugin's name as well as the command's own words, because a user looking
    // for "that notes thing" is remembering the plugin, not the verb.
    keywords: [contribution.pluginName, contribution.pluginId],
    enabled: () => contribution.live,
    run: async () => {
      try {
        await api.plugins.runCommand(contribution.pluginId, contribution.commandId);
      } catch (error) {
        deps.notify(
          "error",
          `${contribution.pluginName} could not run that`,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

/** Registers every contributed command. Returns the teardown. */
export function registerPluginCommands(
  contributions: readonly CommandContribution[],
  deps: PluginCommandDeps,
): () => void {
  return registerCommands(
    contributions.map((contribution) => toCommandDefinition(contribution, deps)),
  );
}
