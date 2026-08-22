<!--
  Settings.

  The contact address is first, largest, and impossible to scroll past when it is empty, because
  nothing in this app works without it. VRChat requires an API client to identify itself with a
  working contact address, and the daemon will not send a single request until one is set. A user
  who cannot find this field has an app that does nothing and no explanation.
-->
<script lang="ts">
import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
import PlusIcon from "@lucide/svelte/icons/plus";
import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import { toast } from "svelte-sonner";
import { api, describeError, EVENT_FAMILIES } from "$lib/api.ts";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import RetentionSection from "$lib/components/RetentionSection.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import * as Alert from "$lib/components/ui/alert/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Card from "$lib/components/ui/card/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import { familyLabel } from "$lib/format.ts";
import {
  type NotificationPermissionState,
  notificationSupport,
  requestNotificationPermission,
} from "$lib/notifications.ts";
import { app } from "$lib/state/app.svelte.ts";
import { prefs } from "$lib/state/prefs.svelte.ts";
import { theme } from "$lib/state/theme.svelte.ts";

let contact = $state("");
let contactTouched = $state(false);
let savingContact = $state(false);
let error = $state<string | null>(null);
let newDirectory = $state("");
let permission = $state<NotificationPermissionState>("default");

$effect(() => {
  permission = notificationSupport();
});

// Seed the field from the daemon once, then leave it alone. Overwriting on every settings refresh
// would delete what the user is halfway through typing.
$effect(() => {
  const loaded = app.settings?.contact;
  if (loaded !== undefined && !contactTouched) contact = loaded;
});

const contactValid = $derived(
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim()) || /^https?:\/\/\S+$/.test(contact.trim()),
);

const contactDirty = $derived(contact.trim() !== (app.settings?.contact ?? ""));

async function save(patch: Parameters<typeof api.settings.update>[0]): Promise<void> {
  error = null;
  try {
    const next = await api.settings.update(patch);
    app.settings = next;
    return;
  } catch (cause) {
    error = describeError(cause);
    throw cause;
  }
}

async function saveContact(): Promise<void> {
  if (savingContact || !contactValid) return;
  savingContact = true;
  try {
    await save({ contact: contact.trim() });
    toast.success("Contact address saved", {
      description: "The daemon can talk to VRChat now. Sign in from the Accounts screen.",
    });
  } catch {
    /* `error` already carries it */
  } finally {
    savingContact = false;
  }
}

async function addDirectory(): Promise<void> {
  const value = newDirectory.trim();
  if (value === "" || app.settings === null) return;
  if (app.settings.logDirectories.includes(value)) {
    newDirectory = "";
    return;
  }
  try {
    await save({ logDirectories: [...app.settings.logDirectories, value] });
    newDirectory = "";
  } catch {
    /* `error` already carries it */
  }
}

async function removeDirectory(path: string): Promise<void> {
  if (app.settings === null) return;
  try {
    await save({
      logDirectories: app.settings.logDirectories.filter((entry) => entry !== path),
    });
  } catch {
    /* `error` already carries it */
  }
}

async function askForNotifications(): Promise<void> {
  permission = await requestNotificationPermission();
}
</script>

<SectionHeader title="Settings" description="Stored on this machine, in plain JSON" />

<div class="min-h-0 flex-1 overflow-y-auto">
  <div class="mx-auto w-full max-w-3xl space-y-8 px-5 py-6">
    {#if error}
      <ErrorNote message={error} />
    {/if}

    <!-- Contact address -->
    <!--
      Still tinted while unset. It is the one setting the whole app depends on, so it keeps a
      colour the eye lands on before reading anything.
    -->
    <Card.Root class={app.needsFirstRun ? "border-warning/60 bg-warning/10" : ""}>
      <Card.Header>
        <Card.Title>Contact address</Card.Title>
        <Card.Description>
          VRChat requires every API client to put a working contact address in its User-Agent so
          they can reach whoever is responsible. An email address or a link to your profile both
          work. Until this is set, vrc.zip sends nothing to VRChat at all and every sign-in fails
          with <code class="bg-muted px-1 font-mono text-xs">setup_required</code>.
        </Card.Description>
      </Card.Header>
      <Card.Content>
      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-64 flex-1 space-y-1.5">
          <Label for="contact">Email or profile URL</Label>
          <Input
            id="contact"
            bind:value={contact}
            oninput={() => {
              contactTouched = true;
            }}
            placeholder="you@example.com"
            autocomplete="email"
            spellcheck={false}
          />
        </div>
        <Button disabled={!contactValid || !contactDirty || savingContact} onclick={() => void saveContact()}>
          {savingContact ? "Saving" : "Save"}
        </Button>
      </div>

      {#if contact.trim() !== "" && !contactValid}
        <p class="mt-2 text-sm text-destructive">
          That is not an address anyone could reach. Use an email address or an https link.
        </p>
      {/if}
      </Card.Content>
    </Card.Root>

    <!-- Log directories -->
    <section class="space-y-3">
      <div>
        <h2 class="text-base font-semibold">VRChat log directories</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Live sessions and the game log come from tailing VRChat's own log files. Leave this empty
          and the daemon uses the directories it discovers for your platform. Add a path to
          override that, for a portable install or a second drive.
        </p>
      </div>

      {#if app.settings === null}
        <p class="text-sm text-muted-foreground">Loading</p>
      {:else if app.settings.logDirectories.length === 0}
        <Alert.Root>
          <FolderOpenIcon />
          <Alert.Description>
            Using auto-discovery. The daemon logs which directories it found at startup, and the
            Live sessions screen fills in as soon as it sees a log file.
          </Alert.Description>
        </Alert.Root>
      {:else}
        <Card.Root class="py-0">
          <ul class="divide-y divide-border">
            {#each app.settings.logDirectories as path (path)}
              <li class="flex items-center gap-2 px-3 py-2">
                <FolderOpenIcon class="size-4 shrink-0 text-muted-foreground" />
                <code class="min-w-0 flex-1 truncate font-mono text-sm">{path}</code>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${path}`}
                  class="text-muted-foreground hover:text-destructive"
                  onclick={() => void removeDirectory(path)}
                >
                  <Trash2Icon class="size-4" />
                </Button>
              </li>
            {/each}
          </ul>
        </Card.Root>
      {/if}

      <div class="flex gap-2">
        <Input
          bind:value={newDirectory}
          placeholder="C:\Users\you\AppData\LocalLow\VRChat\VRChat"
          spellcheck={false}
          class="font-mono text-sm"
        />
        <Button
          variant="outline"
          disabled={newDirectory.trim() === ""}
          onclick={() => void addDirectory()}
        >
          <PlusIcon class="size-4" />
          Add
        </Button>
      </div>
    </section>

    <!-- Daemon behaviour -->
    <section class="space-y-3">
      <h2 class="text-base font-semibold">Daemon</h2>

      <Card.Root class="py-0">
        <div class="divide-y divide-border">
        <div class="flex items-start gap-4 px-4 py-3">
          <div class="min-w-0 flex-1">
            <p class="text-sm">Open the browser at startup</p>
            <p class="text-sm text-muted-foreground">
              Launches this window when the daemon starts. Turn it off if you run vrc.zip headless
              and open it yourself from the tray.
            </p>
          </div>
          <Switch
            checked={app.settings?.openBrowserOnStart ?? true}
            disabled={app.settings === null}
            onCheckedChange={(checked) => void save({ openBrowserOnStart: checked })}
            aria-label="Open the browser at startup"
          />
        </div>
        </div>
      </Card.Root>

      {#if app.settings !== null}
        <dl class="grid grid-cols-3 gap-3">
          {#each [["UI", app.settings.ports.ui], ["Mirror", app.settings.ports.proxy], ["Control API", app.settings.ports.control]] as [label, port] (label)}
            <div class="space-y-1.5">
              <dt class="text-sm text-muted-foreground">{label}</dt>
              <dd><Badge variant="secondary" class="tabular font-mono">{port}</Badge></dd>
            </div>
          {/each}
        </dl>
        <p class="text-sm text-muted-foreground">
          Ports are read-only here. The daemon falls back to an ephemeral port when one of these is
          taken, so the numbers above are what was requested, not necessarily what is bound. Change
          them in settings.json and restart.
        </p>
      {/if}
    </section>

    <!-- History -->
    <RetentionSection />

    <!-- This browser -->
    <section class="space-y-3">
      <div>
        <h2 class="text-base font-semibold">This browser</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Kept in local storage rather than in daemon settings, so a second machine can disagree.
        </p>
      </div>

      <div class="divide-y divide-border border border-border">
        <div class="flex items-start gap-4 px-4 py-3">
          <div class="min-w-0 flex-1">
            <p class="text-sm">Dark theme</p>
            <p class="text-xs text-muted-foreground">
              Applied before first paint, so the window never flashes the wrong one.
            </p>
          </div>
          <Switch
            checked={theme.current === "dark"}
            onCheckedChange={(checked) => {
              theme.set(checked ? "dark" : "light");
            }}
            aria-label="Dark theme"
          />
        </div>

        <div class="px-4 py-3">
          <p class="text-sm">Desktop notifications</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            Raised only while this tab is open and in the background. Notifying about something you
            are already looking at is noise.
          </p>

          {#if permission === "unsupported"}
            <p class="mt-2 text-xs text-muted-foreground">
              This browser does not offer the Notification API.
            </p>
          {:else if permission !== "granted"}
            <Button
              size="sm"
              variant="outline"
              class="mt-2 h-7 text-xs"
              disabled={permission === "denied"}
              onclick={() => void askForNotifications()}
            >
              {permission === "denied" ? "Blocked by the browser" : "Allow notifications"}
            </Button>
          {/if}

          <div class="mt-3 flex flex-wrap gap-1.5">
            {#each EVENT_FAMILIES as name (name)}
              {@const on = prefs.isNotifyFamily(name)}
              <button
                type="button"
                aria-pressed={on}
                onclick={() => {
                  prefs.toggleNotifyFamily(name);
                }}
                class="border px-2 py-0.5 text-xs {on
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted'}"
              >
                {familyLabel(name)}
              </button>
            {/each}
          </div>
        </div>
      </div>
    </section>

    <!-- Credential storage -->
    <section class="space-y-3">
      <h2 class="text-base font-semibold">Credential storage</h2>
      <Alert.Root variant={app.status?.degradedKeychain === true ? "destructive" : "default"}>
        <ShieldCheckIcon />
        {#if app.status === null}
          <Alert.Description>Waiting for the daemon.</Alert.Description>
        {:else if app.status.degradedKeychain}
          <Alert.Title>The master key is in a file, not the OS keychain.</Alert.Title>
          <Alert.Description>
            Backend reported:
            <code class="bg-muted px-1 font-mono text-xs">{app.status.backend}</code>. Credentials
            are still encrypted, but the key sits next to them with only file permissions
            protecting it. Anyone who can read your user profile can attempt to decrypt your VRChat
            passwords and auth cookies. On Linux this usually means no keyring daemon is running in
            the session.
          </Alert.Description>
        {:else}
          <Alert.Title>Credentials are protected by the OS keychain.</Alert.Title>
          <Alert.Description>
            Backend: <code class="bg-muted px-1 font-mono text-xs">{app.status.backend}</code>.
            Passwords and VRChat auth cookies are encrypted with a key the keychain holds, never
            written in the clear, and never sent anywhere except to VRChat.
          </Alert.Description>
        {/if}
      </Alert.Root>
    </section>
  </div>
</div>
