<!--
  The three things you want to know about a stranger standing next to you: how long VRChat has
  known them, whether VRChat has checked they are an adult, and whether you already know them.

  Every indicator here obeys the rule `StatusDot.svelte` set: **never colour alone.** The trust chip
  carries VRChat's own rank colour *and* an icon *and* the rank word, so it survives greyscale, a
  colour-blind reader, and a screenshot. The two boolean chips are icon-plus-tooltip with an
  `sr-only` sentence, because they say a thing that is either true or absent — there is no scale to
  read off a hue.

  Absence is never a claim. No age chip means VRChat said nothing *or* said `hidden`, which is a
  verified person who chose not to publish it; rendering "unverified" for that would be a lie the
  component is structurally incapable of telling, since there is no unverified variant to render.
  Same for friendship: no chip means "not according to the account we asked through", which is why
  the tooltip on the friend chip names the account rather than asserting a global fact.
-->
<script lang="ts">
import BadgeCheckIcon from "@lucide/svelte/icons/badge-check";
import HeartHandshakeIcon from "@lucide/svelte/icons/heart-handshake";
import ShieldIcon from "@lucide/svelte/icons/shield";
import { Badge } from "$lib/components/ui/badge/index.js";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import { ageVerifiedLabel, trustClass, trustDescription, trustLabel } from "$lib/format.ts";
import { cn } from "$lib/utils.js";

let {
  trustLevel = null,
  ageVerificationStatus = null,
  ageVerified = false,
  isFriend = false,
  /** The account the attributes were read through, named in the friendship tooltip. */
  seenThrough = null,
  /** How the row was joined to VRChat's answer; a name match is an inference and says so. */
  matchedBy = null,
}: {
  trustLevel?: string | null;
  ageVerificationStatus?: string | null;
  ageVerified?: boolean;
  isFriend?: boolean;
  seenThrough?: string | null;
  matchedBy?: "id" | "name" | null;
} = $props();

const trust = $derived(trustLabel(trustLevel));
const tint = $derived(trustClass(trustLevel));
const age = $derived(ageVerifiedLabel(ageVerificationStatus, ageVerified));

const inferred =
  " This person had no user id in the game log, so vrc.zip matched them to VRChat's answer by display name.";

const friendText = $derived(
  seenThrough === null
    ? "You are friends with this person on VRChat."
    : `${seenThrough} is friends with this person on VRChat.`,
);

const AGE_TEXT =
  "VRChat has verified this person is an adult. No chip means VRChat said nothing, or that they have a verification and chose to keep it private — it never means they failed one.";

const CHIP = "h-5 gap-1 px-1.5";
</script>

<div class="flex shrink-0 items-center gap-1">
  {#if trust !== null}
    <Tooltip.Root>
      <Tooltip.Trigger aria-label={`Trust rank: ${trust}`}>
        <Badge variant="outline" class={cn(CHIP, tint)}>
          <ShieldIcon aria-hidden="true" />
          {trust}
        </Badge>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {trustDescription(trustLevel)}{matchedBy === "name" ? inferred : ""}
      </Tooltip.Content>
    </Tooltip.Root>
  {/if}

  {#if age !== null}
    <Tooltip.Root>
      <Tooltip.Trigger aria-label={age}>
        <Badge
          variant="outline"
          class={cn(CHIP, "border-status-online/40 bg-status-online/10 text-status-online")}
        >
          <BadgeCheckIcon aria-hidden="true" />
          <span class="sr-only">{age}</span>
        </Badge>
      </Tooltip.Trigger>
      <Tooltip.Content>{age}. {AGE_TEXT}</Tooltip.Content>
    </Tooltip.Root>
  {/if}

  {#if isFriend}
    <Tooltip.Root>
      <Tooltip.Trigger aria-label="Friend">
        <Badge variant="outline" class={cn(CHIP, "border-primary/40 bg-primary/10 text-primary")}>
          <HeartHandshakeIcon aria-hidden="true" />
          <span class="sr-only">Friend</span>
        </Badge>
      </Tooltip.Trigger>
      <Tooltip.Content>{friendText}</Tooltip.Content>
    </Tooltip.Root>
  {/if}
</div>
