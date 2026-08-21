<!--
  The primary navigation.

  Two groups, and the split is the point. "Signed in" counts *accounts* — credentials vrc.zip
  holds. "Running now" counts *game clients* — VRChat processes on this machine. Six of the first
  and two of the second is an ordinary Tuesday, so the sidebar never adds them together, never
  shows one number, and puts a word next to each so the two can't be mistaken for one another.
-->
<script lang="ts">
import type { LucideIcon } from "@lucide/svelte";
import ActivityIcon from "@lucide/svelte/icons/activity";
import BellIcon from "@lucide/svelte/icons/bell";
import MonitorIcon from "@lucide/svelte/icons/monitor";
import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
import SettingsIcon from "@lucide/svelte/icons/settings";
import UsersIcon from "@lucide/svelte/icons/users";
import UsersRoundIcon from "@lucide/svelte/icons/users-round";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { hrefFor, type RouteId } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";

let { current }: { current: RouteId } = $props();

interface NavItem {
  readonly id: RouteId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly badge?: () => number | null;
  /** What the badge counts, spelled out. Numbers next to nav items are famously ambiguous. */
  readonly badgeTitle?: string;
}

const items: readonly NavItem[] = [
  {
    id: "sessions",
    label: "Live sessions",
    icon: MonitorIcon,
    badge: () => (app.sessions.length === 0 ? null : app.sessions.length),
    badgeTitle: "VRChat game clients running now",
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: UsersRoundIcon,
    badge: () => (app.accounts.length === 0 ? null : app.accounts.length),
    badgeTitle: "VRChat accounts vrc.zip holds credentials for",
  },
  { id: "friends", label: "Friends", icon: UsersIcon },
  { id: "feed", label: "Feed", icon: ActivityIcon },
  { id: "gamelog", label: "Game log", icon: ScrollTextIcon },
  {
    id: "notifications",
    label: "Notifications",
    icon: BellIcon,
    badge: () => (app.unseenNotifications.length === 0 ? null : app.unseenNotifications.length),
    badgeTitle: "Unseen VRChat notifications",
  },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];
</script>

<nav aria-label="Primary" class="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar">
  <ul class="flex flex-col p-2">
    {#each items as item (item.id)}
      {@const badge = item.badge?.() ?? null}
      {@const active = current === item.id}
      {@const Icon = item.icon}
      <li>
        <a
          href={hrefFor(item.id)}
          aria-current={active ? "page" : undefined}
          class="flex items-center gap-3 px-3 py-2 text-sm transition-colors {active
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'}"
        >
          <Icon class="size-4 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{item.label}</span>
          {#if badge !== null}
            <Badge variant="secondary" class="tabular" title={item.badgeTitle}>{badge}</Badge>
          {/if}
        </a>
      </li>
    {/each}
  </ul>

  <div class="mt-auto">
    <Separator />
    <dl class="space-y-2 p-4 text-xs text-muted-foreground">
      <div class="flex items-baseline justify-between gap-2">
        <dt>Accounts signed in</dt>
        <dd class="tabular text-foreground">
          {app.connectedAccounts.length}<span class="text-muted-foreground"
            >/{app.accounts.length}</span
          >
        </dd>
      </div>
      <div class="flex items-baseline justify-between gap-2">
        <dt>Clients running</dt>
        <dd class="tabular text-foreground">{app.sessions.length}</dd>
      </div>
    </dl>
    <p class="px-4 pb-4 text-xs leading-relaxed text-muted-foreground">
      An account can be signed in with no client running. A client can run without vrc.zip knowing
      whose it is.
    </p>
  </div>
</nav>
