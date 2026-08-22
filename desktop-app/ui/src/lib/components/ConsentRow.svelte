<!--
  One app waiting at the consent sheet, in the same shape as `FriendRow`: identity, the facts worth
  a column, and an expander for everything that does not fit on a line.

  ## What stays visible, and why it is not the usual answer

  Every other row in this app collapses to one line. This one keeps two things below the line at all
  times, because hiding either would break the screen rather than tidy it.

  **The code.** The user is here to read six digits and type them into another app; that gesture is
  the consent. It is the largest thing on the row for the same reason it was the largest thing on the
  card it replaces, and there is still no "Allow" button anywhere — a button here that granted access
  would defeat the code, whose entire job is to prove the person at this screen is the person
  operating that app. Deny sits on the line, because refusing needs no proof of anything.

  **The account picker**, when the request arrived without one. The code does not work until it is
  answered, so a chevron in front of it would be a dead end with no sign saying so.

  ## What the expander is for

  The scopes. They are the part a user reads once and then scrolls past on every subsequent visit,
  and a wall of familiar text above the code is how the code stops being the first thing seen. An
  escalation still leads with the delta: already-granted lines sort last and stay dimmed, so the new
  ask is not buried in what was approved months ago.

  The app's name, version and contact are shown as claims throughout. They come off a User-Agent any
  local process can send, and nothing here dresses them up as verified.
-->
<script lang="ts">
import CheckIcon from "@lucide/svelte/icons/check";
import ChevronIcon from "@lucide/svelte/icons/chevron-down";
import ClockIcon from "@lucide/svelte/icons/clock";
import PlugZapIcon from "@lucide/svelte/icons/plug-zap";
import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
import type { PendingConsent } from "$lib/api.ts";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { fullTimestamp } from "$lib/format.ts";
import { app } from "$lib/state/app.svelte.ts";
import { clock } from "$lib/state/clock.svelte.ts";

let {
  request,
  busy = false,
  onPickAccount,
  onDeny,
}: {
  request: PendingConsent;
  /** True while this request's own call is in flight, so only its buttons go quiet. */
  busy?: boolean;
  onPickAccount: (accountId: string) => void;
  onDeny: () => void;
} = $props();

let expanded = $state(false);

/*
 * The countdown is read from the shared clock, which the screen subscribes to. A code that has run
 * out is not merely stale — typing it fails — so this number has to keep moving.
 */
const seconds = $derived(Math.max(0, Math.floor((request.expiresAt - clock.now) / 1000)));
const countdown = $derived(
  `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`,
);

/** An escalation greys what is already held; a first grant has nothing to grey. */
const shownScopes = $derived(
  request.escalation
    ? [...request.scopes].sort((a, b) => Number(b.isNew) - Number(a.isNew))
    : request.scopes,
);

const dangerousCount = $derived(request.scopes.filter((scope) => scope.dangerous).length);

/**
 * The one-line summary of what is behind the chevron.
 *
 * A count on its own would be the thing the Connected apps screen refuses to ship ("3 permissions"
 * tells nobody anything), so it never stands alone: the full list is one click away, and the count
 * of scopes worth a second look is named here rather than left for someone to discover.
 */
const scopeSummary = $derived.by(() => {
  const total = request.scopes.length;
  const asked = `${String(total)} ${total === 1 ? "permission" : "permissions"}`;
  if (dangerousCount === 0) return asked;
  return `${asked}, ${String(dangerousCount)} worth a second look`;
});
</script>

<li class="px-4 py-3">
  <div class="flex items-center gap-3">
    <!-- Decorative: the app's name is the very next column, so announcing the tile repeats it. -->
    <div
      class="flex size-9 shrink-0 items-center justify-center border border-border bg-muted/40"
      aria-hidden="true"
    >
      <PlugZapIcon class="size-4 text-muted-foreground" />
    </div>

    <div class="min-w-0 flex-1">
      <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span class="min-w-0 truncate">{request.app.name}</span>
        {#if request.app.version !== ""}
          <Badge variant="outline" class="h-5 px-1.5 text-[10px]">v{request.app.version}</Badge>
        {/if}
        {#if request.escalation}
          <Badge variant="secondary" class="h-5 px-1.5 text-[10px]">Wants more access</Badge>
        {/if}
      </p>
      <!--
        Stated as a claim on purpose. Any local process can send this User-Agent, and a screen that
        presented it as identity would be teaching the wrong thing.

        The contact is optional, because plenty of real clients do not send one and their User-Agent
        never reaches VRChat anyway. Saying so plainly beats "Says it can be reached at " trailing
        into nothing, which reads as a rendering bug.
      -->
      <p class="truncate text-xs text-muted-foreground">
        {#if request.app.contact === ""}
          Gave no contact address
        {:else}
          Says it can be reached at {request.app.contact}
        {/if}
      </p>
    </div>

    <span class="hidden min-w-0 flex-1 text-xs text-muted-foreground sm:block">
      {scopeSummary}
    </span>

    <span
      class="tabular flex w-16 shrink-0 items-center justify-end gap-1.5 text-xs text-muted-foreground"
      title={`This code stops working at ${fullTimestamp(request.expiresAt)}`}
    >
      <ClockIcon class="size-3.5" aria-hidden="true" />
      {countdown}
    </span>

    <Button variant="ghost" size="sm" disabled={busy} onclick={onDeny}>Deny</Button>

    <button
      type="button"
      class="size-5 shrink-0 cursor-pointer rounded-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-expanded={expanded}
      aria-label={expanded
        ? `Hide what ${request.app.name} is asking for`
        : `Show what ${request.app.name} is asking for`}
      onclick={() => {
        expanded = !expanded;
      }}
    >
      <ChevronIcon class="size-4 transition-transform {expanded ? 'rotate-180' : ''}" />
    </button>
  </div>

  <!-- The code, still the largest thing on the row, because it is what the user came for. -->
  <div class="mt-3 ml-12 flex flex-wrap items-center gap-4">
    <div class="space-y-1">
      <p class="text-xs text-muted-foreground">
        Type this into {request.app.name} when it asks for a two-factor code
      </p>
      <p class="font-mono text-3xl font-semibold tabular-nums tracking-[0.2em]">{request.code}</p>
    </div>
    <Button
      variant="outline"
      size="sm"
      onclick={() => {
        void navigator.clipboard?.writeText(request.code);
      }}
    >
      Copy code
    </Button>
  </div>

  {#if request.accountId !== null}
    <p class="mt-2 ml-12 text-xs text-muted-foreground">
      As <span class="text-foreground">{request.accountName ?? request.accountId}</span>
    </p>
  {:else}
    <!--
      The reserved username, or an account vrc.zip does not manage yet. Never behind the chevron:
      the code does not work until this is answered, and pairing to nothing would either fail later
      or pick an account on the user's behalf, which is the worst outcome this system has.
    -->
    <div class="mt-3 ml-12 space-y-2">
      <p class="text-sm text-foreground">
        It asked for <span class="font-mono">{request.requestedUsername || "any account"}</span>.
        Choose which one it may act as:
      </p>
      <div class="flex flex-wrap gap-2">
        {#each app.accounts as account (account.id)}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={() => {
              onPickAccount(account.id);
            }}
          >
            {account.displayName}
          </Button>
        {:else}
          <p class="text-sm text-muted-foreground">
            No accounts are signed in yet. Add one first, then come back.
          </p>
        {/each}
      </div>
    </div>
  {/if}

  {#if expanded}
    <div class="mt-3 ml-12 space-y-2 border-l-2 border-border/60 pl-3">
      <p class="text-sm font-medium text-foreground">
        {#if request.escalation}
          It is asking to add
        {:else}
          It will be able to
        {/if}
      </p>
      <ul class="space-y-1.5">
        {#each shownScopes as entry (entry.scope)}
          <li class="flex items-start gap-2 text-sm {entry.isNew ? '' : 'opacity-50'}">
            {#if entry.dangerous}
              <ShieldAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
            {:else}
              <CheckIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            {/if}
            <span class={entry.dangerous ? "text-foreground" : "text-muted-foreground"}>
              {entry.description}
              {#if !entry.isNew}
                <span class="text-xs">(already allowed)</span>
              {/if}
            </span>
          </li>
        {/each}
      </ul>

      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt class="text-muted-foreground">Asked for</dt>
        <dd class="font-mono break-all">{request.requestedUsername || "any account"}</dd>

        <dt class="text-muted-foreground">Arrived</dt>
        <dd class="tabular">{fullTimestamp(request.createdAt)}</dd>

        <dt class="text-muted-foreground">Code stops working</dt>
        <dd class="tabular">{fullTimestamp(request.expiresAt)}</dd>

        <dt class="text-muted-foreground">Id</dt>
        <dd class="font-mono break-all">{request.id}</dd>
      </dl>
    </div>
  {/if}
</li>
