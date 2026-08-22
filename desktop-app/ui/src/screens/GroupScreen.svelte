<!--
  One VRChat group in full: members, posts, galleries, and the instances it has open.

  The group *modal* stays what a badge or a profile row opens — it answers "what is this group" in
  one glance without leaving wherever you were, and it hands off to here. This is the place with the
  four paged lists, and it is a route rather than a bigger dialog for a concrete reason: infinite
  scroll inside a dialog that shares a back stack with two other dialogs is a fight with the shell.
  Here each tab keeps its own scroll position, the URL survives a reload, and Back means Back.

  ## Which account is asking is half the answer

  Every list here is filtered by VRChat according to who is asking, and the member list is usually
  refused outright to a non-member. So the account is a visible control rather than something the
  daemon picks, and changing it re-reads everything — the header and the lists together, because a
  membership status from one account above a member list from another would be a lie assembled out
  of two true halves.

  ## A refused tab still renders

  A 403 on members is the *normal* answer for a group you have not joined. It is drawn as a sentence
  saying membership is required, with no retry button, because no number of retries acquires
  membership. Hiding the tab instead would read as a bug in vrc.zip to anyone who can see that same
  group's member list on vrchat.com.
-->
<script lang="ts">
import { onDestroy } from "svelte";
import BadgeCheckIcon from "@lucide/svelte/icons/badge-check";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import ImageIcon from "@lucide/svelte/icons/image";
import MessageSquareIcon from "@lucide/svelte/icons/message-square";
import ServerIcon from "@lucide/svelte/icons/server";
import UsersIcon from "@lucide/svelte/icons/users";
import { imageUrl } from "$lib/api.ts";
import EmptyState from "$lib/components/EmptyState.svelte";
import FailureNote from "$lib/components/FailureNote.svelte";
import PagedSection from "$lib/components/PagedSection.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import SectionHeader from "$lib/components/SectionHeader.svelte";
import UserName from "$lib/components/UserName.svelte";
import { Avatar, AvatarFallback, AvatarImage } from "$lib/components/ui/avatar/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import { groupLink, groupTag, initials, shortId } from "$lib/format.ts";
import { app } from "$lib/state/app.svelte.ts";
import { groupScreen, type GroupTab, isGroupTab } from "$lib/state/group-screen.svelte.ts";
import { worldModal } from "$lib/state/world-modal.svelte.ts";

let { groupId }: { groupId: string | null } = $props();

/*
 * The route is the source of truth for which group is showing. `open()` is idempotent for the same
 * (group, account) pair, so re-running this on any unrelated state change costs nothing.
 */
$effect(() => {
  if (groupId === null) return;
  // The first connected account is the default asker. It is only a default: `setAccount` re-reads
  // everything, and which account asks genuinely changes what a group will say.
  groupScreen.open(groupId, {
    accountId: groupScreen.accountId ?? app.connectedAccounts[0]?.id ?? null,
  });
});

// The screen is a singleton, so leaving it must abandon whatever is in flight. Without this a
// half-loaded member list keeps resolving into state nothing is rendering.
onDestroy(() => {
  groupScreen.dispose();
});

const group = $derived(groupScreen.group);
const summary = $derived(groupScreen.summary);
const galleries = $derived(groupScreen.galleries);

/** Loads the tab's first page the moment it is shown. `ensure()` guards the repeat calls. */
function showTab(value: string): void {
  if (!isGroupTab(value)) return;
  groupScreen.tab = value;
  const lists: Record<GroupTab, () => void> = {
    members: () => groupScreen.members.ensure(),
    posts: () => groupScreen.posts.ensure(),
    galleries: () => groupScreen.images.ensure(),
    instances: () => groupScreen.instances.ensure(),
  };
  lists[value]();
}

/*
 * Each tab's own words for each failure.
 *
 * `""` means "the daemon said it better than I can" and falls through to the raw message — see
 * `FailureNote`. `forbidden` is the one that matters here and it is phrased as a fact about the
 * group rather than an apology, because it is not a fault.
 */
const FAILURE_TITLES: Readonly<Record<string, string>> = {
  "no-account": "No account is online",
  "not-found": "Not available",
  forbidden: "Members only",
  offline: "The daemon is not reachable",
  other: "That did not load",
};

const MEMBER_BODIES: Readonly<Record<string, string>> = {
  "no-account":
    "A group's members can only be read through somebody's credentials, and vrc.zip has none online right now.",
  "not-found": "This group is gone, or it is private to the account asking.",
  forbidden:
    "This group shows its member list to its own members. Join it, or switch to an account that already has, and it will appear here.",
  offline: "",
  other: "",
};

const POST_BODIES: Readonly<Record<string, string>> = {
  ...MEMBER_BODIES,
  forbidden:
    "This group shows its posts to its own members. Join it, or switch to an account that already has, and they will appear here.",
};

const GALLERY_BODIES: Readonly<Record<string, string>> = {
  ...MEMBER_BODIES,
  forbidden: "This gallery is for members of the group only.",
};

const INSTANCE_BODIES: Readonly<Record<string, string>> = {
  ...MEMBER_BODIES,
  forbidden: "This group only tells its members where it is gathering.",
};

/*
 * The account picker.
 *
 * Bound through a getter/setter rather than to `groupScreen.accountId` directly, because assigning
 * the id has to go through `setAccount()` - which re-reads the group *and* all four lists. Binding
 * straight to the field would change the label above lists still holding the previous account's
 * answers, which is the "two true halves, one false whole" failure this screen is built to avoid.
 */
const accountChoice = {
  get value(): string {
    return groupScreen.accountId ?? "";
  },
  set value(next: string) {
    groupScreen.setAccount(next === "" ? null : next);
  },
};

const accountLabel = $derived(
  app.accounts.find((account) => account.id === groupScreen.accountId)?.displayName ??
    "Pick an account",
);
</script>

<!--
  The header describes the state actually on screen, in the same order the body branches.

  `groupId === null` is checked *first*, and that is not defensive tidying: `groupScreen` is a
  singleton, so arriving at `#/groups` with no id after visiting a group that failed left the header
  reporting the previous group's error over a "no group chosen" body. Caught by opening the route,
  not by any type. Whenever a header and a body read the same state through different expressions,
  they will eventually disagree - so these branches mirror the body's exactly.
-->
<SectionHeader
  title={groupId === null ? "Group" : (summary?.name ?? "Group")}
  description={groupId === null
    ? "Nothing open"
    : groupScreen.phase === "error"
      ? "This group could not be read"
      : summary === null
        ? "Loading the group"
        : "Members, posts, galleries and the instances this group has open"}
>
  {#snippet actions()}
    {#if app.accounts.length > 0}
      <Select.Root type="single" bind:value={accountChoice.value}>
        <Select.Trigger size="sm" class="w-48" aria-label="Ask as which account">
          {accountLabel}
        </Select.Trigger>
        <Select.Content>
          {#each app.accounts as account (account.id)}
            <Select.Item value={account.id} label={account.displayName} />
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}

    {#if groupId !== null}
      <Button
        variant="ghost"
        size="sm"
        href={groupLink(groupId)}
        target="_blank"
        rel="noreferrer noopener"
      >
        Open on vrchat.com
        <ExternalLinkIcon class="size-3.5" />
      </Button>
    {/if}
  {/snippet}
</SectionHeader>

<div class="space-y-6 p-6">
  {#if groupId === null}
    <EmptyState
      icon={UsersIcon}
      title="No group chosen"
      description="Open a group from a profile's Groups tab or from a represented badge."
    />
  {:else if groupScreen.phase === "error"}
    <FailureNote
      failure={groupScreen.failure ?? "other"}
      titles={FAILURE_TITLES}
      bodies={MEMBER_BODIES}
      message={groupScreen.error}
      onRetry={() => groupScreen.retry()}
    />
  {:else}
    <!--
      The identity block draws from `summary`, which is the fetched record when there is one and the
      caller's hint before that, so arriving from a badge paints a name and an icon immediately.
    -->
    <div class="flex items-start gap-4">
      <Avatar class="size-16 shrink-0">
        {#if summary !== null && summary.iconUrl !== null && summary.iconUrl !== ""}
          <AvatarImage src={imageUrl(summary.iconUrl)} alt="" />
        {/if}
        <AvatarFallback>{initials(summary?.name ?? "?")}</AvatarFallback>
      </Avatar>

      <div class="min-w-0 space-y-1">
        {#if summary === null}
          <Skeleton class="h-6 w-48" />
          <Skeleton class="h-4 w-32" />
        {:else}
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="truncate text-xl font-semibold">{summary.name}</h2>
            {#if group?.isVerified}
              <Badge variant="secondary" class="gap-1">
                <BadgeCheckIcon class="size-3" />
                Verified
              </Badge>
            {/if}
            {#if group?.membershipStatus === "member"}
              <Badge variant="outline">Member</Badge>
            {/if}
          </div>

          <p class="text-sm text-muted-foreground">
            {groupTag(summary.shortCode, summary.discriminator) ?? shortId(groupId, 14)}
            {#if summary.memberCount !== null}
              <span aria-hidden="true"> · </span>{summary.memberCount.toLocaleString()} members
            {/if}
            {#if group?.onlineMemberCount != null}
              <!--
                The age of the online figure is printed beside it, because VRChat recomputes it on
                its own schedule and a live-looking number with no age reads as this second's.
              -->
              <span aria-hidden="true"> · </span>{group.onlineMemberCount.toLocaleString()} online
              {#if group.memberCountSyncedAt !== null}
                (<RelativeTime ts={group.memberCountSyncedAt} />)
              {/if}
            {/if}
          </p>
        {/if}
      </div>
    </div>

    <Tabs.Root value={groupScreen.tab} onValueChange={showTab}>
      <Tabs.List>
        <Tabs.Trigger value="members">Members</Tabs.Trigger>
        <Tabs.Trigger value="posts">Posts</Tabs.Trigger>
        <Tabs.Trigger value="galleries">Galleries</Tabs.Trigger>
        <Tabs.Trigger value="instances">Instances</Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content value="members" class="pt-4">
        <PagedSection
          list={groupScreen.members}
          icon={UsersIcon}
          emptyTitle="No members to show"
          emptyDescription="This group's roster is empty, or VRChat is not describing it to this account."
          titles={FAILURE_TITLES}
          bodies={MEMBER_BODIES}
        >
          {#snippet row(member)}
            <div class="flex items-center gap-3 border border-border p-3">
              <UserName
                userId={member.userId}
                name={member.displayName}
                accountId={groupScreen.accountId}
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

      <Tabs.Content value="posts" class="pt-4">
        <PagedSection
          list={groupScreen.posts}
          icon={MessageSquareIcon}
          emptyTitle="No posts"
          emptyDescription="Nothing has been posted to this group's board."
          titles={FAILURE_TITLES}
          bodies={POST_BODIES}
        >
          {#snippet row(post)}
            <article class="space-y-2 border border-border p-3">
              <div class="flex items-baseline justify-between gap-3">
                <h3 class="min-w-0 truncate font-medium">{post.title ?? "Untitled post"}</h3>
                {#if post.createdAt !== null}
                  <span class="shrink-0 text-xs text-muted-foreground">
                    <RelativeTime ts={post.createdAt} />
                  </span>
                {/if}
              </div>

              {#if post.authorId !== null}
                <!--
                  VRChat's post record carries only an author id; the daemon fills the name in from
                  presence and the friend log at no request cost and leaves it null otherwise. A
                  post whose author is a stranger is a normal post, so the id stands in rather than
                  the row pretending it has no author.
                -->
                <UserName
                  userId={post.authorId}
                  name={post.authorDisplayName ?? shortId(post.authorId, 12)}
                  accountId={groupScreen.accountId}
                />
              {/if}

              {#if post.text !== null}
                <!-- Author-written, line breaks and all. VRChat does not treat it as markdown. -->
                <p class="text-sm whitespace-pre-wrap">{post.text}</p>
              {/if}

              {#if post.imageUrl !== null && post.imageUrl !== ""}
                <img
                  src={imageUrl(post.imageUrl)}
                  alt=""
                  loading="lazy"
                  class="max-h-96 w-full border border-border object-contain"
                />
              {/if}
            </article>
          {/snippet}
        </PagedSection>
      </Tabs.Content>

      <Tabs.Content value="galleries" class="space-y-4 pt-4">
        {#if galleries.length === 0}
          <EmptyState
            icon={ImageIcon}
            title="No galleries"
            description="This group has not created any galleries, or none are visible to this account."
          />
        {:else}
          <!--
            The gallery list rides in on the group record, so switching galleries costs one request
            for images and none for the list itself.
          -->
          <div class="flex flex-wrap gap-2">
            {#each galleries as gallery (gallery.id)}
              <Button
                variant={gallery.id === groupScreen.galleryId ? "secondary" : "ghost"}
                size="sm"
                onclick={() => groupScreen.selectGallery(gallery.id)}
              >
                {gallery.name}
                {#if gallery.membersOnly}
                  <Badge variant="outline" class="ml-1">Members</Badge>
                {/if}
              </Button>
            {/each}
          </div>

          <PagedSection
            list={groupScreen.images}
            icon={ImageIcon}
            emptyTitle="Nothing in this gallery"
            emptyDescription="No images have been added to it yet."
            titles={FAILURE_TITLES}
            bodies={GALLERY_BODIES}
          >
            {#snippet row(image)}
              <figure class="space-y-1 border border-border p-2">
                {#if image.imageUrl !== null && image.imageUrl !== ""}
                  <img
                    src={imageUrl(image.imageUrl)}
                    alt=""
                    loading="lazy"
                    class="max-h-96 w-full object-contain"
                  />
                {/if}
                {#if image.submittedByUserId !== null}
                  <figcaption class="text-xs text-muted-foreground">
                    submitted by <UserName
                      userId={image.submittedByUserId}
                      name={shortId(image.submittedByUserId, 12)}
                      accountId={groupScreen.accountId}
                      class="inline"
                    />
                  </figcaption>
                {/if}
              </figure>
            {/snippet}
          </PagedSection>
        {/if}
      </Tabs.Content>

      <Tabs.Content value="instances" class="pt-4">
        <PagedSection
          list={groupScreen.instances}
          icon={ServerIcon}
          emptyTitle="Nothing open right now"
          emptyDescription="This group has no instances running, or none this account may see."
          titles={FAILURE_TITLES}
          bodies={INSTANCE_BODIES}
        >
          {#snippet row(instance)}
            <div class="flex items-center gap-3 border border-border p-3">
              {#if instance.worldThumbnailImageUrl !== null && instance.worldThumbnailImageUrl !== ""}
                <img
                  src={imageUrl(instance.worldThumbnailImageUrl)}
                  alt=""
                  loading="lazy"
                  class="size-12 shrink-0 border border-border object-cover"
                />
              {/if}

              <div class="min-w-0 flex-1">
                {#if instance.worldId !== null}
                  <button
                    type="button"
                    class="truncate text-left font-medium underline-offset-4 hover:underline"
                    onclick={() =>
                      worldModal.openWorld(instance.worldId ?? "", {
                        // The location is what turns the dialog from "a world" into "that
                        // instance of it", which is the whole point of opening it from here.
                        location: instance.location,
                        name: instance.worldName,
                        accountId: groupScreen.accountId,
                      })}
                  >
                    {instance.worldName ?? shortId(instance.worldId, 14)}
                  </button>
                {:else}
                  <p class="truncate font-medium">{instance.worldName ?? "Unknown world"}</p>
                {/if}
                <p class="truncate text-xs text-muted-foreground">{instance.location}</p>
              </div>

              {#if instance.memberCount !== null}
                <span class="shrink-0 text-sm text-muted-foreground">
                  {instance.memberCount}{#if instance.worldCapacity !== null}/{instance.worldCapacity}{/if}
                </span>
              {/if}
            </div>
          {/snippet}
        </PagedSection>
      </Tabs.Content>
    </Tabs.Root>
  {/if}
</div>
