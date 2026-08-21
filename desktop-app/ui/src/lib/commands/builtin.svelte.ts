/**
 * The commands the shell itself owns: navigation, appearance, connection, and the four instant
 * actions from the plan.
 *
 * The instant actions are registered even though three of the four have no daemon endpoint behind
 * them yet. That is deliberate and is the whole reason the registry exists in Phase 1: a command
 * that appears the day its endpoint lands is a command nobody discovers, and retrofitting a
 * registry onto screens that already grew their own buttons costs far more than carrying a few
 * stubs. A stub says so out loud when it is run — it never silently does nothing.
 */

import { registerCommands } from "../commands.svelte.ts";
import { launchLink } from "../format.ts";
import { navigate, ROUTE_IDS, type RouteId } from "../router.ts";
import { app } from "../state/app.svelte.ts";
import { theme } from "../state/theme.svelte.ts";

const NAV_TITLES: Record<RouteId, string> = {
  sessions: "Go to Live sessions",
  accounts: "Go to Accounts",
  login: "Add an account",
  friends: "Go to Friends",
  feed: "Go to Feed",
  gamelog: "Go to Game log",
  notifications: "Go to Notifications",
  settings: "Go to Settings",
};

const NAV_SUBTITLES: Record<RouteId, string> = {
  sessions: "VRChat game clients running on this machine",
  accounts: "Accounts vrc.zip holds credentials for",
  login: "Sign in to another VRChat account",
  friends: "Friend presence across every signed-in account",
  feed: "Everything that happened, newest first",
  gamelog: "Parsed lines from the running clients' log files",
  notifications: "Invites, friend requests, and messages",
  settings: "Contact address, log directories, ports",
};

/** How a stub reports itself. Injected so the shell owns the toast library, not this module. */
export interface CommandHost {
  readonly notImplemented: (title: string, why: string) => void;
  readonly openPalette: () => void;
}

export function registerBuiltinCommands(host: CommandHost): () => void {
  const navigation = ROUTE_IDS.filter((id) => id !== "login").map((id) => ({
    id: `nav.${id}`,
    title: NAV_TITLES[id],
    subtitle: NAV_SUBTITLES[id],
    group: "Navigation" as const,
    run: (): void => {
      navigate(id);
    },
  }));

  return registerCommands([
    ...navigation,

    {
      id: "app.palette",
      title: "Show all commands",
      subtitle: "Everything this build can do, in one list",
      group: "Application",
      keybinding: "Ctrl+Shift+P",
      keywords: ["palette", "search", "actions"],
      run: host.openPalette,
    },
    {
      id: "app.theme",
      title: "Toggle dark mode",
      subtitle: "Remembered per browser profile, not per account",
      group: "Application",
      keywords: ["light", "dark", "appearance"],
      run: (): void => {
        theme.toggle();
      },
    },
    {
      id: "app.reconnect",
      title: "Reconnect to the daemon",
      subtitle: "Re-read everything and reopen the event socket",
      group: "Application",
      keywords: ["refresh", "reload", "retry", "offline"],
      run: (): void => {
        app.retry();
      },
    },

    {
      id: "accounts.add",
      title: "Add an account",
      subtitle: "Sign in to another VRChat account",
      group: "Accounts",
      keywords: ["login", "sign in", "new"],
      run: (): void => {
        navigate("login");
      },
    },

    // --- instant actions -----------------------------------------------------
    // The plan's four. Only "jump to instance" can be honoured entirely in the browser today,
    // because a `vrchat://` link needs no daemon; the other three need endpoints that do not
    // exist yet, so they stay listed, stay disabled when there is nothing to act on, and say
    // exactly what is missing when they are run.
    {
      id: "instant.jump",
      title: "Jump to a running client's instance",
      subtitle: "Opens VRChat on the instance the first running client is in",
      group: "Instant actions",
      keywords: ["join", "launch", "instance", "world"],
      enabled: (): boolean =>
        app.sessions.some((session) => launchLink(session.currentLocation) !== null),
      run: (): void => {
        const target = app.sessions.find((session) => launchLink(session.currentLocation) !== null);
        const link = launchLink(target?.currentLocation ?? null);
        if (link === null) return;
        window.location.href = link;
      },
    },
    {
      id: "instant.invite",
      title: "Invite a friend to your instance",
      subtitle: "No daemon endpoint yet. Waiting on POST /api/invites.",
      group: "Instant actions",
      keywords: ["invite", "bring", "friend"],
      run: (): void => {
        host.notImplemented(
          "Invite a friend",
          "The daemon has no invite endpoint yet. The command is registered now so it appears the day the route lands.",
        );
      },
    },
    {
      id: "instant.invite-request",
      title: "Ask a friend for an invite",
      subtitle: "No daemon endpoint yet. Waiting on POST /api/invite-requests.",
      group: "Instant actions",
      keywords: ["request", "invite me", "join"],
      run: (): void => {
        host.notImplemented(
          "Request an invite",
          "The daemon has no invite-request endpoint yet. The command is registered now so it appears the day the route lands.",
        );
      },
    },
    {
      id: "instant.boop",
      title: "Boop a friend",
      subtitle: "No daemon endpoint yet. VRChat's interaction API is not wired up.",
      group: "Instant actions",
      keywords: ["poke", "wave", "hello"],
      run: (): void => {
        host.notImplemented(
          "Boop",
          "VRChat's interaction API is not wired into the daemon yet. The command is registered now so it appears the day it is.",
        );
      },
    },
  ]);
}
