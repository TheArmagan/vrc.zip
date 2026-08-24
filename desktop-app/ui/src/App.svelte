<!--
  The root. Owns three things and delegates everything else: the route, the global keymap, and the
  decision about whether a screen may render at all.

  That last one is why the offline branch lives here rather than inside each screen. When the
  daemon is gone, every screen would independently discover it and render its own version of the
  bad news; one check at the top means one answer.
-->
<script lang="ts">
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import AppShell from "$lib/components/AppShell.svelte";
import AvatarModal from "$lib/components/AvatarModal.svelte";
import CommandPalette from "$lib/components/CommandPalette.svelte";
import DaemonOffline from "$lib/components/DaemonOffline.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import GroupModal from "$lib/components/GroupModal.svelte";
import UserModal from "$lib/components/UserModal.svelte";
import WorldModal from "$lib/components/WorldModal.svelte";
import { Toaster } from "$lib/components/ui/sonner/index.js";
import { registerPluginCommands } from "$lib/commands/plugins.svelte.ts";
import { pluginContributions } from "$lib/state/plugin-contributions.svelte.ts";
import { pluginPanels } from "$lib/state/plugin-panels.svelte.ts";
import { registerBuiltinCommands } from "$lib/commands/builtin.svelte.ts";
import { isTypingTarget, matchKeybinding, runCommand } from "$lib/commands.svelte.ts";
import { currentRoute, onRouteChange, type Route } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";
import { theme } from "$lib/state/theme.svelte.ts";
import { updates } from "$lib/state/updates.svelte.ts";
import { screenFor } from "./screens/lazy.ts";

let route = $state<Route>(currentRoute());
let paletteOpen = $state(false);

$effect(() =>
  onRouteChange((next) => {
    route = next;
  }),
);

/*
 * `untrack` is load-bearing on both of these, not decoration.
 *
 * `app.start()` runs the first half of `refresh()` synchronously, and that reads `app.status` to
 * decide whether this is a cold load. Without `untrack` the effect would take a dependency on
 * `status`, so every status change would tear the WebSocket down and open a new one, and the
 * refresh that a fresh connection triggers would set status again. `registerBuiltinCommands` is
 * wrapped for the same reason: its `enabled` predicates read `app.sessions`, and one of them
 * running eagerly would be enough to re-register every command on the next session change.
 */
$effect(() => untrack(() => app.start()));

/*
 * The release check's reader. `untrack` for the same reason `app.start()` has it: `start()` kicks
 * off a read that writes the status it would otherwise take a dependency on, and the poll would
 * then restart itself on every answer. The teardown clears the interval, so a hot reload in dev
 * leaves one poller rather than one per reload.
 */
$effect(() => untrack(() => updates.start()));

$effect(() =>
  untrack(() => {
    /*
     * A plugin's toast, shown as the plugin rather than as the app.
     *
     * The name is the toast's title and the plugin's words are the description, so an interruption
     * says who is interrupting in one glance — a message that reads as vrc.zip's own would be a
     * third party speaking in the host's voice.
     */
    void pluginContributions.refresh();

    pluginPanels.onToast = ({ pluginName, message, description, tone }) => {
      const options = {
        description: description === undefined ? message : `${message} — ${description}`,
        duration: tone === "danger" ? 8000 : 4000,
      };
      if (tone === "success") toast.success(pluginName, options);
      else if (tone === "warn") toast.warning(pluginName, options);
      else if (tone === "danger") toast.error(pluginName, options);
      else toast.info(pluginName, options);
    };
  }),
);

/**
 * Plugin commands, re-registered whenever the contribution list changes.
 *
 * A plain `$effect` rather than `untrack`, unlike the builtins below: builtins are fixed at
 * startup, while a plugin installed or removed *now* has to appear in or leave the palette without
 * a reload. The teardown is what keeps a removed plugin's commands from lingering.
 */
$effect(() => {
  /*
   * Read tracked, register untracked.
   *
   * `registerCommands` writes to the registry's own `$state`, and it reads that same state to
   * append — so registering inside a plain effect makes the effect depend on what it just wrote and
   * re-run forever. Svelte says so as `effect_update_depth_exceeded`, which is what this looked
   * like from the outside: a blank screen and one exception.
   *
   * The dependency that *should* re-run this is the contribution list, so that is the one read
   * outside `untrack`.
   */
  const contributions = pluginContributions.commands;
  return untrack(() =>
    registerPluginCommands(contributions, {
      notify: (level, title, detail) => {
        const options = {
          ...(detail === undefined ? {} : { description: detail }),
          duration: level === "error" ? 8000 : 4000,
        };
        if (level === "error") toast.error(title, options);
        else toast.info(title, options);
      },
    }),
  );
});

$effect(() =>
  untrack(() =>
    registerBuiltinCommands({
      openPalette: () => {
        paletteOpen = true;
      },
      notImplemented: (title, why) => {
        toast.warning(title, { description: why, duration: 6000 });
      },
      /*
       * The registry's one channel back to the user, mapped onto the toaster here so nothing under
       * `lib/commands/` has to import it. Errors linger; a success that confirms a keystroke does
       * not need to.
       */
      notify: (level, title, detail) => {
        // `exactOptionalPropertyTypes`: a missing description and a description of `undefined` are
        // different types here, so the key is omitted rather than set to nothing.
        const options = {
          ...(detail === undefined ? {} : { description: detail }),
          duration: level === "error" ? 8000 : 4000,
        };
        if (level === "success") toast.success(title, options);
        else if (level === "warning") toast.warning(title, options);
        else if (level === "error") toast.error(title, options);
        else toast.info(title, options);
      },
    }),
  ),
);

/**
 * The global keymap. Keystrokes reach commands only when the user is not typing into something,
 * with one exception: a binding that already carries Ctrl or Alt cannot collide with typing, and
 * Ctrl+Shift+P has to work from inside the palette's own search field.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && paletteOpen) {
    paletteOpen = false;
    return;
  }
  const command = matchKeybinding(event);
  if (command === null) return;
  const modified = event.ctrlKey || event.metaKey || event.altKey;
  if (!modified && isTypingTarget(event.target)) return;
  event.preventDefault();
  void runCommand(command.id);
}

const offline = $derived(!app.reachable);

/**
 * The one value a route contributes to its screen, under the name that screen calls it.
 *
 * Screens are loaded as chunks now (`screens/lazy.ts`), so the template renders whichever
 * component the route resolved to rather than naming nine of them — and the props have to travel
 * as a bag for that. Every screen that takes a param takes exactly one, so this stays a lookup
 * rather than growing into a second route table.
 */
const screenProps = $derived<Record<string, unknown>>(
  route.id === "sessions" || route.id === "gamelog"
    ? { sessionId: route.param }
    : route.id === "login"
      ? { accountId: route.param }
      : // `#/consent/<pairingId>` — where the daemon's browser-open lands.
        route.id === "consent"
        ? { pairingId: route.param }
        : // The one two-parameter route: a panel is a plugin *and* a panel id.
          route.id === "plugin"
          ? { pluginId: route.param ?? "", panelId: route.subParam ?? "" }
          : // `#/graphs` is the list and `#/graphs/<id>` is the editor, so the param is optional.
            route.id === "graphs"
            ? { graphId: route.param }
            : {},
);
</script>

<svelte:window onkeydown={onKeydown} />

<Toaster theme={theme.current} position="bottom-right" closeButton />

{#if offline}
  <div class="flex h-full flex-col bg-background text-foreground">
    <DaemonOffline
      onRetry={() => app.retry()}
      retrying={app.phase === "loading"}
      reason={app.offlineReason}
    />
  </div>
{:else}
  <AppShell
    route={route.id}
    onOpenPalette={() => {
      paletteOpen = true;
    }}
  >
    {#if app.error !== null && app.phase === "error"}
      <div class="p-4">
        <ErrorNote message={app.error} />
      </div>
    {/if}

    <!--
      The screen is a chunk of its own, fetched on first visit. The pending branch is deliberately
      empty rather than a spinner: the shell around it has already painted, the chunk comes off
      loopback, and a spinner that flashes for one frame reads as a fault.
    -->
    {#await screenFor(route.id)}
      <!-- nothing: the shell is the loading state -->
    {:then Screen}
      <Screen {...screenProps} />
    {:catch}
      <div class="p-4">
        <ErrorNote
          message="This screen could not be loaded. The daemon may have restarted onto a new build; reload the page."
        />
      </div>
    {/await}
  </AppShell>
{/if}

<CommandPalette bind:open={paletteOpen} />

<!--
  One instance, at the root, deliberately outside the offline branch: local history is vrc.zip's
  own data and a name clicked before the daemon went away should still tell that story.
-->
<UserModal />

<!--
  The world's counterpart, and mounted for the same reason: every location in the app is a control
  that opens it, so there is one dialog rather than one per row. Outside the offline branch too —
  a world already in the daemon's cache still has a name to show when VRChat cannot be reached.
-->
<WorldModal />

<!--
  The third of the three, on the same terms. A group badge appears wherever a user does, so this is
  a singleton too — and it is mounted here rather than inside the user modal because the two are
  peers: opening a group from a profile must not depend on that profile staying open.
-->
<GroupModal />

<!--
  The fourth, and the one that is usually opened from a picture rather than from an id: VRChat puts
  no avatar id on a user, so a "changed avatar" row carries a file and nothing else. Same singleton
  terms as the other three, and it shares their back stack, so an avatar opened from a feed row
  closes back to whatever was underneath it.
-->
<AvatarModal />
