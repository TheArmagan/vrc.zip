<!--
  The VRChat notification inbox.

  Rows are never deleted, only marked seen. VRChat's `clear-notification` frame arrives with no
  content at all, so the daemon cannot know which rows it meant and refuses to guess. That is the
  right call, and it is why this screen filters on `seen` and defaults to hiding what has been
  read, instead of waiting for rows to vanish.
-->
<script lang="ts">
import { Notification03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { shortId } from "$lib/format.ts";
import { app } from "$lib/state/app.svelte.ts";

let showSeen = $state(false);
let accountFilter = $state("");
let loading = $state(app.notifications.length === 0);

$effect(() => {
  void app.refreshNotifications().finally(() => {
    loading = false;
  });
});

/**
 * VRChat's `type` is an open set, so this map is a courtesy rather than a contract. Anything not
 * listed keeps its raw type, spaced out, instead of being dropped or shown as "Unknown".
 */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  friendRequest: "Friend request",
  invite: "Invite",
  inviteResponse: "Invite response",
  requestInvite: "Invite request",
  requestInviteResponse: "Invite request answered",
  message: "Message",
  votetokick: "Vote to kick",
  "group.announcement": "Group announcement",
  "group.informative": "Group notice",
  "group.invite": "Group invite",
  "group.joinRequest": "Group join request",
  "group.queueReady": "Group queue ready",
};

function typeLabel(type: string): string {
  const known = TYPE_LABELS[type];
  if (known !== undefined) return known;
  const spaced = type
    .replace(/[._-]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return spaced === "" ? type : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const filtered = $derived(
  app.notifications.filter(
    (item) =>
      (showSeen || !item.seen) &&
      (accountFilter === "" || item.accountId === accountFilter),
  ),
);

const unseenCount = $derived(app.unseenNotifications.length);

async function markAllSeen(): Promise<void> {
  const pending = app.unseenNotifications.map((item) => item.id);
  await Promise.all(pending.map((id) => app.markNotificationSeen(id)));
}
</script>

<SectionHeader
  title="Notifications"
  count={filtered.length}
  description={unseenCount === 0 ? "Nothing unread" : `${String(unseenCount)} unread`}
>
  {#snippet actions()}
    <div class="flex items-center gap-2">
      <label class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input type="checkbox" bind:checked={showSeen} class="size-3.5 accent-primary" />
        Show read
      </label>
      {#if app.accounts.length > 1}
        <select
          bind:value={accountFilter}
          aria-label="Filter by account"
          class="h-7 border border-border bg-input/30 px-2 text-xs outline-none
                 focus-visible:border-ring"
        >
          <option value="">All accounts</option>
          {#each app.accounts as account (account.id)}
            <option value={account.id}>{account.displayName}</option>
          {/each}
        </select>
      {/if}
      {#if unseenCount > 0}
        <Button
          size="sm"
          variant="outline"
          class="h-7 gap-1.5 text-xs"
          onclick={() => void markAllSeen()}
        >
          <HugeiconsIcon icon={Tick02Icon} size={13} />
          Mark all read
        </Button>
      {/if}
    </div>
  {/snippet}
</SectionHeader>

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if loading}
    <div class="space-y-px p-4">
      {#each [0, 1, 2, 3] as index (index)}
        <Skeleton class="h-14 w-full" />
      {/each}
    </div>
  {:else if app.notifications.length === 0}
    <EmptyState
      icon={Notification03Icon}
      title="Your inbox is empty"
      description="Invites, friend requests, and group announcements land here as VRChat pushes them to the daemon."
    />
  {:else if filtered.length === 0}
    <EmptyState
      icon={Tick02Icon}
      title="Everything is read"
      description="Read notifications are kept rather than deleted, because VRChat's clear signal does not say which ones it meant."
    >
      {#snippet action()}
        <Button
          variant="outline"
          size="sm"
          onclick={() => {
            showSeen = true;
          }}
        >
          Show read notifications
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="divide-y divide-border">
      {#each filtered as item (item.id)}
        {@const account = app.accountById(item.accountId)}
        <li class="flex items-start gap-3 px-5 py-3 {item.seen ? 'opacity-60' : ''}">
          <span
            class="mt-1.5 size-2 shrink-0 rounded-full {item.seen
              ? 'bg-transparent'
              : 'bg-status-join-me'}"
            aria-hidden="true"
          ></span>

          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-baseline gap-x-2 text-[13px]">
              <span class="font-medium">{typeLabel(item.type)}</span>
              {#if item.senderDisplayName}
                <span>{item.senderDisplayName}</span>
              {:else if item.senderUserId}
                <span class="font-mono text-[11px] text-muted-foreground">
                  {shortId(item.senderUserId, 12)}
                </span>
              {/if}
              <RelativeTime ts={item.ts} class="text-[11px] text-muted-foreground" />
            </p>
            {#if item.message}
              <p class="mt-0.5 text-xs text-muted-foreground">{item.message}</p>
            {/if}
            {#if account !== null && app.accounts.length > 1}
              <p class="mt-0.5 text-[11px] text-muted-foreground">To {account.displayName}</p>
            {/if}
          </div>

          {#if !item.seen}
            <Button
              size="sm"
              variant="ghost"
              class="h-7 shrink-0 gap-1.5 text-xs text-muted-foreground"
              onclick={() => void app.markNotificationSeen(item.id)}
            >
              <HugeiconsIcon icon={Tick02Icon} size={13} />
              Mark read
            </Button>
          {/if}
        </li>
      {/each}
    </ul>

    <p class="px-5 py-4 text-xs text-muted-foreground">
      Answering an invite or a friend request still happens in VRChat. vrc.zip reads the inbox and
      tracks what you have read.
    </p>
  {/if}
</div>
