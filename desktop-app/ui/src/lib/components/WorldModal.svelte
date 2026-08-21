<!--
  One VRChat world, and — when it was opened from a real location — the instance inside it.

  Mounted exactly once, by `App.svelte`, and driven entirely by `worldModal`; see that module for
  why there is one instance rather than one per call site.

  The layout is one column rather than the user modal's tabs, because a world is one document: what
  it is, who made it, how big it is, and what VRChat's own counters say. The instance sits at the
  top because it is the only live thing on the page and usually the reason the dialog was opened.

  **Every number here is one VRChat sent.** There is no vrc.zip score, rank, or "popularity out of
  ten" anywhere in this file, and adding one would be worse than showing nothing: a derived number
  rendered in the same list as `visits` and `favorites` reads as a fact of the same kind.
-->
<script lang="ts">
import CalendarIcon from "@lucide/svelte/icons/calendar";
import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import UsersIcon from "@lucide/svelte/icons/users";
import HeroBanner from "$lib/components/HeroBanner.svelte";
import JoinAffordance from "$lib/components/JoinAffordance.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import UserName from "$lib/components/UserName.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import { accessLabel, calendarDay } from "$lib/format.ts";
import { worldModal } from "$lib/state/world-modal.svelte.ts";
import { copyText } from "$lib/user-actions.ts";

const world = $derived(worldModal.world);
const instance = $derived(worldModal.instance);
const parsed = $derived(worldModal.parsed);

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

<Dialog.Root
  open={worldModal.open}
  onOpenChange={(open) => {
    if (!open) worldModal.close();
  }}
>
  <!--
    Same shell as the user card: banner, header, scrolling body. The banner is a sibling of the
    header rather than a child of it, so both modals lay out identically and a change to one is
    visible as a change to the other.
  -->
  <Dialog.Content
    class="grid max-h-[85vh] grid-rows-[auto_auto_minmax(0,1fr)] gap-4 p-0 sm:max-w-2xl"
  >
    <!--
      The same band as the user card, at world height.

      It used to be `h-40` with an image and `h-16` without, so the title and everything under it
      sat at two different heights depending on whether a world had a usable image — and the
      no-image case is common. `HeroBanner` draws the plate unconditionally, fades the image in
      over it, and leaves the plate untouched when the VRChat file host 403s, which it does often
      enough to matter. Nothing below ever moves.
    -->
    <HeroBanner url={heroUrl} class="h-40" />

    <Dialog.Header class="-mt-6 gap-3 px-6 pr-12">
      <div class="space-y-2">
        <Dialog.Title class="text-base leading-snug break-words">{worldModal.title}</Dialog.Title>
        <Dialog.Description class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
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
        </Dialog.Description>

        <div class="flex flex-wrap items-center gap-2">
          {#if world?.releaseStatus === "private"}
            <!--
              A real statement about the world, not a warning: a private world is only reachable by
              its author and people they let in, which is why it can be missing everywhere else.
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
        </div>
      </div>
    </Dialog.Header>

    <div class="min-h-0 space-y-4 overflow-y-auto px-6 pt-4 pb-6">
      {#if worldModal.phase === "loading"}
        <div class="space-y-2">
          <Skeleton class="h-4 w-2/3" />
          <Skeleton class="h-4 w-1/2" />
          <Skeleton class="h-4 w-1/3" />
        </div>
      {:else if worldModal.phase === "error" && worldModal.failure !== null}
        {@const failure = worldModal.failure}
        <div class="space-y-2 border border-border bg-muted/40 px-3 py-3">
          <p class="text-sm font-medium">{FAILURE_TITLES[failure] ?? FAILURE_TITLES.other}</p>
          <p class="text-xs text-muted-foreground">
            {FAILURE_BODIES[failure] === "" ? worldModal.error : FAILURE_BODIES[failure]}
          </p>
          <Button variant="outline" size="sm" onclick={() => worldModal.retry()}>Try again</Button>
        </div>
      {/if}

      <!-- The instance ---------------------------------------------------- -->
      {#if worldModal.hasInstance}
        <section class="space-y-2 border border-border bg-muted/30 px-3 py-3">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p class="text-xs tracking-wide text-muted-foreground uppercase">This instance</p>
            <span class="tabular text-sm font-medium">{parsed.label}</span>
            <Badge variant="outline" class="tracking-wide uppercase">
              {accessLabel(parsed.access)}
            </Badge>
            {#if parsed.region}
              <span class="text-xs tracking-wide text-muted-foreground uppercase">
                {parsed.region}
              </span>
            {/if}

            <div class="ml-auto flex items-center gap-2">
              <!--
                The same join decision as every other location in the app, through the one
                component that owns it: a self-invite when a client is running, the deep link only
                when none is.
              -->
              <JoinAffordance
                location={worldModal.location}
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
            <p class="text-xs text-muted-foreground">
              {INSTANCE_BODIES[failure] === "" ? worldModal.instanceError : INSTANCE_BODIES[failure]}
            </p>
          {/if}
        </section>
      {/if}

      {#if world !== null}
        {#if world.description}
          <!-- Author-written, and it carries its own line breaks. -->
          <p class="text-sm whitespace-pre-wrap">{world.description}</p>
        {/if}

        {#if tags.length > 0}
          <div class="flex flex-wrap gap-1.5">
            <!--
              Keyed by index. VRChat's tag array is not guaranteed unique, and a repeated key is a
              hard runtime error in Svelte 5 rather than a duplicate chip — it would take the whole
              tab down. The list is static for a given world, so the index is stable.
            -->
            {#each tags as tag, index (index)}
              <Badge variant="secondary" class="font-normal">{tag}</Badge>
            {/each}
          </div>
        {/if}

        {#if counters.length > 0}
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            {#each counters as [label, value] (label)}
              <dt class="text-muted-foreground">{label}</dt>
              <dd class="tabular">{value.toLocaleString()}</dd>
            {/each}
          </dl>
          <p class="text-xs text-muted-foreground">
            VRChat's own counters, passed through unchanged. Heat and popularity are VRChat's
            internal scales — vrc.zip does not know what they are out of, and does not guess.
          </p>
        {/if}

        {#if world.publicationDate !== null || world.labsPublicationDate !== null || world.createdAt !== null || world.updatedAt !== null || world.version !== null}
          <Separator />
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
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
          </dl>
        {/if}
      {/if}

      <Separator />

      <div class="flex flex-wrap items-center gap-2">
        {#if worldModal.worldId !== null}
          <Button
            variant="outline"
            size="sm"
            href={`https://vrchat.com/home/world/${encodeURIComponent(worldModal.worldId)}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLinkIcon />
            Open on vrchat.com
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="text-muted-foreground"
            onclick={() => void copyText("World id", worldModal.worldId ?? "")}
          >
            Copy id
          </Button>
        {/if}
        <Button
          variant="ghost"
          size="sm"
          class="ml-auto text-muted-foreground"
          onclick={() => void copyText("World details", raw)}
        >
          Copy JSON
        </Button>
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
