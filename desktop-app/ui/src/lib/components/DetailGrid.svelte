<!--
  The two-column `<dt>`/`<dd>` grid every entity card lays its dates and counters out in.

  A definition list rather than a table because that is what these are — a label and its value, not
  rows of the same kind of thing — and one component rather than a repeated class string because
  the three modals had three copies of the same grid and one of them had already drifted a gap.

  Callers pass `<dt>`/`<dd>` pairs directly, and drop a pair entirely when the field is absent:
  a missing `visits` and a `visits` of zero are different claims, and rendering the first as the
  second is the mistake this layout makes easy and the callers deliberately avoid.
-->
<script lang="ts">
import type { Snippet } from "svelte";
import { cn } from "$lib/utils.js";

let { class: className, children }: { class?: string; children: Snippet } = $props();
</script>

<dl class={cn("grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs", className)}>
  {@render children()}
</dl>
