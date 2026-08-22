<!--
  The Raw JSON tab's body: a sentence, a copy button, and the JSON itself.

  Extracted at the third copy. The user modal had it, the group modal grew one, and the world modal
  was about to get a fourth — and the interesting part is not the `<pre>` but the *rule* the three
  share, which is worth stating once: what is above in the other tabs is a curated reading of the
  data, and this is how somebody finds out when the reading and the data disagree without opening
  devtools. Nothing here is interpreted, so nothing here can be wrong in the way a rendered row can.

  The JSON is printed rather than hidden behind a disclosure. A collapsed panel makes the escape
  hatch cost a click to discover, and a reader who has deliberately opened a tab named "Raw JSON"
  has already said what they want.

  `overflow-x-auto` on the `<pre>` is load-bearing: JSON has long unbreakable strings in it (image
  URLs especially), and without it they push the dialog wider than the viewport instead of scrolling
  inside their own box.
-->
<script lang="ts">
import { Button } from "$lib/components/ui/button/index.js";
import { copyText } from "$lib/user-actions.ts";

let {
  json,
  copyLabel,
  description = "Exactly what the daemon sent, plus what vrc.zip added. Nothing here is interpreted.",
}: {
  json: string;
  /** What the copy toast calls it: "World details", "Group details". */
  copyLabel: string;
  description?: string;
} = $props();
</script>

<div class="space-y-2">
  <div class="flex items-center gap-2">
    <p class="text-xs text-muted-foreground">{description}</p>
    <Button
      variant="outline"
      size="xs"
      class="ml-auto shrink-0"
      onclick={() => void copyText(copyLabel, json)}
    >
      Copy
    </Button>
  </div>
  <pre
    class="max-w-full overflow-x-auto border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{json}</pre>
</div>
