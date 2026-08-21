<!--
  A VRChat group, everywhere one is named — the counterpart of `UserName` and `WorldLink`.

  It **degrades** the same way they do: anything that is not a `grp_…` renders as plain text with no
  underline, no button and no dead click. A row's subject id is whatever its payload carried — a
  user for `friend.*`, a world for `gamelog.world_enter`, a group for `group.*` — so anything
  offering to open a group has to check rather than assume.

  A real `<button>` when it is interactive, because a `<span onclick>` is invisible to the keyboard
  and announced as text.

  Unlike `WorldLink` there is no resolver behind this: nothing batches group names, so a row that
  has only an id shows the id. That is deliberate rather than pending — group ids appear on a
  handful of event kinds, and a per-row lookup to prettify them would spend the account's rate
  budget on cosmetics. The card the click opens has the name.
-->
<script lang="ts">
import { isGroupId } from "$lib/format.ts";
import { groupModal } from "$lib/state/group-modal.svelte.ts";
import { cn } from "$lib/utils.js";

let {
  groupId = null,
  name,
  accountId = null,
  class: className,
}: {
  groupId?: string | null;
  /** What to print — a name if the caller has one, otherwise the id. */
  name: string;
  /** The account this was seen through; it decides visibility and `membershipStatus`. */
  accountId?: string | null;
  class?: string;
} = $props();

const openable = $derived(isGroupId(groupId));

const INTERACTIVE =
  "cursor-pointer rounded-xs underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";
</script>

{#if openable && groupId !== null}
  <button
    type="button"
    class={cn(INTERACTIVE, className)}
    title={`Open ${name} in vrc.zip`}
    onclick={(event) => {
      // These sit inside rows that are themselves clickable in places, and opening the group is the
      // whole intent of the click.
      event.stopPropagation();
      groupModal.openGroup(groupId, { accountId });
    }}
  >
    {name}
  </button>
{:else}
  <span class={className}>{name}</span>
{/if}
