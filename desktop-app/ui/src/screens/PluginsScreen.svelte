<!--
  Plugins — the consent sheet, and what is installed afterwards.

  Two halves on one screen, deliberately. The app world splits these (`#/consent` for the moment,
  `#/apps` for the standing access) because an app's consent arrives *unprompted*, from a separate
  process, possibly while nobody is looking. A plugin install is something the user just started,
  from this page, seconds ago. Sending them somewhere else to answer it would be navigation for its
  own sake.

  Three things shape the sheet:

  **The install is parked on a socket while it renders.** `POST /api/plugins` does not return until
  this is answered or five minutes pass, so this is not a notification the user may leave sitting —
  it is the other end of a request. That is why it sits at the top, above everything, and why the
  countdown is shown.

  **Approving is a hold, not a click.** With signing cut there is no trust tier and no "verified"
  class of plugin, so the sentence under the button is unconditionally true of every plugin: it can
  do anything your computer can do. A two-click arm is defeated by momentum; a hold is not.

  **Dangerous scopes are behind a second toggle and unticked by default**, which is the one place
  this screen is deliberately more work to use than it could be. Everything the plugin asked for is
  listed; what is *approved* is what is still ticked when the hold completes, and an approval can
  only ever narrow the request.
-->
<script lang="ts">
import PlugIcon from "@lucide/svelte/icons/plug";
import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
import {
  api,
  type ConsentScope,
  describeError,
  type InstalledPlugin,
  type PendingPluginConsent,
} from "$lib/api.ts";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import HoldToConfirm from "$lib/components/HoldToConfirm.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import UiNode from "$lib/components/plugin-ui/UiNode.svelte";
import { app } from "$lib/state/app.svelte.ts";
import { pluginPanels } from "$lib/state/plugin-panels.svelte.ts";
import { clock } from "$lib/state/clock.svelte.ts";

let plugins = $state<InstalledPlugin[]>([]);
let pending = $state<PendingPluginConsent[]>([]);
let loading = $state(true);
let loadError = $state<string | null>(null);
let actionError = $state<string | null>(null);
/** The plugin id a request is in flight for, so only its own row spins. */
let busy = $state<string | null>(null);

/**
 * What the user has ticked, per pending request.
 *
 * Keyed by consent id and rebuilt whenever a request appears, so two installs queued behind each
 * other cannot inherit each other's choices. Dangerous scopes and capabilities start **unticked**:
 * the sheet's job is to make granting them a decision rather than a default.
 */
let choices = $state<
  Record<
    string,
    { accountIds: string[]; scopes: string[]; capabilities: string[]; showDangerous: boolean }
  >
>({});

$effect(() => clock.subscribe());

$effect(() => {
  void load();
});

/**
 * Polls for pending requests.
 *
 * A poll rather than a stream frame, and this is a considered choice rather than a shortcut: the
 * install that raises one of these is a request *this browser made*, so the common case is that the
 * sheet is already open and one refetch on install is enough. The interval covers the other case —
 * an install started from a second window or a script — at a cost of one small request every three
 * seconds while this screen is open, and none while it is not.
 */
$effect(() => {
  const timer = setInterval(() => {
    void refreshPending();
  }, 3000);
  return () => clearInterval(timer);
});

async function load(): Promise<void> {
  loading = true;
  try {
    plugins = await api.plugins.list();
    loadError = null;
    void refreshPending();
    // Panels are seeded per plugin from REST, then kept live by `plugin.panel` frames. A plugin
    // that draws nothing simply has none.
    for (const plugin of plugins) void pluginPanels.load(plugin.id);
  } catch (error) {
    loadError = describeError(error);
  } finally {
    loading = false;
  }
}

async function refreshPending(): Promise<void> {
  try {
    const next = await api.plugins.pending();
    for (const request of next) {
      if (choices[request.id] !== undefined) continue;
      choices[request.id] = {
        // No account is pre-selected. A picker that defaults to "all of them" is the over-grant the
        // picker exists to prevent, and a plugin with no accounts is a legal, useful state.
        accountIds: [],
        scopes: request.scopes.filter((entry) => !entry.dangerous).map((entry) => entry.scope),
        capabilities: request.capabilities
          .filter((entry) => !entry.dangerous)
          .map((entry) => entry.scope),
        showDangerous: false,
      };
    }
    // Forget choices for requests that are gone, or a five-minute-old timeout leaves state behind.
    for (const id of Object.keys(choices)) {
      if (!next.some((request) => request.id === id)) delete choices[id];
    }
    pending = next;
  } catch {
    // Deliberately quiet. This runs on an interval, and a page that shows an error banner every
    // three seconds because the daemon blinked is worse than one that shows a stale list.
  }
}

function toggle(id: string, field: "scopes" | "capabilities", value: string): void {
  const choice = choices[id];
  if (choice === undefined) return;
  const list = choice[field];
  choice[field] = list.includes(value)
    ? list.filter((entry) => entry !== value)
    : [...list, value];
}

function toggleAccount(id: string, accountId: string): void {
  const choice = choices[id];
  if (choice === undefined) return;
  choice.accountIds = choice.accountIds.includes(accountId)
    ? choice.accountIds.filter((entry) => entry !== accountId)
    : [...choice.accountIds, accountId];
}

async function approve(request: PendingPluginConsent): Promise<void> {
  const choice = choices[request.id];
  if (choice === undefined) return;
  busy = request.id;
  actionError = null;
  try {
    await api.plugins.approve(request.id, {
      accountIds: choice.accountIds,
      // Always sent explicitly, never omitted. Omitting means "everything asked for", which would
      // silently grant the dangerous scopes this sheet deliberately left unticked.
      scopes: choice.scopes,
      capabilities: choice.capabilities,
      events: request.events,
    });
    await refreshPending();
    // The install request itself is what creates the row, and it returns on its own clock.
    setTimeout(() => void refreshList(), 500);
  } catch (error) {
    actionError = describeError(error);
  } finally {
    busy = null;
  }
}

async function deny(request: PendingPluginConsent): Promise<void> {
  busy = request.id;
  actionError = null;
  try {
    await api.plugins.deny(request.id);
    await refreshPending();
  } catch (error) {
    actionError = describeError(error);
  } finally {
    busy = null;
  }
}

async function refreshList(): Promise<void> {
  try {
    plugins = await api.plugins.list();
  } catch (error) {
    actionError = describeError(error);
  }
}

async function setEnabled(plugin: InstalledPlugin, enabled: boolean): Promise<void> {
  busy = plugin.id;
  actionError = null;
  try {
    const updated = enabled
      ? await api.plugins.enable(plugin.id)
      : await api.plugins.disable(plugin.id);
    plugins = plugins.map((entry) => (entry.id === plugin.id ? updated : entry));
  } catch (error) {
    actionError = describeError(error);
  } finally {
    busy = null;
  }
}

/** Which uninstalls are set to keep their data. Absent means delete, which is the default. */
let keepData = $state<Record<string, boolean>>({});

/**
 * Lifts or restores dry-run for one scope.
 *
 * Lifting is the direction that lets a plugin act on other people, so it is the one that gets the
 * hold. Restoring is a plain click: making it harder to close a door than to open one is exactly
 * backwards.
 */
async function setDryRun(plugin: InstalledPlugin, scope: string, lifted: boolean): Promise<void> {
  busy = plugin.id;
  actionError = null;
  try {
    const updated = await api.plugins.setDryRun(plugin.id, scope, lifted);
    plugins = plugins.map((entry) => (entry.id === plugin.id ? updated : entry));
  } catch (error) {
    actionError = describeError(error);
  } finally {
    busy = null;
  }
}

async function uninstall(plugin: InstalledPlugin): Promise<void> {
  busy = plugin.id;
  actionError = null;
  try {
    await api.plugins.uninstall(plugin.id, { keepData: keepData[plugin.id] === true });
    plugins = plugins.filter((entry) => entry.id !== plugin.id);
    delete keepData[plugin.id];
  } catch (error) {
    actionError = describeError(error);
  } finally {
    busy = null;
  }
}

function dangerousOf(list: readonly ConsentScope[]): ConsentScope[] {
  return list.filter((entry) => entry.dangerous);
}

function ordinaryOf(list: readonly ConsentScope[]): ConsentScope[] {
  return list.filter((entry) => !entry.dangerous);
}

/** Seconds left before the daemon gives up on a request. Five minutes from when it was raised. */
function secondsLeft(requestedAt: number): number {
  return Math.max(0, Math.ceil((requestedAt + 5 * 60_000 - clock.now) / 1000));
}
</script>

<SectionHeader
  title="Plugins"
  count={plugins.length}
  description="installed. Plugins run with your account's privileges."
/>

<div class="flex-1 overflow-y-auto">
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
    {#if actionError !== null}
      <ErrorNote message={actionError} />
    {/if}

    {#each pending as request (request.id)}
      {@const choice = choices[request.id]}
      {#if choice !== undefined}
        <section class="rounded-lg border border-primary/40 bg-popover p-4 ring-1 ring-foreground/5">
          <header class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 class="font-medium text-base">{request.name}</h2>
            <span class="text-muted-foreground text-sm">{request.version}</span>
            {#if request.isUpdate}
              <Badge variant="secondary">Update</Badge>
            {/if}
            <span class="ml-auto text-muted-foreground text-xs">
              expires in {secondsLeft(request.requestedAt)}s
            </span>
          </header>

          <p class="mt-1 text-muted-foreground text-sm">
            by {request.publisher} · from <code class="text-xs">{request.source}</code>
          </p>
          {#if request.description !== null}
            <p class="mt-2 text-sm">{request.description}</p>
          {/if}

          <!--
            Said once, plainly, every time. Not a tier, not a warning about this particular plugin:
            it is what installing any plugin means.
          -->
          <p class="mt-3 rounded border border-border bg-background p-2 text-sm">
            <ShieldAlertIcon class="mr-1 inline size-4 align-text-bottom text-muted-foreground" />
            This plugin runs with your account's privileges and can do anything your computer can
            do. Nothing checks who wrote it. Only install plugins you trust.
          </p>

          <h3 class="mt-4 font-medium text-sm">Accounts</h3>
          <p class="text-muted-foreground text-xs">
            It can act as the accounts you pick, and no others. Picking none is allowed.
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            {#each app.accounts as account (account.id)}
              <Button
                variant={choice.accountIds.includes(account.id) ? "default" : "outline"}
                size="sm"
                onclick={() => toggleAccount(request.id, account.id)}
              >
                {account.displayName ?? account.id}
              </Button>
            {:else}
              <p class="text-muted-foreground text-sm">No accounts are signed in yet.</p>
            {/each}
          </div>

          <h3 class="mt-4 font-medium text-sm">Permissions</h3>
          <ul class="mt-2 flex flex-col gap-2">
            {#each [...ordinaryOf(request.scopes), ...ordinaryOf(request.capabilities)] as entry (entry.scope)}
              <li class="flex items-start gap-2">
                <Switch
                  checked={choice.scopes.includes(entry.scope) ||
                    choice.capabilities.includes(entry.scope)}
                  onCheckedChange={() =>
                    toggle(
                      request.id,
                      request.scopes.some((scope) => scope.scope === entry.scope)
                        ? "scopes"
                        : "capabilities",
                      entry.scope,
                    )}
                />
                <span class="text-sm">
                  {entry.description}
                  {#if entry.isNew}
                    <Badge variant="secondary" class="ml-1">New in this version</Badge>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>

          {#if dangerousOf(request.scopes).length + dangerousOf(request.capabilities).length > 0}
            {@const dangerous = [
              ...dangerousOf(request.scopes),
              ...dangerousOf(request.capabilities),
            ]}
            <div class="mt-4 rounded border border-destructive/40 p-3">
              <label class="flex items-center gap-2 text-sm">
                <Switch
                  checked={choice.showDangerous}
                  onCheckedChange={(value) => {
                    choice.showDangerous = value;
                  }}
                />
                <span class="font-medium">
                  Show {dangerous.length} permission{dangerous.length === 1 ? "" : "s"} worth a second
                  look
                </span>
              </label>
              {#if choice.showDangerous}
                <ul class="mt-3 flex flex-col gap-2">
                  {#each dangerous as entry (entry.scope)}
                    <li class="flex items-start gap-2">
                      <Switch
                        checked={choice.scopes.includes(entry.scope) ||
                          choice.capabilities.includes(entry.scope)}
                        onCheckedChange={() =>
                          toggle(
                            request.id,
                            request.scopes.some((scope) => scope.scope === entry.scope)
                              ? "scopes"
                              : "capabilities",
                            entry.scope,
                          )}
                      />
                      <span class="text-sm">
                        {entry.description}
                        {#if entry.isNew}
                          <Badge variant="destructive" class="ml-1">New in this version</Badge>
                        {/if}
                      </span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}

          {#if request.events.length > 0}
            <h3 class="mt-4 font-medium text-sm">It will be told about</h3>
            <p class="mt-1 text-muted-foreground text-sm">
              {request.events.join(", ")}
            </p>
          {/if}

          <footer class="mt-4 flex items-center gap-2">
            <HoldToConfirm
              label="Hold to install"
              holdingLabel="Keep holding to install…"
              variant="default"
              disabled={busy === request.id}
              onconfirm={() => void approve(request)}
            />
            <Button variant="ghost" disabled={busy === request.id} onclick={() => void deny(request)}>
              Don't install
            </Button>
          </footer>
        </section>
      {/if}
    {/each}

    {#if loadError !== null}
      <ErrorNote message={loadError} />
    {:else if loading}
      <Skeleton class="h-20 w-full" />
      <Skeleton class="h-20 w-full" />
    {:else if plugins.length === 0}
      <EmptyState
        title="No plugins installed"
        description="A plugin is installed from a folder on this computer. There is no registry."
        icon={PlugIcon}
      />
    {:else}
      {#each plugins as plugin (plugin.id)}
        <article class="rounded-lg border border-border p-4">
          <header class="flex flex-wrap items-baseline gap-x-2">
            <h2 class="font-medium">{plugin.name}</h2>
            <span class="text-muted-foreground text-sm">{plugin.version}</span>
            <Badge variant={plugin.state === "running" ? "secondary" : "outline"}>
              {plugin.state}
            </Badge>
            <span class="ml-auto text-muted-foreground text-xs">
              installed <RelativeTime ts={plugin.installedAt} />
            </span>
          </header>

          {#if plugin.refusal !== null}
            <!--
              Not a disable. The file on disk no longer matches the hash it was installed under, so
              it will not be run — and that is the one refusal a user has to act on.
            -->
            <ErrorNote message={plugin.refusal} />
          {:else if plugin.disabledReason !== null}
            <p class="mt-2 text-muted-foreground text-sm">{plugin.disabledReason}</p>
          {/if}

          <p class="mt-2 text-muted-foreground text-sm">
            {plugin.scopes.length} permission{plugin.scopes.length === 1 ? "" : "s"} ·
            {plugin.accountIds.length} account{plugin.accountIds.length === 1 ? "" : "s"}
            {#if plugin.rssBytes !== null}
              · {Math.round(plugin.rssBytes / 1_048_576)} MB
            {/if}
            {#if plugin.restarts > 0}
              · {plugin.restarts} restart{plugin.restarts === 1 ? "" : "s"}
            {/if}
          </p>

          {#if plugin.budgets.some((entry) => entry.granted)}
            <!--
              Correction 3's "a UI naming who is eating it", and correction 4's dry-run gesture, in
              one block. Only granted scopes are shown expanded: a plugin holding none of the three
              has nothing to say here, and three permanently-empty rows on every card would train
              people to skip the section on the cards where it matters.
            -->
            <div class="mt-3 flex flex-col gap-2 rounded border border-border p-3">
              {#each plugin.budgets.filter((entry) => entry.granted) as entry (entry.scope)}
                <div class="flex flex-wrap items-center gap-2 text-sm">
                  <span class="font-medium">{entry.description}</span>
                  <span class="text-muted-foreground text-xs">
                    {entry.used} of {entry.limit ?? "∞"} used this hour
                  </span>
                  {#if entry.dryRun}
                    <Badge variant="secondary">Dry run</Badge>
                    <span class="text-muted-foreground text-xs">
                      logged, not performed
                    </span>
                    <div class="ml-auto">
                      <HoldToConfirm
                        label="Hold to allow for real"
                        holdingLabel="Keep holding…"
                        variant="outline"
                        disabled={busy === plugin.id}
                        onconfirm={() => void setDryRun(plugin, entry.scope, true)}
                      />
                    </div>
                  {:else}
                    <Badge variant="destructive">Live</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="ml-auto"
                      disabled={busy === plugin.id}
                      onclick={() => void setDryRun(plugin, entry.scope, false)}
                    >
                      Back to dry run
                    </Button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#each pluginPanels.panelsFor(plugin.id) as panel (panel.panelId)}
            <!--
              The plugin's own surface, drawn by this app's components. `path` seeds node identity;
              `form` is null until a `form` node opens a scope.
            -->
            <section class="mt-3 rounded border border-border p-3">
              <UiNode
                node={panel.tree}
                pluginId={panel.pluginId}
                panelId={panel.panelId}
                path={panel.panelId}
                form={null}
              />
            </section>
          {/each}

          <footer class="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy === plugin.id}
              onclick={() => void setEnabled(plugin, plugin.state === "disabled")}
            >
              {plugin.state === "disabled" ? "Enable" : "Disable"}
            </Button>

            <label class="ml-auto flex items-center gap-2 text-muted-foreground text-xs">
              <Switch
                checked={keepData[plugin.id] === true}
                onCheckedChange={(value) => {
                  keepData[plugin.id] = value;
                }}
              />
              Keep its data
            </label>
            <HoldToConfirm
              label="Hold to uninstall"
              holdingLabel="Keep holding to uninstall…"
              disabled={busy === plugin.id}
              onconfirm={() => void uninstall(plugin)}
            />
          </footer>
        </article>
      {/each}
    {/if}
  </div>
</div>
