<!--
  The overflow menu — the three dots — for a user.

  Same actions as the right-click menu on any name (`userActions`), rendered with the dropdown
  family instead of the context-menu one, because a header needs a control you can *see*. A menu
  that only exists on right-click is a menu most people never learn about.
-->
<script lang="ts">
import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
import { Button } from "$lib/components/ui/button/index.js";
import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
import { type UserActionTarget, userActions } from "$lib/user-actions.ts";

let { target, class: className }: { target: UserActionTarget; class?: string } = $props();

const actions = $derived(userActions(target));
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon-sm"
        class={className}
        aria-label={`Actions for ${target.name}`}
      >
        <EllipsisIcon />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-56">
    {#each actions as action (action.id)}
      {#if action.separatorBefore}
        <DropdownMenu.Separator />
      {/if}
      <DropdownMenu.Item onSelect={action.run}>
        <action.icon />
        {action.label}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
