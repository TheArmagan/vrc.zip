<!--
  "Which account's data am I looking at?", shared by the four screens that ask it.

  It renders nothing at all with one account, because a filter with a single option is furniture
  rather than a control, and the screens that use it read the same either way.

  The `all` sentinel exists because bits-ui treats the empty string as *no* selection, so an item
  with `value=""` can never show as chosen. The screens keep their own contract — empty string
  means every account — and the translation happens here rather than in four call sites.
-->
<script lang="ts">
import * as Select from "$lib/components/ui/select/index.js";
import { app } from "$lib/state/app.svelte.ts";

let { value = $bindable("") }: { value?: string } = $props();

const ALL = "all";

const label = $derived(
  value === "" ? "All accounts" : (app.accountById(value)?.displayName ?? "All accounts"),
);
</script>

{#if app.accounts.length > 1}
  <Select.Root
    type="single"
    value={value === "" ? ALL : value}
    onValueChange={(next) => {
      value = next === ALL ? "" : next;
    }}
  >
    <Select.Trigger size="sm" class="w-44" aria-label="Filter by account">{label}</Select.Trigger>
    <Select.Content>
      <Select.Item value={ALL} label="All accounts" />
      {#each app.accounts as account (account.id)}
        <Select.Item value={account.id} label={account.displayName} />
      {/each}
    </Select.Content>
  </Select.Root>
{/if}
