<!--
  The shell every entity dialog in vrc.zip is built out of.

  There are three of these — a user, a world, a group — and before this component there were three
  copies of the same twelve lines of dialog chrome. They had already drifted: one header pulled up
  by `-mt-10` and one by `-mt-6`, one title that truncated and one that wrapped, one banner that
  was `h-28` and one `h-40`, and a body that scrolled in two subtly different ways. None of that
  was a decision anybody made; it was three files edited on three days.

  So the chrome lives here and the *contents* stay with the caller. What this owns is exactly the
  part that must be identical everywhere:

  - the dialog itself, its size, and its close behaviour;
  - the three-row grid — banner, header, scrolling body — that keeps the body the only thing that
    ever scrolls, so a long bio never pushes the title off the top;
  - the banner band, always drawn, image or not (see `HeroBanner`);
  - the header's shape: an optional avatar, the title, a description line, an actions slot at the
    right, and a badge row beneath.

  What it does *not* own is the body. Callers pass either a tabbed body — `tabs` plus
  `Tabs.Content` children, which is the user modal — or a plain one, which is the world and group
  modals, where the record reads as a single document rather than four kinds of thing. Both get the
  same scroll container and the same padding, which is the whole point.

  Layout escape hatches (`bannerClass`, `headerClass`, `titleClass`) exist because a world's hero
  image genuinely wants more height than a user's banner and a world's name genuinely wants to wrap
  where a display name should clip. They are for those differences and not for new ones: anything
  that would look like a fourth style of dialog belongs in this file, applied to all three.
-->
<script module lang="ts">
/**
 * One entry on the tab strip. `count` is a badge; null or absent means "nothing to say", which is
 * not the same claim as zero — a tab that has not loaded yet has no count, and its own empty state
 * is the only thing allowed to say "none".
 *
 * In the module script because a type has to be importable by the callers that build these lists.
 */
export interface ModalTab {
  readonly value: string;
  readonly label: string;
  readonly count?: number | null;
}
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import HeroBanner from "$lib/components/HeroBanner.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import { cn } from "$lib/utils.js";

let {
  open,
  onClose,
  bannerUrl = null,
  bannerClass = "",
  title,
  titleClass = "truncate",
  headerClass = "-mt-10",
  avatar,
  subtitle,
  actions,
  badges,
  tabs,
  tab = "",
  onSelectTab = () => {},
  tabsLabel = "Sections",
  children,
}: {
  open: boolean;
  /** Called for every close gesture — the X, Escape, and a click outside. */
  onClose: () => void;
  bannerUrl?: string | null;
  /** Height only, in practice. The band is drawn either way; see `HeroBanner`. */
  bannerClass?: string;
  title: string;
  /** `truncate` for a name that must clip, `break-words` for one that should wrap. */
  titleClass?: string;
  /** How far the header rides up into the banner — it depends on whether there is an avatar. */
  headerClass?: string;
  avatar?: Snippet;
  subtitle?: Snippet;
  actions?: Snippet;
  badges?: Snippet;
  /** Present for a tabbed body, absent for a plain one. Both scroll the same way. */
  tabs?: readonly ModalTab[];
  tab?: string;
  onSelectTab?: (value: string) => void;
  tabsLabel?: string;
  children: Snippet;
} = $props();

const BODY = "min-h-0 overflow-y-auto px-6 pt-4 pb-6";
</script>

<Dialog.Root
  {open}
  onOpenChange={(next) => {
    if (!next) onClose();
  }}
>
  <Dialog.Content
    class="grid max-h-[85vh] grid-rows-[auto_auto_minmax(0,1fr)] gap-4 p-0 sm:max-w-2xl"
  >
    <!--
      Always drawn, image or not — see `HeroBanner` for why the empty case is the design rather
      than a fallback. Whatever overlaps it from the header below only lines up because the band is
      one height for every record of a given kind.
    -->
    <HeroBanner url={bannerUrl} class={bannerClass} />

    <!--
      `relative z-10` is load-bearing, not decoration. The header deliberately rides up into the
      banner, and the banner's scrim is an `absolute` child — which paints above static in-flow
      content **whatever the DOM order**. Without a stacking position here the scrim lies over the
      display name and slices it in half horizontally, which is exactly what it did.

      Fixing it here rather than by darkening the scrim matters: the scrim was made near-opaque to
      compensate, and that swallowed most of a world's hero image in gray. The text belongs above
      the overlay; the overlay does not belong over the text.
    -->
    <Dialog.Header class={cn("relative z-10 gap-3 px-6", headerClass)}>
      <!-- `pr-8` keeps the title clear of the dialog's own close button, which floats top-right. -->
      <div class="flex min-w-0 items-end gap-3 pr-8">
        {@render avatar?.()}

        <div class="min-w-0 flex-1">
          <Dialog.Title class={cn("text-base leading-snug", titleClass)}>{title}</Dialog.Title>
          <Dialog.Description class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {@render subtitle?.()}
          </Dialog.Description>
        </div>

        {@render actions?.()}
      </div>

      {#if badges !== undefined}
        <div class="flex flex-wrap items-center gap-2">
          {@render badges()}
        </div>
      {/if}
    </Dialog.Header>

    {#if tabs !== undefined && tabs.length > 0}
      <Tabs.Root
        value={tab}
        onValueChange={onSelectTab}
        class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-0"
      >
        <Tabs.List variant="line" class="px-6" aria-label={tabsLabel}>
          {#each tabs as entry (entry.value)}
            <Tabs.Trigger value={entry.value}>
              {entry.label}
              {#if entry.count !== null && entry.count !== undefined}
                <Badge variant="secondary" class="tabular">{entry.count}</Badge>
              {/if}
            </Tabs.Trigger>
          {/each}
        </Tabs.List>

        <div class={BODY}>
          {@render children()}
        </div>
      </Tabs.Root>
    {:else}
      <div class={cn(BODY, "space-y-4")}>
        {@render children()}
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
