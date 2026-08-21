<!--
  Accounts: the credentials vrc.zip holds, and nothing about running game clients.

  The counter line at the top is there on purpose. Someone who has just come from Live sessions has
  two numbers in their head, and this is where the app says plainly that the two are unrelated.
-->
<script lang="ts">
import {
  Delete02Icon,
  Key01Icon,
  UserAdd01Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/svelte";
import { toast } from "svelte-sonner";
import { api, describeError } from "$lib/api.ts";
import ConnectionDot from "$lib/components/ConnectionDot.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { connectionLabel } from "$lib/format.ts";
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
    <Button size="sm" href={hrefFor("login")} class="h-7 gap-1.5 text-xs">
      <HugeiconsIcon icon={UserAdd01Icon} size={13} />
      Add account
    </Button>
  {/snippet}
</SectionHeader>

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if app.accountsNeeding2fa.length > 0}
    <div class="border-b border-warning/40 bg-warning/10 px-5 py-2.5 text-sm">
      <p class="font-medium">
        {app.accountsNeeding2fa.length}
        {app.accountsNeeding2fa.length === 1 ? "account is" : "accounts are"} waiting on a two-factor
        code.
      </p>
      <p class="text-xs text-muted-foreground">
        Nothing arrives for these accounts until the challenge is answered.
      </p>
    </div>
  {/if}

  {#if loading}
    <div class="space-y-px p-4">
      {#each [0, 1, 2] as index (index)}
        <Skeleton class="h-14 w-full" />
      {/each}
    </div>
  {:else if app.accounts.length === 0}
    <EmptyState
      icon={UserMultiple02Icon}
      title="No accounts yet"
      description="vrc.zip signs in to VRChat on your behalf and keeps the credentials encrypted on this machine. Nothing is sent anywhere else."
    >
      {#snippet action()}
        <Button size="sm" href={hrefFor("login")}>Sign in to VRChat</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="divide-y divide-border">
      {#each app.accounts as account (account.id)}
        {@const sessionsForAccount = app.sessions.filter(
          (session) => session.accountId === account.id,
        )}
        <li class="flex items-center gap-3 px-5 py-3">
          <ConnectionDot connection={account.connection} size={9} />

          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{account.displayName}</p>
            <p class="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
              <span>{connectionLabel(account.connection)}</span>
              <span aria-hidden="true">·</span>
              <span>
                Added <RelativeTime ts={account.addedAt} />
              </span>
              {#if account.lastSeenAt !== null}
                <span aria-hidden="true">·</span>
                <span>
                  Last event <RelativeTime ts={account.lastSeenAt} />
                </span>
              {/if}
            </p>
          </div>

          <span class="shrink-0 text-[11px] text-muted-foreground">
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
              class="h-7 gap-1.5 text-xs"
              onclick={() => {
                navigate("login", account.id);
              }}
            >
              <HugeiconsIcon icon={Key01Icon} size={13} />
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
            <HugeiconsIcon icon={Delete02Icon} size={15} />
          </Button>
        </li>
      {/each}
    </ul>

    <p class="px-5 py-4 text-xs text-muted-foreground">
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
