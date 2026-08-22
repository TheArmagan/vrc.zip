<!--
  One on/off setting, in the row shape the rest of the app uses: what it is on the left, the control
  on the right, and the reasoning underneath rather than in a tooltip.

  Settings had four hand-written copies of this layout and they had already drifted — two used
  `text-sm` for the explanation and two used `text-xs`, and one of the switches had no accessible
  name at all because the label beside it is a `<p>` rather than a `<label>`. That last part is the
  reason `label` is a required prop and is passed straight to `aria-label`: a switch whose only
  description is adjacent text announces as "switch, on" to a screen reader.

  The explanation is not optional either. Every setting here changes what the daemon does to
  somebody's account or to their network, and a toggle whose consequence is unstated is one people
  flip to find out.
-->
<script lang="ts">
import type { Snippet } from "svelte";
import { Switch } from "$lib/components/ui/switch/index.js";

let {
  label,
  description,
  checked,
  disabled = false,
  onChange,
  children,
}: {
  label: string;
  description: string;
  checked: boolean;
  /** True while the value is not known yet, so the switch cannot be flipped against nothing. */
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  /** Anything the setting needs below its explanation, such as a permission prompt. */
  children?: Snippet;
} = $props();
</script>

<div class="flex items-start gap-4 px-4 py-3">
  <div class="min-w-0 flex-1 space-y-1">
    <p class="text-sm">{label}</p>
    <p class="text-xs text-muted-foreground">{description}</p>
    {#if children}
      {@render children()}
    {/if}
  </div>
  <Switch {checked} {disabled} onCheckedChange={onChange} aria-label={label} />
</div>
