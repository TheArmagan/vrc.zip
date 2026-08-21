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
import CommandPalette from "$lib/components/CommandPalette.svelte";
import DaemonOffline from "$lib/components/DaemonOffline.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import { Toaster } from "$lib/components/ui/sonner/index.js";
import { registerBuiltinCommands } from "$lib/commands/builtin.svelte.ts";
import { isTypingTarget, matchKeybinding, runCommand } from "$lib/commands.svelte.ts";
import { currentRoute, onRouteChange, type Route } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";
import { theme } from "$lib/state/theme.svelte.ts";
import AccountsScreen from "./screens/AccountsScreen.svelte";
import FeedScreen from "./screens/FeedScreen.svelte";
import FriendsScreen from "./screens/FriendsScreen.svelte";
import GameLogScreen from "./screens/GameLogScreen.svelte";
import LoginScreen from "./screens/LoginScreen.svelte";
import NotificationsScreen from "./screens/NotificationsScreen.svelte";
import SessionsScreen from "./screens/SessionsScreen.svelte";
import SettingsScreen from "./screens/SettingsScreen.svelte";

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

$effect(() =>
  untrack(() =>
    registerBuiltinCommands({
      openPalette: () => {
        paletteOpen = true;
      },
      notImplemented: (title, why) => {
        toast.warning(title, { description: why, duration: 6000 });
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

    {#if route.id === "sessions"}
      <SessionsScreen />
    {:else if route.id === "accounts"}
      <AccountsScreen />
    {:else if route.id === "login"}
      <LoginScreen accountId={route.param} />
    {:else if route.id === "friends"}
      <FriendsScreen />
    {:else if route.id === "feed"}
      <FeedScreen />
    {:else if route.id === "gamelog"}
      <GameLogScreen sessionId={route.param} />
    {:else if route.id === "notifications"}
      <NotificationsScreen />
    {:else}
      <SettingsScreen />
    {/if}
  </AppShell>
{/if}

<CommandPalette bind:open={paletteOpen} />
