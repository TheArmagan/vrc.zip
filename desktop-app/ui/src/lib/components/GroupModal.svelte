<!--
  One VRChat group, as vrc.zip knows them.

  Mounted exactly once, by `App.svelte`, and driven entirely by `groupModal` — see that module for
  why there is one instance rather than one per call site, and for what a 404 on a group actually
  means.

  Built on `EntityModal`, like the user and world cards, so the banner, the header and the scroll
  behaviour are the same three in all three. The body is tabbed, the way the user modal's is, because
  the three things worth knowing here are different *kinds* of thing rather than sections of one
  document: what the group is, where it is gathering right now, and what VRChat actually sent.

  Instances in particular do not belong in the middle of a document. They are a live answer that
  changes minute to minute while the description and the rules do not, they cost a second request
  nobody should pay for clicking a badge, and most groups have none — so they load when their tab is
  opened and their empty state is allowed to say so, rather than a blank stretch of the card.

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
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import ServerIcon from "@lucide/svelte/icons/server";
import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
import UsersIcon from "@lucide/svelte/icons/users";
import { imageUrl } from "$lib/api.ts";
import DetailGrid from "$lib/components/DetailGrid.svelte";
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
import { navigate } from "$lib/router.ts";
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
 * Instances load lazily, so their count appears once the tab has been opened rather than on
 * arrival. A count that is absent means "not read yet", never "none" — the empty state inside the
 * tab is the only thing allowed to claim zero.
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

/**
 * The instances tab's own words for the same failures.
 *
 * `forbidden` is the one worth spelling out, and it is not an error: a group deciding that only its
 * members may see where it is gathering is a rule about who may look, so it gets a sentence rather
 * than a retry that could never work.
 */
const INSTANCE_BODIES: Record<string, string> = {
  "no-account":
    "A group's instances can only be read through a signed-in account's credentials, and none of yours are connected right now.",
  "not-found": "This group is gone, or it is private to the account asking.",
  forbidden: "This group only tells its members where it is gathering.",
  offline: "",
  other: "",
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
        something different for the same group opened from two different rows.
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

    <!--
      Into the full group screen, for the three lists this dialog does not carry.

      `dismiss()` rather than `close()`, and this is that method's first real caller. Close pops one
      level of the shared back stack, which is right when a dialog opened another dialog; a route
      change invalidates every level, because the screen the reader would be returning *to* is no
      longer behind anything. Leaving the stack populated here would mean the next modal opened from
      the group screen has a back button pointing at a profile from before the navigation.
    -->
    {#if groupModal.groupId !== null}
      {@const id = groupModal.groupId}
      <Separator />
      <Button
        variant="secondary"
        class="w-full justify-between"
        onclick={() => {
          groupModal.dismiss();
          navigate("groups", id);
        }}
      >
        <span class="inline-flex items-center gap-2">
          <UsersIcon class="size-4" />
          Members, posts and galleries
        </span>
        <ChevronRightIcon class="size-4" />
      </Button>
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
