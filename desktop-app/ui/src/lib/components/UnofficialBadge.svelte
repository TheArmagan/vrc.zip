<!--
  Persistent, non-dismissible. This is a hard requirement, not a decoration.

  `vrc.zip` reads as a semi-official domain and the app holds real VRChat credentials, so a user
  who lands on it must never have to work out whether VRChat built it. There is deliberately no
  close button, no auto-hide, and no setting that removes it — anything that can be turned off
  eventually is, and then the disclosure is not a disclosure.
-->
<script lang="ts">
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import { Badge } from "$lib/components/ui/badge/index.js";
</script>

<div
  class="flex shrink-0 items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs"
>
  <Badge class="bg-warning font-bold tracking-wider text-warning-foreground uppercase">
    Unofficial
  </Badge>
  <span class="min-w-0 truncate text-muted-foreground">
    Not affiliated with, endorsed by, or operated by VRChat Inc. You are signing in with your own
    VRChat credentials.
  </span>
  <a
    href="https://hello.vrchat.com/legal"
    target="_blank"
    rel="noreferrer noopener"
    class="ml-auto inline-flex shrink-0 items-center gap-1.5 text-muted-foreground underline underline-offset-4 hover:text-foreground"
  >
    VRChat ToS
    <ExternalLinkIcon class="size-3.5" />
  </a>
</div>
