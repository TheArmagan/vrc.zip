<!--
  The consent sheet. `PLAN.md` §Phase 2 "Pending consent".

  Three things have to be true of this screen and they shape everything below.

  **The code is the primary object.** The user is here to read six digits and type them into another
  app; that gesture is the consent. So the code is the largest thing on the card, and there is no
  "Allow" button anywhere — a button here that granted access would defeat the code, whose entire
  job is to prove the person at this screen is the person operating that app. Deny exists, because
  refusing needs no proof of anything.

  **The app's identity is a claim, not a fact.** Name, version and contact come off a User-Agent any
  local process can send. They are shown as what the app *says* about itself, and the screen never
  dresses them up as verified.

  **An escalation leads with the delta.** Re-listing scopes the user already approved buries the new
  ask in a wall of familiar text, which is how people end up approving things they did not read.
-->
<script lang="ts">
import CheckIcon from "@lucide/svelte/icons/check";
import ClockIcon from "@lucide/svelte/icons/clock";
import PlugZapIcon from "@lucide/svelte/icons/plug-zap";
import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
import EmptyState from "$lib/components/EmptyState.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import type { PendingConsent } from "$lib/api.ts";
import { app } from "$lib/state/app.svelte.ts";
import { clock } from "$lib/state/clock.svelte.ts";
import { consent } from "$lib/state/consent.svelte.ts";

let { pairingId = null }: { pairingId?: string | null } = $props();

let busy = $state<string | null>(null);
let actionError = $state<string | null>(null);

$effect(() => {
  void consent.refresh();
});

/*
 * A code that has run out is not merely stale — typing it fails, so the countdown has to be real.
 *
 * `clock.subscribe()` is not optional decoration: the shared clock only runs its interval while
 * something has claimed it, so a screen that reads `clock.now` without subscribing renders the
 * time it first mounted at and then sits there. Nothing errors, the number is simply frozen — which
 * on this screen means a five-minute countdown that never moves and an expired code still offered
 * as if it worked.
 */
$effect(() => clock.subscribe());

$effect(() => {
  consent.sweep(clock.now);
});

/**
 * The request the URL names, first — the daemon's browser-open lands on a specific one, and a user
 * who arrived that way should not have to find it in a list.
 */
const ordered = $derived(
  pairingId === null
    ? consent.pending
    : [
        ...consent.pending.filter((request) => request.id === pairingId),
        ...consent.pending.filter((request) => request.id !== pairingId),
      ],
);

/** Seconds left, floored at zero. */
function secondsLeft(request: PendingConsent): number {
  return Math.max(0, Math.floor((request.expiresAt - clock.now) / 1000));
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** An escalation greys what is already held; a first grant has nothing to grey. */
function shownScopes(request: PendingConsent): PendingConsent["scopes"] {
  return request.escalation
    ? [...request.scopes].sort((a, b) => Number(b.isNew) - Number(a.isNew))
    : request.scopes;
}

async function pickAccount(request: PendingConsent, accountId: string): Promise<void> {
  busy = request.id;
  actionError = null;
  try {
    await consent.setAccount(request.id, accountId);
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
  } finally {
    busy = null;
  }
}

async function deny(request: PendingConsent): Promise<void> {
  busy = request.id;
  actionError = null;
  try {
    await consent.deny(request.id);
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
  } finally {
    busy = null;
  }
}
</script>

<SectionHeader
  title="App access"
  count={consent.count}
  description={consent.count === 1 ? "app is waiting for you" : "apps are waiting for you"}
/>

<div class="flex-1 overflow-y-auto">
  {#if actionError !== null}
    <p class="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      {actionError}
    </p>
  {/if}

  {#if ordered.length === 0}
    <EmptyState
      icon={PlugZapIcon}
      title="Nothing is asking for access"
      description="When another app on this machine logs in through vrc.zip, it appears here with a code. You type that code into the app to let it in."
    />
  {:else}
    <div class="flex flex-col gap-4 p-4">
      {#each ordered as request (request.id)}
        {@const seconds = secondsLeft(request)}
        <section class="border border-border bg-card">
          <header class="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div class="min-w-0 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <p class="truncate text-base font-medium text-foreground">{request.app.name}</p>
                <Badge variant="outline">v{request.app.version}</Badge>
                {#if request.escalation}
                  <Badge variant="secondary">Wants more access</Badge>
                {/if}
              </div>
              <!--
                Stated as a claim on purpose. Any local process can send this User-Agent, and a
                screen that presented it as identity would be teaching the wrong thing.
              -->
              <p class="text-sm text-muted-foreground">
                Says it can be reached at {request.app.contact}
              </p>
            </div>
            <div class="flex items-center gap-1.5 text-sm text-muted-foreground">
              <ClockIcon class="size-4" />
              <span class="tabular-nums">{formatCountdown(seconds)}</span>
            </div>
          </header>

          <Separator />

          <!-- The code, as the largest thing on the card, because it is what the user came for. -->
          <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-5">
            <div class="space-y-1">
              <p class="text-sm text-muted-foreground">
                Type this into {request.app.name} when it asks for a two-factor code
              </p>
              <p class="font-mono text-4xl font-semibold tabular-nums tracking-[0.2em]">
                {request.code}
              </p>
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

          <Separator />

          <div class="space-y-3 px-4 py-3">
            <p class="text-sm font-medium text-foreground">
              {#if request.escalation}
                It is asking to add
              {:else}
                It will be able to
              {/if}
            </p>
            <ul class="space-y-1.5">
              {#each shownScopes(request) as entry (entry.scope)}
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
          </div>

          <Separator />

          <footer class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            {#if request.accountId !== null}
              <p class="text-sm text-muted-foreground">
                As <span class="text-foreground">{request.accountName ?? request.accountId}</span>
              </p>
            {:else}
              <!--
                The reserved username, or an account vrc.zip does not manage yet. The code does not
                work until this is answered: pairing to nothing would either fail later or pick an
                account on the user's behalf, which is the worst outcome this system has.
              -->
              <div class="space-y-2">
                <p class="text-sm text-foreground">
                  It asked for <span class="font-mono">{request.requestedUsername || "any account"}</span>.
                  Choose which one it may act as:
                </p>
                <div class="flex flex-wrap gap-2">
                  {#each app.accounts as account (account.id)}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy === request.id}
                      onclick={() => {
                        void pickAccount(request, account.id);
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

            <Button
              variant="ghost"
              size="sm"
              disabled={busy === request.id}
              onclick={() => {
                void deny(request);
              }}
            >
              Deny
            </Button>
          </footer>
        </section>
      {/each}
    </div>
  {/if}
</div>
