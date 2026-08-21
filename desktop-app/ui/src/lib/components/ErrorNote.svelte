<script lang="ts">
import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

let { message, class: className = "" }: { message: string; class?: string } = $props();
</script>

<div
  role="alert"
  class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10
         px-3 py-2 text-sm text-destructive {className}"
>
  <TriangleAlert size={16} class="mt-0.5 shrink-0" />
  <span>{message}</span>
</div>
