<!--
  Connected apps — standing access, and the way out of it. `PLAN.md` §Phase 2 "Enforcement".

  The counterpart to the consent sheet. That screen is about one moment ("should this app get in");
  this one is about what is still in afterwards, which is the half a user needs weeks later when
  they no longer remember what they approved.

  Three things shape it:

  **Revoking is the point, so it is one click and it is never hidden.** `PLAN.md` names the kill
  switch as a requirement rather than a nicety: scopes do not stop an app misbehaving, they only
  bound how far it gets. A user who suspects something needs a way out that is faster than reading.

  **The scopes are shown, not summarised.** "3 permissions" tells nobody anything. The dangerous
  ones are called out in their own row, the same way the consent sheet does, because the whole
  reason that distinction exists is that those are the ones worth a second look.

  **The app's identity is still a claim.** Name, version and contact come off a `User-Agent` any
  local process can send. Nothing here dresses them up as verified, for the same reason the consent
  sheet does not.
-->
<script lang="ts">
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import RadioIcon from "@lucide/svelte/icons/radio";
import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
import TrashIcon from "@lucide/svelte/icons/trash-2";
import EmptyState from "$lib/components/EmptyState.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { api, type ConnectedApp } from "$lib/api.ts";
import Sparkline from "$lib/components/Sparkline.svelte";
import { fullTimestamp, timeAgo } from "$lib/format.ts";
import { clock } from "$lib/state/clock.svelte.ts";
import { rates } from "$lib/state/rates.svelte.ts";

let apps = $state<ConnectedApp[]>([]);
let loading = $state(true);
let loadError = $state<string | null>(null);
let actionError = $state<string | null>(null);
/** The grant a request is in flight for, so only its own button spins. */
let busy = $state<string | null>(null);
/**
 * Revoke-all is armed by a first click and fired by a second.
 *
 * A `confirm()` would block the whole page and reads as a browser artefact; a dialog is a lot of
 * machinery for one irreversible button. Arming in place says the same thing in the place the user
 * is already looking, and clicking anything else disarms it.
 */
let armed = $state(false);

// The relative timestamps below have to move on their own. The shared clock only runs its interval
// while something has claimed it, so a screen that reads `clock.now` without subscribing renders
// the time it mounted at and then sits there — no error, just a frozen "3 minutes ago".
$effect(() => clock.subscribe());

$effect(() => {
  void load();
});

async function load(): Promise<void> {
  loading = true;
  try {
    apps = await api.apps.list();
    // Seed each card's history; the live socket extends them from here.
    for (const entry of apps) rates.seedGrant(entry.id, entry.rate);
    loadError = null;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  } finally {
    loading = false;
  }
}

async function revoke(app: ConnectedApp): Promise<void> {
  busy = app.id;
  actionError = null;
  try {
    await api.apps.revoke(app.id);
    // Removed locally rather than by refetching: the answer is not in doubt, and a list that
    // flickers through a loading state on every revoke makes revoking several feel unreliable.
    apps = apps.filter((entry) => entry.id !== app.id);
    // Its history must not outlive it: a revoked grant's id could be reused by nothing, but a
    // series nobody reads is one the live frame keeps advancing forever.
    rates.forgetGrant(app.id);
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
  } finally {
    busy = null;
  }
}

async function revokeAll(): Promise<void> {
  if (!armed) {
    armed = true;
    return;
  }
  armed = false;
  busy = "*";
  actionError = null;
  try {
    await api.apps.revokeAll();
    for (const entry of apps) rates.forgetGrant(entry.id);
    apps = [];
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
  } finally {
    busy = null;
  }
}

/** The last complete second. The live socket appends to the end of the array. */
function latest(history: readonly number[]): number {
  return history[history.length - 1] ?? 0;
}

/**
 * Requests across the whole window.
 *
 * Summed from the live history rather than read off `entry.rate.total`, which was true when the
 * page loaded and is a minute stale by the time anyone looks at it.
 */
function windowTotal(history: readonly number[]): number {
  let sum = 0;
  for (const value of history) sum += value;
  return sum;
}

/** Scopes worth a second look, listed separately exactly as the consent sheet lists them. */
function dangerous(app: ConnectedApp): readonly { scope: string; description: string }[] {
  return app.scopes.filter((scope) => scope.dangerous);
}

function ordinary(app: ConnectedApp): readonly { scope: string; description: string }[] {
  return app.scopes.filter((scope) => !scope.dangerous);
}
</script>

<div class="flex h-full flex-col">
  <SectionHeader
    title="Connected apps"
    count={apps.length}
    description="Apps you have allowed to use your VRChat accounts through vrc.zip. Revoking one cuts it off immediately, including any live event stream it holds."
  >
    {#snippet actions()}
      {#if apps.length > 0}
        <Button
          variant={armed ? "destructive" : "outline"}
          size="sm"
          disabled={busy !== null}
          onclick={revokeAll}
        >
          <TrashIcon class="size-4" />
          {armed ? "Really revoke all?" : "Revoke all"}
        </Button>
      {/if}
    {/snippet}
  </SectionHeader>

  {#if actionError !== null}
    <p class="mx-4 mb-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {actionError}
    </p>
  {/if}

  <div class="flex-1 overflow-y-auto px-4 pb-4">
    {#if loading && apps.length === 0}
      <p class="py-8 text-center text-sm text-muted-foreground">Loading…</p>
    {:else if loadError !== null}
      <EmptyState
        icon={KeyRoundIcon}
        title="Could not load connected apps"
        description={loadError}
      >
        {#snippet action()}
          <Button variant="outline" size="sm" onclick={load}>Try again</Button>
        {/snippet}
      </EmptyState>
    {:else if apps.length === 0}
      <EmptyState
        icon={KeyRoundIcon}
        title="No apps are connected"
        description="An app connects by logging in through the vrc.zip proxy. You approve it by typing a six-digit code, and it shows up here afterwards."
      />
    {:else}
      <ul class="flex flex-col gap-3">
        {#each apps as entry (entry.id)}
          {@const danger = dangerous(entry)}
          {@const plain = ordinary(entry)}
          <!-- `{@const}` is only legal as an immediate child of a block, hence up here. -->
          {@const history = rates.grant(entry.id)}
          <li class="rounded-lg border border-border bg-card p-4">
            <header class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="truncate text-base font-medium text-foreground">{entry.app.name}</p>
                  {#if entry.app.version !== ""}
                    <Badge variant="outline">v{entry.app.version}</Badge>
                  {/if}
                  {#if entry.liveSockets > 0}
                    <!-- Worth surfacing: an app with an open socket is receiving events right now. -->
                    <Badge variant="secondary" class="gap-1">
                      <RadioIcon class="size-3" />
                      Live
                    </Badge>
                  {/if}
                </div>
                <p class="mt-0.5 text-sm text-muted-foreground">
                  Acting as <span class="text-foreground">{entry.accountName}</span>
                  {#if entry.app.contact !== ""}
                    · says it can be reached at {entry.app.contact}
                  {/if}
                </p>
              </div>

              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onclick={() => revoke(entry)}
              >
                {busy === entry.id ? "Revoking…" : "Revoke"}
              </Button>
            </header>

            <Separator class="my-3" />

            <div class="flex flex-col gap-2 text-sm">
              {#if danger.length > 0}
                <div class="flex items-start gap-2 text-destructive">
                  <ShieldAlertIcon class="mt-0.5 size-4 shrink-0" />
                  <div class="flex flex-wrap gap-1.5">
                    {#each danger as scope (scope.scope)}
                      <Badge variant="destructive" title={scope.description}>{scope.scope}</Badge>
                    {/each}
                  </div>
                </div>
              {/if}

              {#if plain.length > 0}
                <div class="flex flex-wrap gap-1.5">
                  {#each plain as scope (scope.scope)}
                    <Badge variant="secondary" title={scope.description}>{scope.scope}</Badge>
                  {/each}
                </div>
              {:else if danger.length === 0}
                <p class="text-muted-foreground">No permissions recorded for this app.</p>
              {/if}

              <!--
                What this app is costing, which is the fact that makes the Revoke button beside it
                an informed decision rather than a guess. PLAN.md §Phase 3: an app polling too hard
                gets *the user* rate-limited, and the user blames vrc.zip.
              -->
              <div class="flex items-center gap-3">
                <Sparkline
                  values={history}
                  height={18}
                  class="w-24"
                  label="{entry.app.name} requests per second over the last ten minutes"
                />
                <span class="tabular text-xs text-muted-foreground">
                  {latest(history)}/s now · {windowTotal(history)} in the last 10 min
                </span>
              </div>

              <p class="text-xs text-muted-foreground">
                Connected <span title={fullTimestamp(entry.createdAt)}
                  >{timeAgo(entry.createdAt, clock.now)}</span
                >
                ·
                {#if entry.lastUsedAt === null}
                  never used
                {:else}
                  last used <span title={fullTimestamp(entry.lastUsedAt)}
                    >{timeAgo(entry.lastUsedAt, clock.now)}</span
                  >
                {/if}
              </p>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
