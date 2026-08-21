<!-- The inline failure note. Everything that is not "the daemon is gone" surfaces through this. -->
<script lang="ts">
import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
import * as Alert from "$lib/components/ui/alert/index.js";

let { message, class: className = "" }: { message: string; class?: string } = $props();
</script>

<Alert.Root variant="destructive" class="border-destructive/40 bg-destructive/5 {className}">
  <TriangleAlertIcon />
  <Alert.Description class="text-destructive">{message}</Alert.Description>
</Alert.Root>
