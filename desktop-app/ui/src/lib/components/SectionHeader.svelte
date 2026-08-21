<!--
  The bar at the top of every screen.

  Not sticky, and that is a change from how it started: the shell now puts the header outside the
  scroll container rather than inside it, so `position: sticky` had nothing to stick to and only
  cost a stacking context that the feed's day headings then had to fight.

  The count and the description are separate props for a reason. A number on its own is ambiguous
  on this app's screens in particular, where "6" could mean accounts or clients, so the count sits
  next to a sentence that says what was counted.
-->
<script lang="ts">
import type { Snippet } from "svelte";
import { Badge } from "$lib/components/ui/badge/index.js";

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
  class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-background px-4 py-3"
>
  <h1 class="text-base font-semibold tracking-tight">{title}</h1>

  {#if count !== undefined}
    <Badge variant="secondary" class="tabular">{count}</Badge>
  {/if}

  {#if description}
    <p class="min-w-0 truncate text-sm text-muted-foreground">{description}</p>
  {/if}

  {#if actions}
    <div class="ml-auto flex items-center gap-2">{@render actions()}</div>
  {/if}
</header>
