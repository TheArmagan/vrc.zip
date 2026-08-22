/**
 * What plugins contribute to the shell: sidebar entries, and command palette commands.
 *
 * Held apart from `plugin-panels.svelte.ts` because the two answer different questions and change
 * on different clocks. A *panel* is what a running plugin is drawing right now, and it comes and
 * goes with the process. A *contribution* is what a plugin declared in its manifest, and it is
 * there whether the plugin is running, stopped or crashed — which is deliberate: a sidebar entry
 * that vanished when a plugin fell over would hide exactly the fact the user needs, and they would
 * be left wondering where the thing they installed went.
 *
 * Loaded once by the shell and refreshed when the plugin list changes. There is no live frame for
 * this: contributions change only when something is installed, uninstalled or updated, all of which
 * are things the user just did.
 */

import { api, type InstalledPlugin } from "$lib/api.ts";

/** One plugin panel that asked for a place in the sidebar. */
export interface SidebarContribution {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly panelId: string;
  readonly title: string;
  /** False when the plugin is disabled or not running, so the entry can say so rather than lie. */
  readonly live: boolean;
}

/** One command a plugin contributed to the palette. */
export interface CommandContribution {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly commandId: string;
  readonly title: string;
  readonly description: string | null;
  readonly live: boolean;
}

class PluginContributionState {
  #plugins = $state<InstalledPlugin[]>([]);

  /**
   * Panels asking for the sidebar, in install order.
   *
   * `placement` is the manifest's own word. `"sidebar"` is its default, so a plugin that declares a
   * panel and says nothing about where it goes gets an entry — which is the behaviour an author
   * expects from "I contributed a panel".
   */
  readonly sidebar = $derived<SidebarContribution[]>(
    this.#plugins.flatMap((plugin) =>
      plugin.panels
        .filter((panel) => panel.placement === "sidebar")
        .map((panel) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          panelId: panel.id,
          title: panel.title,
          live: plugin.state === "running" || plugin.state === "activating",
        })),
    ),
  );

  /**
   * The sidebar entries grouped by the plugin that contributed them.
   *
   * Grouped rather than flat because a sidebar with six plugins' panels in one list is a list where
   * nobody can tell whose is whose — the same reason the palette gives each plugin its own group. A
   * plugin contributing exactly one panel still gets a heading: making the heading conditional would
   * mean two layouts to read, and the one-panel case is where "which plugin is this?" is asked most.
   */
  readonly sidebarGroups = $derived<
    { pluginId: string; pluginName: string; entries: SidebarContribution[] }[]
  >(
    this.#plugins
      .map((plugin) => ({
        pluginId: plugin.id,
        pluginName: plugin.name,
        entries: this.sidebar.filter((entry) => entry.pluginId === plugin.id),
      }))
      .filter((group) => group.entries.length > 0),
  );

  readonly commands = $derived<CommandContribution[]>(
    this.#plugins.flatMap((plugin) =>
      plugin.commands.map((command) => ({
        pluginId: plugin.id,
        pluginName: plugin.name,
        commandId: command.id,
        title: command.title,
        description: command.description,
        live: plugin.state === "running" || plugin.state === "activating",
      })),
    ),
  );

  async refresh(): Promise<void> {
    try {
      this.#plugins = await api.plugins.list();
    } catch {
      // Quiet on purpose. This runs at startup beside everything else the shell loads, and a
      // daemon that cannot answer it has bigger problems already on screen — an error banner about
      // *plugin contributions* would be the least useful of them.
    }
  }
}

export const pluginContributions = new PluginContributionState();
