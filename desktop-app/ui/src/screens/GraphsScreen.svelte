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
import BugIcon from "@lucide/svelte/icons/bug";
import DownloadIcon from "@lucide/svelte/icons/download";
import PencilIcon from "@lucide/svelte/icons/pencil";
import PlayIcon from "@lucide/svelte/icons/play";
import PlusIcon from "@lucide/svelte/icons/plus";
import UploadIcon from "@lucide/svelte/icons/upload";
import WorkflowIcon from "@lucide/svelte/icons/workflow";
import ZapIcon from "@lucide/svelte/icons/zap";
import { api, describeError, type GraphSummary, type GraphTemplate } from "$lib/api.ts";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import GraphEditor from "$lib/components/graphs/GraphEditor.svelte";
import HoldToConfirm from "$lib/components/HoldToConfirm.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import StoresPanel from "$lib/components/graphs/StoresPanel.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import { graphState, watchesFor } from "$lib/graphs/graph-state.ts";
import { RUN_NOW_TYPE } from "$lib/graphs/loops.ts";
import { hrefFor } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";
import { graphs } from "$lib/state/graphs.svelte.ts";

let { graphId }: { graphId: string | null } = $props();

let actionError = $state<string | null>(null);
/** The graph a request is in flight for, so only its own row is disabled. */
let busy = $state<string | null>(null);
let creating = $state(false);
let newName = $state("");
let templates = $state<GraphTemplate[]>([]);
/** Which template the new graph starts from. Empty means a blank canvas. */
let fromTemplate = $state("");
/** The default account the new graph starts with. Empty means it has none. */
let newAccountId = $state("");
/** What an import could not find on this machine. Kept until the user starts something else. */
let importNote = $state<string | null>(null);
let fileInput = $state<HTMLInputElement | null>(null);
/**
 * The graph being renamed, and the draft of its two editable fields.
 *
 * Inline on the card rather than in a dialog: naming a graph is something you do *because* of the
 * other graphs — "this one is the invite watcher, that one is the roundup" — and a modal covers
 * exactly the list you are naming it against.
 */
let editing = $state<{ id: string; name: string; description: string } | null>(null);

/**
 * "This graph has no default account".
 *
 * A sentinel rather than the empty string for the same reason `AccountFilter` needs one: bits-ui
 * reads `""` as *nothing is selected*, so an item with that value can never show as chosen. The
 * wire value stays `null`, which is what the daemon means by it, and the translation happens at
 * the two edges below.
 */
const NO_ACCOUNT = "none";

/**
 * What the picker says a graph acts as.
 *
 * An id that no longer names an account is a normal state, not an error: `accountId` is cleared
 * when the account is removed, but a graph saved by an older build, or imported, can still carry
 * one. Saying so is more use than falling back to "No default", which would read as if the graph
 * had never had one.
 */
function accountLabel(accountId: string | null): string {
  if (accountId === null) return "No default";
  return app.accountById(accountId)?.displayName ?? "Account not signed in";
}

/**
 * Sets the account a graph's nodes act as unless they name one themselves.
 *
 * Saved immediately, like Enabled and Armed and unlike the name: it is a setting rather than a
 * draft, and there is nothing to cancel. Name and description are deliberately not sent, so
 * choosing an account here cannot overwrite a rename somebody is typing on another card.
 */
async function setAccount(graph: GraphSummary, next: string): Promise<void> {
  const accountId = next === NO_ACCOUNT ? null : next;
  if (accountId === graph.accountId) return;
  await act(graph.id, () => api.graphs.update(graph.id, { accountId }));
}

$effect(() => {
  if (!graphs.loaded) void graphs.load();
});

$effect(() => {
  void api.graphs
    .templates()
    .then((list) => {
      templates = list;
    })
    .catch(() => {
      // A missing template list is not worth an error banner: the New graph form still works, it
      // just has one fewer starting point.
    });
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
    const template = templates.find((entry) => entry.id === fromTemplate);
    const created = await api.graphs.create({
      name,
      ...(newAccountId === "" ? {} : { accountId: newAccountId }),
      ...(template === undefined
        ? {}
        : { description: template.description, definition: template.definition }),
    });
    creating = false;
    newName = "";
    newAccountId = "";
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

/**
 * Downloads the graph as a file.
 *
 * A blob URL rather than a link straight at `/api/graphs/:id/export`: that route needs the session
 * token, and a plain `<a download>` cannot carry an Authorization header. Fetching first also means
 * a failure shows up as an error here rather than as a downloaded file full of JSON error text.
 */
async function exportGraph(graph: GraphSummary): Promise<void> {
  busy = graph.id;
  actionError = null;
  try {
    const document = await api.graphs.export(graph.id);
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = `${graph.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.vrcz-graph.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (cause) {
    actionError = describeError(cause);
  } finally {
    busy = null;
  }
}

async function importGraph(file: File): Promise<void> {
  busy = "*";
  actionError = null;
  importNote = null;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    const result = await api.graphs.import(parsed);
    await graphs.load();
    importNote =
      result.missing.length === 0
        ? `Imported "${result.graph.name}". It is off until you switch it on.`
        : `Imported "${result.graph.name}", but this machine has no ${result.missing.join(", ")}. Those nodes will not run.`;
  } catch (cause) {
    actionError = describeError(cause);
  } finally {
    busy = null;
  }
}

/**
 * Saves a renamed graph.
 *
 * Name and description only. `update` takes the definition too, and deliberately is not handed one
 * here: sending the fields you did not touch is how a rename from a list overwrites a canvas
 * somebody has open in another tab.
 */
async function saveDetails(): Promise<void> {
  const draft = editing;
  if (draft === null) return;
  const name = draft.name.trim();
  if (name === "") return;
  busy = draft.id;
  actionError = null;
  try {
    graphs.replace(
      await api.graphs.update(draft.id, { name, description: draft.description.trim() }),
    );
    editing = null;
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
      <Button size="sm" variant="ghost" onclick={() => fileInput?.click()}>
        <UploadIcon class="size-4" />
        Import
      </Button>
      <Button size="sm" onclick={() => (creating = true)}>
        <PlusIcon class="size-4" />
        New graph
      </Button>
    {/snippet}
  </SectionHeader>

  <div class="flex-1 overflow-y-auto">
    <div class="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <!--
        A file, not a paste box. A graph arrives as a file somebody sent you, and reading it here
        rather than posting the raw file means the daemon never sees anything but parsed JSON.
      -->
      <input
        bind:this={fileInput}
        class="hidden"
        type="file"
        accept="application/json,.json"
        onchange={(event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          const file = input.files?.[0];
          if (file !== undefined) void importGraph(file);
          // Cleared so picking the same file twice fires `change` the second time too.
          input.value = "";
        }}
      />

      {#if actionError !== null}
        <ErrorNote message={actionError} />
      {/if}
      {#if importNote !== null}
        <p class="rounded-lg border border-border p-3 text-sm text-muted-foreground">
          {importNote}
        </p>
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
          {#if templates.length > 0}
            <label class="text-sm font-medium" for="graph-template">Start from</label>
            <select
              id="graph-template"
              class="rounded border border-input bg-background px-2 py-2 text-sm"
              bind:value={fromTemplate}
            >
              <option value="">A blank canvas</option>
              {#each templates as template (template.id)}
                <option value={template.id}>{template.name}</option>
              {/each}
            </select>
            {#if fromTemplate !== ""}
              <p class="text-xs text-muted-foreground">
                {templates.find((entry) => entry.id === fromTemplate)?.description ?? ""}
              </p>
            {/if}
          {/if}

          {#if app.accounts.length > 0}
            <!--
              The account the graph's nodes act as unless a node names one itself. Set here because
              a graph that sends anything needs one, and finding that out after wiring the canvas is
              finding it out too late.
            -->
            <label class="text-sm font-medium" for="graph-account">Acts as</label>
            <select
              id="graph-account"
              class="rounded border border-input bg-background px-2 py-2 text-sm"
              bind:value={newAccountId}
            >
              <option value="">No default account</option>
              {#each app.accounts as account (account.id)}
                <option value={account.id}>{account.displayName}</option>
              {/each}
            </select>
          {/if}

          <div class="flex gap-2">
            <Button disabled={newName.trim() === "" || busy === "*"} onclick={() => void create()}>
              Create
            </Button>
            <Button
              variant="ghost"
              onclick={() => {
                creating = false;
                newName = "";
                newAccountId = "";
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
          {@const state = graphState(graph)}
          {@const watches = watchesFor(
            graph.triggerTypes,
            (type) => graphs.definition(type)?.title ?? null,
          )}
          <!--
            The rail and the dot carry the state, in one colour, at the left edge where the eye
            starts. Off and armed used to look identical at a glance and one of them sends real
            invites; a badge for one of the four states was not enough to tell them apart.
          -->
          <article
            class="group relative overflow-hidden rounded-lg border border-border transition-shadow hover:shadow-md"
          >
            <span
              class="absolute inset-y-0 left-0 w-1"
              style="background: {state.color}"
              aria-hidden="true"
            ></span>
            <div class="flex flex-col gap-3 p-4 pl-5">
              {#if editing?.id === graph.id}
                <!--
                  The fields take the place of the title and the description rather than appearing
                  under them, so the card does not jump and you are editing the thing you are
                  looking at. Enter saves, Escape abandons.
                -->
                <div class="flex flex-col gap-2">
                  <Input
                    bind:value={editing.name}
                    aria-label="Name"
                    placeholder="Tell me when Ada comes online"
                    onkeydown={(event: KeyboardEvent) => {
                      if (event.key === "Enter") void saveDetails();
                      if (event.key === "Escape") editing = null;
                    }}
                  />
                  <Textarea
                    bind:value={editing.description}
                    aria-label="Description"
                    rows={2}
                    placeholder="What this graph is for. Optional."
                    onkeydown={(event: KeyboardEvent) => {
                      if (event.key === "Escape") editing = null;
                    }}
                  />
                  <div class="flex gap-2">
                    <Button
                      size="sm"
                      disabled={editing.name.trim() === "" || busy === graph.id}
                      onclick={() => void saveDetails()}
                    >
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onclick={() => (editing = null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              {:else}
                <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span
                    class="size-2 shrink-0 self-center rounded-full"
                    style="background: {state.color}"
                    aria-hidden="true"
                  ></span>
                  <a class="font-medium hover:underline" href={hrefFor("graphs", graph.id)}>
                    {graph.name}
                  </a>
                  {#if graph.debug}
                    <!--
                      Said on the card because debug mode is not free and it is not visible from
                      anywhere else: while it is on, every run of this graph is recorded and its
                      failures arrive as toasts wherever the user happens to be. A graph left in
                      debug mode a fortnight ago is exactly the thing a list is for.
                    -->
                    <span
                      class="flex items-center gap-1 text-xs text-muted-foreground"
                      title="Runs of this graph are being recorded, and its failures are announced."
                    >
                      <BugIcon class="size-3.5" />
                      Debugging
                    </span>
                  {/if}
                  <span class="ml-auto text-xs text-muted-foreground">
                    edited <RelativeTime ts={graph.updatedAt} />
                  </span>
                </div>

                <!-- One meta line instead of a row of badges. `.` separators rather than bullets,
                     which is the house rule about typing what a keyboard types. -->
                <div class="-mt-1 flex flex-wrap items-center gap-x-1.5 text-xs">
                  <span class="font-medium" style="color: {state.color}">{state.label}</span>
                  <span class="text-muted-foreground">.</span>
                  <span class="text-muted-foreground">
                    {graph.nodeCount}
                    {graph.nodeCount === 1 ? "node" : "nodes"}
                  </span>
                  <span class="text-muted-foreground">.</span>
                  <span class="text-muted-foreground">
                    {#if graph.lastRunAt === null}
                      never run
                    {:else}
                      ran <RelativeTime ts={graph.lastRunAt} />
                    {/if}
                  </span>
                </div>

                {#if state.detail !== ""}
                  <p class="text-xs" style="color: {state.color}">{state.detail}</p>
                {/if}

                {#if watches.length > 0}
                  <!-- What the graph is *for*, which the node count never said. -->
                  <p
                    class="flex items-start gap-1.5 text-sm text-muted-foreground"
                    title="This graph's triggers"
                  >
                    <ZapIcon class="mt-0.5 size-3.5 shrink-0" />
                    <span>{watches.join(", ")}</span>
                  </p>
                {/if}

                {#if graph.description !== ""}
                  <p class="text-sm text-muted-foreground">{graph.description}</p>
                {/if}
              {/if}

            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
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

              <!--
                Whose account the graph acts as. Beside the two switches rather than behind Open,
                because it is the third thing that decides what a run actually does: enabled says it
                runs, armed says it reaches other people, and this says who they hear from. A node
                that names its own account still wins; this is only the fallback.
              -->
              {#if app.accounts.length > 0}
                <div class="flex items-center gap-2 text-sm">
                  <span class="text-muted-foreground">Acts as</span>
                  <Select.Root
                    type="single"
                    disabled={busy === graph.id}
                    value={graph.accountId ?? NO_ACCOUNT}
                    onValueChange={(next: string) => void setAccount(graph, next)}
                  >
                    <Select.Trigger size="sm" class="w-44 shrink-0" aria-label="Default account">
                      <span class="truncate">{accountLabel(graph.accountId)}</span>
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value={NO_ACCOUNT} label="No default account" />
                      {#each app.accounts as account (account.id)}
                        <Select.Item value={account.id} label={account.displayName} />
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
              {/if}

              <!--
                The secondary actions fade in on hover, and on focus, and always below `md`.

                Hover alone would put Delete and Export out of reach of a keyboard and of a narrow
                window, which is a real loss dressed up as restraint. What the fade buys is a resting
                card that is a name and a state rather than six buttons — and `Open` never fades,
                because it is the one thing you came to the list to do.
              -->
              <div class="ml-auto flex items-center gap-1">
              <div
                class="flex items-center gap-1 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
              >
                <!--
                  Icons rather than words, and the label lives in `aria-label` and the tooltip.
                  Three labelled ghost buttons plus a hold plus Open does not fit one line at this
                  card width, and the row wrapping put the primary action on a line of its own.
                -->
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Rename"
                  title="Rename"
                  disabled={busy === graph.id}
                  onclick={() =>
                    (editing = {
                      id: graph.id,
                      name: graph.name,
                      description: graph.description,
                    })}
                >
                  <PencilIcon class="size-4" />
                </Button>
<!--
                  Only where there is something to press.

                  This used to be on every card and answered 409 on a graph with no manual trigger,
                  which is a button whose only function is to tell you it was the wrong button.
                  `triggerTypes` already arrives on the summary, so the question costs nothing.
                -->
                {#if graph.triggerTypes.includes(RUN_NOW_TYPE)}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Run now"
                    title="Run now"
                    disabled={busy === graph.id}
                    onclick={() => void runNow(graph)}
                  >
                    <PlayIcon class="size-4" />
                  </Button>
                {/if}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Export"
                  title="Export"
                  disabled={busy === graph.id}
                  onclick={() => void exportGraph(graph)}
                >
                  <DownloadIcon class="size-4" />
                </Button>
                <!--
                  Held, not clicked. A graph is a document with no version history and no undo, and
                  Delete sits at the end of a row of ordinary buttons — Run now, Export — where a
                  click that overshoots by forty pixels destroys work that took an evening to wire.
                  The same reasoning as arming, and deliberately the same control: the cost of a
                  hold is attention, which is exactly what a mis-aimed click did not have.
                -->
                <HoldToConfirm
                  label="Hold to delete"
                  variant="ghost"
                  disabled={busy === graph.id}
                  onconfirm={() => void remove(graph)}
                />
              </div>
              <!-- Outside the fading group on purpose: opacity applies to a whole subtree, and
                   Open is the one thing you came to the list to do. -->
              <Button size="sm" href={hrefFor("graphs", graph.id)}>Open</Button>
              </div>
            </div>
            </div>
          </article>
        {/each}
      {/if}

      <!--
        Below the graphs rather than on a route of its own: a store is only interesting because a
        graph is writing to it, and a screen you have to go looking for is one nobody checks after a
        typo turns into a store.
      -->
      <div class="mt-4 border-t border-border pt-6">
        <StoresPanel />
      </div>
    </div>
  </div>
{/if}
