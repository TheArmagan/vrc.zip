<!--
  A timestamp that keeps up with itself. The exact time lives in the `title`, because "3h ago" is
  the useful reading nine times out of ten and the wall clock is the tenth.
-->
<script lang="ts">
import { fullTimestamp, timeAgo } from "$lib/format.ts";
import { clock } from "$lib/state/clock.svelte.ts";

let { ts, class: className = "" }: { ts: number; class?: string } = $props();

$effect(() => clock.subscribe());

const text = $derived(timeAgo(ts, clock.now));
</script>

<time datetime={new Date(ts).toISOString()} title={fullTimestamp(ts)} class="tabular {className}">
  {text}
</time>
