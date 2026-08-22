<!--
  A plugin's table: paged, and sorted by the host.

  **Paged rather than virtualized**, per decision 182. `ui/` has no windowing primitive and no
  shadcn table, and every other long list in this app pages — the friends list, the feed, the game
  log. Adding a windowing dependency for the one surface a third party controls would make plugin
  tables behave unlike everything else in the app while adding the only dependency in the bundle
  that exists for plugins.

  So `MAX_TABLE_ROWS` is a ceiling on what a plugin may *send*, not a promise to draw ten thousand
  rows at once. What it can send, the host holds; what it draws is a page.

  **Sorting and filtering are host-side over the rows the host holds**, which is the trade an author
  has to know about: it is instant and costs no round trip, and what you did not send cannot be
  filtered. A plugin backed by a bigger store filters its own data and sends the answer.
-->
<script lang="ts">
import type { TableNode, TableRow } from "@vrcz/plugin-api/ui";
import UserName from "$lib/components/UserName.svelte";
import WorldLink from "$lib/components/WorldLink.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { pluginPanels } from "$lib/state/plugin-panels.svelte.ts";
import { fullTimestamp } from "$lib/format.ts";

let {
  node,
  pluginId,
  panelId,
  path,
}: { node: TableNode; pluginId: string; panelId: string; path: string } = $props();

/** One page. Big enough that most tables never page at all. */
const PAGE_SIZE = 50;

let shown = $state(PAGE_SIZE);
let filter = $state("");
/** Host-side sort. Seeded from the plugin's own `sortBy`, then owned locally. */
/*
 * Seeded once from what the plugin drew, then owned locally.
 *
 * Svelte warns that this reads `node` non-reactively, and that is the intent: a plugin that
 * re-sends its table must not yank the column the user just sorted by out from under them. The
 * plugin's `sortBy` is an opening position, not a running instruction.
 */
// svelte-ignore state_referenced_locally
let sortBy = $state<string | null>(node.sortBy ?? null);
// svelte-ignore state_referenced_locally
let sortDir = $state<"asc" | "desc">(node.sortDir === "desc" ? "desc" : "asc");

const filtered = $derived.by(() => {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return node.rows;
  return node.rows.filter((row) =>
    Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(needle)),
  );
});

const sorted = $derived.by(() => {
  const column = sortBy;
  if (column === null) return filtered;
  // A copy: sorting the plugin's own array in place would mutate a tree the host is holding, and
  // the next patch would diff against something the plugin never sent.
  return [...filtered].sort((left, right) => {
    const a = left[column] ?? "";
    const b = right[column] ?? "";
    const order =
      typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return sortDir === "asc" ? order : -order;
  });
});

const page = $derived(sorted.slice(0, shown));

function toggleSort(columnId: string): void {
  if (sortBy === columnId) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
    return;
  }
  sortBy = columnId;
  sortDir = "asc";
}

function cellOf(row: TableRow, columnId: string): string {
  const value = row[columnId];
  return value === null || value === undefined ? "" : String(value);
}
</script>

<div class="flex flex-col gap-2">
  {#if node.filterable === true}
    <Input placeholder="Filter" value={filter} oninput={(event) => (filter = event.currentTarget.value)} />
  {/if}

  <div class="overflow-x-auto rounded border border-border">
    <table class="w-full text-sm">
      <thead class="bg-muted/50">
        <tr>
          {#each node.columns as column (column.id)}
            <th class="px-3 py-2 text-left font-medium" style={column.width === undefined ? "" : `width:${column.width}px`}>
              {#if column.sortable === true}
                <button
                  type="button"
                  class="flex items-center gap-1 hover:underline"
                  onclick={() => toggleSort(column.id)}
                >
                  {column.header}
                  {#if sortBy === column.id}<span aria-hidden="true">{sortDir === "asc" ? "↑" : "↓"}</span>{/if}
                </button>
              {:else}
                {column.header}
              {/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody class="divide-y divide-border">
        {#each page as row, index (row[node.rowKey] ?? index)}
          <tr
            class={node.onSelect === undefined ? "" : "cursor-pointer hover:bg-muted/40"}
            onclick={() =>
              node.onSelect === undefined
                ? undefined
                : void pluginPanels.dispatch(
                    pluginId,
                    panelId,
                    `${path}.row.${String(row[node.rowKey] ?? index)}`,
                    node.onSelect,
                    {},
                  )}
          >
            {#each node.columns as column (column.id)}
              <td class="px-3 py-2 align-top">
                {#if column.cell === "userRef"}
                  <UserName userId={cellOf(row, column.id)} name={null} />
                {:else if column.cell === "worldRef"}
                  <WorldLink worldId={cellOf(row, column.id)} />
                {:else if column.cell === "timestamp"}
                  {fullTimestamp(Number(row[column.id] ?? 0))}
                {:else if column.cell === "boolean"}
                  {row[column.id] === true ? "yes" : "no"}
                {:else if column.cell === "badge"}
                  <Badge variant="secondary">{cellOf(row, column.id)}</Badge>
                {:else}
                  {cellOf(row, column.id)}
                {/if}
              </td>
            {/each}
          </tr>
        {:else}
          <tr>
            <td class="px-3 py-4 text-center text-muted-foreground" colspan={node.columns.length}>
              {node.empty ?? "Nothing to show."}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  {#if sorted.length > page.length}
    <!--
      Says how many are loaded of how many there are, the same way the mutual-friends search does.
      A "Show more" with no count leaves a reader unable to tell a short page from the end.
    -->
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" onclick={() => (shown += PAGE_SIZE)}>Show more</Button>
      <span class="text-muted-foreground text-xs">
        {page.length} of {sorted.length}{filter.trim() === "" ? "" : ` matching (${node.rows.length} total)`}
      </span>
    </div>
  {/if}
</div>
