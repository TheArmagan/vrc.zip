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
import { Input } from "$lib/components/ui/input/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import PlugIcon from "@lucide/svelte/icons/plug";
import PlugZapIcon from "@lucide/svelte/icons/plug-zap";
import { hrefFor, type RouteId } from "$lib/router.ts";
import { app } from "$lib/state/app.svelte.ts";
import { consent } from "$lib/state/consent.svelte.ts";
import { pluginContributions } from "$lib/state/plugin-contributions.svelte.ts";

let { current }: { current: RouteId } = $props();

/** The sidebar filter. Local and transient — it is a way of looking, not a setting. */
let filter = $state("");

/** Case-insensitive substring, the same rule for a built-in entry and a plugin's panel. */
function matches(...text: readonly string[]): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return true;
  return text.some((value) => value.toLowerCase().includes(needle));
}

interface NavItem {
  readonly id: RouteId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly badge?: () => number | null;
  /** What the badge counts, spelled out. Numbers next to nav items are famously ambiguous. */
  readonly badgeTitle?: string;
}

const allItems: readonly NavItem[] = [
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
  {
    id: "consent",
    label: "App access",
    icon: PlugZapIcon,
    badge: () => (consent.count === 0 ? null : consent.count),
    badgeTitle: "Apps waiting for you to approve them",
  },
  { id: "apps", label: "Connected apps", icon: KeyRoundIcon },
  { id: "plugins", label: "Plugins", icon: PlugIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

const visibleItems = $derived(allItems.filter((item) => matches(item.label)));

const visibleGroups = $derived(
  pluginContributions.sidebarGroups
    .map((group) => ({
      ...group,
      entries: matches(group.pluginName)
        ? group.entries
        : group.entries.filter((entry) => matches(entry.title)),
    }))
    .filter((group) => group.entries.length > 0),
);

/**
 * Every visible destination, in the order they are drawn.
 *
 * Flat, because arrow keys move through *what the eye sees* rather than through a data structure:
 * the plugin groups are headings, not stops, so walking the built-in list and then each group's
 * entries is exactly the sequence a reader would follow with a finger.
 */
const walkable = $derived([
  ...visibleItems.map((item) => ({ key: item.id, href: hrefFor(item.id) })),
  ...visibleGroups.flatMap((group) =>
    group.entries.map((entry) => ({
      key: `${entry.pluginId}/${entry.panelId}`,
      href: hrefFor("plugin", entry.pluginId, undefined, entry.panelId),
    })),
  ),
]);

/**
 * Which entry the arrow keys have landed on, or null before they have been used.
 *
 * Null rather than 0 on purpose: pre-selecting the first row would mean Enter navigates somewhere
 * the moment the box is focused, which is a trap for anyone who typed a filter and then reached for
 * Enter out of habit. The first ArrowDown is what commits to a selection.
 */
let activeKey = $state<string | null>(null);

// A filter that no longer contains the highlighted entry loses the highlight, rather than keeping a
// selection on something invisible.
$effect(() => {
  if (activeKey !== null && !walkable.some((entry) => entry.key === activeKey)) activeKey = null;
});

function move(delta: number): void {
  if (walkable.length === 0) return;
  const current = walkable.findIndex((entry) => entry.key === activeKey);
  // From nothing, Down lands on the first and Up on the last — the wrap people expect from a menu.
  const next =
    current === -1
      ? delta > 0
        ? 0
        : walkable.length - 1
      : (current + delta + walkable.length) % walkable.length;
  activeKey = walkable[next]?.key ?? null;
}

function onFilterKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
    return;
  }
  if (event.key === "Enter") {
    const target = walkable.find((entry) => entry.key === activeKey);
    if (target === undefined) return;
    event.preventDefault();
    window.location.hash = target.href.replace(/^#/, "#");
    // The highlight is a *pending* choice, and Enter spends it. Leaving it on would put a ring on
    // one entry while `aria-current` sits on another — two marks claiming to say where you are —
    // and the next Enter would re-navigate somewhere the user has already been.
    activeKey = null;
    return;
  }
  if (event.key === "Escape") {
    // Escape clears the filter first and only gives up focus once there is nothing to clear, so
    // one key does the two things a reader means by "never mind" in the order they mean them.
    if (filter !== "") {
      event.preventDefault();
      filter = "";
      activeKey = null;
    }
  }
}

/**
 * Plugin groups, filtered.
 *
 * A group survives if its *plugin name* matches or any of its panels do — so typing a plugin's name
 * shows everything it contributes, and typing a panel's name shows just that one. A group whose
 * name matched but whose entries were then all filtered away would be a heading over nothing.
 */

</script>

<nav aria-label="Primary" class="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar">
  <!--
    A filter, because this list grows without bound.

    The built-in entries are a fixed dozen; plugin panels are not, and a sidebar with thirty of them
    is one nobody reads. Filtering rather than collapsing: a collapsed group hides the thing you are
    looking for behind a guess about which group it is in, while a filter over the words you can see
    needs no such guess.

    Not a replacement for the command palette. That is for *doing*; this is for *going*, and it
    keeps the destination visible while you narrow it, which is what makes it usable with one hand
    while reading the page.
  -->
  <div class="p-2 pb-1">
    <Input
      type="search"
      placeholder="Filter"
      aria-label="Filter the sidebar"
      class="h-8 text-xs"
      value={filter}
      oninput={(event) => {
        filter = event.currentTarget.value;
      }}
      onkeydown={onFilterKeydown}
    />
  </div>

  <!--
    The scroll container is the *list*, not the whole nav: the footer counts stay pinned to the
    bottom where they are always readable, which is the half a plain `overflow-y-auto` on the nav
    would have scrolled away.
  -->
  <div class="min-h-0 flex-1 overflow-y-auto">
  <ul class="flex flex-col p-2 pt-1">
    {#each visibleItems as item (item.id)}
      {@const badge = item.badge?.() ?? null}
      {@const active = current === item.id}
      {@const Icon = item.icon}
      <li>
        <a
          href={hrefFor(item.id)}
          aria-current={active ? "page" : undefined}
          class="flex items-center gap-3 px-3 py-2 text-sm transition-colors {active
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'} {activeKey ===
          item.id
            ? 'ring-1 ring-primary/60 ring-inset'
            : ''}"
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

  {#if visibleGroups.length > 0}
    <!--
      Plugin panels, one group per plugin.

      Grouped rather than listed flat because with two plugins installed a flat list is one where
      nobody can tell whose entry is whose — the same reason the command palette gives each plugin
      its own group. The "Plugins" label above them all is what says these are not vrc.zip: a panel
      named "Notes" sitting under Settings would read as a feature of the app.

      A stopped plugin keeps its entries, greyed and labelled. The entry vanishing would hide the
      one fact that explains why the thing they installed stopped working.
    -->
    <Separator />
    <p class="px-3 pt-3 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Plugins
    </p>
    {#each visibleGroups as group (group.pluginId)}
      <p class="truncate px-3 pt-2 pb-0.5 text-[11px] text-muted-foreground/70" title={group.pluginName}>
        {group.pluginName}
      </p>
      <ul class="flex flex-col px-2 pb-1">
        {#each group.entries as entry (`${entry.pluginId}/${entry.panelId}`)}
          <li>
            <a
              href={hrefFor("plugin", entry.pluginId, undefined, entry.panelId)}
              title="{entry.title} — from {entry.pluginName}"
              class="flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground {activeKey ===
              `${entry.pluginId}/${entry.panelId}`
                ? 'ring-1 ring-primary/60 ring-inset'
                : ''}"
            >
              <PlugIcon class="size-4 shrink-0 {entry.live ? '' : 'opacity-40'}" />
              <span class="min-w-0 flex-1 truncate {entry.live ? '' : 'opacity-60'}">
                {entry.title}
              </span>
              {#if !entry.live}
                <span class="text-[10px] text-muted-foreground">stopped</span>
              {/if}
            </a>
          </li>
        {/each}
      </ul>
    {/each}
  {/if}

  {#if filter.trim() !== "" && visibleItems.length === 0 && visibleGroups.length === 0}
    <p class="px-3 py-2 text-muted-foreground text-xs">Nothing matches "{filter.trim()}".</p>
  {/if}
  </div>

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
