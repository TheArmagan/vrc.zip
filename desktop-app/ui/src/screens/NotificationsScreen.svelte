<!--
  The VRChat notification inbox.

  Rows are never deleted, only marked seen. VRChat's `clear-notification` frame arrives with no
  content at all, so the daemon cannot know which rows it meant and refuses to guess. That is the
  right call, and it is why this screen filters on `seen` and defaults to hiding what has been
  read, instead of waiting for rows to vanish.
-->
<script lang="ts">
import BellIcon from "@lucide/svelte/icons/bell";
import CheckIcon from "@lucide/svelte/icons/check";
import AccountFilter from "$lib/components/AccountFilter.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import UserName from "$lib/components/UserName.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
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
      (showSeen || !item.seen) && (accountFilter === "" || item.accountId === accountFilter),
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
      <Switch id="show-read" size="sm" bind:checked={showSeen} />
      <Label for="show-read" class="text-xs text-muted-foreground">Show read</Label>
    </div>
    <AccountFilter bind:value={accountFilter} />
    {#if unseenCount > 0}
      <Button size="sm" variant="outline" onclick={() => void markAllSeen()}>
        <CheckIcon />
        Mark all read
      </Button>
    {/if}
  {/snippet}
</SectionHeader>

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if loading}
    <div class="space-y-2 p-4">
      {#each [0, 1, 2, 3] as index (index)}
        <Skeleton class="h-16 w-full" />
      {/each}
    </div>
  {:else if app.notifications.length === 0}
    <EmptyState
      icon={BellIcon}
      title="Your inbox is empty"
      description="Invites, friend requests, and group announcements land here as VRChat pushes them to the daemon."
    />
  {:else if filtered.length === 0}
    <EmptyState
      icon={CheckIcon}
      title="Everything is read"
      description="Read notifications are kept rather than deleted, because VRChat's clear signal does not say which ones it meant."
    >
      {#snippet action()}
        <Button
          variant="outline"
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
        <li class="flex items-start gap-3 px-4 py-3 {item.seen ? 'opacity-60' : ''}">
          <span
            class="mt-2 size-2 shrink-0 rounded-full {item.seen
              ? 'bg-transparent'
              : 'bg-status-join-me'}"
            aria-hidden="true"
          ></span>

          <div class="min-w-0 flex-1 space-y-1">
            <p class="flex flex-wrap items-baseline gap-2 text-sm">
              <span class="font-medium">{typeLabel(item.type)}</span>
              {#if item.senderDisplayName}
                <!-- Group announcements have a sender name and no sender id; that degrades. -->
                <UserName
                  userId={item.senderUserId}
                  name={item.senderDisplayName}
                  accountId={item.accountId}
                />
              {:else if item.senderUserId}
                <!-- An id and no name: still a person, and the modal is how you find out who. -->
                <UserName
                  userId={item.senderUserId}
                  name={shortId(item.senderUserId, 12)}
                  accountId={item.accountId}
                  class="font-mono text-xs text-muted-foreground"
                />
              {/if}
              <RelativeTime ts={item.ts} class="text-xs text-muted-foreground" />
            </p>
            {#if item.message}
              <p class="text-sm text-muted-foreground">{item.message}</p>
            {/if}
            {#if account !== null && app.accounts.length > 1}
              <Badge variant="outline">
                To <UserName userId={account.id} name={account.displayName} accountId={account.id} />
              </Badge>
            {/if}
          </div>

          {#if !item.seen}
            <Button
              size="sm"
              variant="ghost"
              class="shrink-0 text-muted-foreground"
              onclick={() => void app.markNotificationSeen(item.id)}
            >
              <CheckIcon />
              Mark read
            </Button>
          {/if}
        </li>
      {/each}
    </ul>

    <Separator />

    <p class="px-4 py-4 text-sm text-muted-foreground">
      Answering an invite or a friend request still happens in VRChat. vrc.zip reads the inbox and
      tracks what you have read.
    </p>
  {/if}
</div>
