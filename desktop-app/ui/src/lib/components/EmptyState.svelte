<!--
  Every list in this app has one of these. An empty list with no explanation is indistinguishable
  from a broken one, so each empty state says what would be here and what puts it here.
-->
<script lang="ts">
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/svelte";
import type { Snippet } from "svelte";

let {
  icon,
  title,
  description,
  action,
}: {
  icon?: IconSvgElement;
  title: string;
  description: string;
  action?: Snippet;
} = $props();
</script>

<div class="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
  {#if icon}
    <div class="border border-border bg-muted/40 p-3 text-muted-foreground">
      <HugeiconsIcon {icon} size={20} />
    </div>
  {/if}
  <div class="space-y-1">
    <p class="text-sm font-medium text-foreground">{title}</p>
    <p class="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
  </div>
  {#if action}
    <div class="pt-1">{@render action()}</div>
  {/if}
</div>
