<!--
  Choosing event kinds, by typing rather than by scrolling.

  This replaced a plain `Select` on both the feed and the game log, for two reasons that arrived
  together. The list is *long* — it is every kind the store actually holds, and splitting
  `friend.updated` into eight named sub-kinds made it markedly longer — so a menu with no filter is
  a wall of near-identical labels that has to be read top to bottom. And an unbounded menu grew past
  the bottom of the window: `Select.Content` carried `overflow-y-auto` with no height cap, and a box
  with no height limit does not scroll, it simply gets taller. That cap is fixed in the vendored
  component so every menu benefits, but a list this long wants a search box regardless.

  `Command` gives both: it filters as you type and `CommandList` already caps its own height, so the
  list scrolls inside the popover no matter how many kinds exist.

  ## One component, two selection models

  The feed picks one kind (its family tabs already answer "several of these") and the game log picks
  several ("joins and leaves, nothing else" is a real question about a log). Rather than two
  components, this takes a `multiple` flag and always speaks in arrays — an empty array means "all",
  which is the same statement in both modes. The caller maps that onto whatever its own state looks
  like, which is where the difference belongs.

  ## What the search matches

  Both the human label and the raw dotted kind, because people arrive with either in mind: somebody
  hunting avatar changes types "avatar", and somebody who saw `friend.updated.avatar` in a row's
  expander types that. `Command` filters on each item's `value`, so both strings go in it.
-->
<script lang="ts">
import CheckIcon from "@lucide/svelte/icons/check";
import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
import * as Command from "$lib/components/ui/command/index.js";
import * as Popover from "$lib/components/ui/popover/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { eventLabel } from "$lib/format.ts";
import { cn } from "$lib/utils.js";

let {
  kinds,
  selected,
  onChange,
  multiple = false,
  allLabel,
  ariaLabel,
  class: className,
}: {
  /** The kinds on offer, with the counts the store reports. Commonest first is the caller's job. */
  kinds: readonly { readonly kind: string; readonly count: number }[];
  /** The chosen kinds. **Empty means every kind**, in both selection modes. */
  selected: readonly string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  /** What the trigger reads when nothing is chosen, e.g. "All kinds". */
  allLabel: string;
  ariaLabel: string;
  class?: string;
} = $props();

let open = $state(false);

const label = $derived.by(() => {
  if (selected.length === 0) return allLabel;
  const first = selected[0];
  if (selected.length === 1 && first !== undefined) return eventLabel(first);
  return `${String(selected.length)} kinds`;
});

function pick(kind: string): void {
  if (!multiple) {
    onChange(selected[0] === kind ? [] : [kind]);
    // A single choice is the whole interaction, so it closes. A multi-select must not: ticking a
    // second kind would mean reopening the menu and finding your place in it again.
    open = false;
    return;
  }
  onChange(
    selected.includes(kind)
      ? selected.filter((entry) => entry !== kind)
      : [...selected, kind],
  );
}
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="outline"
        size="sm"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        class={cn("justify-between font-normal", className)}
      >
        <span class="min-w-0 truncate">{label}</span>
        <ChevronsUpDownIcon class="shrink-0 opacity-50" />
      </Button>
    {/snippet}
  </Popover.Trigger>

  <Popover.Content class="w-72 p-0" align="start">
    <Command.Root>
      <Command.Input placeholder="Search kinds" aria-label="Search event kinds" />
      <Command.List>
        <Command.Empty>No kind matches that.</Command.Empty>

        <Command.Group>
          <!--
            Clearing is an item rather than a separate button so it is reachable the same way
            everything else here is: typed at, and arrowed to.
          -->
          <Command.Item value={allLabel} onSelect={() => {
            onChange([]);
            if (!multiple) open = false;
          }}>
            <CheckIcon class={selected.length === 0 ? "opacity-100" : "opacity-0"} />
            <span>{allLabel}</span>
          </Command.Item>

          {#each kinds as entry (entry.kind)}
            <!--
              `value` carries both spellings so either matches the filter. `onSelect` closes over
              the kind rather than reading the value back, which would hand us that combined string.
            -->
            <Command.Item
              value={`${eventLabel(entry.kind)} ${entry.kind}`}
              onSelect={() => pick(entry.kind)}
            >
              <CheckIcon
                class={selected.includes(entry.kind) ? "opacity-100" : "opacity-0"}
              />
              <span class="min-w-0 flex-1 truncate">{eventLabel(entry.kind)}</span>
              <span class="tabular shrink-0 text-xs text-muted-foreground">{entry.count}</span>
            </Command.Item>
          {/each}
        </Command.Group>
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
