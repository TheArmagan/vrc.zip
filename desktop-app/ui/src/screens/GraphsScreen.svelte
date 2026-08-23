<!--
  Graphs — the list, and the door to the editor.

  One route serves both: `#/graphs` lists them and `#/graphs/<id>` hands off to the canvas, the same
  shape `#/gamelog/<sessionId>` uses. The editor is a separate component because it is a *document*
  being edited — dirty state, undo, a save that can fail — and none of that belongs in a list.

  The two switches on a card are deliberately not the same control. **Enable** says the graph should
  run; **Arm** says its outbound actions are real rather than rehearsed. Enabling is a click, because
  a graph in dry-run cannot reach anybody. Arming is a hold, because after it a wrongly-wired graph
  sends real invites — the same reasoning, and the same primitive, as approving a plugin install.
-->
<script lang="ts">
import PlayIcon from "@lucide/svelte/icons/play";
import PlusIcon from "@lucide/svelte/icons/plus";
import TrashIcon from "@lucide/svelte/icons/trash-2";
import WorkflowIcon from "@lucide/svelte/icons/workflow";
import { api, describeError, type GraphSummary } from "$lib/api.ts";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import GraphEditor from "$lib/components/graphs/GraphEditor.svelte";
import HoldToConfirm from "$lib/components/HoldToConfirm.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import { hrefFor } from "$lib/router.ts";
import { graphs } from "$lib/state/graphs.svelte.ts";

let { graphId }: { graphId: string | null } = $props();

let actionError = $state<string | null>(null);
/** The graph a request is in flight for, so only its own row is disabled. */
let busy = $state<string | null>(null);
let creating = $state(false);
let newName = $state("");

$effect(() => {
  if (!graphs.loaded) void graphs.load();
});

async function act(id: string, run: () => Promise<GraphSummary>): Promise<void> {
  busy = id;
  actionError = null;
  try {
    graphs.replace(await run());
  } catch (cause) {
    actionError = describeError(cause);
  } finally {
    busy = null;
  }
}

async function create(): Promise<void> {
  const name = newName.trim();
  if (name === "") return;
  busy = "*";
  actionError = null;
  try {
    const created = await api.graphs.create({ name });
    creating = false;
    newName = "";
    await graphs.load();
    // Straight into the editor: a graph with no nodes is not something to admire in a list.
    window.location.hash = hrefFor("graphs", created.id);
  } catch (cause) {
    actionError = describeError(cause);
  } finally {
    busy = null;
  }
}

async function remove(graph: GraphSummary): Promise<void> {
  busy = graph.id;
  actionError = null;
  try {
    await api.graphs.remove(graph.id);
    graphs.remove(graph.id);
  } catch (cause) {
    actionError = describeError(cause);
  } finally {
    busy = null;
  }
}

async function runNow(graph: GraphSummary): Promise<void> {
  busy = graph.id;
  actionError = null;
  try {
    await api.graphs.runNow(graph.id);
  } catch (cause) {
    actionError = describeError(cause);
  } finally {
    busy = null;
  }
}
</script>

{#if graphId !== null}
  <GraphEditor {graphId} />
{:else}
  <SectionHeader
    title="Graphs"
    count={graphs.graphs.length}
    description="saved. A graph watches for something and then does something."
  >
    {#snippet actions()}
      <Button size="sm" onclick={() => (creating = true)}>
        <PlusIcon class="size-4" />
        New graph
      </Button>
    {/snippet}
  </SectionHeader>

  <div class="flex-1 overflow-y-auto">
    <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      {#if actionError !== null}
        <ErrorNote message={actionError} />
      {/if}
      {#if graphs.error !== null}
        <ErrorNote message={graphs.error} />
      {/if}

      {#if creating}
        <div class="flex flex-col gap-3 rounded-lg border border-border p-4">
          <label class="text-sm font-medium" for="graph-name">Name</label>
          <Input
            id="graph-name"
            bind:value={newName}
            placeholder="Tell me when Ada comes online"
            onkeydown={(event: KeyboardEvent) => {
              if (event.key === "Enter") void create();
            }}
          />
          <div class="flex gap-2">
            <Button disabled={newName.trim() === "" || busy === "*"} onclick={() => void create()}>
              Create
            </Button>
            <Button
              variant="ghost"
              onclick={() => {
                creating = false;
                newName = "";
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      {/if}

      {#if graphs.loading && graphs.graphs.length === 0}
        {#each [0, 1, 2] as index (index)}
          <Skeleton class="h-24 w-full" />
        {/each}
      {:else if graphs.graphs.length === 0}
        <EmptyState
          icon={WorkflowIcon}
          title="No graphs yet"
          description="A graph reacts to something that happens — a friend coming online, someone joining your instance — and does something about it."
        />
      {:else}
        {#each graphs.graphs as graph (graph.id)}
          <div class="flex flex-col gap-3 rounded-lg border border-border p-4">
            <div class="flex flex-wrap items-center gap-2">
              <a class="font-medium hover:underline" href={hrefFor("graphs", graph.id)}>
                {graph.name}
              </a>
              <Badge variant="secondary">{graph.nodeCount} nodes</Badge>
              {#if graph.enabled && !graph.armed}
                <!-- The state a new graph starts in, and the one worth naming on the card. -->
                <Badge variant="outline">Rehearsing</Badge>
              {/if}
              {#if graph.disabledReason !== null}
                <Badge variant="destructive">{graph.disabledReason}</Badge>
              {/if}
              <span class="ml-auto text-xs text-muted-foreground">
                edited <RelativeTime ts={graph.updatedAt} />
              </span>
            </div>

            {#if graph.description !== ""}
              <p class="text-sm text-muted-foreground">{graph.description}</p>
            {/if}

            <div class="flex flex-wrap items-center gap-4">
              <label class="flex items-center gap-2 text-sm">
                <Switch
                  checked={graph.enabled}
                  disabled={busy === graph.id}
                  onCheckedChange={(next: boolean) =>
                    void act(graph.id, () => api.graphs.setEnabled(graph.id, next))}
                />
                Enabled
              </label>

              {#if graph.armed}
                <label class="flex items-center gap-2 text-sm">
                  <Switch
                    checked={true}
                    disabled={busy === graph.id}
                    onCheckedChange={() =>
                      void act(graph.id, () => api.graphs.setArmed(graph.id, false))}
                  />
                  Armed
                </label>
              {:else}
                <!--
                  A hold, not a click. Everything this graph sends is currently rehearsed and
                  written to the feed as a note; after this it reaches other people.
                -->
                <HoldToConfirm
                  label="Hold to arm"
                  disabled={busy === graph.id}
                  onconfirm={() => void act(graph.id, () => api.graphs.setArmed(graph.id, true))}
                />
              {/if}

              <div class="ml-auto flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy === graph.id}
                  onclick={() => void runNow(graph)}
                >
                  <PlayIcon class="size-4" />
                  Run now
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy === graph.id}
                  onclick={() => void remove(graph)}
                >
                  <TrashIcon class="size-4" />
                  Delete
                </Button>
              </div>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}
