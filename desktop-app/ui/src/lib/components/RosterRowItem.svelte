<!--
  One person in a live instance, in the same shape as `FriendRow`: identity, chips, when they got
  here, and an expander for everything that does not fit on a line.

  ## Why the expander is the same gesture here

  A roster row is built from two cheap sources — the game log, which costs nothing, and the
  instance-attributes snapshot, which describes the whole room in one request. Neither carries a
  bio, a pronoun, or the day someone joined VRChat: those live on the profile, which is a request
  *per person*, and a room of eighty is exactly the traffic pattern the roster store spends its
  `EAGER_FILL_LIMIT` cap avoiding. So the profile is never read for a list; opening a row is a
  person asking about that one person, and that is what authorises `userProfiles.ensure`.

  ## Why a row can be un-expandable

  VRChat has shipped the join log line both with and without a user id, and a name that never
  matched VRChat's answer recovers none. A row with no id cannot be looked up at all, so it gets no
  chevron rather than one that opens onto a permanent "reading…". The collapsed row is the whole
  truth for that person, which is the honest outcome and not a degraded one.
-->
<script lang="ts">
import ChevronIcon from "@lucide/svelte/icons/chevron-down";
import { type GameSession, imageUrl } from "$lib/api.ts";
import PlayerAttributes from "$lib/components/PlayerAttributes.svelte";
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
  calendarDay,
  chosenStatus,
  duration,
  fullTimestamp,
  initials,
  timeOfDay,
} from "$lib/format.ts";
import { clock } from "$lib/state/clock.svelte.ts";
import { instanceRoster, type RosterRow } from "$lib/state/instance-roster.svelte.ts";
import { userProfiles } from "$lib/state/user-profiles.svelte.ts";

let {
  row,
  session,
  seenThrough,
}: {
  row: RosterRow;
  /** The client this roster belongs to; supplies the account whose eyes the profile is read with. */
  session: GameSession;
  /** That account's display name, named in the friendship tooltip. */
  seenThrough: string | null;
} = $props();

let expanded = $state(false);

const status = $derived(chosenStatus(row.attributes?.status));

/** The only rows worth an expander are the ones a profile lookup can name. */
const lookupable = $derived(row.userId !== null);

/* Pure reads. They start nothing, so eighty collapsed rows cost eighty map lookups. */
const profile = $derived(userProfiles.get(row.userId, session.accountId));
const entry = $derived(userProfiles.entry(row.userId, session.accountId));

/** How the log row was joined to VRChat's answer. A name match is an inference and says so. */
const matchedText = $derived.by(() => {
  switch (row.matchedBy) {
    case "id":
      return "By user id, which the game log reported directly.";
    case "name":
      return "By display name. The game log carried no user id for this join, so vrc.zip matched the row against VRChat's own answer for this instance.";
    case null:
      return "Not matched. VRChat described nobody by this id or name, so the chips above are empty.";
  }
});

function toggle(): void {
  expanded = !expanded;
  // The open gesture is what authorises the request; `ensure` refuses to re-ask inside its
  // freshness window, so closing and reopening costs nothing.
  if (expanded) userProfiles.ensure(row.userId, session.accountId);
}
</script>

<!--
  `onmouseenter` hydrates a row the fallback deliberately skipped past its cap, which is the same
  rule the resolvers follow: fetch on hover, never on render. It is safe to fire on every row and
  every pass — `ensureUser` ignores anyone already described, already pending, or recently missing,
  and batches a pointer sweep into one request.

  On the `<li>` rather than on the name, so the whole row is the target. No keyboard equivalent is
  needed: the interactive things in the row are the name button and the chevron, and reaching
  either fetches this person in full anyway.
-->
<li
  class="px-4 py-2"
  onmouseenter={() =>
    instanceRoster.ensureUser(session.currentLocation, session.accountId, row.userId)}
>
  <div class="flex items-center gap-3">
    <!-- alt="" deliberately: the name is the next column, so announcing it twice is noise. -->
    <Avatar class="size-8 shrink-0">
      <AvatarImage src={imageUrl(row.attributes?.iconUrl)} alt="" loading="lazy" />
      <AvatarFallback class="text-[10px]">{initials(row.displayName)}</AvatarFallback>
      {#if status !== null}
        <!--
          Only a status the person *chose* — see `chosenStatus`. This list is not asking whether
          they are online: the game log has them in the room, which is a better answer than
          VRChat's and the reason the column this replaced was a lie. So nobody here gets an
          offline dot, and somebody VRChat said nothing about gets no dot at all rather than a grey
          one meaning "we did not ask".

          `ring-background` and not `ring-popover`: these rows sit on the page, unlike the same
          badge inside the modals.
        -->
        <AvatarBadge class="bg-transparent ring-background">
          <StatusDot {status} size={null} class="size-full" />
        </AvatarBadge>
      {/if}
    </Avatar>

    <div class="flex min-w-0 flex-1 items-center gap-2">
      <span class="min-w-0 truncate text-sm">
        <!--
          `row.userId` may have come from the log or been recovered by matching the name against
          VRChat's answer. With neither, `UserName` degrades to plain text rather than offering a
          click that cannot resolve.
        -->
        <UserName
          userId={row.userId}
          name={row.displayName}
          accountId={session.accountId}
          class="max-w-full truncate"
        />
      </span>
      {#if row.isSelf}
        <Badge variant="outline" class="h-5 shrink-0 px-1.5 text-[10px]">You</Badge>
      {/if}
    </div>

    <PlayerAttributes
      trustLevel={row.attributes?.trustLevel ?? null}
      ageVerificationStatus={row.attributes?.ageVerificationStatus ?? null}
      ageVerified={row.attributes?.ageVerified ?? false}
      isFriend={row.attributes?.isFriend ?? false}
      {seenThrough}
      matchedBy={row.matchedBy}
    />

    <span
      class="tabular w-24 shrink-0 text-right text-xs text-muted-foreground"
      title={`Seen joining at ${fullTimestamp(row.joinedAt)}`}
    >
      {timeOfDay(row.joinedAt)} · {duration(clock.now - row.joinedAt)}
    </span>

    {#if lookupable}
      <button
        type="button"
        class="size-5 shrink-0 cursor-pointer rounded-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-expanded={expanded}
        aria-label={expanded
          ? `Hide details for ${row.displayName}`
          : `Show details for ${row.displayName}`}
        onclick={toggle}
      >
        <ChevronIcon class="size-4 transition-transform {expanded ? 'rotate-180' : ''}" />
      </button>
    {:else}
      <!-- Holds the column so the rows above and below do not step sideways around it. -->
      <span class="size-5 shrink-0" aria-hidden="true"></span>
    {/if}
  </div>

  {#if expanded}
    <div class="mt-3 ml-11 space-y-2 border-l-2 border-border/60 pl-3">
      {#if profile !== null && profile.bio}
        <p class="whitespace-pre-wrap text-xs text-muted-foreground">{profile.bio}</p>
      {/if}

      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {#if profile?.pronouns}
          <dt class="text-muted-foreground">Pronouns</dt>
          <dd>{profile.pronouns}</dd>
        {/if}

        {#if profile?.dateJoined != null}
          <dt class="text-muted-foreground">On VRChat since</dt>
          <dd>{calendarDay(profile.dateJoined)}</dd>
        {/if}

        {#if profile?.friendedAt != null}
          <dt class="text-muted-foreground">Friends since</dt>
          <dd>{calendarDay(profile.friendedAt)}</dd>
        {/if}

        <!--
          The log's own facts, which are exact and need no network. They stay below the profile
          fields on purpose: this is the roster, and when someone walked in is the thing the screen
          was opened for.
        -->
        <dt class="text-muted-foreground">Joined this instance</dt>
        <dd class="tabular">{fullTimestamp(row.joinedAt)}</dd>

        <dt class="text-muted-foreground">Time in the room</dt>
        <dd class="tabular">{duration(clock.now - row.joinedAt)}</dd>

        <dt class="text-muted-foreground">Matched</dt>
        <dd>{matchedText}</dd>

        {#if row.userId !== null}
          <dt class="text-muted-foreground">Id</dt>
          <dd class="font-mono break-all">{row.userId}</dd>
        {/if}
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
