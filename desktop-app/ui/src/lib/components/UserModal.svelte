<!--
  One VRChat user, as vrc.zip knows them.

  Mounted exactly once, by `App.svelte`, and driven entirely by `userModal` — see that module for
  why there is one instance rather than one per call site.

  The header is fixed and the body is tabbed, because the four things worth knowing about a person
  are different *kinds* of thing rather than sections of one document: who they are, what they are
  part of, who you both know, and what vrc.zip has watched them do. That last tab is the one no
  VRChat client can show, and Raw JSON behind it is the escape hatch for when the curated reading
  and the data disagree.

  Almost every row is conditional. `GET /users/{id}` returns *fewer fields* for a user the caller is
  not friends with (PROGRESS.md §Gotchas), so a non-friend renders as a short honest card, never as
  the friend layout with half its rows blank.
-->
<script lang="ts">
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import HeartHandshakeIcon from "@lucide/svelte/icons/heart-handshake";
import SearchIcon from "@lucide/svelte/icons/search";
import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
import UsersIcon from "@lucide/svelte/icons/users";
import { imageUrl, MAX_NOTE_LENGTH } from "$lib/api.ts";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import EventRow from "$lib/components/EventRow.svelte";
import LocationLine from "$lib/components/LocationLine.svelte";
import { Input } from "$lib/components/ui/input/index.js";
import HeroBanner from "$lib/components/HeroBanner.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import RepresentedGroup from "$lib/components/RepresentedGroup.svelte";
import StatusDot from "$lib/components/StatusDot.svelte";
import UserActionsMenu from "$lib/components/UserActionsMenu.svelte";
import UserName from "$lib/components/UserName.svelte";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from "$lib/components/ui/avatar/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import { rowToEvent } from "$lib/events.ts";
import {
  ageVerifiedLabel,
  calendarDay,
  groupLink,
  groupTag,
  initials,
  platformLabel,
  statusLabel,
  trustClass,
  trustLabel,
} from "$lib/format.ts";
import {
  USER_TAB_LABELS,
  USER_TABS,
  type UserTab,
  userModal,
} from "$lib/state/user-modal.svelte.ts";
import { copyText } from "$lib/user-actions.ts";
import { cn } from "$lib/utils.js";

const profile = $derived(userModal.profile);

const platform = $derived(platformLabel(profile?.platform ?? profile?.lastPlatform ?? null));
const trust = $derived(trustLabel(profile?.trustLevel ?? null));
const trustTint = $derived(trustClass(profile?.trustLevel ?? null));
const ageVerified = $derived(
  profile === null ? null : ageVerifiedLabel(profile.ageVerificationStatus, profile.ageVerified),
);
const bioLinks = $derived((profile?.bioLinks ?? []).filter((link) => link.trim() !== ""));

/**
 * VRChat's non-friend response is genuinely a different, shorter object — no location, no bio, no
 * last login. The daemon says which one this is rather than leaving the UI to infer it from a run
 * of nulls, so the modal says it in words instead of drawing empty rows.
 */
const notFriend = $derived(profile !== null && !profile.isFriend && !userModal.isOwnAccount);

/** VRChat spells "no location visible" as `""`, which is not a place. */
const location = $derived(
  profile === null || profile.location === null || profile.location === ""
    ? null
    : profile.location,
);

const raw = $derived(JSON.stringify(userModal.snapshot, null, 2));

const actionTarget = $derived({
  userId: userModal.userId ?? "",
  name: userModal.title,
  accountId: userModal.accountId,
  meta: () => userModal.snapshot,
});

/**
 * Counts on the tab strip.
 *
 * Groups and mutual friends load lazily, so their counts appear once their tab has been opened
 * rather than on arrival. A count that is absent means "not read yet", never "none" — the empty
 * state inside the tab is the only thing that claims zero.
 */
function tabCount(tab: UserTab): number | null {
  if (tab === "groups") return userModal.groupList.length || null;
  if (tab === "friends") return userModal.mutuals.length || null;
  if (tab === "history") return userModal.history.length || null;
  return null;
}

const FAILURE_TITLES: Record<string, string> = {
  "no-account": "No account is online",
  "not-found": "VRChat does not know that user",
  offline: "The daemon is not reachable",
  other: "Could not load this profile",
};

const FAILURE_BODIES: Record<string, string> = {
  "no-account":
    "A profile can only be read through a signed-in account's credentials, and none of yours are connected right now. The History tab below is vrc.zip's own record and does not need VRChat.",
  "not-found":
    "The id vrc.zip recorded no longer resolves. VRChat users can be deleted, and very old log lines can carry ids that no longer exist.",
  offline:
    "vrc.zip's daemon is not answering, so neither VRChat data nor local history can be read.",
  other: "",
};

/**
 * The 503 both tab routes share with the profile route, in the tab's own words.
 *
 * It is not an error. Groups and mutual friends can only be read through a signed-in account's
 * credentials, and vrc.zip may hold none that are connected — which is a fact about this moment,
 * not about this user, so it gets a retry rather than an apology.
 */
const NO_ACCOUNT_FOR_TAB =
  "This can only be read through a signed-in account's credentials, and none of yours are connected right now.";
</script>

<Dialog.Root
  open={userModal.open}
  onOpenChange={(open) => {
    if (!open) userModal.close();
  }}
>
  <Dialog.Content
    class="grid max-h-[85vh] grid-rows-[auto_auto_minmax(0,1fr)] gap-4 p-0 sm:max-w-2xl"
  >
    <!--
      Always drawn, image or not — see `HeroBanner` for why the empty case is the design rather
      than a fallback. The avatar below overlaps it by `-mt-10`, which only works because the band
      is one height for everybody.
    -->
    <HeroBanner url={userModal.bannerUrl} />

    <Dialog.Header class="-mt-10 gap-3 px-6">
      <div class="flex min-w-0 items-end gap-3 pr-8">
        <Avatar class="size-14 shrink-0 ring-2 ring-popover">
          <AvatarImage src={imageUrl(profile?.iconUrl)} alt="" />
          <AvatarFallback>{initials(userModal.title)}</AvatarFallback>
          {#if profile !== null}
            <AvatarBadge class="bg-transparent ring-popover">
              <StatusDot status={profile.status} size={null} class="size-full" />
            </AvatarBadge>
          {/if}
        </Avatar>

        <div class="min-w-0 flex-1">
          <Dialog.Title class="truncate text-base">{userModal.title}</Dialog.Title>
          <Dialog.Description class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {#if profile !== null}
              <span>{statusLabel(profile.status)}</span>
              {#if profile.statusDescription}
                <span aria-hidden="true">·</span>
                <span class="truncate">{profile.statusDescription}</span>
              {/if}
              {#if profile.pronouns}
                <span aria-hidden="true">·</span>
                <span>{profile.pronouns}</span>
              {/if}
            {:else if userModal.phase === "loading"}
              <span>Reading the profile…</span>
            {:else}
              <span class="font-mono">{userModal.userId ?? ""}</span>
            {/if}
          </Dialog.Description>
        </div>

        {#if userModal.userId !== null}
          <UserActionsMenu target={actionTarget} class="shrink-0 text-muted-foreground" />
        {/if}
      </div>

      <div class="flex flex-wrap items-center gap-2">
        {#if userModal.representedGroup !== null}
          <!--
            First in the row: it is the user's own statement about themselves, where the rest of
            these badges are VRChat's statements about them. Absent for most people, and nothing
            stands in for it.
          -->
          <RepresentedGroup group={userModal.representedGroup} />
        {/if}
        {#if userModal.isOwnAccount}
          <Badge variant="secondary">This is your account</Badge>
        {/if}
        {#if trust !== null}
          <!-- VRChat's own rank colour; see `trustClass` for why it is not a vrc.zip token. -->
          <Badge variant="outline" class={trustTint} title="VRChat trust rank">{trust}</Badge>
        {/if}

        {#if profile !== null && profile.isFriend}
          <Badge
            variant="outline"
            class="border-status-online/40 bg-status-online/10 text-status-online"
            title={profile.friendedAt === null
              ? "A friend of the account this was looked up through"
              : `Friends since ${calendarDay(profile.friendedAt)}`}
          >
            <HeartHandshakeIcon />
            Friend
          </Badge>
        {/if}

        {#if ageVerified !== null}
          <!--
            Drawn only when VRChat affirmatively says so. `hidden` — verified but not published —
            renders nothing, and so does a user VRChat said nothing about: the absence of this
            badge is never a claim that someone is unverified.
          -->
          <Badge variant="outline" title="VRChat age verification">
            <ShieldCheckIcon />
            {ageVerified}
          </Badge>
        {/if}

        {#if platform !== null}
          <Badge variant="outline">{platform}</Badge>
        {/if}
        {#if notFriend}
          <span class="text-xs text-muted-foreground">
            Not a friend — VRChat sends a shorter profile for people you are not friends with.
          </span>
        {/if}
      </div>
    </Dialog.Header>

    <Tabs.Root
      value={userModal.tab}
      onValueChange={(value) => {
        userModal.selectTab(value as UserTab);
      }}
      class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-0"
    >
      <Tabs.List variant="line" class="px-6" aria-label="What to show about this user">
        {#each USER_TABS as tab (tab)}
          {@const count = tabCount(tab)}
          <Tabs.Trigger value={tab}>
            {USER_TAB_LABELS[tab]}
            {#if count !== null}
              <Badge variant="secondary" class="tabular">{count}</Badge>
            {/if}
          </Tabs.Trigger>
        {/each}
      </Tabs.List>

      <div class="min-h-0 overflow-y-auto px-6 pt-4 pb-6">
        <!-- Overview ------------------------------------------------------- -->
        <Tabs.Content value="overview" class="space-y-4">
          {#if userModal.phase === "loading"}
            <div class="space-y-2">
              <Skeleton class="h-4 w-2/3" />
              <Skeleton class="h-4 w-1/2" />
              <Skeleton class="h-4 w-1/3" />
            </div>
          {:else if userModal.phase === "error" && userModal.failure !== null}
            {@const failure = userModal.failure}
            <div class="space-y-2 border border-border bg-muted/40 px-3 py-3">
              <p class="text-sm font-medium">{FAILURE_TITLES[failure] ?? FAILURE_TITLES.other}</p>
              <p class="text-xs text-muted-foreground">
                {FAILURE_BODIES[failure] === "" ? userModal.error : FAILURE_BODIES[failure]}
              </p>
              <Button variant="outline" size="sm" onclick={() => userModal.retry()}>
                Try again
              </Button>
            </div>
          {/if}

          {#if profile !== null}
            {#if profile.bio}
              <!-- User-authored, and it carries its own line breaks; whitespace is kept. -->
              <p class="text-sm whitespace-pre-wrap">{profile.bio}</p>
            {/if}

            {#if bioLinks.length > 0}
              <ul class="space-y-1">
                <!--
                  Keyed by index, not by the link itself. A bio is free text the *user* controls,
                  so the same URL appearing twice is entirely possible — and a repeated key is a
                  hard runtime error in Svelte 5, which would take the whole Overview tab down over
                  someone pasting a link twice. The list is static for a given profile, so the
                  index is a stable key here.
                -->
                {#each bioLinks as link, index (index)}
                  <li class="min-w-0">
                    <a
                      href={link}
                      target="_blank"
                      rel="noreferrer noopener"
                      class="inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                    >
                      <span class="truncate">{link}</span>
                      <ExternalLinkIcon class="size-3 shrink-0" />
                    </a>
                  </li>
                {/each}
              </ul>
            {/if}

            {#if location !== null}
              <div class="space-y-1">
                <p class="text-xs tracking-wide text-muted-foreground uppercase">Right now</p>
                <!--
                  The same join affordance as everywhere else, through `requestJoin`: a self-invite
                  when a client is running, the deep link only when none is.
                -->
                <LocationLine {location} accountId={userModal.accountId} />
              </div>
            {/if}

            {#if profile.friendedAt !== null || profile.lastLogin !== null || profile.dateJoined !== null}
              <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                {#if profile.friendedAt !== null}
                  <dt class="text-muted-foreground">Friends since</dt>
                  <dd class="tabular">{calendarDay(profile.friendedAt)}</dd>
                {/if}
                {#if profile.lastLogin !== null}
                  <dt class="text-muted-foreground">Last login</dt>
                  <dd><RelativeTime ts={profile.lastLogin} /></dd>
                {/if}
                {#if profile.dateJoined !== null}
                  <dt class="text-muted-foreground">On VRChat since</dt>
                  <dd class="tabular">{calendarDay(profile.dateJoined)}</dd>
                {/if}
              </dl>
            {/if}

            <Separator />

            <div class="space-y-2">
              <label for="user-note" class="text-xs tracking-wide text-muted-foreground uppercase">
                Your note
              </label>
              <Textarea
                id="user-note"
                bind:value={userModal.noteDraft}
                maxlength={MAX_NOTE_LENGTH}
                placeholder="Kept on this machine only. VRChat is never told."
                class="min-h-20 text-sm"
              />
              {#if userModal.noteError}
                <ErrorNote message={userModal.noteError} />
              {/if}
              <div class="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={!userModal.noteDirty || userModal.savingNote}
                  onclick={() => void userModal.saveNote()}
                >
                  {userModal.savingNote ? "Saving" : "Save note"}
                </Button>
                {#if userModal.noteDirty && !userModal.savingNote}
                  <span class="text-xs text-muted-foreground">Not saved yet</span>
                {/if}
                <span class="tabular ml-auto text-xs text-muted-foreground">
                  {userModal.noteDraft.length}/{MAX_NOTE_LENGTH}
                </span>
              </div>
            </div>
          {/if}
        </Tabs.Content>

        <!-- Groups --------------------------------------------------------- -->
        <Tabs.Content value="groups" class="space-y-3">
          {#if userModal.groupsPhase === "idle" || userModal.groupsPhase === "loading"}
            {#each [0, 1, 2] as index (index)}
              <Skeleton class="h-14 w-full" />
            {/each}
          {:else if userModal.groupsPhase === "error"}
            {@const failure = userModal.groupsFailure ?? "other"}
            <div class="space-y-2 border border-border bg-muted/40 px-3 py-3">
              <p class="text-sm font-medium">{FAILURE_TITLES[failure] ?? FAILURE_TITLES.other}</p>
              <p class="text-xs text-muted-foreground">
                {failure === "no-account" ? NO_ACCOUNT_FOR_TAB : userModal.groupsError}
              </p>
              <Button variant="outline" size="sm" onclick={() => userModal.retryGroups()}>
                Try again
              </Button>
            </div>
          {:else if userModal.groupList.length === 0}
            <p class="text-sm text-muted-foreground">
              No groups vrc.zip can see. VRChat only reveals a membership when the group's own
              visibility allows this account to, so a private membership looks exactly like none —
              a short list here is normal, not a failed read.
            </p>
          {:else}
            <!--
              The search box appears only once there is a list to search. Eighty-plus memberships
              is normal, so this is the difference between the tab being useful and being a wall.
            -->
            <div class="relative">
              <SearchIcon
                class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                bind:value={userModal.groupQuery}
                placeholder="Search {userModal.groupList.length} groups by name or short code"
                aria-label="Search groups"
                class="pl-8"
              />
            </div>

            <p class="text-xs text-muted-foreground">
              Only the memberships this account is permitted to see. VRChat hides the rest, so this
              list can be shorter than the one the user sees themselves.
            </p>

            {#if userModal.visibleGroups.length === 0}
              <p class="text-sm text-muted-foreground">
                No group here matches “{userModal.groupQuery}”.
              </p>
            {/if}

            <ul class="divide-y divide-border">
              {#each userModal.visibleGroups as group (group.id)}
                {@const tag = groupTag(group.shortCode, group.discriminator)}
                <li class="flex items-center gap-3 py-2">
                  <Avatar class="size-9 shrink-0 rounded-md">
                    <AvatarImage src={imageUrl(group.iconUrl)} alt="" loading="lazy" />
                    <AvatarFallback class="text-xs">{initials(group.name)}</AvatarFallback>
                  </Avatar>

                  <div class="min-w-0 flex-1">
                    <p class="flex min-w-0 items-center gap-2 text-sm">
                      <a
                        href={groupLink(group.id)}
                        target="_blank"
                        rel="noreferrer noopener"
                        class="min-w-0 truncate underline-offset-4 hover:underline"
                        title="Open on vrchat.com"
                      >
                        {group.name}
                      </a>
                      {#if group.isRepresenting}
                        <Badge variant="secondary" class="shrink-0">Represents</Badge>
                      {/if}
                      {#if group.privacy === "private"}
                        <Badge variant="outline" class="shrink-0" title="VRChat group privacy">
                          Private
                        </Badge>
                      {/if}
                    </p>
                    <p class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      {#if tag !== null}
                        <span class="font-mono">{tag}</span>
                      {/if}
                      {#if group.memberCount !== null}
                        {#if tag !== null}
                          <span aria-hidden="true">·</span>
                        {/if}
                        <span class="tabular">{group.memberCount} members</span>
                      {/if}
                    </p>
                  </div>

                  <Button
                    variant="ghost"
                    size="xs"
                    class="shrink-0 text-muted-foreground"
                    onclick={() => void copyText("Group id", group.id)}
                  >
                    Copy id
                  </Button>
                </li>
              {/each}
            </ul>
          {/if}
        </Tabs.Content>

        <!-- Mutual friends ------------------------------------------------- -->
        <Tabs.Content value="friends" class="space-y-3">
          {#if userModal.mutualsPhase === "loading" || userModal.mutualsPhase === "idle"}
            {#each [0, 1, 2] as index (index)}
              <Skeleton class="h-10 w-full" />
            {/each}
          {:else if userModal.mutualsPhase === "error"}
            {@const failure = userModal.mutualsFailure ?? "other"}
            <div class="space-y-2 border border-border bg-muted/40 px-3 py-3">
              <p class="text-sm font-medium">{FAILURE_TITLES[failure] ?? FAILURE_TITLES.other}</p>
              <p class="text-xs text-muted-foreground">
                {failure === "no-account" ? NO_ACCOUNT_FOR_TAB : userModal.mutualsError}
              </p>
              <Button variant="outline" size="sm" onclick={() => userModal.retryMutuals()}>
                Try again
              </Button>
            </div>
          {:else if userModal.mutuals.length === 0}
            <p class="flex items-center gap-2 text-sm text-muted-foreground">
              <UsersIcon class="size-4 shrink-0" />
              No friends in common, or none this account can see.
            </p>
          {:else}
            <div class="relative">
              <SearchIcon
                class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                bind:value={userModal.mutualQuery}
                placeholder="Search {userModal.mutuals.length} loaded friends"
                aria-label="Search mutual friends"
                class="pl-8"
              />
            </div>

            {#if userModal.mutualsFilterIncomplete}
              <!--
                Said plainly rather than hidden: this list is paged, so the filter can only search
                what has been fetched. A search box that quietly returns "no match" while unloaded
                pages hold the answer is worse than no search box.
              -->
              <p class="text-xs text-muted-foreground">
                Searching the {userModal.mutuals.length} loaded so far — load more below to search the
                rest.
              </p>
            {/if}

            {#if userModal.visibleMutuals.length === 0}
              <p class="text-sm text-muted-foreground">
                No loaded friend matches “{userModal.mutualQuery}”.
              </p>
            {/if}

            <ul class="grid gap-1 sm:grid-cols-2">
              {#each userModal.visibleMutuals as friend (friend.id)}
                <li class="flex min-w-0 items-center gap-2 py-1">
                  <Avatar class="size-7 shrink-0">
                    <AvatarImage src={imageUrl(friend.iconUrl)} alt="" loading="lazy" />
                    <AvatarFallback class="text-[10px]">
                      {initials(friend.displayName)}
                    </AvatarFallback>
                    <AvatarBadge class="bg-transparent ring-popover">
                      <StatusDot status={friend.status} size={null} class="size-full" />
                    </AvatarBadge>
                  </Avatar>
                  <!--
                    A real `UserName`, so every row here re-targets this same modal at that person
                    — the dialog stays open and swaps its contents, which is the whole reason the
                    modal is a singleton.
                  -->
                  <UserName
                    userId={friend.id}
                    name={friend.displayName}
                    accountId={userModal.accountId}
                    class={cn("min-w-0 truncate text-sm", trustClass(friend.trustLevel))}
                  />
                </li>
              {/each}
            </ul>

            <!--
              A button, not an observer. The daemon walks a friend list to answer this, so more
              pages are something the reader asks for rather than something scrolling triggers.
            -->
            {#if userModal.mutualsError !== null}
              <ErrorNote message={userModal.mutualsError} />
            {/if}
            {#if userModal.mutualsHasMore}
              <Button
                variant="outline"
                size="sm"
                disabled={userModal.mutualsLoadingMore}
                onclick={() => void userModal.loadMoreMutuals()}
              >
                {userModal.mutualsLoadingMore ? "Loading" : "Load more"}
              </Button>
            {:else}
              <p class="pt-1 text-xs text-muted-foreground">
                That is every mutual friend this account can see.
              </p>
            {/if}
          {/if}
        </Tabs.Content>

        <!-- Local history --------------------------------------------------- -->
        <Tabs.Content value="history" class="space-y-2">
          <p class="text-xs text-muted-foreground">
            Every event vrc.zip recorded with this person as its subject, newest first. This is our
            own record, not VRChat's, and it is the one thing no VRChat client can show you.
          </p>

          {#if userModal.historyPhase === "loading"}
            <div class="space-y-1">
              {#each [0, 1, 2, 3] as index (index)}
                <Skeleton class="h-8 w-full" />
              {/each}
            </div>
          {:else if userModal.historyError}
            <ErrorNote message={userModal.historyError} />
          {:else if userModal.history.length === 0}
            <p class="text-sm text-muted-foreground">
              Nothing recorded yet. History accumulates as they come online, change instance, or
              appear in a log line from a running client — and the retention job trims the oldest of
              it.
            </p>
          {:else}
            <ul class="-mx-3 divide-y divide-border/50">
              {#each userModal.history as row (row.id)}
                <EventRow event={rowToEvent(row)} dense />
              {/each}
            </ul>

            {#if userModal.historyExhausted}
              <p class="pt-1 text-xs text-muted-foreground">
                That is everything still held for this user.
              </p>
            {:else}
              <Button
                variant="outline"
                size="sm"
                disabled={userModal.loadingMore}
                onclick={() => void userModal.loadMoreHistory()}
              >
                {userModal.loadingMore ? "Loading" : "Load older"}
              </Button>
            {/if}
          {/if}
        </Tabs.Content>

        <!-- Raw ------------------------------------------------------------ -->
        <Tabs.Content value="raw" class="space-y-2">
          <div class="flex items-center gap-2">
            <p class="text-xs text-muted-foreground">
              Exactly what the daemon sent, plus what vrc.zip added. Nothing here is interpreted.
            </p>
            <Button
              variant="outline"
              size="xs"
              class="ml-auto shrink-0"
              onclick={() => void copyText("Details", raw)}
            >
              Copy
            </Button>
          </div>
          <pre
            class="max-w-full overflow-x-auto border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{raw}</pre>
        </Tabs.Content>
      </div>
    </Tabs.Root>
  </Dialog.Content>
</Dialog.Root>
