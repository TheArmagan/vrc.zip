<!--
  One line of the feed.

  It used to print a kind label and, if the payload happened to carry a name, a name: "Player
  joined  Ada". Every screenshot read "Screenshot taken", every failed join read "Join failed", and
  every notification of any type read "Notification" — while the payload held the file, the reason
  and the invite the whole time. `event-details.ts` reads it; this renders what it returns.

  What is rendered here rather than there is everything interactive: names go through `UserName`
  and `GroupName` so they open a card, and locations through `LocationLine` so they can be joined.
  `describeEvent` returns data, never markup.

  Payloads are VRChat's own shapes forwarded verbatim, so this still says nothing when it finds
  nothing. A row never invents a subject, and a kind this build has never seen still gets a
  readable label and a place in the list rather than being dropped.
-->
<script lang="ts">
import ChevronIcon from "@lucide/svelte/icons/chevron-down";
import ShirtIcon from "@lucide/svelte/icons/shirt";
import { fileIdFromImageUrl } from "$lib/api.ts";
import GroupName from "$lib/components/GroupName.svelte";
import LocationLine from "$lib/components/LocationLine.svelte";
import UserName from "$lib/components/UserName.svelte";
import { describeEvent, TONE_CLASSES } from "$lib/event-details.ts";
import type { LiveEvent } from "$lib/events.ts";
import { fullTimestamp, isGroupId, isUserId, shortId, timeOfDay } from "$lib/format.ts";
import { avatarModal } from "$lib/state/avatar-modal.svelte.ts";

let {
  event,
  dense = false,
  repeats = 1,
  oldestTs = null,
}: {
  event: LiveEvent;
  dense?: boolean;
  /** How many identical adjacent events this row stands for. See `collapseRepeats`. */
  repeats?: number;
  /** Timestamp of the oldest event in the run, when `repeats` is above 1. */
  oldestTs?: number | null;
} = $props();

const details = $derived(describeEvent(event));
const tone = $derived(TONE_CLASSES[details.tone]);
/** Capitalised so the template renders it as a component rather than as an `<icon>` element. */
const Icon = $derived(details.icon);

/*
 * A row's subject is only sometimes a person.
 *
 * `subjectOf` in the daemon's bridges files whatever id the payload carried: a user for
 * `friend.*` and `gamelog.player_*`, but a world for `gamelog.world_enter`, a group for
 * `group.*`, and a notification id for `notification.seen`. A `usr_…` and a `grp_…` each get a
 * control that opens their own card; everything else — a notification id, a `gamelog.player_join`
 * whose payload has a name but no id (VRChat has shipped it both ways) — stays plain text.
 */
const subjectUserId = $derived(isUserId(event.subjectId) ? event.subjectId : null);
const subjectGroupId = $derived(isGroupId(event.subjectId) ? event.subjectId : null);

/*
 * What the row calls its subject.
 *
 * A `usr_…` is handed to `UserName` as `null`, which is that component's request to look the person
 * up rather than a blank: a bare `usr_a1b2c3…` in a feed row tells the reader nothing, and VRChat
 * is the only thing that knows the name. Anything that is *not* a user — a notification id, a world
 * — has no lookup and keeps the shortened id, which is at least an identifier a person can match
 * against another row.
 */
const subject = $derived(
  details.subject ??
    (subjectUserId !== null || event.subjectId === null ? null : shortId(event.subjectId, 12)),
);

/** True when the row is showing an identifier rather than a name, which reads differently. */
const subjectIsId = $derived(details.subject === null && subject !== null);

/**
 * A row with a user to name always renders one, even when the payload carried only the id — unless
 * the description says the row has no subject at all. See `EventDetails.subjectless`: an economy
 * frame carries the reader's own account id, and naming it turns "Credit balance changed" into a
 * sentence about somebody else.
 */
const showsUser = $derived(
  details.subjectless !== true && (subject !== null || subjectUserId !== null),
);

/**
 * True when the row actually drew something before the action phrase.
 *
 * Not the same question as "did `describeEvent` give us a name": a `usr_…` with no name still
 * renders as a resolved `UserName`, so the phrase after it is a continuation rather than the whole
 * sentence. This is what the action's weight keys on.
 */
const showsSubject = $derived(subjectGroupId !== null || showsUser);

/**
 * The picture a "switched avatar" row is about, as a file id — or null when there is not one.
 *
 * The payload of `friend.updated.avatar` and `user.updated.avatar` carries the new
 * `currentAvatarImageUrl`, and **that picture is the only handle VRChat gives out**: there is no
 * avatar id anywhere on a user. So the file id inside the URL is what the avatar modal is opened
 * with, and `avatar-ids.svelte.ts` turns it into an `avtr_…` on the other side.
 *
 * A URL that yields no file id renders no control at all. VRChat sends `""` for an unset image and
 * the payload is its own shape forwarded verbatim, so "there is no picture here" is ordinary and a
 * button that could only fail is worse than no button.
 */
const avatarFileId = $derived.by(() => {
  if (event.kind !== "friend.updated.avatar" && event.kind !== "user.updated.avatar") return null;
  const payload: unknown = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const changes: unknown = (payload as Record<string, unknown>).changes;
  if (!Array.isArray(changes)) return null;
  for (const item of changes as readonly unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const change = item as Record<string, unknown>;
    if (change.aspect !== "avatar") continue;
    const to = change.to;
    if (typeof to !== "string" || to === "") continue;
    const fileId = fileIdFromImageUrl(to);
    if (fileId !== null && fileId !== "") return fileId;
  }
  return null;
});

const repeatTitle = $derived(
  oldestTs === null || repeats < 2
    ? ""
    : `${String(repeats)} times, from ${fullTimestamp(oldestTs)} to ${fullTimestamp(event.ts)}`,
);

let expanded = $state(false);

/**
 * The payload, pretty-printed, for the expanded panel.
 *
 * The row above it is an interpretation — chosen fields, in the app's own words. This is the thing
 * itself, VRChat's shape forwarded verbatim, and it is what makes the interpretation checkable
 * rather than something the reader has to take on trust. It is also the only place a field this
 * build does not know about can appear at all.
 */
const raw = $derived.by(() => {
  if (event.payload === null || event.payload === undefined) return null;
  try {
    return JSON.stringify(event.payload, null, 2);
  } catch {
    // A payload with a cycle in it cannot come off the wire, but a row must not be able to throw.
    return null;
  }
});

/** True when expanding would show something the collapsed row does not already say. */
const expandable = $derived(raw !== null || details.facts.length > 0 || details.location !== null);

/*
 * The toggle is a real `<button>` at the row's edge, and the row itself is *not* clickable.
 *
 * Making the whole row a click target reads as the friendlier choice and is not one here: a row
 * already carries names, world links and a join affordance, all real controls, so a row-level
 * handler has to guess which clicks were meant for it. A row is also an `<li>`, which a screen
 * reader announces as content rather than as a control, and giving it a click handler either
 * leaves it unreachable from a keyboard or nests interactive elements inside each other. One
 * button with `aria-expanded` is the honest version of the same affordance.
 */
</script>

<li
  class="flex gap-3 border-l-2 {tone.rule} pr-2 pl-3 {dense ? 'py-1' : 'py-2'} hover:bg-muted/40"
>
  <span
    class="tabular w-14 shrink-0 text-xs leading-5 text-muted-foreground"
    title={fullTimestamp(event.ts)}
  >
    {timeOfDay(event.ts)}
  </span>

  <!--
    The icon is the fastest thing on the row to read: a column of arrivals, departures and alerts
    is scannable without reading a single word. `aria-hidden` because the sentence beside it says
    the same thing, and a screen reader announcing both says everything twice.
  -->
  <Icon class="mt-0.5 size-4 shrink-0 {tone.icon}" aria-hidden="true" />

  <div class="min-w-0 flex-1">
    <p class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      {#if subjectGroupId !== null}
        <GroupName
          groupId={subjectGroupId}
          name={subject ?? shortId(subjectGroupId, 12)}
          accountId={event.accountId}
          class={subjectIsId ? "font-mono text-xs text-muted-foreground" : "font-medium"}
        />
      {:else if showsUser}
        <UserName
          userId={subjectUserId}
          name={subject}
          accountId={event.accountId}
          class={subjectIsId ? "font-mono text-xs text-muted-foreground" : "font-medium"}
        />
      {/if}

      <!--
        The action reads as a sentence after the subject ("Ada joined the instance") and as a whole
        sentence without one ("Entered a world"), which is why `describeEvent` writes each phrase
        to work both ways rather than gluing a label onto a name.

        The weight follows *whether a subject was drawn*, not whether `describeEvent` supplied a
        name — and those are different. `friend.offline` carries a bare `userId`, so `subject` is
        null while `UserName` renders the person anyway by looking the id up. Keyed on `subject`,
        "went offline" was therefore drawn as a standalone sentence, in full-strength text beside
        the name it belongs to, while "left the instance" one row above was muted. The phrase is
        only carrying the sentence on its own when nothing else is.
      -->
      <span class={showsSubject ? "text-muted-foreground" : "font-medium"}>
        {details.action}
      </span>

      {#if avatarFileId !== null}
        <!--
          A real `<button>`, a sibling of the name rather than a child of it: `UserName` is itself a
          button, and nesting one control inside another is invalid and unreachable from a keyboard.
          It sits in the same wrapping line as the rest of the sentence, so a row that has one is
          not a taller row than a row that does not.
        -->
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1 rounded-xs text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          onclick={() => void avatarModal.openByFile(avatarFileId, { accountId: event.accountId })}
        >
          <ShirtIcon class="size-3.5" aria-hidden="true" />
          Open avatar
        </button>
      {/if}

      {#if repeats > 1}
        <!--
          A run of identical rows, counted rather than printed. The title carries the span it
          covers, so collapsing never hides when the run started.
        -->
        <span
          class="tabular rounded-sm border border-border px-1 text-xs text-muted-foreground"
          title={repeatTitle}
        >
          ×{repeats}
        </span>
      {/if}

      {#if event.live}
        <span class="text-xs tracking-wide text-status-online uppercase">live</span>
      {/if}
    </p>

    {#if details.facts.length > 0}
      <!--
        Labelled facts rather than one anonymous line of text. "Reason: Instance full" is a
        different thing to read than "Instance full" under a heading that already said
        "Could not join an instance".
      -->
      <p class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {#each details.facts as entry, index (index)}
          <!--
            Truncated while collapsed and shown whole when expanded. A group announcement can be
            several paragraphs; clipping it in the list is right, and having no way to read the
            rest is not.
          -->
          <span class={expanded ? "min-w-0" : "min-w-0 max-w-full truncate"} title={entry.value}>
            <span class="text-muted-foreground/70">{entry.label}</span>
            <span class="{entry.mono === true ? 'font-mono' : ''} {expanded ? 'whitespace-pre-wrap' : ''}"
              >{entry.value}</span
            >
          </span>
        {/each}
      </p>
    {/if}

    {#if details.location !== null}
      <LocationLine
        location={details.location}
        worldName={details.worldName}
        accountId={event.accountId}
        showJump={false}
        observedAt={event.ts}
      />
    {:else if details.worldName !== null}
      <!--
        `Entering Room:` gives a world *name* and no id at all, so there is no location to parse
        and nothing to join. The name is still the most useful thing on the row.
      -->
      <p class="truncate text-sm font-medium">{details.worldName}</p>
    {/if}

    {#if expanded}
      <div class="mt-2 space-y-2 border-l-2 border-border/60 pl-3">
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt class="text-muted-foreground">Kind</dt>
          <dd class="font-mono break-all">{event.kind}</dd>

          <dt class="text-muted-foreground">When</dt>
          <dd class="tabular">
            {fullTimestamp(event.ts)}{#if repeats > 1}
              <span class="text-muted-foreground"> · {repeatTitle}</span>
            {/if}
          </dd>

          {#if event.subjectId !== null}
            <dt class="text-muted-foreground">Subject</dt>
            <dd class="font-mono break-all">{event.subjectId}</dd>
          {/if}

          {#if details.location !== null}
            <dt class="text-muted-foreground">Location</dt>
            <dd class="font-mono break-all">{details.location}</dd>
          {/if}
        </dl>

        {#if raw !== null}
          <!--
            VRChat's own shape, verbatim. `overflow-x-auto` on the block rather than wrapping,
            because a wrapped JSON tree is harder to read than a scrolled one.
          -->
          <pre
            class="max-h-64 overflow-auto rounded-sm bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">{raw}</pre>
        {/if}
      </div>
    {/if}
  </div>

  <span
    class="hidden w-28 shrink-0 truncate text-right font-mono text-xs leading-5 text-muted-foreground md:block"
    title={event.kind}
  >
    {event.kind}
  </span>

  {#if expandable}
    <button
      type="button"
      class="mt-0.5 size-5 shrink-0 cursor-pointer rounded-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-expanded={expanded}
      aria-label={expanded ? "Hide the details of this event" : "Show the details of this event"}
      onclick={() => {
        expanded = !expanded;
      }}
    >
      <ChevronIcon class="size-4 transition-transform {expanded ? 'rotate-180' : ''}" />
    </button>
  {:else}
    <!-- Keeps the rows aligned when one of them has nothing more to say. -->
    <span class="size-5 shrink-0" aria-hidden="true"></span>
  {/if}
</li>
