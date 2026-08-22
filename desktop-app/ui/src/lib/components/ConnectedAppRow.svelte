<!--
  One app holding a live grant, in the same shape as `FriendRow`: identity, the facts worth a
  column, and an expander for everything else.

  ## Why the row is mostly collapsed

  A grant carries more than any other row in this app — its scopes, three hourly allowances, the
  webhooks it registered, what it has done lately, when it connected, what it is spending — and
  putting all of that on screen at once is how this page ended up as a wall of nested boxes where
  the Revoke button was the smallest thing in view. Revoking is the point (`PLAN.md` names the kill
  switch as a requirement, not a nicety), so it stays on the line with the app's name, one click and
  never hidden. Everything a person reads *before* deciding is one click away, in one place.

  ## Why opening a row fetches

  The audit rows are one request per grant, so a page of six apps would spend six of them filling
  panels nobody opened. The expander is the gesture that authorises it, exactly as in `FriendRow`:
  the fetch runs on first open and the answer is kept, so closing and reopening costs nothing.

  ## What the collapsed line does not summarise away

  The scope *names* are never replaced by a count alone. "3 permissions" tells nobody anything, and
  the whole reason the dangerous/ordinary split exists is that some of them are worth a second look
  — so the summary names how many of those there are, and the list itself is behind the chevron.

  The app's name, version and contact are claims off a `User-Agent` any local process can send.
  Nothing here dresses them up as verified.
-->
<script lang="ts">
import ChevronIcon from "@lucide/svelte/icons/chevron-down";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import RadioIcon from "@lucide/svelte/icons/radio";
import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
import {
  api,
  type AppAuditEntry,
  type ConnectedApp,
  describeError,
  type WebhookSummary,
} from "$lib/api.ts";
import Sparkline from "$lib/components/Sparkline.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { fullTimestamp, timeAgo } from "$lib/format.ts";
import { clock } from "$lib/state/clock.svelte.ts";
import { rates } from "$lib/state/rates.svelte.ts";

let {
  grant,
  webhooks,
  busy = false,
  revoking = false,
  savingBudget = null,
  deletingWebhook = null,
  onRevoke,
  onSaveBudget,
  onResetBudget,
  onRemoveWebhook,
}: {
  grant: ConnectedApp;
  /** This grant's webhooks. Fetched once for the whole page; see the screen's `loadWebhooks`. */
  webhooks: readonly WebhookSummary[];
  /** True while *any* revoke is in flight, so a second click cannot race the first. */
  busy?: boolean;
  /** True only for the grant being revoked, so one row spins rather than all of them. */
  revoking?: boolean;
  /** The `"<grant> <scope>"` key currently being saved, or null. */
  savingBudget?: string | null;
  deletingWebhook?: string | null;
  onRevoke: () => void;
  onSaveBudget: (scope: string, raw: string) => void;
  onResetBudget: (scope: string) => void;
  onRemoveWebhook: (hook: WebhookSummary) => void;
} = $props();

let expanded = $state(false);

/**
 * This grant's audit rows, once someone has asked for them.
 *
 * Null means nobody has opened the row yet, which is different from "opened and empty": an empty
 * panel is a claim (this app has changed nothing) and must not be shown before the request that
 * earns it.
 */
let activity = $state<{ loading: boolean; error: string | null; entries: AppAuditEntry[] } | null>(
  null,
);

/** A row's worth of entries. Older ones are in the log; this panel is about what happened lately. */
const ACTIVITY_LIMIT = 20;

const danger = $derived(grant.scopes.filter((scope) => scope.dangerous));
const ordinary = $derived(grant.scopes.filter((scope) => !scope.dangerous));

const history = $derived(rates.grant(grant.id));
/** The last complete second. The live socket appends to the end of the array. */
const latest = $derived(history[history.length - 1] ?? 0);

/**
 * Requests across the whole window.
 *
 * Summed from the live history rather than read off `grant.rate.total`, which was true when the
 * page loaded and is stale by the time anyone looks at it.
 */
const windowTotal = $derived.by(() => {
  let sum = 0;
  for (const value of history) sum += value;
  return sum;
});

const scopeSummary = $derived.by(() => {
  const total = grant.scopes.length;
  if (total === 0) return "No permissions recorded";
  const held = `${String(total)} ${total === 1 ? "permission" : "permissions"}`;
  if (danger.length === 0) return held;
  return `${held}, ${String(danger.length)} worth a second look`;
});

/**
 * The store's outcome vocabulary in words a user has a chance with.
 *
 * An unrecognised outcome falls through as itself rather than as "unknown": a daemon newer than
 * this bundle records outcomes this build has never heard of, and the raw word is still evidence.
 */
function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "allowed":
      return "Allowed";
    case "denied_scope":
      return "Denied, no permission";
    case "hard_denied":
      return "Blocked by vrc.zip";
    case "denied_revoked":
      return "Denied, revoked";
    case "rate_limited":
      return "Rate limited";
    case "blocked_egress":
      return "Blocked, not VRChat";
    default:
      return outcome;
  }
}

/** "Delivered 12, 1 waiting, 3 given up" — the three states an endpoint can be in at once. */
function deliveryLine(hook: WebhookSummary): string {
  const parts = [`${hook.deliveredCount.toLocaleString()} delivered`];
  if (hook.pending > 0) parts.push(`${hook.pending.toLocaleString()} waiting`);
  if (hook.deadCount > 0) parts.push(`${hook.deadCount.toLocaleString()} given up on`);
  return parts.join(" · ");
}

async function loadActivity(): Promise<void> {
  activity = { loading: true, error: null, entries: [] };
  try {
    const entries = await api.apps.audit(grant.id, { limit: ACTIVITY_LIMIT });
    activity = { loading: false, error: null, entries };
  } catch (cause) {
    activity = { loading: false, error: describeError(cause), entries: [] };
  }
}

function toggle(): void {
  expanded = !expanded;
  // The open gesture is what authorises the request. Reopening costs nothing: the answer is kept,
  // and a page of grants that were never opened costs no audit requests at all.
  if (expanded && activity === null) void loadActivity();
}
</script>

<li class="px-4 py-3">
  <div class="flex items-center gap-3">
    <!-- Decorative: the app's name is the very next column, so announcing the tile repeats it. -->
    <div
      class="flex size-9 shrink-0 items-center justify-center border border-border bg-muted/40"
      aria-hidden="true"
    >
      <KeyRoundIcon class="size-4 text-muted-foreground" />
    </div>

    <div class="min-w-0 flex-1">
      <p class="flex flex-wrap items-center gap-2 text-sm font-medium">
        <span class="min-w-0 truncate">{grant.app.name}</span>
        {#if grant.app.version !== ""}
          <Badge variant="outline" class="h-5 px-1.5 text-[10px]">v{grant.app.version}</Badge>
        {/if}
        {#if grant.liveSockets > 0}
          <!-- Worth surfacing: an app with an open socket is receiving events right now. -->
          <Badge variant="secondary" class="h-5 gap-1 px-1.5 text-[10px]">
            <RadioIcon class="size-3" aria-hidden="true" />
            Live
          </Badge>
        {/if}
      </p>
      <p class="truncate text-xs text-muted-foreground">
        Acting as <span class="text-foreground">{grant.accountName}</span>
        ·
        {#if grant.lastUsedAt === null}
          never used
        {:else}
          last used <span title={fullTimestamp(grant.lastUsedAt)}
            >{timeAgo(grant.lastUsedAt, clock.now)}</span
          >
        {/if}
      </p>
    </div>

    <span class="hidden min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
      {#if danger.length > 0}
        <ShieldAlertIcon class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      {/if}
      <span class="min-w-0 truncate">{scopeSummary}</span>
    </span>

    <!--
      What this app is costing, which is the fact that makes the Revoke button beside it an informed
      decision rather than a guess. `PLAN.md` §Phase 3: an app polling too hard gets *the user*
      rate-limited, and the user blames vrc.zip.
    -->
    <span class="hidden w-28 shrink-0 items-center justify-end gap-2 sm:flex">
      <Sparkline
        values={history}
        height={14}
        class="w-14"
        label="{grant.app.name} requests per second over the last minute"
      />
      <span class="tabular whitespace-nowrap text-xs text-muted-foreground">{latest}/s</span>
    </span>

    <Button variant="outline" size="sm" disabled={busy} onclick={onRevoke}>
      {revoking ? "Revoking…" : "Revoke"}
    </Button>

    <button
      type="button"
      class="size-5 shrink-0 cursor-pointer rounded-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-expanded={expanded}
      aria-label={expanded
        ? `Hide details for ${grant.app.name}`
        : `Show details for ${grant.app.name}`}
      onclick={toggle}
    >
      <ChevronIcon class="size-4 transition-transform {expanded ? 'rotate-180' : ''}" />
    </button>
  </div>

  {#if expanded}
    <div class="mt-3 ml-12 space-y-3 border-l-2 border-border/60 pl-3">
      <!--
        The scopes, shown rather than summarised. The dangerous ones keep their own row, exactly as
        the consent sheet lists them, because that distinction is the whole reason it exists.
      -->
      {#if danger.length > 0}
        <div class="flex items-start gap-2">
          <ShieldAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <div class="flex flex-wrap gap-1.5">
            {#each danger as scope (scope.scope)}
              <Badge variant="destructive" class="h-5 px-1.5 text-[10px]" title={scope.description}>
                {scope.scope}
              </Badge>
            {/each}
          </div>
        </div>
      {/if}

      {#if ordinary.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each ordinary as scope (scope.scope)}
            <Badge variant="secondary" class="h-5 px-1.5 text-[10px]" title={scope.description}>
              {scope.scope}
            </Badge>
          {/each}
        </div>
      {:else if danger.length === 0}
        <p class="text-xs text-muted-foreground">No permissions recorded for this app.</p>
      {/if}

      <!--
        What this app is quietly forwarding, and where to. A webhook keeps working while nothing is
        on screen, which is exactly why it belongs on the page whose job is "what does this app
        actually have".
      -->
      {#if webhooks.length > 0}
        <div class="border border-border">
          <p class="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            Sending your events to {webhooks.length === 1 ? "an address" : "addresses"} outside
            vrc.zip. Deleting one stops that feed without touching anything else this app does.
          </p>
          <ul class="divide-y divide-border">
            {#each webhooks as hook (hook.id)}
              <li class="flex flex-wrap items-center gap-3 px-3 py-2">
                <div class="min-w-0 flex-1">
                  <p class="truncate font-mono text-xs text-foreground" title={hook.url}>
                    {hook.url}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    {hook.kinds.join(", ")} · {deliveryLine(hook)}
                    {#if hook.disabledAt !== null}
                      · <span class="text-warning"
                        >switched off{hook.disabledReason === null
                          ? ""
                          : `: ${hook.disabledReason}`}</span
                      >
                    {:else if hook.lastError !== null}
                      · <span class="text-warning" title={hook.lastError}>last try failed</span>
                    {/if}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  disabled={deletingWebhook !== null}
                  onclick={() => {
                    onRemoveWebhook(hook);
                  }}
                >
                  {deletingWebhook === hook.id ? "Deleting…" : "Delete"}
                </Button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <!--
        The hourly allowances. Rendered for all three scopes whether or not the app holds them, with
        the ones it does not hold dimmed: a row that disappeared for an app without `invite:send`
        would hide the control exactly when someone opens this row to check that it cannot send
        invites.
      -->
      <div class="border border-border">
        <p class="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          Hourly limits. These cap how much this app can do in your name per hour, on top of the
          permissions above. Empty the box to go back to the default; 0 means never.
        </p>
        <ul class="divide-y divide-border">
          {#each grant.budgets as budget (budget.scope)}
            <li
              class="flex flex-wrap items-center gap-3 px-3 py-2 {budget.granted ? '' : 'opacity-60'}"
            >
              <div class="min-w-0 flex-1">
                <p class="font-mono text-xs text-foreground">{budget.scope}</p>
                <p class="text-xs text-muted-foreground">
                  {#if budget.granted}
                    {budget.used} of {budget.limit} used this hour
                  {:else}
                    Not granted, so nothing is spending this
                  {/if}
                </p>
              </div>
              <Input
                type="number"
                min={0}
                class="w-24 tabular"
                placeholder={String(budget.defaultLimit)}
                value={budget.overridden ? String(budget.limit) : ""}
                disabled={savingBudget !== null}
                onblur={(event) => {
                  onSaveBudget(budget.scope, event.currentTarget.value);
                }}
              />
              {#if budget.overridden}
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  disabled={savingBudget !== null}
                  onclick={() => {
                    onResetBudget(budget.scope);
                  }}
                >
                  Reset to {budget.defaultLimit}
                </Button>
              {/if}
            </li>
          {/each}
        </ul>
      </div>

      <!--
        What it has done, as against what it may do. The scope badges above are a permission; this
        is the record of use, and it is the half that turns "should I revoke this?" into a question
        with evidence behind it. Only mutating calls are recorded, so an empty panel means the app
        has changed nothing.
      -->
      <div class="space-y-1">
        <p class="text-xs font-medium text-foreground">Recent activity</p>
        {#if activity === null || activity.loading}
          <p class="text-xs text-muted-foreground">Reading what this app has done…</p>
        {:else if activity.error !== null}
          <p class="text-xs text-destructive">{activity.error}</p>
        {:else if activity.entries.length === 0}
          <p class="text-xs text-muted-foreground">
            This app has not changed anything. Reading is not recorded.
          </p>
        {:else}
          <ul class="flex flex-col divide-y divide-border border border-border">
            {#each activity.entries as row (row.id)}
              <li class="flex items-baseline gap-2 px-2 py-1 text-xs">
                <span class="shrink-0 text-muted-foreground" title={fullTimestamp(row.ts)}>
                  {timeAgo(row.ts, clock.now)}
                </span>
                <span class="tabular shrink-0 font-medium text-foreground">{row.method}</span>
                <span class="truncate text-muted-foreground" title={row.path}>{row.path}</span>
                <Badge
                  variant={row.outcome === "allowed" ? "secondary" : "destructive"}
                  class="ml-auto shrink-0"
                  title={row.status === null ? undefined : `HTTP ${String(row.status)}`}
                >
                  {outcomeLabel(row.outcome)}
                </Badge>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt class="text-muted-foreground">Acting as</dt>
        <dd>{grant.accountName}</dd>

        {#if grant.app.contact !== ""}
          <dt class="text-muted-foreground">Contact</dt>
          <dd class="break-all">Says it can be reached at {grant.app.contact}</dd>
        {/if}

        <dt class="text-muted-foreground">Connected</dt>
        <dd class="tabular">{fullTimestamp(grant.createdAt)}</dd>

        {#if grant.lastUsedAt !== null}
          <dt class="text-muted-foreground">Last used</dt>
          <dd class="tabular">{fullTimestamp(grant.lastUsedAt)}</dd>
        {/if}

        <dt class="text-muted-foreground">Requests</dt>
        <dd class="flex items-center gap-2">
          <Sparkline
            values={history}
            height={14}
            class="w-20"
            label="{grant.app.name} requests per second over the last minute"
          />
          <span class="tabular whitespace-nowrap text-muted-foreground">
            {latest}/s now · {windowTotal} in the last minute
          </span>
        </dd>

        <dt class="text-muted-foreground">Id</dt>
        <dd class="font-mono break-all">{grant.id}</dd>
      </dl>
    </div>
  {/if}
</li>
