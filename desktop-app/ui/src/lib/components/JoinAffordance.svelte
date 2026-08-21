<!--
  The "go there" control for one location, in whichever form is actually correct.

  Lifted out of `LocationLine` unchanged when the world and instance links were added, so that the
  world modal can offer the same affordance without a second copy of the decision. The decision
  itself is `planJoin` in `format.ts` and the reasoning is written down there; the short version is
  that `vrchat://launch` is only ever right when **no client is running**, because firing it at a
  machine that already has VRChat open starts a second client rather than moving the first.

  Nothing here decides anything on its own — it renders one of `planJoin`'s four answers, and the
  fourth (`blocked`) deliberately still looks like a control so that clicking it produces the
  explanation rather than nothing at all.
-->
<script lang="ts">
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import { planJoin } from "$lib/format.ts";
import { requestJoin } from "$lib/join.ts";
import { app } from "$lib/state/app.svelte.ts";
import { cn } from "$lib/utils.js";

let {
  location,
  accountId = null,
  enabled = true,
  class: className,
}: {
  location: string | null;
  /**
   * The account this location was seen through — a session's own account, or the friend list's
   * account filter. It decides which running client gets moved when several are up; see
   * `planJoin`.
   */
  accountId?: string | null;
  /** False where a row should show no join control at all, such as a historical feed line. */
  enabled?: boolean;
  class?: string;
} = $props();

const plan = $derived(enabled ? planJoin(location, app.sessions, accountId) : null);

const JUMP_CLASS =
  "inline-flex items-center text-muted-foreground underline underline-offset-4 hover:text-foreground";
const INVITE_TITLE =
  "VRChat is already running — this sends you an invite to accept in the game, instead of opening a second client";

function onJoin(): void {
  void requestJoin(location, accountId);
}
</script>

{#if plan?.kind === "launch"}
  <a
    href={plan.href}
    class={cn(JUMP_CLASS, className)}
    title="No client is running, so this launches VRChat into the instance"
  >
    Jump
    <ChevronRightIcon class="size-3.5" />
  </a>
{:else if plan?.kind === "invite"}
  <button type="button" class={cn(JUMP_CLASS, className)} title={INVITE_TITLE} onclick={onJoin}>
    Invite me
    <ChevronRightIcon class="size-3.5" />
  </button>
{:else if plan?.kind === "blocked"}
  <button type="button" class={cn(JUMP_CLASS, className)} title={plan.reason} onclick={onJoin}>
    Jump
    <ChevronRightIcon class="size-3.5" />
  </button>
{/if}
