<script lang="ts">
import type { Snippet } from "svelte";

let {
  title,
  count,
  description,
  actions,
}: {
  title: string;
  count?: number;
  description?: string;
  actions?: Snippet;
} = $props();
</script>

<header
  class="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border
         bg-background/85 px-5 py-3 backdrop-blur"
>
  <h1 class="text-sm font-semibold tracking-tight">{title}</h1>
  {#if count !== undefined}
    <span class="tabular rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {count}
    </span>
  {/if}
  {#if description}
    <p class="text-xs text-muted-foreground">{description}</p>
  {/if}
  {#if actions}
    <div class="ml-auto flex items-center gap-2">{@render actions()}</div>
  {/if}
</header>
