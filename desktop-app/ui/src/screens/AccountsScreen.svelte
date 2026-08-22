<!--
  Accounts: the credentials vrc.zip holds, and nothing about running game clients.

  The counter line at the top is there on purpose. Someone who has just come from Live sessions has
  two numbers in their head, and this is where the app says plainly that the two are unrelated.
-->
<script lang="ts">
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import UserPlusIcon from "@lucide/svelte/icons/user-plus";
import UsersRoundIcon from "@lucide/svelte/icons/users-round";
import { toast } from "svelte-sonner";
import { api, describeError, imageUrl } from "$lib/api.ts";
import ConnectionDot from "$lib/components/ConnectionDot.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import UserName from "$lib/components/UserName.svelte";
import * as Alert from "$lib/components/ui/alert/index.js";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from "$lib/components/ui/avatar/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import Sparkline from "$lib/components/Sparkline.svelte";
import { connectionLabel, initials } from "$lib/format.ts";
import { rates } from "$lib/state/rates.svelte.ts";
import { hrefFor, navigate } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";

let removing = $state<string | null>(null);
let busy = $state(false);
let error = $state<string | null>(null);

const target = $derived(app.accounts.find((account) => account.id === removing) ?? null);
const loading = $derived(app.phase === "loading" || app.phase === "idle");

async function confirmRemove(): Promise<void> {
  if (target === null) return;
  busy = true;
  error = null;
  try {
    await api.accounts.remove(target.id);
    toast.success(`Removed ${target.displayName}`, {
      description: "Its credentials, cookies, and event history are gone from this machine.",
    });
    removing = null;
    await app.refresh();
  } catch (cause) {
    error = describeError(cause);
  } finally {
    busy = false;
  }
}
</script>

<SectionHeader
  title="Accounts"
  count={app.accounts.length}
  description="VRChat accounts vrc.zip holds credentials for"
>
  {#snippet actions()}
    <Button size="sm" href={hrefFor("login")}>
      <UserPlusIcon />
      Add account
    </Button>
  {/snippet}
</SectionHeader>

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if app.accountsNeeding2fa.length > 0}
    <div class="p-4">
      <Alert.Root class="border-warning/50 bg-warning/10">
        <KeyRoundIcon class="text-warning" />
        <Alert.Title>
          {app.accountsNeeding2fa.length}
          {app.accountsNeeding2fa.length === 1 ? "account is" : "accounts are"} waiting on a
          two-factor code.
        </Alert.Title>
        <Alert.Description>
          Nothing arrives for these accounts until the challenge is answered.
        </Alert.Description>
      </Alert.Root>
    </div>
  {/if}

  {#if loading}
    <div class="space-y-2 p-4">
      {#each [0, 1, 2] as index (index)}
        <Skeleton class="h-16 w-full" />
      {/each}
    </div>
  {:else if app.accounts.length === 0}
    <EmptyState
      icon={UsersRoundIcon}
      title="No accounts yet"
      description="vrc.zip signs in to VRChat on your behalf and keeps the credentials encrypted on this machine. Nothing is sent anywhere else."
    >
      {#snippet action()}
        <Button href={hrefFor("login")}>Sign in to VRChat</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="divide-y divide-border">
      {#each app.accounts as account (account.id)}
        <!-- `{@const}` is only legal as an immediate child of a block, hence up here. -->
        {@const accountRate = rates.account(account.id)}
        {@const sessionsForAccount = app.sessions.filter(
          (session) => session.accountId === account.id,
        )}
        <li class="flex items-center gap-3 px-4 py-3">
          <!--
            alt="" on purpose: the display name is the very next element, so announcing the icon
            too would read the name twice. The dot stays aria-hidden — `connectionLabel()` spells
            the same state out in words directly under the name.
          -->
          <Avatar class="size-9">
            <AvatarImage src={imageUrl(account.iconUrl)} alt="" loading="lazy" />
            <AvatarFallback class="text-xs">{initials(account.displayName)}</AvatarFallback>
            <AvatarBadge class="bg-transparent ring-background">
              <ConnectionDot connection={account.connection} size={null} class="size-full" />
            </AvatarBadge>
          </Avatar>

          <div class="min-w-0 flex-1">
            <!--
              An account is a user too, and its own profile is the one VRChat answers most fully —
              the lookup runs through the account itself. See `userModal.openUser`.
            -->
            <p class="truncate text-sm font-medium">
              <UserName
                userId={account.id}
                name={account.displayName}
                accountId={account.id}
                class="max-w-full truncate"
              />
            </p>
            <p class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{connectionLabel(account.connection)}</span>
              <span aria-hidden="true">·</span>
              <span>Added <RelativeTime ts={account.addedAt} /></span>
              {#if account.lastSeenAt !== null}
                <span aria-hidden="true">·</span>
                <span>Last event <RelativeTime ts={account.lastSeenAt} /></span>
              {/if}
            </p>

            <!--
              What this account is spending. Worth showing per account rather than only in total,
              because six accounts share one per-IP ceiling (PLAN.md §1.4) and the per-account
              limiter is structurally unable to see that — so "which one is eating it" is a real
              question with no other answer on screen.
            -->
            <div class="mt-1 flex items-center gap-2">
              <Sparkline
                values={accountRate}
                height={14}
                class="w-20"
                label="{account.displayName} requests per second over the last ten minutes"
              />
              <span class="tabular text-xs text-muted-foreground">
                {accountRate[accountRate.length - 1] ?? 0}/s
              </span>
            </div>
          </div>

          <span class="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {#if sessionsForAccount.length === 0}
              No client running
            {:else}
              {sessionsForAccount.length}
              {sessionsForAccount.length === 1 ? "client" : "clients"} running
            {/if}
          </span>

          {#if account.connection === "needs-2fa"}
            <Button
              size="sm"
              variant="outline"
              onclick={() => {
                navigate("login", account.id);
              }}
            >
              <KeyRoundIcon />
              Enter code
            </Button>
          {/if}

          <Button
            size="icon-sm"
            variant="ghost"
            class="text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${account.displayName}`}
            onclick={() => {
              removing = account.id;
              error = null;
            }}
          >
            <Trash2Icon />
          </Button>
        </li>
      {/each}
    </ul>

    <Separator />

    <p class="px-4 py-4 text-sm text-muted-foreground">
      Signing an account in here does not start VRChat, and closing VRChat does not sign an account
      out. Running clients live on the Live sessions screen.
    </p>
  {/if}
</div>

<Dialog.Root
  open={removing !== null}
  onOpenChange={(open) => {
    if (!open) removing = null;
  }}
>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title>Remove {target?.displayName ?? "this account"}?</Dialog.Title>
      <Dialog.Description>
        This deletes the stored password, the VRChat auth cookies, and every event vrc.zip recorded
        for the account. It does not touch the VRChat account itself.
      </Dialog.Description>
    </Dialog.Header>

    {#if error}
      <ErrorNote message={error} />
    {/if}

    <Dialog.Footer>
      <Button
        variant="ghost"
        disabled={busy}
        onclick={() => {
          removing = null;
        }}
      >
        Cancel
      </Button>
      <Button variant="destructive" disabled={busy} onclick={() => void confirmRemove()}>
        {busy ? "Removing" : "Remove account"}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
