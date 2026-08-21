<!--
  A VRChat display name, everywhere one appears.

  Four things make this a component rather than a class string.

  The first is that it **degrades**. A great many names in this app arrive with no user id attached:
  VRChat has added and removed the id on `OnPlayerJoined` more than once (PROGRESS.md §Gotchas), a
  bus event's `subjectId` is as likely to be a world or a notification id as a user, and a
  notification can name a sender it has no id for. With no id there is nothing to open, so this
  renders plain text — no underline, no button, no context menu, no hover card, no dead click. It
  never guesses an id from a name.

  The second is that it is a real `<button>` when it is interactive. A `<span onclick>` is invisible
  to the keyboard and announced as text, and these are the app's most-repeated control.

  The third is the hover card, the counterpart of the one `WorldLink` puts on a world. A name on its
  own is the least informative thing this app can show about a person, and the roster proves the
  point by putting an icon and a trust rank beside every stranger in the room. Hovering any name
  anywhere now gets the same reading.

  **The lookup happens on hover, never on render.** That distinction is the whole design of
  `user-profiles.svelte.ts` and it is load-bearing here: a feed page is a hundred of these mounting
  in one frame, and a fetch in an `$effect` would be a hundred profile requests for a page nobody
  has pointed at yet. `ensure` is called from `onOpenChange`, so a request is a person asking.

  The fourth is layout, which stays the caller's business. The base class carries no width, no
  display and no truncation, because these sit inside truncating flex rows: a caller that needs
  clipping passes `class="max-w-full truncate"` and gets it on the button itself, which is where
  `text-overflow` can actually apply.

  ## Why the context menu wraps and the tooltip does not

  Both primitives want to own the trigger element, and there is only one button. They cannot both
  have it — their prop bags collide on `id`, `data-state` and three pointer handlers, and spreading
  one over the other silently drops whichever lost.

  So they are split by what each actually needs. The tooltip keeps the button, because hover is
  hit-testing and it has to be the real box. The context menu becomes a wrapper carrying `contents`
  — `display: contents` generates no box, so it changes no layout and the truncation promise above
  survives — and every event it listens for (`contextmenu`, `pointerdown`, `pointermove`,
  `pointercancel`, `pointerup`) bubbles up to it from the button. It opens at the pointer's own
  coordinates rather than against the trigger's rectangle, so having no rectangle costs it nothing.
-->
<script lang="ts">
import { imageUrl } from "$lib/api.ts";
import StatusDot from "$lib/components/StatusDot.svelte";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from "$lib/components/ui/avatar/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import {
  ageVerifiedLabel,
  initials,
  isUserId,
  platformLabel,
  statusLabel,
  trustClass,
  trustLabel,
} from "$lib/format.ts";
import { userModal } from "$lib/state/user-modal.svelte.ts";
import { userProfiles } from "$lib/state/user-profiles.svelte.ts";
import { userActions } from "$lib/user-actions.ts";
import { cn } from "$lib/utils.js";

let {
  userId = null,
  name,
  accountId = null,
  class: className,
}: {
  /**
   * The VRChat user id. Anything that is not a `usr_…` is treated as absent — a `wrld_…` subject
   * would otherwise grow a clickable name that resolves to nothing.
   */
  userId?: string | null;
  name: string;
  /** The account this name was seen through; see `OpenUserOptions.accountId`. */
  accountId?: string | null;
  class?: string;
} = $props();

const openable = $derived(isUserId(userId));
const actions = $derived(
  openable && userId !== null ? userActions({ userId, name, accountId }) : [],
);

/*
 * Pure reads. `userProfiles.get`/`entry` start nothing, which is what makes it safe for every name
 * on a feed page to call them — the card is populated only for a user somebody has already hovered
 * once, and shows its own loading line for the first hover.
 */
const profile = $derived(userProfiles.get(userId, accountId));
const entry = $derived(userProfiles.entry(userId, accountId));

const trust = $derived(trustLabel(profile?.trustLevel ?? null));
const age = $derived(
  profile === null ? null : ageVerifiedLabel(profile.ageVerificationStatus, profile.ageVerified),
);
const platform = $derived(platformLabel(profile?.platform ?? null));

/** The name VRChat currently has, which can be newer than the one the caller passed in. */
const cardName = $derived(profile?.displayName ?? name);

/**
 * Why there is nothing to show, in the ordinary muted voice.
 *
 * `no-account` is not a failure and must not read as one: a profile can only be fetched through
 * somebody's credentials, and vrc.zip may be holding none that are signed in.
 */
const unavailableText = $derived.by(() => {
  if (entry === null || entry.status !== "unavailable") return null;
  if (entry.reason === "no-account") {
    return "No signed-in account to ask VRChat through, so there is nothing to read about this person yet.";
  }
  return "VRChat has no record of this user id.";
});

const INTERACTIVE =
  "cursor-pointer rounded-xs underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

/** The one place a profile request starts: a hover or a keyboard focus, which is a person asking. */
function onOpenChange(open: boolean): void {
  if (open) userProfiles.ensure(userId, accountId);
}
</script>

{#if openable && userId !== null}
  <ContextMenu.Root>
    <!-- `contents`: the menu needs an element to listen on, not a box. See the note above. -->
    <ContextMenu.Trigger class="contents">
      <Tooltip.Provider delayDuration={350}>
        <Tooltip.Root {onOpenChange}>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class={cn(INTERACTIVE, className)}
                onclick={(event) => {
                  // Names live inside rows that are themselves clickable in places. Opening the
                  // modal is the whole intent of the click, so it stops there.
                  event.stopPropagation();
                  userModal.openUser(userId, { name, accountId });
                }}
              >
                {name}
              </button>
            {/snippet}
          </Tooltip.Trigger>

          <Tooltip.Content class="max-w-xs flex-col items-stretch gap-2 p-0">
            {#if profile?.bannerUrl}
              <!--
                Through the image proxy, never a direct `<img src>`: VRChat's image host wants the
                account's auth cookie and a User-Agent the browser may not set, and answers a bare
                request with 401/403. See `imageUrl` in `api.ts`.

                Most people have never set a banner, and the card is built to look finished without
                one rather than to leave a gap where an image should have been.
              -->
              <img
                src={imageUrl(profile.bannerUrl)}
                alt=""
                loading="lazy"
                class="h-20 w-full rounded-t-2xl object-cover"
              />
            {/if}

            <div class="space-y-1.5 px-3 pt-1 pb-2">
              <div class="flex min-w-0 items-center gap-2">
                <!-- alt="" deliberately: the name is right beside it, so announcing it twice is noise. -->
                <Avatar class="size-8 shrink-0">
                  <AvatarImage src={imageUrl(profile?.iconUrl)} alt="" loading="lazy" />
                  <AvatarFallback class="text-[10px]">{initials(cardName)}</AvatarFallback>
                  {#if profile !== null}
                    <AvatarBadge class="bg-transparent ring-popover">
                      <StatusDot status={profile.status} size={null} class="size-full" />
                    </AvatarBadge>
                  {/if}
                </Avatar>

                <div class="min-w-0 flex-1">
                  <p class="truncate font-medium">{cardName}</p>
                  {#if profile !== null}
                    <p class="truncate opacity-80">
                      {statusLabel(profile.status)}{#if profile.pronouns}<span aria-hidden="true">
                          ·
                        </span>{profile.pronouns}{/if}
                    </p>
                  {/if}
                </div>
              </div>

              {#if profile !== null && profile.statusDescription}
                <p class="truncate opacity-80">{profile.statusDescription}</p>
              {/if}

              <!--
                The chips obey the rule `PlayerAttributes` sets: absence is never a claim. No age
                chip means VRChat said nothing *or* said `hidden` — a verified person keeping it
                private — and there is no "unverified" variant to render.
              -->
              {#if trust !== null || age !== null || platform !== null || profile?.isFriend}
                <div class="flex flex-wrap items-center gap-1">
                  {#if trust !== null}
                    <!-- VRChat's own rank colour; see `trustClass` for why it is not a vrc.zip token. -->
                    <Badge
                      variant="outline"
                      class={cn("h-5 px-1.5 text-[10px]", trustClass(profile?.trustLevel ?? null))}
                    >
                      {trust}
                    </Badge>
                  {/if}
                  {#if age !== null}
                    <Badge
                      variant="outline"
                      class="h-5 border-status-online/40 bg-status-online/10 px-1.5 text-[10px] text-status-online"
                    >
                      {age}
                    </Badge>
                  {/if}
                  {#if profile !== null && profile.isFriend}
                    <Badge
                      variant="outline"
                      class="h-5 border-primary/40 bg-primary/10 px-1.5 text-[10px] text-primary"
                    >
                      Friend
                    </Badge>
                  {/if}
                  {#if platform !== null}
                    <Badge variant="outline" class="h-5 px-1.5 text-[10px]">{platform}</Badge>
                  {/if}
                </div>
              {/if}

              {#if profile === null}
                {#if unavailableText !== null}
                  <p class="opacity-80">{unavailableText}</p>
                {:else if entry?.status === "error" && entry.error !== null}
                  <p class="opacity-80">This profile could not be read: {entry.error}</p>
                {:else}
                  <p class="opacity-80">Reading this profile…</p>
                {/if}
              {/if}

              <p class="font-mono text-[10px] opacity-60">{userId}</p>
              <p class="opacity-60">Click for the full profile · right-click for more</p>
            </div>
          </Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    </ContextMenu.Trigger>

    <ContextMenu.Content class="w-56">
      <!--
        `Label`, not `GroupHeading`: bits-ui's heading reads its group from context and throws
        outright when there is no `Menu.Group` above it. This is a caption, not a group.
      -->
      <ContextMenu.Label class="truncate font-medium text-foreground">{name}</ContextMenu.Label>
      <ContextMenu.Separator />
      {#each actions as action (action.id)}
        {#if action.separatorBefore}
          <ContextMenu.Separator />
        {/if}
        <ContextMenu.Item onSelect={action.run}>
          <action.icon />
          {action.label}
        </ContextMenu.Item>
      {/each}
    </ContextMenu.Content>
  </ContextMenu.Root>
{:else}
  <span class={className}>{name}</span>
{/if}
