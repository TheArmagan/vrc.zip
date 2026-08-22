<!--
  Accounts: the credentials vrc.zip holds, and nothing about running game clients.

  The counter line at the top is there on purpose. Someone who has just come from Live sessions has
  two numbers in their head, and this is where the app says plainly that the two are unrelated.
-->
<script lang="ts">
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import UserPlusIcon from "@lucide/svelte/icons/user-plus";
import UsersRoundIcon from "@lucide/svelte/icons/users-round";
import { toast } from "svelte-sonner";
import { api, describeError } from "$lib/api.ts";
import AccountRow from "$lib/components/AccountRow.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import * as Alert from "$lib/components/ui/alert/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { hrefFor } from "$lib/router.ts";
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
        {@const sessionCount = app.sessions.filter(
          (session) => session.accountId === account.id,
        ).length}
        <AccountRow
          {account}
          {sessionCount}
          onRemove={() => {
            removing = account.id;
            error = null;
          }}
        />
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
