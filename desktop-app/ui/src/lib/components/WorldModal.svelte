<!--
  One VRChat world, and — when it was opened from a real location — the instance inside it.

  Mounted exactly once, by `App.svelte`, and driven entirely by `worldModal`; see that module for
  why there is one instance rather than one per call site.

  Built on `EntityModal`, the shell the user and group cards share, so the banner, the header and
  the scroll behaviour are identical in all three.

  ## Why this is three tabs now, when it used to be one column

  It was one column on the argument that a world is one document. That was true of the *record* and
  false of the dialog: half of it described a world, which barely changes, and half described one
  live instance, which changes by the minute — and the live half was pinned to whichever location
  the dialog happened to be opened from, with no way to reach any other. A reader asking "where can
  I actually go in this world" had nowhere to look.

  So the live half is a tab of its own with a list in it, and the instance being described is a
  *selection* rather than a fixed fact about how the dialog was opened. The old behaviour survives
  as the default: opening from a location preselects that instance and starts on this tab, because
  that instance is still the reason the dialog was opened.

  **The list is assembled and it says so.** VRChat has no endpoint that enumerates a world's
  instances, so the daemon merges three partial sources: the world record read *once per signed-in
  account* (its `instances` field is empty when unauthenticated and differs by who asked), friends'
  presence, and the game clients on this machine. None is complete alone, so an instance no account
  was shown and nobody you know is in does not appear here — and the tab says that out loud rather
  than letting a short list read as an empty world. See `WorldInstanceList`.

  Each row then reads its own instance record for the head count and the name somebody gave the
  room. That is a request per row, which is affordable only because `instance-info.svelte.ts` queues
  them three at a time and caches; see the note there on why fetching from render is safe now.

  **Every number here is one VRChat sent.** There is no vrc.zip score, rank, or "popularity out of
  ten" anywhere in this file, and adding one would be worse than showing nothing: a derived number
  rendered in the same list as `visits` and `favorites` reads as a fact of the same kind.
-->
<script lang="ts">
import { tick } from "svelte";
import CalendarIcon from "@lucide/svelte/icons/calendar";
import DoorOpenIcon from "@lucide/svelte/icons/door-open";
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import UsersIcon from "@lucide/svelte/icons/users";
import DetailGrid from "$lib/components/DetailGrid.svelte";
import EntityFooter from "$lib/components/EntityFooter.svelte";
import EntityModal, { type ModalTab } from "$lib/components/EntityModal.svelte";
import FailureNote from "$lib/components/FailureNote.svelte";
import JoinAffordance from "$lib/components/JoinAffordance.svelte";
import PagedSection from "$lib/components/PagedSection.svelte";
import RawJsonPanel from "$lib/components/RawJsonPanel.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import UserName from "$lib/components/UserName.svelte";
import WorldInstanceRow from "$lib/components/WorldInstanceRow.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import { accessLabel, calendarDay } from "$lib/format.ts";
import { app } from "$lib/state/app.svelte.ts";
import { modalBack } from "$lib/state/entity-modal.svelte.ts";
import {
  WORLD_MODAL_TAB_LABELS,
  WORLD_MODAL_TABS,
  isWorldModalTab,
  worldModal,
} from "$lib/state/world-modal.svelte.ts";

const world = $derived(worldModal.world);
const instance = $derived(worldModal.instance);
const parsed = $derived(worldModal.parsed);

/*
 * Where this machine's own clients are standing.
 *
 * From the game log rather than from the daemon's derived list, so it is right even for an instance
 * the list does not contain — an old feed row can open a location nobody is in but you. The daemon
 * answers the same question for the rows it returns; this is the same fact read locally, and it
 * costs nothing because `app.sessions` is already in memory.
 */
const myLocations = $derived(
  new Set(
    app.sessions
      .map((session) => session.currentLocation)
      .filter((location): location is string => location !== null && location !== ""),
  ),
);

const youAreHere = $derived(worldModal.selected !== null && myLocations.has(worldModal.selected));

/** The detail panel, so choosing a row from further down the list can bring the answer into view. */
let panel = $state<HTMLElement | null>(null);

/**
 * Selecting an instance, and then showing the reader what they selected.
 *
 * The panel sits above the list, so picking the ninth row updates something off the top of the
 * screen and looks like nothing happened. `tick()` first because the panel may not exist yet: a
 * world opened without a location has no selection, so the very first pick is what creates it.
 *
 * `scrollIntoView` acts on the nearest scrollable ancestor, which is `EntityModal`'s body, so this
 * moves the dialog rather than the page behind it.
 */
async function chooseInstance(location: string): Promise<void> {
  worldModal.selectInstance(location);
  await tick();
  panel?.scrollIntoView({
    // A jump for anyone who has asked the OS for less motion; the movement is the point, not the
    // animation, and this is a small enough courtesy to be worth the one line.
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}

/**
 * The count on the Instances tab.
 *
 * Null until the list has actually loaded: an absent count means "not read yet", never "none".
 * The tab's own empty state is the only thing allowed to claim zero. See `ModalTab`.
 */
const tabs = $derived<ModalTab[]>(
  WORLD_MODAL_TABS.map((tab) => ({
    value: tab,
    label: WORLD_MODAL_TAB_LABELS[tab],
    count:
      tab === "instances" && worldModal.instances.phase === "ready"
        ? worldModal.instances.items.length
        : null,
  })),
);

const INSTANCE_FAILURE_TITLES: Record<string, string> = {
  offline: "The daemon is not reachable",
  other: "Could not read the instance list",
};

const INSTANCE_FAILURE_BODIES: Record<string, string> = {
  offline: "vrc.zip's daemon is not answering, so it cannot say what it can see.",
  other: "",
};

/** The banner image, then the thumbnail. Both are VRChat's; nothing is substituted for them. */
const heroUrl = $derived(world?.imageUrl ?? world?.thumbnailImageUrl ?? null);

/**
 * VRChat's own tags, minus its internal ones.
 *
 * `author_tag_` prefixes are what the *author* typed, which is the half a reader recognises;
 * `system_` tags are VRChat's bookkeeping and are shown unprefixed rather than hidden, because a
 * world's approval state is a real fact about it.
 */
const tags = $derived(
  (world?.tags ?? []).map((tag) => tag.replace(/^author_tag_/, "").replace(/^system_/, "")),
);

const raw = $derived(JSON.stringify(worldModal.snapshot, null, 2));

/**
 * `visits`, `favorites`, `occupants`, `heat`, `popularity` — passed through and never combined.
 *
 * A row is dropped when VRChat did not send the number rather than rendered as a zero, because a
 * world with no `visits` field and a world with no visits are not the same claim.
 */
const counters = $derived.by(() => {
  const rows: [string, number][] = [];
  if (world === null) return rows;
  const push = (label: string, value: number | null): void => {
    if (value !== null) rows.push([label, value]);
  };
  push("Visits", world.visits);
  push("Favorites", world.favorites);
  push("In this world now", world.occupants);
  push("Heat", world.heat);
  push("Popularity", world.popularity);
  return rows;
});

const FAILURE_TITLES: Record<string, string> = {
  "no-account": "No account is online",
  "not-found": "VRChat does not have this world",
  offline: "The daemon is not reachable",
  other: "Could not load this world",
};

const FAILURE_BODIES: Record<string, string> = {
  "no-account":
    "A world vrc.zip has never fetched can only be read through a signed-in account's credentials, and none of yours are connected right now. Worlds it has already seen are served from its cache with nobody signed in.",
  "not-found":
    "The id no longer resolves. Worlds are unpublished and deleted all the time, and an old log line is exactly where a dead world id comes from.",
  offline: "vrc.zip's daemon is not answering, so nothing about this world can be read.",
  other: "",
};

const INSTANCE_BODIES: Record<string, string> = {
  closed:
    "VRChat has no record of this instance any more. Instances close when the last person leaves, so this is the ordinary fate of every location string given enough time — the world below is unaffected.",
  "no-account":
    "The live counts for an instance can only be read through a signed-in account's credentials, and none of yours are connected right now.",
  "invalid-location": "This is not an instance VRChat can be asked about.",
  offline: "The daemon is not answering, so the live counts could not be read.",
  other: "",
};
</script>

<EntityModal
  open={worldModal.open}
  onClose={() => worldModal.close()}
  backLabel={modalBack()?.label ?? null}
  bannerUrl={heroUrl}
  bannerClass="h-40"
  title={worldModal.title}
  titleClass="break-words"
  headerClass="-mt-6"
  {tabs}
  tab={worldModal.tab}
  onSelectTab={(value) => {
    if (isWorldModalTab(value)) worldModal.selectTab(value);
  }}
  tabsLabel="What to show about this world"
>
  {#snippet subtitle()}
    {#if world !== null}
      {#if world.authorName}
        <span>
          by
          <!-- A real `UserName`, so the author is one click from their own profile. -->
          <UserName
            userId={world.authorId}
            name={world.authorName}
            accountId={worldModal.accountId}
          />
        </span>
      {/if}
      {#if world.capacity !== null}
        <span aria-hidden="true">·</span>
        <span class="tabular">holds {world.capacity}</span>
      {/if}
      {#if world.recommendedCapacity !== null && world.recommendedCapacity !== world.capacity}
        <span class="tabular">({world.recommendedCapacity} recommended)</span>
      {/if}
    {:else if worldModal.phase === "loading"}
      <span>Reading the world…</span>
    {:else}
      <span class="font-mono">{worldModal.worldId ?? ""}</span>
    {/if}
  {/snippet}

  {#snippet badges()}
    {#if world?.releaseStatus === "private"}
      <!--
        A real statement about the world, not a warning: a private world is only reachable by its
        author and people they let in, which is why it can be missing everywhere else.
      -->
      <Badge variant="outline" title="Only the author and people they invite can find this">
        Private world
      </Badge>
    {:else if world?.releaseStatus}
      <Badge variant="outline" title="VRChat release status">{world.releaseStatus}</Badge>
    {/if}
    {#if world?.cached}
      <Badge variant="secondary" title="Served from vrc.zip's world cache, not a live fetch">
        Cached <RelativeTime ts={world.fetchedAt} />
      </Badge>
    {/if}
  {/snippet}

  <!-- Instances ---------------------------------------------------------------- -->
  <Tabs.Content value="instances" class="space-y-4">
    <!--
      The selected instance, in full. Above the list rather than below it because it is what the
      list is *for*: the rows are how you choose, this is the answer.
    -->
    {#if worldModal.hasInstance}
      <section bind:this={panel} class="space-y-2 border border-border bg-muted/30 px-3 py-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p class="text-xs tracking-wide text-muted-foreground uppercase">This instance</p>
        {#if instance?.displayName}
          <!-- The room's own name when it has one, with the number kept beside it. -->
          <span class="min-w-0 truncate text-sm font-medium">{instance.displayName}</span>
          <span class="tabular text-xs text-muted-foreground">{parsed.label}</span>
        {:else}
          <span class="tabular text-sm font-medium">{parsed.label}</span>
        {/if}
        <Badge variant="outline" class="tracking-wide uppercase">
          {accessLabel(parsed.access)}
        </Badge>
        {#if parsed.region}
          <span class="text-xs tracking-wide text-muted-foreground uppercase">
            {parsed.region}
          </span>
        {/if}
        {#if youAreHere}
          <!--
            Read off this machine's own game logs, so it holds for an instance the derived list
            below does not contain — which is the common case for a location opened from old feed
            scrollback.
          -->
          <Badge
            variant="outline"
            class="border-status-online/40 bg-status-online/10 text-status-online"
          >
            You are here
          </Badge>
        {/if}

        <div class="ml-auto flex items-center gap-2">
          <!--
            The same join decision as every other location in the app, through the one component
            that owns it: a self-invite when a client is running, the deep link only when none is.
          -->
          <JoinAffordance
            location={worldModal.selected}
            accountId={worldModal.accountId}
            class="text-xs"
          />
          <Button
            variant="ghost"
            size="xs"
            class="text-muted-foreground"
            disabled={worldModal.instancePhase === "loading"}
            onclick={() => worldModal.refreshInstance()}
          >
            <RefreshCwIcon />
            Refresh
          </Button>
        </div>
      </div>

      {#if worldModal.instancePhase === "loading"}
        <Skeleton class="h-4 w-40" />
      {:else if instance !== null}
        <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span class="inline-flex items-center gap-1.5">
            <UsersIcon class="size-3.5 text-muted-foreground" />
            <span class="tabular">
              {instance.userCount === null ? "not reported" : instance.userCount}
              {#if instance.capacity !== null}<span class="text-muted-foreground">
                  / {instance.capacity}
                </span>{/if}
            </span>
          </span>
          {#if instance.full}
            <Badge variant="outline">Full</Badge>
          {/if}
          {#if instance.queueEnabled}
            <Badge variant="outline">
              Queue{instance.queueSize === null ? "" : ` · ${instance.queueSize}`}
            </Badge>
          {/if}
          {#if instance.closedAt !== null}
            <Badge variant="outline" title={instance.hardClose === true ? "Hard close" : ""}>
              Closed <RelativeTime ts={instance.closedAt} />
            </Badge>
          {/if}
          {#if !instance.active}
            <Badge variant="outline">Not active</Badge>
          {/if}
        </p>
        {#if instance.nUsers !== null && instance.nUsers !== instance.userCount}
          <!--
            VRChat sends both counts and they can disagree. Showing the difference rather than
            picking a winner: which one is right is VRChat's business, not this app's.
          -->
          <p class="text-xs text-muted-foreground">
            VRChat's second count for this instance says {instance.nUsers}.
          </p>
        {/if}
        {#if worldModal.instanceFetchedAt !== null}
          <p class="text-xs text-muted-foreground">
            Read <RelativeTime ts={worldModal.instanceFetchedAt} />
          </p>
        {/if}
      {:else if worldModal.instanceFailure !== null}
        {@const failure = worldModal.instanceFailure}
        <!--
          A sentence, not a `FailureNote`: none of these is a fault, there is nothing to retry that
          the Refresh button above does not already offer, and a bordered error box inside a
          bordered section would read as the world itself having failed.
        -->
        <p class="text-xs text-muted-foreground">
          {INSTANCE_BODIES[failure] === "" ? worldModal.instanceError : INSTANCE_BODIES[failure]}
        </p>
      {/if}
      </section>
    {/if}

    <!--
      The list. `PagedSection` draws the skeleton, the empty state and the failure, exactly as the
      group screen's four lists do; only the row differs.
    -->
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs tracking-wide text-muted-foreground uppercase">Instances vrc.zip can see</p>
        <Button
          variant="ghost"
          size="xs"
          class="text-muted-foreground"
          disabled={worldModal.instances.phase === "loading"}
          onclick={() => worldModal.refreshInstances()}
        >
          <RefreshCwIcon />
          Refresh
        </Button>
      </div>

      <PagedSection
        list={worldModal.instances}
        icon={DoorOpenIcon}
        emptyTitle="No instances vrc.zip can see"
        emptyDescription="VRChat has no call that lists a world's instances, so this is built from where your friends are and where your own clients are. A busy public instance with nobody you know in it does not appear here, and that is a limit of what can be seen rather than a statement about the world."
        titles={INSTANCE_FAILURE_TITLES}
        bodies={INSTANCE_FAILURE_BODIES}
        skeletonRows={3}
      >
        {#snippet row(entry)}
          <WorldInstanceRow
            instance={entry}
            selected={entry.location === worldModal.selected}
            youAreHere={myLocations.has(entry.location)}
            accountsConsulted={worldModal.accountsConsulted}
            accountId={worldModal.accountId}
            onSelect={(location) => void chooseInstance(location)}
          />
        {/snippet}
      </PagedSection>

      {#if !worldModal.instances.isEmpty && worldModal.instances.phase === "ready"}
        <!--
          The caveat again, and deliberately not only in the empty state: a list with three rows in
          it reads as complete unless something says otherwise, and that is the reading this whole
          tab has to avoid.
        -->
        <p class="text-xs text-muted-foreground">
          Derived from where your friends are and where your own clients are, not from a listing
          VRChat publishes. Instances with nobody you know in them are not shown.
        </p>
      {/if}
    </div>
  </Tabs.Content>

  <!-- Overview ---------------------------------------------------------------- -->
  <Tabs.Content value="overview" class="space-y-4">
    {#if worldModal.phase === "loading"}
      <div class="space-y-2">
        <Skeleton class="h-4 w-2/3" />
        <Skeleton class="h-4 w-1/2" />
        <Skeleton class="h-4 w-1/3" />
      </div>
    {:else if worldModal.phase === "error" && worldModal.failure !== null}
      <FailureNote
        failure={worldModal.failure}
        titles={FAILURE_TITLES}
        bodies={FAILURE_BODIES}
        message={worldModal.error}
        onRetry={() => worldModal.retry()}
      />
    {/if}

  {#if world !== null}
    {#if world.description}
      <!-- Author-written, and it carries its own line breaks. -->
      <p class="text-sm whitespace-pre-wrap">{world.description}</p>
    {/if}

    {#if tags.length > 0}
      <div class="flex flex-wrap gap-1.5">
        <!--
          Keyed by index. VRChat's tag array is not guaranteed unique, and a repeated key is a hard
          runtime error in Svelte 5 rather than a duplicate chip — it would take the card down. The
          list is static for a given world, so the index is stable.
        -->
        {#each tags as tag, index (index)}
          <Badge variant="secondary" class="font-normal">{tag}</Badge>
        {/each}
      </div>
    {/if}

    {#if counters.length > 0}
      <DetailGrid>
        {#each counters as [label, value] (label)}
          <dt class="text-muted-foreground">{label}</dt>
          <dd class="tabular">{value.toLocaleString()}</dd>
        {/each}
      </DetailGrid>
      <p class="text-xs text-muted-foreground">
        VRChat's own counters, passed through unchanged. Heat and popularity are VRChat's internal
        scales — vrc.zip does not know what they are out of, and does not guess.
      </p>
    {/if}

    {#if world.publicationDate !== null || world.labsPublicationDate !== null || world.createdAt !== null || world.updatedAt !== null || world.version !== null}
      <Separator />
      <DetailGrid>
        {#if world.publicationDate !== null}
          <dt class="flex items-center gap-1.5 text-muted-foreground">
            <CalendarIcon class="size-3.5" />
            Published
          </dt>
          <dd class="tabular">{calendarDay(world.publicationDate)}</dd>
        {/if}
        {#if world.labsPublicationDate !== null}
          <dt class="text-muted-foreground">In Labs since</dt>
          <dd class="tabular">{calendarDay(world.labsPublicationDate)}</dd>
        {/if}
        {#if world.createdAt !== null}
          <dt class="text-muted-foreground">Created</dt>
          <dd class="tabular">{calendarDay(world.createdAt)}</dd>
        {/if}
        {#if world.updatedAt !== null}
          <dt class="text-muted-foreground">Last updated</dt>
          <dd><RelativeTime ts={world.updatedAt} /></dd>
        {/if}
        {#if world.version !== null}
          <dt class="text-muted-foreground">Version</dt>
          <dd class="tabular">{world.version}</dd>
        {/if}
      </DetailGrid>
    {/if}
  {/if}
  </Tabs.Content>

  <!-- Raw JSON ---------------------------------------------------------------- -->
  <Tabs.Content value="raw" class="space-y-4">
    <RawJsonPanel json={raw} copyLabel="World details" />
    <EntityFooter
      id={worldModal.worldId}
      href={worldModal.worldId === null
        ? null
        : `https://vrchat.com/home/world/${encodeURIComponent(worldModal.worldId)}`}
      openLabel="Open on vrchat.com"
      idLabel="World id"
      jsonLabel="World details"
      json={raw}
    />
  </Tabs.Content>
</EntityModal>
