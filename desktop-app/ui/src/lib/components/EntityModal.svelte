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

  ## The back control

  The three modals share one screen and a back stack — `entity-modal.svelte.ts` explains why — so
  closing this dialog often means *stepping back* to whatever it was opened from. That is a
  perfectly good behaviour and a terrible surprise: a close button that reopens something is
  indistinguishable from a bug unless the reader was told where it goes.

  So when there is a level below, the banner grows a control that names it. It calls `onClose`,
  because back and close are the same action here and giving them two handlers would be inventing a
  difference the model does not have. It sits opposite the dialog's own X for the same reason a
  browser puts Back at the far left: the two controls are read together, and the labelled one is
  what teaches the reader what the unlabelled one does.
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
import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
import HeroBanner from "$lib/components/HeroBanner.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import { cn } from "$lib/utils.js";

let {
  open,
  onClose,
  backLabel = null,
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
  /** Called for every close gesture — the X, Escape, a click outside, and the back control. */
  onClose: () => void;
  /**
   * What closing this dialog would return to, or null when it would dismiss.
   *
   * Present means a back control is drawn naming it. It is a label rather than a handler because
   * there is only one thing it could do — see the note above.
   */
  backLabel?: string | null;
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

    {#if backLabel !== null && backLabel !== ""}
      <!--
        Over the banner rather than in the header, which rides up into it: the header's row is
        already the avatar, the title and the actions, and a fourth thing in it would push the
        title off its baseline on exactly the records that have the longest names.

        `max-w-[55%]` keeps it clear of the X at any name length, and the label truncates rather
        than wrapping — a two-line back button would overlap the avatar below it.
      -->
      <button
        type="button"
        onclick={onClose}
        class="absolute top-3.5 left-4 z-20 inline-flex max-w-[55%] items-center gap-1 rounded-full bg-popover/85 px-2 py-1 text-xs text-popover-foreground ring-1 ring-foreground/10 backdrop-blur transition-colors hover:bg-popover focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <ChevronLeftIcon class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="truncate">{backLabel}</span>
      </button>
    {/if}

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
