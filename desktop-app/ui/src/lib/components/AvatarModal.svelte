<!--
  One VRChat avatar.

  Mounted exactly once, by `App.svelte`, and driven entirely by `avatarModal`; see that module for
  why there is one instance rather than one per call site, and for why most of the ways in start
  from a picture rather than from an id.

  Built on `EntityModal`, the same shell the user, world and group cards use, so the banner, the
  header and the scroll behaviour are identical in all four.

  Two tabs rather than the world modal's three, because an avatar has no live half. A world has
  instances that change by the minute; an avatar record is a document that changes when its author
  uploads a new build and not otherwise, so there is the reading and there are the bytes.

  **Nothing here is a judgement about the avatar.** No performance rank, no size estimate, no
  "quality" of any kind. VRChat's own `releaseStatus` and `tags` are passed through and everything
  else is a date or a version number it sent. A derived number rendered beside them would read as a
  fact of the same kind, and vrc.zip does not have one.
-->
<script lang="ts">
import CalendarIcon from "@lucide/svelte/icons/calendar";
import { imageUrl } from "$lib/api.ts";
import DetailGrid from "$lib/components/DetailGrid.svelte";
import EntityFooter from "$lib/components/EntityFooter.svelte";
import EntityModal, { type ModalTab } from "$lib/components/EntityModal.svelte";
import FailureNote from "$lib/components/FailureNote.svelte";
import RawJsonPanel from "$lib/components/RawJsonPanel.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import UserName from "$lib/components/UserName.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Separator } from "$lib/components/ui/separator/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import * as Tabs from "$lib/components/ui/tabs/index.js";
import { calendarDay } from "$lib/format.ts";
import {
  AVATAR_MODAL_TAB_LABELS,
  AVATAR_MODAL_TABS,
  avatarModal,
  isAvatarModalTab,
} from "$lib/state/avatar-modal.svelte.ts";
import { app } from "$lib/state/app.svelte.ts";
import { modalBack } from "$lib/state/entity-modal.svelte.ts";

const avatar = $derived(avatarModal.avatar);

/**
 * The name of the account VRChat answered through, or null when saying so would be noise.
 *
 * Null with one account signed in: "seen through Ada" is only informative when there was another
 * account it might have been. Null too for a cached row written before the daemon recorded it,
 * where the honest answer is "not known" rather than a guess.
 */
const seenBy = $derived.by(() => {
  const id = avatar?.seenByAccountId ?? null;
  if (id === null || app.accounts.length < 2) return null;
  return app.accountById(id)?.displayName ?? null;
});

const tabs = $derived<ModalTab[]>(
  AVATAR_MODAL_TABS.map((tab) => ({ value: tab, label: AVATAR_MODAL_TAB_LABELS[tab] })),
);

/**
 * The avatar's own picture: the full image, falling back to the thumbnail.
 *
 * VRChat's image host refuses a browser outright — it wants the account's auth cookie and a
 * User-Agent a page cannot set — so the bytes come from the daemon's own `GET /api/image`. That
 * proxying is `HeroBanner`'s job, not this one's: passing an already-proxied URL produced
 * `/api/image?url=/api/image?url=…`, which resolves to nothing and left the plate blank grey.
 * `WorldModal` hands over the raw VRChat URL for the same reason.
 *
 * VRChat sends `""` rather than omitting an unset image, which `??` would happily hand on as a URL,
 * so emptiness is tested rather than nullishness.
 */
const heroUrl = $derived.by(() => {
  if (avatar === null) return null;
  return avatar.imageUrl !== null && avatar.imageUrl !== ""
    ? avatar.imageUrl
    : avatar.thumbnailImageUrl !== null && avatar.thumbnailImageUrl !== ""
      ? avatar.thumbnailImageUrl
      : null;
});

/**
 * VRChat's own tags, minus its internal prefixes.
 *
 * `author_tag_` is what the *author* typed, which is the half a reader recognises; `system_` tags
 * are VRChat's bookkeeping and are shown unprefixed rather than hidden, because an avatar's
 * approval state is a real fact about it.
 */
const tags = $derived(
  (avatar?.tags ?? []).map((tag) => tag.replace(/^author_tag_/, "").replace(/^system_/, "")),
);

const raw = $derived(JSON.stringify(avatarModal.snapshot, null, 2));

const FAILURE_TITLES: Record<string, string> = {
  "not-an-avatar": "This picture is not an avatar vrc.zip can identify",
  "no-account": "No account is online",
  "not-found": "VRChat does not have this avatar",
  offline: "The daemon is not reachable",
  other: "Could not load this avatar",
};

const FAILURE_BODIES: Record<string, string> = {
  "not-an-avatar":
    "VRChat puts no avatar id on a user, so the picture's file id is the only handle there is, and this one maps to nothing. Profile pictures, banners and gallery images are ordinary images rather than avatars, and an avatar nobody has ever looked up cannot be named from its picture alone.",
  "no-account":
    "An avatar record is VRChat's alone, so it can only be read through a signed-in account's credentials, and none of yours are connected right now.",
  "not-found":
    "The id no longer resolves. Avatars are deleted and made private constantly, and an id out of an old feed row is exactly where a dead one comes from.",
  offline: "vrc.zip's daemon is not answering, so nothing about this avatar can be read.",
  other: "",
};
</script>

<EntityModal
  open={avatarModal.open}
  onClose={() => avatarModal.close()}
  backLabel={modalBack()?.label ?? null}
  bannerUrl={heroUrl}
  bannerClass="h-40"
  title={avatarModal.title}
  titleClass="break-words"
  headerClass="-mt-6"
  {tabs}
  tab={avatarModal.tab}
  onSelectTab={(value) => {
    if (isAvatarModalTab(value)) avatarModal.selectTab(value);
  }}
  tabsLabel="What to show about this avatar"
>
  {#snippet subtitle()}
    {#if avatar !== null && avatar.authorName}
      <span>
        by
        <!-- A real `UserName`, so the author is one click from their own profile. -->
        <UserName
          userId={avatar.authorId}
          name={avatar.authorName}
          accountId={avatarModal.accountId}
        />
      </span>
    {:else if avatarModal.phase === "loading"}
      <span>Reading the avatar…</span>
    {:else}
      <span class="font-mono">{avatarModal.avatarId ?? avatarModal.fileId ?? ""}</span>
    {/if}
  {/snippet}

  {#snippet badges()}
    {#if avatar?.releaseStatus === "private"}
      <!--
        A statement about the avatar, not a warning: a private avatar is only wearable by its author
        and the people they shared it with, which is why it can be missing everywhere else.
      -->
      <Badge variant="outline" title="Only the author and people they share it with can use this">
        Private avatar
      </Badge>
    {:else if avatar?.releaseStatus}
      <Badge variant="outline" title="VRChat release status">{avatar.releaseStatus}</Badge>
    {/if}
    {#if avatar?.cached}
      <Badge variant="secondary" title="Served from vrc.zip's avatar cache, not a live fetch">
        Cached <RelativeTime ts={avatar.fetchedAt} />
      </Badge>
    {/if}
    {#if seenBy !== null}
      <!--
        Which account could see it, which on a multi-account setup is a real fact rather than a
        detail of how it was fetched: VRChat serves an avatar record only to accounts allowed to
        see it, so this is the difference between "this avatar is gone" and "your other account
        can see this one". Only drawn when more than one account is signed in, because with one
        account it says nothing the reader does not already know.
      -->
      <Badge variant="secondary" title="The account whose credentials VRChat answered">
        Seen through {seenBy}
      </Badge>
    {/if}
  {/snippet}

  <!-- Overview ---------------------------------------------------------------- -->
  <Tabs.Content value="overview" class="space-y-4">
    {#if avatarModal.phase === "loading"}
      <div class="space-y-2">
        <Skeleton class="h-4 w-2/3" />
        <Skeleton class="h-4 w-1/2" />
        <Skeleton class="h-4 w-1/3" />
      </div>
    {:else if avatarModal.phase === "error" && avatarModal.displayFailure !== null}
      {@const failure = avatarModal.displayFailure}
      <!--
        No retry offered for a picture that names no avatar: the resolver latches that answer for
        the session, so the button could only ever repeat itself. Everything else is worth asking
        again — a signed-out account signs in, a daemon comes back.
      -->
      {#if failure === "not-an-avatar"}
        <FailureNote
          {failure}
          titles={FAILURE_TITLES}
          bodies={FAILURE_BODIES}
          message={avatarModal.error}
        />
      {:else}
        <FailureNote
          {failure}
          titles={FAILURE_TITLES}
          bodies={FAILURE_BODIES}
          message={avatarModal.error}
          onRetry={() => avatarModal.retry()}
        />
      {/if}
    {/if}

    {#if avatar !== null}
      {#if heroUrl !== null}
        <!--
          The picture again, and at its own shape this time.
          
          The banner above is a 160px band that centre-crops whatever it is given, which suits a
          world's letterbox hero and does not suit an avatar: VRChat's avatar images are portrait,
          so the band shows a horizontal slice of one and the thing the reader came to look at is
          mostly off-screen. This is the whole image, and it is the reason the tab exists.

          `alt=""` because the words beside it — the name, the author, the tags — are everything
          about this image that can be said in words, and the heading has already said them.
        -->
        <img
          src={imageUrl(heroUrl)}
          alt=""
          loading="lazy"
          class="max-h-72 w-full border border-border bg-muted/40 object-contain"
        />
      {/if}

      {#if avatar.description}
        <!-- Author-written, and it carries its own line breaks. -->
        <p class="text-sm whitespace-pre-wrap">{avatar.description}</p>
      {/if}

      {#if tags.length > 0}
        <div class="flex flex-wrap gap-1.5">
          <!--
            Keyed by index. VRChat's tag array is not guaranteed unique, and a repeated key is a
            hard runtime error in Svelte 5 rather than a duplicate chip — it would take the whole
            dialog down. The list is static for a given avatar, so the index is stable.
          -->
          {#each tags as tag, index (index)}
            <Badge variant="secondary" class="font-normal">{tag}</Badge>
          {/each}
        </div>
      {/if}

      {#if avatar.version !== null || avatar.createdAt !== null || avatar.updatedAt !== null}
        <!--
          A row is dropped when VRChat did not send the field rather than rendered as a zero or a
          dash: an avatar with no `version` and an avatar at version 0 are not the same claim.
        -->
        <Separator />
        <DetailGrid>
          {#if avatar.version !== null}
            <dt class="text-muted-foreground">Version</dt>
            <dd class="tabular">{avatar.version}</dd>
          {/if}
          {#if avatar.createdAt !== null}
            <dt class="flex items-center gap-1.5 text-muted-foreground">
              <CalendarIcon class="size-3.5" />
              Created
            </dt>
            <dd class="tabular">{calendarDay(avatar.createdAt)}</dd>
          {/if}
          {#if avatar.updatedAt !== null}
            <dt class="text-muted-foreground">Last updated</dt>
            <dd><RelativeTime ts={avatar.updatedAt} /></dd>
          {/if}
        </DetailGrid>
      {/if}
    {/if}
  </Tabs.Content>

  <!-- Raw JSON ---------------------------------------------------------------- -->
  <Tabs.Content value="raw" class="space-y-4">
    <RawJsonPanel json={raw} copyLabel="Avatar details" />
    <EntityFooter
      id={avatarModal.avatarId}
      href={avatarModal.avatarId === null
        ? null
        : `https://vrchat.com/home/avatar/${encodeURIComponent(avatarModal.avatarId)}`}
      openLabel="Open on vrchat.com"
      idLabel="Avatar id"
      jsonLabel="Avatar details"
      json={raw}
    />
  </Tabs.Content>
</EntityModal>
