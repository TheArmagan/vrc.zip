<!--
  One VRChat group in full: what it is, who is in it, what has been said and shown in it, and where
  it is gathering right now.

  Mounted exactly once, by `App.svelte`, and driven entirely by `groupModal` — see that module for
  why there is one instance rather than one per call site, for what a 404 on a group actually means,
  and for why the account this was opened through is part of the question rather than bookkeeping.

  Built on `EntityModal`, like the user and world cards, so the banner, the header and the scroll
  behaviour are the same three in all three. The body is tabbed, the way the user modal's is, because
  these are different *kinds* of thing rather than sections of one document: what the group is, its
  roster, its board, its walls, where it is gathering, and what VRChat actually sent.

  Everything below Overview loads when its tab is first opened. Four lists fetched on arrival is four
  requests through a 20/s per-account bucket for three lists nobody looked at, paid for by clicking a
  badge — and most groups have no open instances at all, so their tab's empty state is allowed to say
  so rather than leaving a blank stretch of the card.

  ## A refused tab still renders

  A 403 on members is the *normal* answer for a group you have not joined. It is drawn as a sentence
  saying membership is required, with no retry button, because no number of retries acquires
  membership. Hiding the tab instead would read as a bug in vrc.zip to anyone who can see that same
  group's member list on vrchat.com.

  **Every number here is one VRChat sent.** No vrc.zip activity score, no "how alive is this group"
  out of ten. The two counts sit side by side with the age of the second one, because VRChat
  recomputes `onlineMemberCount` on its own schedule and a live-looking figure with no age on it
  reads as this second's.

  The card draws from `groupModal.summary`, not from the fetched group, which is what lets a click
  on a represented badge paint a name, an icon and a banner in the first frame and fill in the rest
  when the request lands. See `OpenGroupOptions.hint`.
-->
<script lang="ts">
import CalendarIcon from "@lucide/svelte/icons/calendar";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import ImageIcon from "@lucide/svelte/icons/image";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import ServerIcon from "@lucide/svelte/icons/server";
import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
import UsersIcon from "@lucide/svelte/icons/users";
import { imageUrl } from "$lib/api.ts";
import DetailGrid from "$lib/components/DetailGrid.svelte";
import EmptyState from "$lib/components/EmptyState.svelte";
import EntityFooter from "$lib/components/EntityFooter.svelte";
import EntityModal, { type ModalTab } from "$lib/components/EntityModal.svelte";
import FailureNote from "$lib/components/FailureNote.svelte";
import JoinAffordance from "$lib/components/JoinAffordance.svelte";
import PagedSection from "$lib/components/PagedSection.svelte";
import RawJsonPanel from "$lib/components/RawJsonPanel.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import UserName from "$lib/components/UserName.svelte";
import { Avatar, AvatarFallback, AvatarImage } from "$lib/components/ui/avatar/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import {
  accessLabel,
  calendarDay,
  groupLink,
  groupTag,
  initials,
  parseLocation,
  shortId,
} from "$lib/format.ts";
import { app } from "$lib/state/app.svelte.ts";
import { modalBack } from "$lib/state/entity-modal.svelte.ts";
import {
  GROUP_MODAL_TAB_LABELS,
  GROUP_MODAL_TABS,
  type GroupModalTab,
  groupModal,
} from "$lib/state/group-modal.svelte.ts";
import { worldModal } from "$lib/state/world-modal.svelte.ts";

const summary = $derived(groupModal.summary);
const group = $derived(groupModal.group);
const galleries = $derived(groupModal.galleries);

const tag = $derived(groupTag(summary?.shortCode, summary?.discriminator));

/**
 * VRChat's own tags, minus its internal prefix — the same treatment the world card gives them.
 *
 * `system_` tags are VRChat's bookkeeping and are shown unprefixed rather than hidden, because a
 * group's verified state is a real fact about it.
 */
const tags = $derived((group?.tags ?? []).map((entry) => entry.replace(/^system_/, "")));

const raw = $derived(JSON.stringify(groupModal.snapshot, null, 2));

/**
 * Counts on the tab strip.
 *
 * Only Instances gets one, and only once its tab has been opened: it is the one list that arrives
 * whole, so its length is the answer rather than a page of it. A paged tab showing "50" would be
 * claiming a total it does not have, and a count that is absent means "not read yet", never "none"
 * — the empty state inside the tab is the only thing allowed to claim zero.
 */
function tabCount(tab: GroupModalTab): number | null {
  if (tab !== "instances") return null;
  if (groupModal.instances.phase !== "ready") return null;
  return groupModal.instances.items.length || null;
}

const tabs = $derived<ModalTab[]>(
  GROUP_MODAL_TABS.map((tab) => ({
    value: tab,
    label: GROUP_MODAL_TAB_LABELS[tab],
    count: tabCount(tab),
  })),
);

/**
 * The account picker.
 *
 * Bound through a getter/setter rather than to `groupModal.accountId` directly, because assigning
 * the id has to go through `setAccount()` - which re-reads the group *and* every list. Binding
 * straight to the field would change the membership badge above lists still holding the previous
 * account's answers, which is the "two true halves, one false whole" failure this dialog is built
 * to avoid.
 */
const accountChoice = {
  get value(): string {
    return groupModal.accountId ?? "";
  },
  set value(next: string) {
    groupModal.setAccount(next === "" ? null : next);
  },
};

const accountLabel = $derived(
  app.accounts.find((account) => account.id === groupModal.accountId)?.displayName ??
    "Any account",
);

/**
 * How someone would join, in words rather than in VRChat's enum.
 *
 * An unrecognised value falls through to VRChat's own string rather than to "Unknown" — the enum
 * is theirs to extend, and printing the word they sent is more use than admitting we have no map
 * entry for it.
 */
const JOIN_STATES: Record<string, string> = {
  open: "Anyone can join",
  invite: "Invite only",
  request: "Request to join",
  closed: "Closed",
};

/** The viewer's own standing — about the account this was opened through, not about the group. */
const MEMBERSHIP: Record<string, string> = {
  member: "You are a member",
  requested: "You have requested to join",
  invited: "You have been invited",
  userblocked: "You are blocked from this group",
};

const FAILURE_TITLES: Record<string, string> = {
  "no-account": "No account is online",
  "not-found": "VRChat will not show this group",
  forbidden: "Members only",
  offline: "The daemon is not reachable",
  other: "Could not load this group",
};

const FAILURE_BODIES: Record<string, string> = {
  "no-account":
    "A group can only be read through a signed-in account's credentials, and none of yours are connected right now.",
  /*
   * Both causes, deliberately. VRChat answers 404 for a deleted group and for a private one this
   * account may not see, and nothing in the response tells them apart — so picking one, in front of
   * a user who may be looking at that very group on their own screen, would be a confident wrong
   * answer.
   */
  "not-found":
    "Either the group no longer exists, or it is private and the account this was looked up through cannot see it. VRChat answers both the same way, so vrc.zip cannot tell you which.",
  offline: "vrc.zip's daemon is not answering, so nothing about this group can be read.",
  other: "",
};

/*
 * Each list's own words for each failure.
 *
 * `""` means "the daemon said it better than I can" and falls through to the raw message — see
 * `FailureNote`. `forbidden` is the one that matters here and it is phrased as a fact about the
 * group rather than an apology, because it is not a fault: a group deciding who may read its
 * roster is a rule about who may look, so it gets a sentence rather than a retry that could never
 * work.
 */
const MEMBER_BODIES: Record<string, string> = {
  "no-account":
    "A group's members can only be read through somebody's credentials, and vrc.zip has none online right now.",
  "not-found": "This group is gone, or it is private to the account asking.",
  forbidden:
    "This group shows its member list to its own members. Join it, or switch to an account that already has, and it will appear here.",
  offline: "",
  other: "",
};

const POST_BODIES: Record<string, string> = {
  ...MEMBER_BODIES,
  forbidden:
    "This group shows its posts to its own members. Join it, or switch to an account that already has, and they will appear here.",
};

const GALLERY_BODIES: Record<string, string> = {
  ...MEMBER_BODIES,
  forbidden: "This gallery is for members of the group only.",
};

const INSTANCE_BODIES: Record<string, string> = {
  ...MEMBER_BODIES,
  "no-account":
    "A group's instances can only be read through a signed-in account's credentials, and none of yours are connected right now.",
  forbidden: "This group only tells its members where it is gathering.",
};
</script>

<EntityModal
  open={groupModal.open}
  onClose={() => groupModal.close()}
  backLabel={modalBack()?.label ?? null}
  bannerUrl={groupModal.bannerUrl}
  bannerClass="h-32"
  title={groupModal.title}
  titleClass="break-words"
  headerClass="-mt-8"
  {tabs}
  tab={groupModal.tab}
  onSelectTab={(value) => groupModal.selectTab(value as GroupModalTab)}
  tabsLabel="What to show about this group"
>
  {#snippet avatar()}
    <!-- Square, not round: a group icon is a badge, and VRChat renders it as one. -->
    <Avatar class="size-14 shrink-0 rounded-lg ring-2 ring-popover">
      <AvatarImage src={imageUrl(summary?.iconUrl)} alt="" />
      <AvatarFallback class="rounded-lg">{initials(groupModal.title)}</AvatarFallback>
    </Avatar>
  {/snippet}

  {#snippet subtitle()}
    {#if tag !== null}
      <!-- `ABCD.1234`. The pair is what is unique; two groups may share a short code. -->
      <span class="font-mono">{tag}</span>
    {/if}
    {#if summary != null && summary.memberCount !== null}
      {#if tag !== null}<span aria-hidden="true">·</span>{/if}
      <span class="tabular">{summary.memberCount.toLocaleString()} members</span>
    {/if}
    {#if summary === null}
      {#if groupModal.phase === "loading"}
        <span>Reading the group…</span>
      {:else}
        <span class="font-mono">{groupModal.groupId ?? ""}</span>
      {/if}
    {/if}
  {/snippet}

  {#snippet actions()}
    <!--
      Who is asking, as a control rather than something the daemon picks. A group shows its roster
      to its own members and refuses everyone else, and the membership badge below is a statement
      about this account, so the answer on screen is only half an answer without it.
    -->
    {#if app.accounts.length > 0}
      <Select.Root type="single" bind:value={accountChoice.value}>
        <Select.Trigger size="sm" class="w-40 shrink-0" aria-label="Ask as which account">
          <span class="truncate">{accountLabel}</span>
        </Select.Trigger>
        <Select.Content>
          {#each app.accounts as account (account.id)}
            <Select.Item value={account.id} label={account.displayName} />
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
  {/snippet}

  {#snippet badges()}
    {#if group?.isVerified}
      <Badge variant="outline" title="VRChat verified this group">
        <ShieldCheckIcon />
        Verified
      </Badge>
    {/if}
    {#if summary?.privacy === "private"}
      <!--
        A statement about the group, not a warning: a private group does not publish its member
        list, which is also why it can be missing from a user's Groups tab entirely.
      -->
      <Badge variant="outline" title="This group does not publish its membership">Private</Badge>
    {/if}
    {#if group?.joinState}
      <Badge variant="outline" title="VRChat join state">
        {JOIN_STATES[group.joinState] ?? group.joinState}
      </Badge>
    {/if}
    {#if group?.membershipStatus}
      <!--
        About the account this was opened through, never about the group — which is why it can say
        something different for the same group asked about through two different accounts.
      -->
      <Badge variant="secondary">
        {MEMBERSHIP[group.membershipStatus] ?? group.membershipStatus}
      </Badge>
    {/if}
  {/snippet}

  <!-- Overview -------------------------------------------------------------- -->
  <Tabs.Content value="overview" class="space-y-4">
    {#if groupModal.phase === "loading" && group === null}
      <div class="space-y-2">
        <Skeleton class="h-4 w-2/3" />
        <Skeleton class="h-4 w-1/2" />
        <Skeleton class="h-4 w-1/3" />
      </div>
    {:else if groupModal.phase === "error" && groupModal.failure !== null}
      <FailureNote
        failure={groupModal.failure}
        titles={FAILURE_TITLES}
        bodies={FAILURE_BODIES}
        message={groupModal.error}
        onRetry={() => groupModal.retry()}
      />
    {/if}

    {#if summary?.description}
      <!-- Author-written, and it carries its own line breaks. -->
      <p class="text-sm whitespace-pre-wrap">{summary.description}</p>
    {/if}

    {#if group !== null}
      {#if tags.length > 0}
        <div class="flex flex-wrap gap-1.5">
          <!--
            Keyed by index. VRChat's tag array is not guaranteed unique, and a repeated key is a hard
            runtime error in Svelte 5 rather than a duplicate chip — it would take the tab down. The
            list is static for a given group, so the index is stable.
          -->
          {#each tags as entry, index (index)}
            <Badge variant="secondary" class="font-normal">{entry}</Badge>
          {/each}
        </div>
      {/if}

      <DetailGrid>
        {#if group.memberCount !== null}
          <dt class="flex items-center gap-1.5 text-muted-foreground">
            <UsersIcon class="size-3.5" />
            Members
          </dt>
          <dd class="tabular">{group.memberCount.toLocaleString()}</dd>
        {/if}
        {#if group.onlineMemberCount !== null}
          <dt class="text-muted-foreground">Online now</dt>
          <dd class="tabular">
            {group.onlineMemberCount.toLocaleString()}
            {#if group.memberCountSyncedAt !== null}
              <!--
                The age, always, beside the count. VRChat recomputes this on its own schedule, and a
                number with no age on it reads as this second's when it may be hours old.
              -->
              <span class="text-muted-foreground">
                — counted <RelativeTime ts={group.memberCountSyncedAt} />
              </span>
            {/if}
          </dd>
        {/if}
        {#if group.ownerId !== null}
          <dt class="text-muted-foreground">Owner</dt>
          <dd>
            <!--
              A real `UserName`, so the owner is one click from their own profile — and the label is
              the id, because VRChat's group record carries no display name for them. `UserName`
              resolves nothing on its own; the modal it opens does.
            -->
            <UserName
              userId={group.ownerId}
              name={group.ownerId}
              accountId={groupModal.accountId}
              class="font-mono"
            />
          </dd>
        {/if}
        {#if group.createdAt !== null}
          <dt class="flex items-center gap-1.5 text-muted-foreground">
            <CalendarIcon class="size-3.5" />
            Created
          </dt>
          <dd class="tabular">{calendarDay(group.createdAt)}</dd>
        {/if}
        {#if group.languages.length > 0}
          <dt class="text-muted-foreground">Languages</dt>
          <dd class="uppercase">{group.languages.join(", ")}</dd>
        {/if}
      </DetailGrid>

      {#if group.rules !== null}
        <Separator />
        <div class="space-y-1">
          <p class="text-xs tracking-wide text-muted-foreground uppercase">Rules</p>
          <!-- Author-written, line breaks and all. Not markdown — VRChat does not treat it as any. -->
          <p class="text-sm whitespace-pre-wrap">{group.rules}</p>
        </div>
      {/if}

      {#if group.links.length > 0}
        <div class="space-y-1">
          <p class="text-xs tracking-wide text-muted-foreground uppercase">Links</p>
          <ul class="space-y-1">
            <!--
              Keyed by index: these are free text the group's owner controls, so the same URL twice
              is entirely possible, and a repeated key would take the tab down.
            -->
            {#each group.links as link, index (index)}
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
        </div>
      {/if}
    {/if}
  </Tabs.Content>

  <!-- Members ---------------------------------------------------------------- -->
  <Tabs.Content value="members" class="space-y-3">
    <PagedSection
      list={groupModal.members}
      icon={UsersIcon}
      emptyTitle="No members to show"
      emptyDescription="This group's roster is empty, or VRChat is not describing it to this account."
      titles={FAILURE_TITLES}
      bodies={MEMBER_BODIES}
      skeletonRows={4}
    >
      {#snippet row(member)}
        <div class="flex items-center gap-3 border border-border p-3">
          <UserName
            userId={member.userId}
            name={member.displayName}
            accountId={groupModal.accountId}
            class="min-w-0 flex-1"
          />
          {#if member.isRepresenting}
            <Badge variant="outline" class="shrink-0">Represents</Badge>
          {/if}
          {#if member.joinedAt !== null}
            <span class="shrink-0 text-xs text-muted-foreground">
              joined <RelativeTime ts={member.joinedAt} />
            </span>
          {/if}
        </div>
      {/snippet}
    </PagedSection>
  </Tabs.Content>

  <!-- Posts ------------------------------------------------------------------ -->
  <Tabs.Content value="posts" class="space-y-3">
    <PagedSection
      list={groupModal.posts}
      icon={MessageSquareIcon}
      emptyTitle="No posts"
      emptyDescription="Nothing has been posted to this group's board."
      titles={FAILURE_TITLES}
      bodies={POST_BODIES}
      skeletonRows={3}
    >
      {#snippet row(post)}
        <article class="space-y-2 border border-border p-3">
          <div class="flex items-baseline justify-between gap-3">
            <h3 class="min-w-0 truncate text-sm font-medium">{post.title ?? "Untitled post"}</h3>
            {#if post.createdAt !== null}
              <span class="shrink-0 text-xs text-muted-foreground">
                <RelativeTime ts={post.createdAt} />
              </span>
            {/if}
          </div>

          {#if post.authorId !== null}
            <!--
              VRChat's post record carries only an author id; the daemon fills the name in from
              presence and the friend log at no request cost and leaves it null otherwise. A post
              whose author is a stranger is a normal post, so the id stands in rather than the row
              pretending it has no author.
            -->
            <UserName
              userId={post.authorId}
              name={post.authorDisplayName ?? shortId(post.authorId, 12)}
              accountId={groupModal.accountId}
            />
          {/if}

          {#if post.text !== null}
            <!-- Author-written, line breaks and all. VRChat does not treat it as markdown. -->
            <p class="text-sm whitespace-pre-wrap">{post.text}</p>
          {/if}

          {#if post.imageUrl !== null && post.imageUrl !== ""}
            <!-- Through `imageUrl()`: a browser cannot load a VRChat asset URL directly. -->
            <img
              src={imageUrl(post.imageUrl)}
              alt=""
              loading="lazy"
              class="max-h-80 w-full border border-border object-contain"
            />
          {/if}
        </article>
      {/snippet}
    </PagedSection>
  </Tabs.Content>

  <!-- Galleries -------------------------------------------------------------- -->
  <Tabs.Content value="galleries" class="space-y-3">
    {#if galleries.length === 0}
      <EmptyState
        icon={ImageIcon}
        title="No galleries"
        description="This group has not created any galleries, or none are visible to this account."
      />
    {:else}
      <!--
        The gallery list rides in on the group record, so switching galleries costs one request for
        images and none for the list itself.
      -->
      <div class="flex flex-wrap gap-2">
        {#each galleries as gallery (gallery.id)}
          <Button
            variant={gallery.id === groupModal.galleryId ? "secondary" : "ghost"}
            size="sm"
            onclick={() => groupModal.selectGallery(gallery.id)}
          >
            {gallery.name}
            {#if gallery.membersOnly}
              <Badge variant="outline" class="ml-1">Members</Badge>
            {/if}
          </Button>
        {/each}
      </div>

      <PagedSection
        list={groupModal.images}
        icon={ImageIcon}
        emptyTitle="Nothing in this gallery"
        emptyDescription="No images have been added to it yet."
        titles={FAILURE_TITLES}
        bodies={GALLERY_BODIES}
        skeletonRows={2}
      >
        {#snippet row(image)}
          <figure class="space-y-1 border border-border p-2">
            {#if image.imageUrl !== null && image.imageUrl !== ""}
              <img
                src={imageUrl(image.imageUrl)}
                alt=""
                loading="lazy"
                class="max-h-80 w-full object-contain"
              />
            {/if}
            {#if image.submittedByUserId !== null}
              <figcaption class="text-xs text-muted-foreground">
                submitted by <UserName
                  userId={image.submittedByUserId}
                  name={shortId(image.submittedByUserId, 12)}
                  accountId={groupModal.accountId}
                  class="inline"
                />
              </figcaption>
            {/if}
          </figure>
        {/snippet}
      </PagedSection>
    {/if}
  </Tabs.Content>

  <!-- Instances -------------------------------------------------------------- -->
  <Tabs.Content value="instances" class="space-y-3">
    <PagedSection
      list={groupModal.instances}
      icon={ServerIcon}
      emptyTitle="Nothing open right now"
      emptyDescription="This group has no instances running, or none this account may see."
      titles={FAILURE_TITLES}
      bodies={INSTANCE_BODIES}
      skeletonRows={3}
    >
      {#snippet row(instance)}
        {@const place = parseLocation(instance.location)}
        {@const worldId = instance.worldId}
        <div class="flex items-center gap-3 border border-border p-3">
          {#if instance.worldThumbnailImageUrl !== null && instance.worldThumbnailImageUrl !== ""}
            <!-- Through `imageUrl()`: a browser cannot load a VRChat asset URL directly. -->
            <img
              src={imageUrl(instance.worldThumbnailImageUrl)}
              alt=""
              loading="lazy"
              class="size-12 shrink-0 border border-border object-cover"
            />
          {/if}

          <div class="min-w-0 flex-1">
            {#if worldId !== null}
              <!--
                The location rides along, which is what turns the world dialog from "a world" into
                "that instance of it" — the whole reason it is worth opening from here.
              -->
              <button
                type="button"
                class="max-w-full cursor-pointer truncate rounded-xs text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                onclick={() =>
                  worldModal.openWorld(worldId, {
                    location: instance.location,
                    name: instance.worldName,
                    accountId: groupModal.accountId,
                  })}
              >
                {instance.worldName ?? shortId(worldId, 14)}
              </button>
            {:else}
              <p class="truncate text-sm font-medium">{instance.worldName ?? "Unknown world"}</p>
            {/if}
            <p class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span class="font-mono">{place.label}</span>
              <span aria-hidden="true">·</span>
              <span>{accessLabel(place.access)}</span>
              {#if place.region !== null}
                <span aria-hidden="true">·</span>
                <span class="uppercase">{place.region}</span>
              {/if}
            </p>
          </div>

          {#if instance.memberCount !== null}
            <span class="tabular shrink-0 text-sm text-muted-foreground">
              {instance.memberCount}{#if instance.worldCapacity !== null}/{instance.worldCapacity}{/if}
            </span>
          {/if}

          <!--
            The same join affordance as everywhere else: a self-invite when a client is running, the
            deep link only when none is. See `planJoin`.
          -->
          <JoinAffordance
            location={instance.location}
            accountId={groupModal.accountId}
            class="shrink-0 text-xs"
          />
        </div>
      {/snippet}
    </PagedSection>
  </Tabs.Content>

  <!-- Raw --------------------------------------------------------------------- -->
  <Tabs.Content value="raw" class="space-y-2">
    <RawJsonPanel json={raw} copyLabel="Group details" />

    <!--
      vrchat.com stays down here as the way out to everything vrc.zip does not mirror - the calendar,
      moderation, anything that needs a real session in a browser.
    -->
    <EntityFooter
      id={groupModal.groupId}
      href={groupModal.groupId === null ? null : groupLink(groupModal.groupId)}
      openLabel="Open on vrchat.com"
      idLabel="Group id"
      jsonLabel="Group details"
      json={raw}
    />
  </Tabs.Content>
</EntityModal>
