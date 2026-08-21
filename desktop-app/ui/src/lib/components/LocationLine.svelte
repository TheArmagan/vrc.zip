<!--
  One VRChat location, rendered honestly.

  A location string is the app's densest piece of data: it can be a world plus an instance plus an
  access level plus a region, or it can be one of five words meaning "nowhere you can follow". The
  two cases look nothing alike, so they render differently rather than forcing "Private world" into
  a layout designed for `wrld_… #42 · Friends · us`.
-->
<script lang="ts">
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import { Badge } from "$lib/components/ui/badge/index.js";
import { accessLabel, parseLocation, planJoin, shortId } from "$lib/format.ts";
import { requestJoin } from "$lib/join.ts";
import { app } from "$lib/state/app.svelte.ts";

let {
  location,
  worldName = null,
  showJump = true,
  accountId = null,
}: {
  location: string | null;
  worldName?: string | null;
  showJump?: boolean;
  /**
   * The account this location was seen through — a session's own account, or the friend list's
   * account filter. It decides which running client gets moved when several are up; see
   * `planJoin`.
   */
  accountId?: string | null;
} = $props();

const parsed = $derived(parseLocation(location));

/*
 * Not a link any more, except in the one case where a link is correct.
 *
 * With a client already running, `vrchat://launch` starts a second one instead of moving the
 * first, so the affordance becomes a self-invite and says so on its face — the user should know
 * before they click that this puts a notification in the game rather than opening a window.
 */
const plan = $derived(showJump ? planJoin(location, app.sessions, accountId) : null);

const JUMP_CLASS =
  "inline-flex items-center text-muted-foreground underline underline-offset-4 hover:text-foreground";
const INVITE_TITLE =
  "VRChat is already running — this sends you an invite to accept in the game, instead of opening a second client";

function onJoin(): void {
  void requestJoin(location, accountId);
}
</script>

<div class="flex min-w-0 flex-wrap items-center gap-2 text-xs">
  {#if parsed.opaque}
    <span class="text-muted-foreground">{parsed.label}</span>
  {:else}
    <span class="truncate text-sm font-medium text-foreground" title={location ?? undefined}>
      {worldName ?? shortId(parsed.worldId, 14)}
    </span>
    {#if parsed.instanceId}
      <span class="tabular text-muted-foreground">{parsed.label}</span>
    {/if}
    <Badge variant="outline" class="tracking-wide uppercase">{accessLabel(parsed.access)}</Badge>
    {#if parsed.region}
      <span class="tracking-wide text-muted-foreground uppercase">{parsed.region}</span>
    {/if}
    {#if plan?.kind === "launch"}
      <a
        href={plan.href}
        class={JUMP_CLASS}
        title="No client is running, so this launches VRChat into the instance"
      >
        Jump
        <ChevronRightIcon class="size-3.5" />
      </a>
    {:else if plan?.kind === "invite"}
      <button type="button" class={JUMP_CLASS} title={INVITE_TITLE} onclick={onJoin}>
        Invite me
        <ChevronRightIcon class="size-3.5" />
      </button>
    {:else if plan?.kind === "blocked"}
      <button type="button" class={JUMP_CLASS} title={plan.reason} onclick={onJoin}>
        Jump
        <ChevronRightIcon class="size-3.5" />
      </button>
    {/if}
  {/if}
</div>
