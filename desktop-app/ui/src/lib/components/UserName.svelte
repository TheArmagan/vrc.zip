<!--
  A VRChat display name, everywhere one appears.

  Three things make this a component rather than a class string.

  The first is that it **degrades**. A great many names in this app arrive with no user id attached:
  VRChat has added and removed the id on `OnPlayerJoined` more than once (PROGRESS.md §Gotchas), a
  bus event's `subjectId` is as likely to be a world or a notification id as a user, and a
  notification can name a sender it has no id for. With no id there is nothing to open, so this
  renders plain text — no underline, no button, no context menu, no dead click. It never guesses an
  id from a name.

  The second is that it is a real `<button>` when it is interactive. A `<span onclick>` is invisible
  to the keyboard and announced as text, and these are the app's most-repeated control. The context
  menu hangs off that same button through bits-ui's `child` snippet, so right-click gains a menu
  without a wrapper element appearing in the layout.

  The third is layout, which stays the caller's business. The base class carries no width, no
  display and no truncation, because these sit inside truncating flex rows: a caller that needs
  clipping passes `class="max-w-full truncate"` and gets it on the button itself, which is where
  `text-overflow` can actually apply.
-->
<script lang="ts">
import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
import { isUserId } from "$lib/format.ts";
import { userModal } from "$lib/state/user-modal.svelte.ts";
import { userActions } from "$lib/user-actions.ts";
import { cn } from "$lib/utils.js";

let {
  userId = null,
  name,
  accountId = null,
  class: className,
}: {
  /**
   * The VRChat user id. Anything that is not a `usr_…` is treated as absent — a `wrld_…` subject
   * would otherwise grow a clickable name that resolves to nothing.
   */
  userId?: string | null;
  name: string;
  /** The account this name was seen through; see `OpenUserOptions.accountId`. */
  accountId?: string | null;
  class?: string;
} = $props();

const openable = $derived(isUserId(userId));
const actions = $derived(
  openable && userId !== null ? userActions({ userId, name, accountId }) : [],
);

const INTERACTIVE =
  "cursor-pointer rounded-xs underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";
</script>

{#if openable && userId !== null}
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class={cn(INTERACTIVE, className)}
          title={`Open ${name} in vrc.zip — right-click for more`}
          onclick={(event) => {
            // Names live inside rows that are themselves clickable in places. Opening the modal is
            // the whole intent of the click, so it stops there.
            event.stopPropagation();
            userModal.openUser(userId, { name, accountId });
          }}
        >
          {name}
        </button>
      {/snippet}
    </ContextMenu.Trigger>

    <ContextMenu.Content class="w-56">
      <!--
        `Label`, not `GroupHeading`: bits-ui's heading reads its group from context and throws
        outright when there is no `Menu.Group` above it. This is a caption, not a group.
      -->
      <ContextMenu.Label class="truncate font-medium text-foreground">{name}</ContextMenu.Label>
      <ContextMenu.Separator />
      {#each actions as action (action.id)}
        {#if action.separatorBefore}
          <ContextMenu.Separator />
        {/if}
        <ContextMenu.Item onSelect={action.run}>
          <action.icon />
          {action.label}
        </ContextMenu.Item>
      {/each}
    </ContextMenu.Content>
  </ContextMenu.Root>
{:else}
  <span class={className}>{name}</span>
{/if}
