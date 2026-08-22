<!--
  The consent sheet. `PLAN.md` §Phase 2 "Pending consent".

  Three things have to be true of this screen and they shape everything below.

  **The code is the primary object.** The user is here to read six digits and type them into another
  app; that gesture is the consent. So the code is the largest thing on a row, and there is no
  "Allow" button anywhere — a button here that granted access would defeat the code, whose entire
  job is to prove the person at this screen is the person operating that app. Deny exists, because
  refusing needs no proof of anything.

  **The app's identity is a claim, not a fact.** Name, version and contact come off a User-Agent any
  local process can send. They are shown as what the app *says* about itself, and the screen never
  dresses them up as verified.

  **An escalation leads with the delta.** Re-listing scopes the user already approved buries the new
  ask in a wall of familiar text, which is how people end up approving things they did not read.

  The screen itself is now only the list and its states; a request renders as a `ConsentRow`, in the
  same row shape as the rest of the app. See that file for what stays above the fold and why.
-->
<script lang="ts">
import PlugZapIcon from "@lucide/svelte/icons/plug-zap";
import ConsentRow from "$lib/components/ConsentRow.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import type { PendingConsent } from "$lib/api.ts";
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

/** Nothing has arrived *yet* is not the same claim as nothing is waiting. See the skeleton below. */
const firstLoad = $derived(consent.loading && consent.pending.length === 0);

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

<div class="min-h-0 flex-1 overflow-y-auto">
  <!--
    Two failures, kept apart on purpose. `consent.error` means the list could not be read at all, so
    what is on screen may be incomplete; `actionError` means one deny or one account pick failed and
    everything shown is still true.
  -->
  {#if consent.error !== null}
    <div class="p-4"><ErrorNote message={consent.error} /></div>
  {/if}

  {#if actionError !== null}
    <div class="px-4 pt-4"><ErrorNote message={actionError} /></div>
  {/if}

  {#if firstLoad}
    <div class="space-y-2 p-4" aria-busy="true">
      {#each [0, 1] as index (index)}
        <Skeleton class="h-32 w-full" />
      {/each}
    </div>
  {:else if ordered.length === 0}
    <EmptyState
      icon={PlugZapIcon}
      title="Nothing is asking for access"
      description="When another app on this machine logs in through vrc.zip, it appears here with a code. You type that code into the app to let it in."
    />
  {:else}
    <ul class="divide-y divide-border">
      {#each ordered as request (request.id)}
        <ConsentRow
          {request}
          busy={busy === request.id}
          onPickAccount={(accountId) => {
            void pickAccount(request, accountId);
          }}
          onDeny={() => {
            void deny(request);
          }}
        />
      {/each}
    </ul>
  {/if}
</div>
