<!--
  One plugin's panel, as a page.

  The plugins screen shows every panel inline under its plugin's card, which is right for glancing
  at what is installed and wrong for using something: a plugin that draws a real tool wants the
  width, and a sidebar entry that lands on a card halfway down a list is not a place.

  So a panel declared with `placement: "sidebar"` gets an entry of its own and this screen behind it.
  Nothing about the rendering differs — it is the same `UiNode` walking the same tree — only the
  frame around it.

  ## When the panel is not there

  Three different absences, said differently, because they need different actions from the reader:
  the plugin is not installed, the plugin is installed but stopped (so nothing is drawing), and the
  plugin is running but has not drawn this panel yet. Collapsing them into "nothing here" would
  leave someone staring at an empty page with no idea whose fault it is.
-->
<script lang="ts">
import PlugIcon from "@lucide/svelte/icons/plug";
import { api, describeError, type InstalledPlugin } from "$lib/api.ts";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import UiNode from "$lib/components/plugin-ui/UiNode.svelte";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { pluginPanels } from "$lib/state/plugin-panels.svelte.ts";

let { pluginId, panelId }: { pluginId: string; panelId: string } = $props();

let plugin = $state<InstalledPlugin | null>(null);
let loading = $state(true);
let loadError = $state<string | null>(null);

const panel = $derived(pluginPanels.get(pluginId, panelId));
const declared = $derived(plugin?.panels.find((entry) => entry.id === panelId) ?? null);

$effect(() => {
  void load(pluginId);
});

async function load(id: string): Promise<void> {
  loading = true;
  try {
    plugin = (await api.plugins.list()).find((entry) => entry.id === id) ?? null;
    await pluginPanels.load(id);
    loadError = null;
  } catch (error) {
    loadError = describeError(error);
  } finally {
    loading = false;
  }
}
</script>

<SectionHeader
  title={declared?.title ?? panelId}
  description={plugin === null ? "" : `from ${plugin.name}`}
/>

<div class="flex-1 overflow-y-auto">
  <div class="mx-auto w-full max-w-3xl p-4">
    {#if loadError !== null}
      <ErrorNote message={loadError} />
    {:else if loading}
      <Skeleton class="h-40 w-full" />
    {:else if plugin === null}
      <EmptyState
        title="That plugin is not installed"
        description="It may have been uninstalled since this link was made."
        icon={PlugIcon}
      />
    {:else if panel === null && plugin.state === "disabled"}
      <EmptyState
        title="{plugin.name} is disabled"
        description="A disabled plugin draws nothing. Enable it on the Plugins screen."
        icon={PlugIcon}
      />
    {:else if panel === null}
      <EmptyState
        title="Nothing drawn yet"
        description="{plugin.name} is running but has not drawn this panel."
        icon={PlugIcon}
      />
    {:else}
      <UiNode node={panel.tree} {pluginId} {panelId} path={panelId} form={null} />
    {/if}
  </div>
</div>
