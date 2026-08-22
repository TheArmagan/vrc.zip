<!--
  One managed account, in the same shape as a friend row: identity, the two facts worth a column,
  and an expander for everything else.

  ## Why the row is mostly collapsed

  An account carries far more than a friend does — its id, when it was added, its connection state,
  how many game clients are running under it, what it is spending against the shared per-IP ceiling
  — and putting all of that on one line is how the previous version of this screen ended up with a
  sparkline, three separated clauses and two buttons fighting for the same row. Only the things a
  person scans for stay visible; the rest is one click away.

  ## Why opening a row fetches

  An account is a VRChat user too, and the interesting half of it (trust rank, age verification,
  pronouns, bio) lives on the profile, which is a request per account. So the expander is the
  gesture that authorises it, exactly as in `FriendRow`: `userProfiles.ensure` runs on open. The
  lookup is made through the account *itself*, because VRChat answers most fully to the account a
  profile belongs to.
-->
<script lang="ts">
import ChevronIcon from "@lucide/svelte/icons/chevron-down";
import KeyRoundIcon from "@lucide/svelte/icons/key-round";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import { type Account, imageUrl } from "$lib/api.ts";
import ConnectionDot from "$lib/components/ConnectionDot.svelte";
import RelativeTime from "$lib/components/RelativeTime.svelte";
import Sparkline from "$lib/components/Sparkline.svelte";
import UserName from "$lib/components/UserName.svelte";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from "$lib/components/ui/avatar/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import {
  ageVerifiedLabel,
  connectionLabel,
  fullTimestamp,
  initials,
  platformLabel,
  trustClass,
  trustLabel,
} from "$lib/format.ts";
import { navigate } from "$lib/router.ts";
import { rates } from "$lib/state/rates.svelte.ts";
import { userProfiles } from "$lib/state/user-profiles.svelte.ts";
import { cn } from "$lib/utils.js";

let {
  account,
  sessionCount,
  onRemove,
}: {
  account: Account;
  /** How many game clients are running under this account right now. */
  sessionCount: number;
  onRemove: () => void;
} = $props();

let expanded = $state(false);

/* Pure reads: they start nothing, so a collapsed row costs a map lookup and no request. */
const profile = $derived(userProfiles.get(account.id, account.id));
const entry = $derived(userProfiles.entry(account.id, account.id));

const trust = $derived(trustLabel(profile?.trustLevel ?? null));
const age = $derived(
  profile === null ? null : ageVerifiedLabel(profile.ageVerificationStatus, profile.ageVerified),
);
const platform = $derived(platformLabel(profile?.platform ?? null));

const rate = $derived(rates.account(account.id));
const currentRate = $derived(rate[rate.length - 1] ?? 0);

const clients = $derived(
  sessionCount === 0
    ? "No client running"
    : `${String(sessionCount)} ${sessionCount === 1 ? "client" : "clients"} running`,
);

function toggle(): void {
  expanded = !expanded;
  // The open gesture is what authorises the request; `ensure` refuses to re-ask inside its
  // freshness window, so closing and reopening costs nothing.
  if (expanded) userProfiles.ensure(account.id, account.id);
}
</script>

<li class="px-4 py-3">
  <div class="flex items-center gap-3">
    <!--
      alt="" on purpose: the display name is the very next element, so announcing the icon too
      would read the name twice. The dot stays aria-hidden — `connectionLabel()` spells the same
      state out in words both in the row and in the facts below.
    -->
    <Avatar class="size-9 shrink-0">
      <AvatarImage src={imageUrl(account.iconUrl)} alt="" loading="lazy" />
      <AvatarFallback class="text-xs">{initials(account.displayName)}</AvatarFallback>
      <AvatarBadge class="bg-transparent ring-background">
        <ConnectionDot connection={account.connection} size={null} class="size-full" />
      </AvatarBadge>
    </Avatar>

    <div class="min-w-0 flex-1">
      <!--
        An account is a user too, and its own profile is the one VRChat answers most fully — the
        lookup runs through the account itself. See `userModal.openUser`.
      -->
      <p class="truncate text-sm font-medium">
        <UserName
          userId={account.id}
          name={account.displayName}
          accountId={account.id}
          class="max-w-full truncate"
        />
      </p>
      <p class="truncate text-xs text-muted-foreground">
        Added <RelativeTime ts={account.addedAt} />
      </p>
    </div>

    <span class="hidden min-w-0 flex-1 text-xs text-muted-foreground sm:block">
      {clients}
    </span>

    <span class="w-24 shrink-0 text-right text-xs text-muted-foreground">
      {connectionLabel(account.connection)}
    </span>

    {#if account.connection === "needs-2fa"}
      <Button
        size="sm"
        variant="outline"
        onclick={() => {
          navigate("login", account.id);
        }}
      >
        <KeyRoundIcon />
        Enter code
      </Button>
    {/if}

    <Button
      size="icon-sm"
      variant="ghost"
      class="text-muted-foreground hover:text-destructive"
      aria-label={`Remove ${account.displayName}`}
      onclick={onRemove}
    >
      <Trash2Icon />
    </Button>

    <button
      type="button"
      class="size-5 shrink-0 cursor-pointer rounded-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-expanded={expanded}
      aria-label={expanded
        ? `Hide details for ${account.displayName}`
        : `Show details for ${account.displayName}`}
      onclick={toggle}
    >
      <ChevronIcon class="size-4 transition-transform {expanded ? 'rotate-180' : ''}" />
    </button>
  </div>

  {#if expanded}
    <div class="mt-3 ml-12 space-y-2 border-l-2 border-border/60 pl-3">
      {#if trust !== null || age !== null || platform !== null}
        <div class="flex flex-wrap items-center gap-1">
          {#if trust !== null}
            <!-- VRChat's own rank colour; see `trustClass` for why it is not a vrc.zip token. -->
            <Badge
              variant="outline"
              class={cn("h-5 px-1.5 text-[10px]", trustClass(profile?.trustLevel ?? null))}
            >
              {trust}
            </Badge>
          {/if}
          {#if age !== null}
            <Badge
              variant="outline"
              class="h-5 border-status-online/40 bg-status-online/10 px-1.5 text-[10px] text-status-online"
            >
              {age}
            </Badge>
          {/if}
          {#if platform !== null}
            <Badge variant="outline" class="h-5 px-1.5 text-[10px]">{platform}</Badge>
          {/if}
        </div>
      {/if}

      {#if profile !== null && profile.bio}
        <p class="whitespace-pre-wrap text-xs text-muted-foreground">{profile.bio}</p>
      {/if}

      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {#if profile?.pronouns}
          <dt class="text-muted-foreground">Pronouns</dt>
          <dd>{profile.pronouns}</dd>
        {/if}

        <dt class="text-muted-foreground">Connection</dt>
        <dd>{connectionLabel(account.connection)}</dd>

        <dt class="text-muted-foreground">Added</dt>
        <dd class="tabular">{fullTimestamp(account.addedAt)}</dd>

        {#if account.lastSeenAt !== null}
          <dt class="text-muted-foreground">Last event</dt>
          <dd class="tabular">{fullTimestamp(account.lastSeenAt)}</dd>
        {/if}

        <dt class="text-muted-foreground">Game clients</dt>
        <dd>{clients}</dd>

        <!--
          What this account is spending. Worth showing per account rather than only in total,
          because six accounts share one per-IP ceiling (PLAN.md §1.4) and the per-account limiter
          is structurally unable to see that — so "which one is eating it" is a real question with
          no other answer on screen.
        -->
        <dt class="text-muted-foreground">Requests</dt>
        <dd class="flex items-center gap-2">
          <Sparkline
            values={rate}
            height={14}
            class="w-20"
            label="{account.displayName} requests per second over the last minute"
          />
          <span class="tabular whitespace-nowrap text-muted-foreground">{currentRate}/s</span>
        </dd>

        <dt class="text-muted-foreground">Id</dt>
        <dd class="font-mono break-all">{account.id}</dd>
      </dl>

      {#if profile === null}
        <!--
          Absence is never a claim here, the same rule the hover card follows: `no-account` means
          vrc.zip holds no signed-in account to ask VRChat through, which is a fact about vrc.zip
          rather than about this account.
        -->
        <p class="text-xs text-muted-foreground">
          {#if entry?.status === "unavailable" && entry.reason === "no-account"}
            No signed-in account to ask VRChat through, so there is nothing more to read yet.
          {:else if entry?.status === "unavailable"}
            VRChat has no record of this user id.
          {:else if entry?.status === "error" && entry.error !== null}
            This profile could not be read: {entry.error}
          {:else}
            Reading this profile…
          {/if}
        </p>
      {/if}
    </div>
  {/if}
</li>
