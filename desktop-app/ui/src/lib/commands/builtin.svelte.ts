/**
 * The commands the shell itself owns: navigation, appearance, connection, and the four instant
 * actions from the plan.
 *
 * The instant actions are registered even though two of the four still have no daemon endpoint
 * behind them. That is deliberate and is the whole reason the registry exists in Phase 1: a command
 * that appears the day its endpoint lands is a command nobody discovers, and retrofitting a
 * registry onto screens that already grew their own buttons costs far more than carrying a few
 * stubs. A stub says so out loud when it is run — it never silently does nothing.
 */

import { api, describeError } from "../api.ts";
import { registerCommands } from "../commands.svelte.ts";
import { parseLocation, planJoin } from "../format.ts";
import { requestJoin } from "../join.ts";
import { navigate, ROUTE_IDS, type RouteId } from "../router.ts";
import { app } from "../state/app.svelte.ts";
import { prefs } from "../state/prefs.svelte.ts";
import { theme } from "../state/theme.svelte.ts";
import { registerDirectCommands } from "./direct.svelte.ts";
import type { CommandHost } from "./host.ts";

export type { CommandHost };

/**
 * Routes with no meaningful bare form, so no palette entry.
 *
 * `login` needs to be reached through the accounts screen, which is where the "add an account"
 * affordance already lives. `groups` is the first route that *requires* a param: `#/groups` with no
 * group id is not a screen, and a palette command that navigates somewhere blank is worse than one
 * that is missing. Both stay in `ROUTE_IDS` because they are real routes; they are just not
 * destinations you can pick out of a list.
 */
const UNLISTED_ROUTES: readonly RouteId[] = ["login", "groups"];

const NAV_TITLES: Record<RouteId, string> = {
  sessions: "Go to Live sessions",
  accounts: "Go to Accounts",
  login: "Add an account",
  friends: "Go to Friends",
  feed: "Go to Feed",
  gamelog: "Go to Game log",
  notifications: "Go to Notifications",
  groups: "Go to a group",
  consent: "Go to App access",
  apps: "Go to Connected apps",
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
  groups: "Reached from a group badge or a profile, never on its own",
  consent: "Apps asking to use your VRChat accounts through vrc.zip",
  apps: "Standing app access, and the switch that cuts it off",
  settings: "Contact address, log directories, ports",
};

/**
 * The first running client whose instance another client could be sent to.
 *
 * Locations only ever come from running clients here — the palette has no target picker — so the
 * plan is an invite or nothing. `planJoin` returns `here` for the client that is already there.
 */
function firstJoinable(): { currentLocation: string | null; accountId: string | null } | null {
  return (
    app.sessions.find(
      (session) =>
        planJoin(session.currentLocation, app.sessions, session.accountId)?.kind === "invite",
    ) ?? null
  );
}

/** The location of the first running client that is somewhere nameable, or null. */
function firstLocated(): string | null {
  const session = app.sessions.find(
    (entry) => entry.currentLocation !== null && !parseLocation(entry.currentLocation).opaque,
  );
  return session?.currentLocation ?? null;
}

export function registerBuiltinCommands(host: CommandHost): () => void {
  const disposeDirect = registerDirectCommands(host);

  const navigation = ROUTE_IDS.filter((id) => !UNLISTED_ROUTES.includes(id)).map((id) => ({
    id: `nav.${id}`,
    title: NAV_TITLES[id],
    subtitle: NAV_SUBTITLES[id],
    group: "Navigation" as const,
    run: (): void => {
      navigate(id);
    },
  }));

  const disposeBuiltins = registerCommands([
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
      id: "sessions.copy-location",
      title: "Copy a running client's instance location",
      subtitle: "The location string, ready to paste into a chat or back into this palette",
      group: "Sessions",
      keywords: ["clipboard", "share", "instance", "where"],
      enabled: (): boolean => firstLocated() !== null,
      run: async (): Promise<void> => {
        const location = firstLocated();
        if (location === null) return;
        try {
          await navigator.clipboard.writeText(location);
          host.notify("success", "Location copied", location);
        } catch {
          host.notify(
            "error",
            "Could not write to the clipboard",
            "The browser refused clipboard access to the page.",
          );
        }
      },
    },

    {
      id: "notifications.mark-all-seen",
      title: "Mark every notification as seen",
      subtitle: "Clears the unseen count. Nothing is deleted — VRChat's own inbox is untouched.",
      group: "Notifications",
      keywords: ["read", "clear", "inbox", "dismiss"],
      enabled: (): boolean => app.unseenNotifications.length > 0,
      run: async (): Promise<void> => {
        const pending = app.unseenNotifications.map((item) => item.id);
        await Promise.all(pending.map((id) => app.markNotificationSeen(id)));
        host.notify(
          "success",
          pending.length === 1
            ? "1 notification marked seen"
            : `${pending.length} notifications marked seen`,
        );
      },
    },

    {
      id: "apps.revoke-all",
      title: "Cut off every connected app",
      subtitle: "Opens Connected apps, where the second click confirms it",
      group: "App access",
      keywords: ["revoke", "kill switch", "disconnect", "grants"],
      // Deliberately not the call itself. Revoking every grant is irreversible, and the screen
      // arms the button with a first click for exactly that reason; a palette entry that fired it
      // on one Enter would be the same decision made with less thought, not more convenience.
      run: (): void => {
        navigate("apps");
        host.notify(
          "info",
          "Confirm on this screen",
          "Revoke all is armed by its first click and fired by the second.",
        );
      },
    },

    {
      id: "data.run-retention",
      title: "Run the retention pass now",
      subtitle: "Deletes whatever is already past its window, without waiting for the daily pass",
      group: "Data",
      keywords: ["prune", "delete", "cleanup", "database", "vacuum"],
      run: async (): Promise<void> => {
        try {
          const result = await api.retention.run();
          host.notify(
            "success",
            result.totalDeleted === 0
              ? "Nothing was past its window"
              : `${result.totalDeleted} rows deleted`,
            `The pass took ${result.durationMs} ms.`,
          );
        } catch (error) {
          host.notify("error", "The retention pass failed", describeError(error));
        }
      },
    },

    {
      id: "feed.dense",
      title: "Toggle dense feed rows",
      subtitle: "Remembered per browser profile, like the theme",
      group: "Feed",
      keywords: ["compact", "spacing", "density"],
      run: (): void => {
        prefs.setDenseFeed(!prefs.denseFeed);
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
    // The plan's four. "Jump to instance" and self-invite are real now; the other two still need
    // endpoints that do not exist, so they stay listed, stay disabled when there is nothing to act
    // on, and say exactly what is missing when they are run.
    {
      id: "instant.jump",
      title: "Bring another client to a running client's instance",
      subtitle: "Invites one running client to where another one already is",
      group: "Instant actions",
      keywords: ["join", "jump", "invite me", "instance", "world"],
      // Enabled only when some client is somewhere another client could be sent. With a single
      // client running, the answer to "jump to its instance" is "you are already in it" — the old
      // command launched a *second* client into it, which is exactly the bug this replaces.
      enabled: (): boolean => firstJoinable() !== null,
      run: (): void => {
        const target = firstJoinable();
        if (target === null) return;
        void requestJoin(target.currentLocation, target.accountId);
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

  return () => {
    disposeDirect();
    disposeBuiltins();
  };
}
