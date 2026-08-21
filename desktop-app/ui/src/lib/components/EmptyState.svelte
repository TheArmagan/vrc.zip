<!--
  Every list in this app has one of these. An empty list with no explanation is indistinguishable
  from a broken one, so each empty state says what would be here and what puts it here.
-->
<script lang="ts">
import type { LucideIcon } from "@lucide/svelte";
import type { Snippet } from "svelte";

let {
  icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: Snippet;
} = $props();

const Icon = $derived(icon);
</script>

<div class="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
  {#if Icon}
    <div class="flex size-12 items-center justify-center border border-border bg-muted/40">
      <Icon class="size-5 text-muted-foreground" />
    </div>
  {/if}
  <div class="space-y-2">
    <p class="text-base font-medium text-foreground">{title}</p>
    <p class="mx-auto max-w-md text-sm text-muted-foreground">{description}</p>
  </div>
  {#if action}
    {@render action()}
  {/if}
</div>
