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
  reason that distinction exists is that those are the ones worth a second look. They live behind
  each row's chevron now rather than on the page, which is the one thing that changed: six apps'
  worth of scope chips, webhook tables and budget forms all unfolded at once is a page where the
  Revoke button is the smallest thing in view.

  **The app's identity is still a claim.** Name, version and contact come off a `User-Agent` any
  local process can send. Nothing here dresses them up as verified, for the same reason the consent
  sheet does not.

  What is left in this file is the list, the page-level actions, and the calls that mutate a grant.
  A grant renders as a `ConnectedAppRow`; the audit rows it shows are fetched by the row itself, on
  the open gesture, because that is one request per grant and nobody opens six.
-->
<script lang="ts">
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import TrashIcon from "@lucide/svelte/icons/trash-2";
import {
  api,
  type ConnectedApp,
  describeError,
  type WebhookSummary,
} from "$lib/api.ts";
import ConnectedAppRow from "$lib/components/ConnectedAppRow.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
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

// The relative timestamps in the rows below have to move on their own. The shared clock only runs
// its interval while something has claimed it, so a screen that reads `clock.now` without
// subscribing renders the time it mounted at and then sits there — no error, just a frozen
// "3 minutes ago".
$effect(() => clock.subscribe());

$effect(() => {
  void load();
});

async function load(): Promise<void> {
  loading = true;
  try {
    apps = await api.apps.list();
    // Seed each row's history; the live socket extends them from here.
    for (const entry of apps) rates.seedGrant(entry.id, entry.rate);
    loadError = null;
    // Not awaited into the same failure path: a webhook list that cannot load must not turn a page
    // of perfectly good grants into an error state. See `loadWebhooks`.
    void loadWebhooks();
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

/*
 * Hourly allowances.
 *
 * Three scopes carry one — invites, friend requests, group invites — because those are the calls
 * other people see, and an app that mass-sends them gets *the user* reported rather than itself.
 * The rate sparkline answers "is this app noisy"; this answers "how much of my reputation can it
 * spend in an hour", which is a different question and the one a per-app number belongs to.
 *
 * Saved on blur rather than per keystroke: typing "5" on the way to "50" would otherwise commit a
 * number the user never meant, against a window that is already counting.
 */
let savingBudget = $state<string | null>(null);

// A space, because neither a grant id nor a scope string can contain one. The separator only has
// to be a character that cannot appear in either half; it never reaches a screen.
function budgetKey(grantId: string, scope: string): string {
  return `${grantId} ${scope}`;
}

async function saveBudget(app: ConnectedApp, scope: string, raw: string): Promise<void> {
  const key = budgetKey(app.id, scope);
  const trimmed = raw.trim();
  // An emptied field means "go back to the default", which is not the same as zero. Zero is a
  // setting someone chose: never.
  const limit = trimmed === "" ? null : Number.parseInt(trimmed, 10);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) return;

  const current = app.budgets.find((budget) => budget.scope === scope);
  if (current !== undefined && (limit === null ? !current.overridden : current.limit === limit)) {
    return;
  }

  savingBudget = key;
  actionError = null;
  try {
    const updated = await api.apps.setBudget(app.id, scope, limit);
    apps = apps.map((entry) => (entry.id === updated.id ? updated : entry));
  } catch (cause) {
    actionError = describeError(cause);
  } finally {
    savingBudget = null;
  }
}

/*
 * Webhooks, listed under the app that registered them.
 *
 * This is the quietest thing an app can do and the one most worth showing: a grant with a webhook
 * is forwarding this user's presence to an address they never typed, at an address that keeps
 * working while nothing is on screen. Revoking the app stops the events; deleting the webhook stops
 * this one feed without touching anything else the app does, which is why both buttons exist.
 *
 * Fetched once with the page rather than per row. There are rarely more than a handful, and one
 * request that returns them all is cheaper than one request per app that mostly returns nothing.
 */
let webhooks = $state<WebhookSummary[]>([]);
let deletingWebhook = $state<string | null>(null);

function webhooksFor(grantId: string): WebhookSummary[] {
  return webhooks.filter((hook) => hook.grantId === grantId);
}

async function loadWebhooks(): Promise<void> {
  try {
    webhooks = await api.webhooks.list();
  } catch {
    // Deliberately silent. The grants are the page; a webhook list that failed to load should not
    // put an error banner over apps that loaded fine. An empty section is the honest fallback, and
    // the next refresh retries.
    webhooks = [];
  }
}

async function removeWebhook(hook: WebhookSummary): Promise<void> {
  if (deletingWebhook !== null) return;
  deletingWebhook = hook.id;
  actionError = null;
  try {
    await api.webhooks.remove(hook.id);
    webhooks = webhooks.filter((entry) => entry.id !== hook.id);
  } catch (cause) {
    actionError = describeError(cause);
  } finally {
    deletingWebhook = null;
  }
}
</script>

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

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if actionError !== null}
    <div class="px-4 pt-4"><ErrorNote message={actionError} /></div>
  {/if}

  {#if loading && apps.length === 0}
    <div class="space-y-2 p-4" aria-busy="true">
      {#each [0, 1, 2] as index (index)}
        <Skeleton class="h-16 w-full" />
      {/each}
    </div>
  {:else if loadError !== null}
    <EmptyState icon={KeyRoundIcon} title="Could not load connected apps" description={loadError}>
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
    <ul class="divide-y divide-border">
      {#each apps as entry (entry.id)}
        <ConnectedAppRow
          grant={entry}
          webhooks={webhooksFor(entry.id)}
          busy={busy !== null}
          revoking={busy === entry.id}
          {savingBudget}
          {deletingWebhook}
          onRevoke={() => {
            void revoke(entry);
          }}
          onSaveBudget={(scope, raw) => {
            void saveBudget(entry, scope, raw);
          }}
          onResetBudget={(scope) => {
            void saveBudget(entry, scope, "");
          }}
          onRemoveWebhook={(hook) => {
            void removeWebhook(hook);
          }}
        />
      {/each}
    </ul>
  {/if}
</div>
