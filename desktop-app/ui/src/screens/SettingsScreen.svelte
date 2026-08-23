<!--
  Settings.

  The contact address is first, largest, and impossible to scroll past when it is empty, because
  nothing in this app works without it. VRChat requires an API client to identify itself with a
  working contact address, and the daemon will not send a single request until one is set. A user
  who cannot find this field has an app that does nothing and no explanation.

  Everything below it is a group of rows in the shape the rest of the app uses: what the setting is
  on the left, the control on the right, and the reasoning underneath. The one group with more than
  a switch's worth of detail — the daemon's ports, which are read-only here and have a caveat that
  takes a paragraph — puts that paragraph behind a chevron, so a screen people open to change one
  thing is not three screens tall by default.
-->
<script lang="ts">
import ChevronIcon from "@lucide/svelte/icons/chevron-down";
import DownloadIcon from "@lucide/svelte/icons/download";
import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
import PlusIcon from "@lucide/svelte/icons/plus";
import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import { toast } from "svelte-sonner";
import {
  api,
  describeError,
  EVENT_FAMILIES,
  type SettingsPatch,
} from "$lib/api.ts";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import RetentionSection from "$lib/components/RetentionSection.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import SettingSwitchRow from "$lib/components/SettingSwitchRow.svelte";
import * as Alert from "$lib/components/ui/alert/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Card from "$lib/components/ui/card/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
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
/** The ports group's caveat, which is a paragraph nobody needs on the way to a switch. */
let portsOpen = $state(false);

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

/**
 * The avtr.zip switch.
 *
 * Falls back to on rather than off, matching `DEFAULT_SETTINGS` in `daemon/src/settings.ts`: while
 * settings are still loading the switch should show what the daemon is actually doing, and a
 * default-off render would tell the reader the lookup is disabled when it is not.
 */
const resolveAvatarIds = $derived(app.settings?.resolveAvatarIds ?? true);

async function save(patch: SettingsPatch): Promise<void> {
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

/*
 * "Start with Windows" and the install action.
 *
 * The switch and the button are one group because they are one decision seen from two sides: the
 * daemon refuses to register an autostart from Downloads or a temp folder, so for the people most
 * likely to want the switch, the button is the thing that makes it possible. Showing the refusal
 * without the fix next to it would be a dead end.
 */
const startupSupported = $derived(app.settings?.startWithWindowsSupported ?? false);
const startupReason = $derived(app.settings?.startWithWindowsReason ?? null);
const installSupported = $derived(app.settings?.installSupported ?? false);
const installed = $derived(app.settings?.installed ?? false);
const installPath = $derived(app.settings?.installPath ?? null);
/*
 * An older copy is installed and this is not it.
 *
 * The same button does both jobs, because the underlying action is the same copy — but the words
 * are not interchangeable. "Install vrc.zip properly" in front of somebody who installed it months
 * ago reads as though the app has forgotten, and it buries the thing they would actually want to
 * know, which is that the installed copy is out of date.
 */
const installedVersion = $derived(app.settings?.installedVersion ?? null);
const updatable = $derived(installedVersion !== null && !installed);

let installing = $state(false);
let desktopShortcut = $state(true);

async function setStartWithWindows(checked: boolean): Promise<void> {
  try {
    await save({ startWithWindows: checked });
    // The daemon answers with what the registry now says rather than with what was asked for, so a
    // refusal arrives as a switch that did not move plus a reason. Surfacing it is the whole point:
    // a switch that silently springs back is the worst version of this.
    const settings = app.settings;
    if (settings !== null && settings.startWithWindows !== checked) {
      toast.error(settings.startWithWindowsReason ?? "Windows would not accept that change.");
    }
  } catch {
    /* `error` already carries it */
  }
}

async function install(): Promise<void> {
  installing = true;
  error = null;
  try {
    const report = await api.settings.install({
      desktopShortcut,
      // Never optional here. This is what makes vrc.zip come up when somebody types its name, which
      // is most of what "install it properly" means.
      startMenuShortcut: true,
    });
    if (!report.ok) {
      toast.error(report.reason ?? "Could not install vrc.zip.");
    } else if (report.reason !== null) {
      // Success *and* a reason means a partial: the copy landed and something after it did not,
      // usually a shortcut or the autostart entry. Showing that as a success toast would claim the
      // whole thing worked, and showing it as an error would send them to redo the part that did.
      toast.warning(report.reason);
    } else {
      toast.success(`Installed to ${report.path ?? "your local app data folder"}.`);
    }
    // Re-read rather than trusting the report: the switch above is drawn from the settings payload,
    // and the install has just changed what that payload says.
    app.settings = await api.settings.get();
  } catch (cause) {
    error = describeError(cause);
  } finally {
    installing = false;
  }
}

async function setResolveAvatarIds(checked: boolean): Promise<void> {
  const patch: SettingsPatch = { resolveAvatarIds: checked };
  try {
    await save(patch);
  } catch {
    /* `error` already carries it */
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
          <Button
            disabled={!contactValid || !contactDirty || savingContact}
            onclick={() => void saveContact()}
          >
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
        <!-- Not an empty state: nothing has been read yet, so "none configured" would be a claim. -->
        <Skeleton class="h-12 w-full" />
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
          {#if installSupported || startupSupported}
            <SettingSwitchRow
              label="Start with Windows"
              description="Signs vrc.zip in and starts collecting your feed as soon as you log in, with its console hidden and no browser tab. Registered against your account only, and removable from Task Manager's Startup tab like anything else."
              checked={app.settings?.startWithWindows ?? false}
              disabled={app.settings === null || !startupSupported}
              onChange={(checked) => void setStartWithWindows(checked)}
            />
          {/if}

          <!--
            The install offer, and the reason it sits directly under that switch rather than in a
            section of its own: for anybody running vrc.zip out of Downloads, this *is* the switch.
            The daemon refuses to point an autostart entry at a folder Windows cleans up, so the
            reason it gives is shown here with the fix next to it.
          -->
          {#if installSupported && !installed}
            <div class="space-y-3 px-4 py-3">
              <div class="space-y-1">
                <p class="text-sm font-medium">
                  {updatable ? "Update the installed copy" : "Install vrc.zip properly"}
                </p>
                {#if updatable}
                  <p class="text-sm text-muted-foreground">
                    Version <span class="font-mono text-xs">{installedVersion}</span> is installed at
                    <span class="font-mono text-xs">{installPath}</span>, and this is a different
                    copy. Installing again replaces it with the one you are running. vrc.zip does not
                    update itself, so nothing happens here until you ask for it.
                  </p>
                {:else}
                  <p class="text-sm text-muted-foreground">
                    Copies vrc.zip to
                    <span class="font-mono text-xs"
                      >{installPath ?? "your local app data folder"}</span
                    >
                    and adds it to the Start menu, so you can search for it by name and it survives a
                    disk cleanup. No administrator rights, and nothing outside your own user folder.
                  </p>
                {/if}
                {#if startupReason !== null}
                  <p class="text-sm text-amber-600 dark:text-amber-500">{startupReason}</p>
                {/if}
              </div>

              {#if !updatable}
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    class="size-4 accent-primary"
                    bind:checked={desktopShortcut}
                    disabled={installing}
                  />
                  Also add a desktop shortcut
                </label>
              {/if}

              <Button size="sm" disabled={installing} onclick={() => void install()}>
                <DownloadIcon class="size-4" />
                {installing ? "Installing…" : updatable ? "Update" : "Install"}
              </Button>
            </div>
          {/if}

          {#if installed}
            <div class="px-4 py-3">
              <p class="text-sm font-medium">Installed</p>
              <p class="text-sm text-muted-foreground">
                Running from
                <span class="font-mono text-xs">{installPath}</span>. Remove it from Settings →
                Installed apps, or run
                <span class="font-mono text-xs">vrc.zip --uninstall</span>. Your accounts, settings
                and feed are kept either way.
              </p>
            </div>
          {/if}

          <SettingSwitchRow
            label="Open the browser at startup"
            description="Launches this window when the daemon starts. Turn it off if you run vrc.zip headless and open it yourself from the tray."
            checked={app.settings?.openBrowserOnStart ?? true}
            disabled={app.settings === null}
            onChange={(checked) => void save({ openBrowserOnStart: checked })}
          />

          <!--
            The one setting that sends anything anywhere other than VRChat, so it says so in as many
            words. See `daemon/src/net/avatar-ids.ts`: VRChat never reveals which avatar somebody is
            wearing, only a picture, and turning that picture's file id into an avatar id is what a
            third party is for.
          -->
          <SettingSwitchRow
            label="Look up avatar ids at avtr.zip"
            description="VRChat only tells you what an avatar looks like, never which avatar it is, so a 'changed avatar' row has a picture and nothing to open. avtr.zip turns the picture's file id into an avatar id. This is a third-party lookup and the only request vrc.zip makes to anything other than VRChat. Exactly one image file id leaves this machine: no account, no cookie, no user id, no display name, and nothing that says whose feed it came from. Turn it off and avatar rows stay unresolved rather than failing."
            checked={resolveAvatarIds}
            disabled={app.settings === null}
            onChange={(checked) => void setResolveAvatarIds(checked)}
          />

          {#if app.settings !== null}
            <!--
              Ports are read-only here and the reason why is a paragraph, which is exactly the kind
              of thing a chevron is for. The numbers themselves stay one click away rather than
              gone: "which port is the mirror on" is a question people come to this screen with.
            -->
            <div class="px-4 py-3">
              <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-2 text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                aria-expanded={portsOpen}
                onclick={() => {
                  portsOpen = !portsOpen;
                }}
              >
                <span class="min-w-0 flex-1">
                  <span class="block text-sm">Ports</span>
                  <span class="block text-xs text-muted-foreground">
                    Which port each of the three servers asks for.
                  </span>
                </span>
                <ChevronIcon
                  class="size-4 shrink-0 text-muted-foreground transition-transform {portsOpen
                    ? 'rotate-180'
                    : ''}"
                />
              </button>

              {#if portsOpen}
                <div class="mt-3 space-y-3 border-l-2 border-border/60 pl-3">
                  <dl class="grid grid-cols-3 gap-3">
                    {#each [["UI", app.settings.ports.ui], ["Mirror", app.settings.ports.proxy], ["Control API", app.settings.ports.control]] as [label, port] (label)}
                      <div class="space-y-1.5">
                        <dt class="text-sm text-muted-foreground">{label}</dt>
                        <dd><Badge variant="secondary" class="tabular font-mono">{port}</Badge></dd>
                      </div>
                    {/each}
                  </dl>
                  <p class="text-xs text-muted-foreground">
                    Ports are read-only here. The daemon falls back to an ephemeral port when one of
                    these is taken, so the numbers above are what was requested, not necessarily
                    what is bound. Change them in settings.json and restart.
                  </p>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </Card.Root>
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
        <SettingSwitchRow
          label="Dark theme"
          description="Applied before first paint, so the window never flashes the wrong one."
          checked={theme.current === "dark"}
          onChange={(checked) => {
            theme.set(checked ? "dark" : "light");
          }}
        />

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
