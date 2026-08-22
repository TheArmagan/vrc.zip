<!--
  One friend, in the same shape as a feed row: identity, what they are doing, where, and an
  expander for everything that does not fit on a line.

  ## What the expander is for

  A friend row can only show what `GET /api/friends` carries: name, status, location, platform. The
  things people actually want next — trust rank, whether VRChat has age-verified them, their bio,
  when the friendship started — live on the profile, which is a request per person and must not be
  made for a list. So the expander is the gesture that authorises it: `userProfiles.ensure` runs
  when a row is opened, which is a person asking, exactly as the hover card does.
-->
<script lang="ts">
import ChevronIcon from "@lucide/svelte/icons/chevron-down";
import { type Friend, imageUrl } from "$lib/api.ts";
import LocationLine from "$lib/components/LocationLine.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import StatusDot from "$lib/components/StatusDot.svelte";
import UserName from "$lib/components/UserName.svelte";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from "$lib/components/ui/avatar/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import {
  ageVerifiedLabel,
  calendarDay,
  fullTimestamp,
  initials,
  platformLabel,
  statusLabel,
  trustClass,
  trustLabel,
} from "$lib/format.ts";
import { userProfiles } from "$lib/state/user-profiles.svelte.ts";
import { cn } from "$lib/utils.js";

let {
  friend,
  accountId = null,
}: {
  friend: Friend;
  /** The account this friend was seen through; decides which client a join moves. */
  accountId?: string | null;
} = $props();

let expanded = $state(false);

const platform = $derived(platformLabel(friend.platform));

/* Pure reads: they start nothing, so a thousand collapsed rows cost a thousand map lookups. */
const profile = $derived(userProfiles.get(friend.id, accountId));
const entry = $derived(userProfiles.entry(friend.id, accountId));

const trust = $derived(trustLabel(profile?.trustLevel ?? null));
const age = $derived(
  profile === null ? null : ageVerifiedLabel(profile.ageVerificationStatus, profile.ageVerified),
);

function toggle(): void {
  expanded = !expanded;
  // The open gesture is what authorises the request. Closing and reopening costs nothing extra:
  // `ensure` refuses to re-ask inside its freshness window.
  if (expanded) userProfiles.ensure(friend.id, accountId);
}
</script>

<li class="px-4 py-3">
  <div class="flex items-center gap-3">
    <!--
      alt="" on purpose: the display name is right there in the next column, so a screen reader
      announcing the icon as well would read the name twice. The presence dot is aria-hidden for
      the same reason — the status word is spelled out further along the row, so colour is never
      the only signal.
    -->
    <Avatar class="size-9 shrink-0">
      <AvatarImage src={imageUrl(friend.iconUrl)} alt="" loading="lazy" />
      <AvatarFallback class="text-xs">{initials(friend.displayName)}</AvatarFallback>
      <AvatarBadge class="bg-transparent ring-background">
        <StatusDot status={friend.status} size={null} class="size-full" />
      </AvatarBadge>
    </Avatar>

    <div class="min-w-0 flex-1">
      <p class="truncate text-sm">
        <UserName
          userId={friend.id}
          name={friend.displayName}
          {accountId}
          class="max-w-full truncate"
        />
      </p>
      {#if friend.statusDescription}
        <p class="truncate text-xs text-muted-foreground">{friend.statusDescription}</p>
      {/if}
    </div>

    <div class="hidden min-w-0 flex-1 sm:block">
      {#if friend.status === "offline"}
        <p class="text-xs text-muted-foreground">
          {#if friend.lastSeenAt !== null}
            Last seen <RelativeTime ts={friend.lastSeenAt} />
          {:else}
            Offline
          {/if}
        </p>
      {:else}
        <LocationLine location={friend.location} {accountId} />
      {/if}
    </div>

    <span class="w-24 shrink-0 text-right text-xs text-muted-foreground">
      {statusLabel(friend.status)}
    </span>

    <span class="tabular w-12 shrink-0 text-right text-xs text-muted-foreground">
      {platform ?? ""}
    </span>

    <button
      type="button"
      class="size-5 shrink-0 cursor-pointer rounded-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-expanded={expanded}
      aria-label={expanded
        ? `Hide details for ${friend.displayName}`
        : `Show details for ${friend.displayName}`}
      onclick={toggle}
    >
      <ChevronIcon class="size-4 transition-transform {expanded ? 'rotate-180' : ''}" />
    </button>
  </div>

  {#if expanded}
    <div class="mt-3 ml-12 space-y-2 border-l-2 border-border/60 pl-3">
      {#if trust !== null || age !== null || platform !== null}
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
          {#if platform !== null}
            <Badge variant="outline" class="h-5 px-1.5 text-[10px]">{platform}</Badge>
          {/if}
        </div>
      {/if}

      {#if profile !== null && profile.bio}
        <p class="whitespace-pre-wrap text-xs text-muted-foreground">{profile.bio}</p>
      {/if}

      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {#if profile?.pronouns}
          <dt class="text-muted-foreground">Pronouns</dt>
          <dd>{profile.pronouns}</dd>
        {/if}

        {#if profile?.friendedAt != null}
          <dt class="text-muted-foreground">Friends since</dt>
          <dd>{calendarDay(profile.friendedAt)}</dd>
        {/if}

        {#if friend.lastSeenAt !== null}
          <dt class="text-muted-foreground">Last seen</dt>
          <dd class="tabular">{fullTimestamp(friend.lastSeenAt)}</dd>
        {/if}

        {#if friend.location !== null && friend.location !== ""}
          <dt class="text-muted-foreground">Location</dt>
          <dd class="font-mono break-all">{friend.location}</dd>
        {/if}

        <dt class="text-muted-foreground">Id</dt>
        <dd class="font-mono break-all">{friend.id}</dd>
      </dl>

      {#if profile === null}
        <!--
          Absence is never a claim here, the same rule the hover card follows: `no-account` means
          vrc.zip holds no signed-in account to ask VRChat through, which is a fact about vrc.zip
          rather than about this person.
        -->
        <p class="text-xs text-muted-foreground">
          {#if entry?.status === "unavailable" && entry.reason === "no-account"}
            No signed-in account to ask VRChat through, so there is nothing more to read yet.
          {:else if entry?.status === "unavailable"}
            VRChat has no record of this user id.
          {:else if entry?.status === "error" && entry.error !== null}
            This profile could not be read: {entry.error}
          {:else}
            Reading this profile…
          {/if}
        </p>
      {/if}
    </div>
  {/if}
</li>
