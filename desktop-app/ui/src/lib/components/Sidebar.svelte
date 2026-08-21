<!--
  The primary navigation.

  Two groups, and the split is the point. "Signed in" counts *accounts* — credentials vrc.zip
  holds. "Running now" counts *game clients* — VRChat processes on this machine. Six of the first
  and two of the second is an ordinary Tuesday, so the sidebar never adds them together, never
  shows one number, and puts a word next to each so the two can't be mistaken for one another.
-->
<script lang="ts">
import {
  Activity03Icon,
  ComputerIcon,
  FileScriptIcon,
  Notification03Icon,
  Settings02Icon,
  UserGroupIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/svelte";
import { hrefFor, type RouteId } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";

let { current }: { current: RouteId } = $props();

interface NavItem {
  readonly id: RouteId;
  readonly label: string;
  readonly icon: IconSvgElement;
  readonly badge?: () => number | null;
  /** What the badge counts, spelled out. Numbers next to nav items are famously ambiguous. */
  readonly badgeTitle?: string;
}

const items: readonly NavItem[] = [
  {
    id: "sessions",
    label: "Live sessions",
    icon: ComputerIcon,
    badge: () => (app.sessions.length === 0 ? null : app.sessions.length),
    badgeTitle: "VRChat game clients running now",
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: UserMultiple02Icon,
    badge: () => (app.accounts.length === 0 ? null : app.accounts.length),
    badgeTitle: "VRChat accounts vrc.zip holds credentials for",
  },
  { id: "friends", label: "Friends", icon: UserGroupIcon },
  { id: "feed", label: "Feed", icon: Activity03Icon },
  { id: "gamelog", label: "Game log", icon: FileScriptIcon },
  {
    id: "notifications",
    label: "Notifications",
    icon: Notification03Icon,
    badge: () =>
      app.unseenNotifications.length === 0 ? null : app.unseenNotifications.length,
    badgeTitle: "Unseen VRChat notifications",
  },
  { id: "settings", label: "Settings", icon: Settings02Icon },
];
</script>

<nav aria-label="Primary" class="flex w-52 shrink-0 flex-col border-r border-border bg-sidebar">
  <ul class="flex flex-col gap-px p-2">
    {#each items as item (item.id)}
      {@const badge = item.badge?.() ?? null}
      {@const active = current === item.id}
      <li>
        <a
          href={hrefFor(item.id)}
          aria-current={active ? "page" : undefined}
          class="flex items-center gap-2.5 px-2.5 py-1.5 text-[13px] transition-colors
                 {active
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'}"
        >
          <HugeiconsIcon icon={item.icon} size={16} class="shrink-0" />
          <span class="min-w-0 flex-1 truncate">{item.label}</span>
          {#if badge !== null}
            <span
              title={item.badgeTitle}
              class="tabular min-w-5 bg-muted px-1 py-px text-center text-[11px]
                     text-muted-foreground"
            >
              {badge}
            </span>
          {/if}
        </a>
      </li>
    {/each}
  </ul>

  <div class="mt-auto space-y-2 border-t border-border p-3 text-[11px] text-muted-foreground">
    <div class="flex items-baseline justify-between gap-2">
      <span>Accounts signed in</span>
      <span class="tabular text-foreground">
        {app.connectedAccounts.length}<span class="text-muted-foreground"
          >/{app.accounts.length}</span
        >
      </span>
    </div>
    <div class="flex items-baseline justify-between gap-2">
      <span>Clients running</span>
      <span class="tabular text-foreground">{app.sessions.length}</span>
    </div>
    <p class="leading-snug">
      An account can be signed in with no client running. A client can run without vrc.zip
      knowing whose it is.
    </p>
  </div>
</nav>
