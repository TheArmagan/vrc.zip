<!--
  A search box with its magnifier, for the lists inside a modal that get long enough to need one.

  `type="search"`, so a browser draws its own clear affordance and the Escape key does what the
  platform says it does. The icon is `pointer-events-none` because it sits *over* the input rather
  than beside it — a click on the glass should land in the field, not on nothing.

  Callers bind `value` and are responsible for the filtering, including for saying out loud when a
  filter can only see part of a paged list. This component knows nothing about what is being
  searched.
-->
<script lang="ts">
import SearchIcon from "@lucide/svelte/icons/search";
import { Input } from "$lib/components/ui/input/index.js";

let {
  value = $bindable(""),
  placeholder,
  label,
}: {
  value?: string;
  placeholder: string;
  /** The accessible name. The placeholder is not one — it disappears the moment anyone types. */
  label: string;
} = $props();
</script>

<div class="relative">
  <SearchIcon
    class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
  />
  <Input
    type="search"
    bind:value
    {placeholder}
    aria-label={label}
    class="pl-8"
  />
</div>
