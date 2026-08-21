<!--
  The row at the bottom of a world or group card: open it on vrchat.com, copy its id, copy the JSON.

  Three controls with one rule between them, which is why they are one component. The link is the
  honest admission that vrc.zip does not hold everything VRChat does about a world or a group — the
  members list, the posts, the galleries — so the destination that has the rest is one click away
  rather than reimplemented badly. The id is what anyone debugging actually wants to paste
  somewhere. And the JSON is the same escape hatch the user modal's Raw tab is: the card above is a
  curated reading of the data, and when the reading and the data disagree, this is how someone
  finds out without opening devtools.

  The user modal has no footer of its own — its Raw JSON tab covers the third of these and its
  actions menu covers the first two — which is why this is shared by two callers rather than three.
-->
<script lang="ts">
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import { Button } from "$lib/components/ui/button/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { copyText } from "$lib/user-actions.ts";

let {
  id = null,
  href = null,
  openLabel,
  idLabel,
  jsonLabel,
  json,
}: {
  /** Null before anything is loaded; the id controls simply do not appear. */
  id?: string | null;
  href?: string | null;
  /** "Open on vrchat.com" everywhere so far, but named by the caller rather than assumed. */
  openLabel: string;
  /** What the copy toast calls the id — "World id", "Group id". */
  idLabel: string;
  jsonLabel: string;
  json: string;
} = $props();
</script>

<Separator />

<div class="flex flex-wrap items-center gap-2">
  {#if id !== null && id !== ""}
    {#if href !== null}
      <Button variant="outline" size="sm" {href} target="_blank" rel="noreferrer noopener">
        <ExternalLinkIcon />
        {openLabel}
      </Button>
    {/if}
    <Button
      variant="ghost"
      size="sm"
      class="text-muted-foreground"
      onclick={() => void copyText(idLabel, id ?? "")}
    >
      Copy id
    </Button>
  {/if}
  <Button
    variant="ghost"
    size="sm"
    class="ml-auto text-muted-foreground"
    onclick={() => void copyText(jsonLabel, json)}
  >
    Copy JSON
  </Button>
</div>
