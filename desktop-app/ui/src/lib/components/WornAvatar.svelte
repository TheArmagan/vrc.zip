<!--
  The avatar a user is wearing, on their profile.

  ## Why this is harder than it looks

  VRChat tells you what an avatar looks like and never which avatar it is. `currentAvatarImageUrl`
  is a picture; there is no avatar id anywhere on a public user. So identifying it means taking the
  picture's file id to avtr.zip, which is a third-party lookup and a setting the user can turn off.

  That shapes every state below. The picture is shown *immediately* and unconditionally, because it
  is VRChat's own and needs nobody's permission. The identity is a separate, slower, optional thing
  layered on top, and its absence is never presented as a failure of the profile.

  ## Which pictures are offered, and in what order

  The worn avatar first, then the profile icon, then the banner. Only the first is *meant* to be an
  avatar, and the other two usually are not — a profile icon is normally a crop somebody uploaded.
  They are tried anyway because VRChat's own image chain sometimes puts the avatar picture in the
  icon slot for a user with no custom icon, and asking is the only way to find out. A picture that
  is not an avatar resolves to null, which is an ordinary answer and is cached as one.

  So "no avatar identified" here means exactly that: none of this person's pictures is one avtr.zip
  knows an avatar for. It does not mean they have no avatar, and the copy says so.
-->
<script lang="ts">
import ShirtIcon from "@lucide/svelte/icons/shirt";
import { imageUrl, type UserProfile } from "$lib/api.ts";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Skeleton } from "$lib/components/ui/skeleton/index.js";
import UserName from "$lib/components/UserName.svelte";
import { avatarIds } from "$lib/state/avatar-ids.svelte.ts";
import { avatarModal } from "$lib/state/avatar-modal.svelte.ts";
import { avatarRecords } from "$lib/state/avatar-records.svelte.ts";

let {
  profile,
  accountId = null,
}: {
  profile: UserProfile;
  accountId?: string | null;
} = $props();

/**
 * Every picture worth asking about, best candidate first.
 *
 * `resolveAny` returns the first that resolves, not the first that was asked, so the ordering is a
 * preference rather than a sequence: if the icon resolves before the worn avatar does, the icon's
 * answer is used until the better one lands and then replaced by it.
 */
const candidates = $derived([
  profile.currentAvatarImageUrl,
  profile.currentAvatarThumbnailImageUrl,
  profile.iconUrl,
  profile.bannerUrl,
]);

/*
 * The lookup starts on render, which the resolver is built for: it queues three at a time, latches
 * both answers for the session, and never asks twice about one file. A profile names four pictures
 * and most of them are the same two files.
 */
$effect(() => {
  avatarIds.ensureAll(candidates);
});

const avatarId = $derived(avatarIds.resolveAny(candidates));
const looking = $derived(avatarId === null && avatarIds.pending(candidates));

/*
 * Once the id is known, read the record so the row can print a name.
 *
 * A second lookup, and worth it: "Robot Kyle by Kung" is the answer, where a button saying "open
 * this avatar" is an offer to go and find the answer. The resolver caches per id for the session
 * and dedupes, so several profiles wearing the same popular avatar cost one request.
 */
$effect(() => {
  avatarRecords.ensure(avatarId, accountId);
});

const record = $derived(avatarRecords.get(avatarId));
const recordEntry = $derived(avatarRecords.entry(avatarId));
/** True while the record is on its way and there is nothing yet to draw in its place. */
const reading = $derived(avatarId !== null && record === null && recordEntry?.status === "loading");

/** The picture itself, which is VRChat's and needs no third party. Shown whatever the lookup says. */
const picture = $derived(
  profile.currentAvatarThumbnailImageUrl ?? profile.currentAvatarImageUrl,
);

/** VRChat's content tags for the worn avatar, minus its own prefixes. */
const tags = $derived(
  profile.currentAvatarTags.map((tag) =>
    tag.replace(/^content_/, "").replace(/^author_tag_/, "").replace(/^system_/, ""),
  ),
);

/** True when there is genuinely nothing to draw, so the section can stay out of the way. */
const empty = $derived(picture === null && tags.length === 0 && avatarId === null && !looking);
</script>

{#if !empty}
  <section class="space-y-2">
    <p class="text-xs tracking-wide text-muted-foreground uppercase">Wearing</p>

    <div class="flex items-start gap-3">
      {#if picture !== null}
        <!--
          `alt=""`: everything this image depicts that can be put into words is in the words beside
          it, and when the avatar has no identified name there is nothing truer to say than "the
          avatar they are wearing", which the heading above already says.
        -->
        <img
          src={imageUrl(picture)}
          alt=""
          loading="lazy"
          class="h-20 w-16 shrink-0 border border-border object-cover"
        />
      {/if}

      <div class="min-w-0 flex-1 space-y-1.5">
        {#if avatarId !== null && record !== null}
          <!--
            The name is the control, the way a world's name is in `WorldLink` and a person's is in
            `UserName`. A separate "open" button beside a name the reader can already see would be
            a second target for the same intent.
          -->
          <button
            type="button"
            class="max-w-full cursor-pointer truncate text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            onclick={() => avatarModal.openAvatar(avatarId, { name: record.name, accountId })}
          >
            {record.name}
          </button>

          <p class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {#if record.authorName || record.authorId !== null}
              <span>
                by
                <!-- A real `UserName`, so the author is one click from their own card. -->
                <UserName
                  userId={record.authorId}
                  name={record.authorName}
                  {accountId}
                  class="max-w-full truncate"
                />
              </span>
            {/if}
            {#if record.releaseStatus === "private"}
              <!--
                Not a warning. A private avatar is one only its author and the people they shared
                it with can wear, which is also why most avatars are unreadable to most accounts.
              -->
              <span aria-hidden="true">·</span>
              <span>Private</span>
            {/if}
          </p>
        {:else if avatarId !== null && reading}
          <Skeleton class="h-5 w-44" />
        {:else if avatarId !== null}
          <!--
            The id resolved but the record did not: deleted, or private to an author none of your
            accounts is. The modal is still worth opening, because it is the thing that explains
            which of those it was.
          -->
          <Button
            variant="outline"
            size="sm"
            onclick={() => avatarModal.openAvatar(avatarId, { accountId })}
          >
            <ShirtIcon />
            Open this avatar
          </Button>
          {#if recordEntry?.failure === "not-visible"}
            <p class="text-xs text-muted-foreground">
              None of your signed-in accounts can read this avatar's record, which is ordinary for
              a private one.
            </p>
          {/if}
        {:else if looking}
          <Skeleton class="h-8 w-40" />
        {:else}
          <!--
            Not a failure, and worded so it cannot be read as one. VRChat published the picture and
            not the identity; avtr.zip either does not know this file or was never asked.
          -->
          <p class="text-xs text-muted-foreground">
            VRChat does not say which avatar this is, and avtr.zip has no match for the pictures on
            this profile. The image above is still theirs.
          </p>
        {/if}

        {#if tags.length > 0}
          <div class="flex flex-wrap gap-1">
            <!--
              Keyed by index. VRChat's tag arrays are not guaranteed unique, and a duplicate key is
              a hard runtime error in Svelte 5 rather than a repeated chip.
            -->
            {#each tags as tag, index (index)}
              <Badge variant="secondary" class="h-5 px-1.5 text-[10px] font-normal">{tag}</Badge>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </section>
{/if}
