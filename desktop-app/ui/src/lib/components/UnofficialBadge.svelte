<!--
  Persistent, non-dismissible. This is a hard requirement, not a decoration.

  `vrc.zip` reads as a semi-official domain and the app holds real VRChat credentials, so a user
  who lands on it must never have to work out whether VRChat built it. There is deliberately no
  close button, no auto-hide, and no setting that removes it — anything that can be turned off
  eventually is, and then the disclosure is not a disclosure.
-->
<script lang="ts">
import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/svelte";
</script>

<div
  class="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5
         text-[11px] leading-tight"
>
  <span
    class="shrink-0 bg-warning px-1.5 py-0.5 text-[10px] font-bold tracking-wider
           text-warning-foreground uppercase"
  >
    Unofficial
  </span>
  <span class="min-w-0 truncate text-muted-foreground">
    Not affiliated with, endorsed by, or operated by VRChat Inc. You are signing in with your own
    VRChat credentials.
  </span>
  <a
    href="https://hello.vrchat.com/legal"
    target="_blank"
    rel="noreferrer noopener"
    class="ml-auto inline-flex shrink-0 items-center gap-1 text-muted-foreground underline
           underline-offset-2 hover:text-foreground"
  >
    VRChat ToS
    <HugeiconsIcon icon={LinkSquare02Icon} size={11} />
  </a>
</div>
