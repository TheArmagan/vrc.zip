<!-- The inline failure note. Everything that is not "the daemon is gone" surfaces through this. -->
<script lang="ts">
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/svelte";

let { message, class: className = "" }: { message: string; class?: string } = $props();
</script>

<div
  role="alert"
  class="flex items-start gap-2 border border-destructive/40 bg-destructive/10
         px-3 py-2 text-sm text-destructive {className}"
>
  <HugeiconsIcon icon={Alert02Icon} size={16} class="mt-0.5 shrink-0" />
  <span class="min-w-0">{message}</span>
</div>
