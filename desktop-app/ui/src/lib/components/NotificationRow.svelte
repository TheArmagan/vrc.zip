<!--
  One row of the inbox — the notification counterpart of `EventRow`, and deliberately the same
  shape: time, icon, sender, what happened, labelled facts, an expander.

  What it adds over a feed row is the read/unread state and the action that changes it. Rows are
  never deleted, only marked seen: VRChat's `clear-notification` frame arrives with no content at
  all, so the daemon cannot know which rows it meant and refuses to guess.
-->
<script lang="ts">
import CheckIcon from "@lucide/svelte/icons/check";
import ChevronIcon from "@lucide/svelte/icons/chevron-down";
import type { NotificationItem } from "$lib/api.ts";
import LocationLine from "$lib/components/LocationLine.svelte";
import UserName from "$lib/components/UserName.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { TONE_CLASSES } from "$lib/event-details.ts";
import { fullTimestamp, timeOfDay } from "$lib/format.ts";
import { describeNotification } from "$lib/notification-details.ts";
import { app } from "$lib/state/app.svelte.ts";

let {
  item,
  dense = false,
  onMarkSeen,
}: {
  item: NotificationItem;
  dense?: boolean;
  onMarkSeen: (id: string) => void;
} = $props();

const details = $derived(describeNotification(item));
const tone = $derived(TONE_CLASSES[details.tone]);
const Icon = $derived(details.icon);
const account = $derived(app.accountById(item.accountId));

let expanded = $state(false);

const raw = $derived.by(() => {
  if (item.data === null || item.data === undefined) return null;
  try {
    return JSON.stringify(item.data, null, 2);
  } catch {
    return null;
  }
});

/**
 * Whether the collapsed row is holding anything back.
 *
 * A long message is the common case — a group announcement runs to paragraphs and the row clips it
 * to one line. Without an expander that text is simply unreadable in the app, which is what this
 * exists to fix.
 */
const expandable = $derived(raw !== null || details.facts.length > 0);
</script>

<li
  class="flex gap-3 border-l-2 {tone.rule} pr-2 pl-3 {dense ? 'py-2' : 'py-3'} hover:bg-muted/40 {item.seen
    ? 'opacity-60'
    : ''}"
>
  <span
    class="tabular w-14 shrink-0 text-xs leading-5 text-muted-foreground"
    title={fullTimestamp(item.ts)}
  >
    {timeOfDay(item.ts)}
  </span>

  <Icon class="mt-0.5 size-4 shrink-0 {tone.icon}" aria-hidden="true" />

  <div class="min-w-0 flex-1 space-y-1">
    <p class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <!--
        `name={item.senderDisplayName}` and nothing else: when it is null, `UserName` reads that as
        "I have an id and no name, find one" and resolves the display name from VRChat. A group
        announcement has a name and no id and degrades to plain text, which is correct — there is
        no profile behind it to open.
      -->
      {#if item.senderDisplayName !== null || item.senderUserId !== null}
        <UserName
          userId={item.senderUserId}
          name={item.senderDisplayName}
          accountId={item.accountId}
          class="font-medium"
        />
        <span class="text-muted-foreground">{details.action}</span>
      {:else}
        <span class="font-medium">{details.title}</span>
      {/if}

      {#if !item.seen}
        <span
          class="rounded-sm border border-status-join-me/40 bg-status-join-me/10 px-1 text-[10px] tracking-wide text-status-join-me uppercase"
        >
          New
        </span>
      {/if}
    </p>

    {#if details.facts.length > 0}
      <p class="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {#each details.facts as entry, index (index)}
          <span class={expanded ? "min-w-0" : "min-w-0 max-w-full truncate"} title={entry.value}>
            <span class="text-muted-foreground/70">{entry.label}</span>
            <span class={expanded ? "whitespace-pre-wrap" : ""}>{entry.value}</span>
          </span>
        {/each}
      </p>
    {/if}

    {#if details.location !== null}
      <!-- An invite's whole point is somewhere to go, so this one keeps its join affordance. -->
      <LocationLine
        location={details.location}
        worldName={details.worldName}
        accountId={item.accountId}
        observedAt={item.ts}
      />
    {/if}

    {#if account !== null && app.accounts.length > 1}
      <Badge variant="outline">
        To <UserName userId={account.id} name={account.displayName} accountId={account.id} />
      </Badge>
    {/if}

    {#if expanded}
      <div class="mt-2 space-y-2 border-l-2 border-border/60 pl-3">
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt class="text-muted-foreground">Type</dt>
          <dd class="font-mono break-all">{item.type}</dd>

          <dt class="text-muted-foreground">When</dt>
          <dd class="tabular">{fullTimestamp(item.ts)}</dd>

          {#if item.senderUserId !== null}
            <dt class="text-muted-foreground">From</dt>
            <dd class="font-mono break-all">{item.senderUserId}</dd>
          {/if}

          <dt class="text-muted-foreground">Id</dt>
          <dd class="font-mono break-all">{item.id}</dd>
        </dl>

        {#if raw !== null}
          <pre
            class="max-h-64 overflow-auto rounded-sm bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">{raw}</pre>
        {/if}
      </div>
    {/if}
  </div>

  {#if !item.seen}
    <Button
      size="sm"
      variant="ghost"
      class="shrink-0 text-muted-foreground"
      onclick={() => onMarkSeen(item.id)}
    >
      <CheckIcon />
      Mark read
    </Button>
  {/if}

  {#if expandable}
    <button
      type="button"
      class="mt-0.5 size-5 shrink-0 cursor-pointer rounded-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-expanded={expanded}
      aria-label={expanded
        ? "Hide the details of this notification"
        : "Show the details of this notification"}
      onclick={() => {
        expanded = !expanded;
      }}
    >
      <ChevronIcon class="size-4 transition-transform {expanded ? 'rotate-180' : ''}" />
    </button>
  {:else}
    <span class="size-5 shrink-0" aria-hidden="true"></span>
  {/if}
</li>
