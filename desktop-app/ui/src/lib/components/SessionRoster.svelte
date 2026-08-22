<!--
  Everyone in one live instance, at full size.

  Two sources feed this and they are not equals. The **game log** decides who is on the list: it is
  live, exact, and needs no network. `GET /api/instance-users` decides what the chips say. The rule
  and its reasoning live in `state/instance-roster.svelte.ts`; the only thing to remember while
  reading this file is that no branch below can add or remove a person, only decorate one.

  The screen therefore has three honest shapes rather than one shape and an error: attributes
  present, attributes unavailable (the *common* outcome — VRChat sends a roster only for an
  instance the account itself created, so a group or public room you walked into has none, and the
  store then falls back to reading the observed players one at a time), and a genuine fault. Only
  the third is drawn as a problem.

  The per-person row lives in `RosterRowItem.svelte`. It moved out when it grew an expander, because
  a row that holds its own open/closed state and authorises its own profile fetch is a component and
  not a fragment. What stays here is everything about the *list*: the toolbar, the sort, the search,
  and the sentence explaining where the chips came from.
-->
<script lang="ts">
import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
import SearchIcon from "@lucide/svelte/icons/search";
import UsersIcon from "@lucide/svelte/icons/users";
import type { GameSession } from "$lib/api.ts";
import EmptyState from "$lib/components/EmptyState.svelte";
import ErrorNote from "$lib/components/ErrorNote.svelte";
import RosterRowItem from "$lib/components/RosterRowItem.svelte";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import * as InputGroup from "$lib/components/ui/input-group/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import * as Tooltip from "$lib/components/ui/tooltip/index.js";
import { parseLocation, timeOfDay, trustRank } from "$lib/format.ts";
import type { ObservedPlayer } from "$lib/state/live-sessions.svelte.ts";
import { app } from "$lib/state/app.svelte.ts";
import { clock } from "$lib/state/clock.svelte.ts";
import {
  instanceRoster,
  mergeRoster,
  rosterUnavailableText,
  type RosterRow,
} from "$lib/state/instance-roster.svelte.ts";

let {
  session,
  players,
}: {
  session: GameSession;
  /** Null when no socket frame has been correlated to this client yet — not the same as empty. */
  players: readonly ObservedPlayer[] | null;
} = $props();

let query = $state("");
let sort = $state<SortKey>("joined-desc");

type SortKey = "joined-desc" | "joined-asc" | "name" | "trust";

const SORT_LABELS: Record<SortKey, string> = {
  "joined-desc": "Newest arrival",
  "joined-asc": "Longest here",
  name: "Name",
  trust: "Trust rank",
};

const SORT_KEYS: readonly SortKey[] = ["joined-desc", "joined-asc", "name", "trust"];

const account = $derived(app.accountById(session.accountId));

/**
 * The local player is in their own instance's log roster with nothing marking them as such, so the
 * only handle on them is the name. The account's own display name is the better source when it is
 * known, because the log's `displayName` can lag a rename.
 */
const ownName = $derived(account?.displayName ?? session.displayName);

const parsed = $derived(parseLocation(session.currentLocation));
/** `private`, `traveling`, and the empty string are not instances anyone can be asked about. */
const askable = $derived(!parsed.opaque && session.currentLocation !== null);

/*
 * The one place a request is started. It reads the location, the account, and the roster *size* —
 * a join or a leave is the event that reliably invalidates an otherwise fine snapshot, and
 * `ensure` rate-limits the rest. Everything else on this screen reads state and starts nothing.
 */
/**
 * The ids the log recovered, which are the fallback's only possible input.
 *
 * Sorted and joined into a string rather than passed as an array, because this feeds the `$effect`
 * below: a fresh array every render would re-run it on every frame, where a string only changes
 * when the *set* of identified players does.
 */
const observedKey = $derived(
  (players ?? [])
    .map((player) => player.userId)
    .filter((id): id is string => id !== null)
    .toSorted()
    .join(","),
);

$effect(() => {
  const location = session.currentLocation;
  const accountId = session.accountId;
  const ids = observedKey === "" ? [] : observedKey.split(",");
  // Both dependencies earn their place: `observedKey` changes when the set of *identifiable*
  // players does, and the raw count catches a join or leave the log gave no id for — which still
  // invalidates an otherwise fine snapshot even though it can never be looked up individually.
  void players?.length;
  if (!askable) return;
  instanceRoster.ensure(location, accountId, ids);
});

$effect(() => clock.subscribe());

const entry = $derived(
  askable ? instanceRoster.entry(session.currentLocation, session.accountId) : null,
);

const rows = $derived(mergeRoster(players ?? [], entry?.users ?? [], ownName));

const sorted = $derived.by(() => {
  const needle = query.trim().toLowerCase();
  const matched = rows.filter((row) => row.displayName.toLowerCase().includes(needle));
  return matched.toSorted(compare);
});

function compare(a: RosterRow, b: RosterRow): number {
  switch (sort) {
    case "joined-desc":
      return b.joinedAt - a.joinedAt || a.displayName.localeCompare(b.displayName);
    case "joined-asc":
      return a.joinedAt - b.joinedAt || a.displayName.localeCompare(b.displayName);
    case "name":
      return a.displayName.localeCompare(b.displayName);
    case "trust":
      // Unranked people sort last rather than being folded into "Visitor"; see `trustRank`.
      return (
        trustRank(a.attributes?.trustLevel ?? null) - trustRank(b.attributes?.trustLevel ?? null) ||
        a.displayName.localeCompare(b.displayName)
      );
  }
}

const friendCount = $derived(rows.filter((row) => row.attributes?.isFriend === true).length);
const decorated = $derived(rows.filter((row) => row.attributes !== null).length);
const refreshing = $derived(entry?.status === "loading");
</script>

<Tooltip.Provider delayDuration={200}>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Toolbar. The count is the live one, straight off the log. -->
    <div
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2"
    >
      <p class="text-xs tracking-wide text-muted-foreground uppercase">In the room</p>
      <Badge variant="secondary" class="tabular">{rows.length}</Badge>
      {#if entry?.status === "ready" && friendCount > 0}
        <span class="text-xs text-muted-foreground">
          {friendCount}
          {friendCount === 1 ? "friend" : "friends"}
        </span>
      {/if}

      <div class="ml-auto flex items-center gap-2">
        <InputGroup.Root class="h-8 w-44">
          <InputGroup.Addon>
            <SearchIcon />
          </InputGroup.Addon>
          <InputGroup.Input
            bind:value={query}
            name="roster-filter"
            type="search"
            placeholder="Find someone"
            aria-label="Filter this roster by name"
            class="h-8 text-sm"
          />
        </InputGroup.Root>

        <Select.Root type="single" value={sort} onValueChange={(next) => (sort = next as SortKey)}>
          <Select.Trigger size="sm" class="w-36" aria-label="Sort the roster">
            {SORT_LABELS[sort]}
          </Select.Trigger>
          <Select.Content>
            {#each SORT_KEYS as key (key)}
              <Select.Item value={key} label={SORT_LABELS[key]} />
            {/each}
          </Select.Content>
        </Select.Root>

        {#if askable}
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground"
            disabled={refreshing}
            onclick={() =>
              instanceRoster.refresh(
                session.currentLocation,
                session.accountId,
                observedKey === "" ? [] : observedKey.split(","),
              )}
            aria-label="Re-read trust, age and friendship from VRChat"
            title="Re-read trust, age and friendship from VRChat"
          >
            <RefreshCwIcon class={refreshing ? "animate-spin" : undefined} />
          </Button>
        {/if}
      </div>
    </div>

    <!--
      What the chips are, or plainly why there are none. `unavailable` is the endpoint working as
      designed, so it gets a sentence in the ordinary muted voice — never `ErrorNote`.
    -->
    {#if !askable}
      <p class="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        This client is not in an instance VRChat can describe, so there is no trust, age or
        friendship data to attach. The names below are still exactly what the game log reported.
      </p>
    {:else if entry?.status === "unavailable" && entry.reason !== null}
      <p class="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        {rosterUnavailableText(entry.reason, entry.filledIndividually)}
      </p>
    {:else if entry?.status === "error" && entry.error !== null}
      <div class="shrink-0 px-4 py-2">
        <ErrorNote message={entry.error} />
      </div>
    {:else if entry?.status === "ready"}
      <p class="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">
        Trust, age verification and friendship read from VRChat
        {#if account !== null}through {account.displayName}{/if}
        {#if entry.fetchedAt !== null}
          at {timeOfDay(entry.fetchedAt, true)}{/if}. {decorated} of {rows.length} matched.
      </p>
    {/if}

    <!--
      A plain scroll pane rather than `ScrollArea`, for the reason the card version recorded: the
      bits-ui viewport is `size-full`, which resolves to nothing inside a flex parent that is only
      `min-h-0`. The app styles native scrollbars in `app.css`.
    -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if players === null}
        <EmptyState
          icon={UsersIcon}
          title="Roster not observed yet"
          description="The list is built from join and leave lines in the game log, so it fills in from the next person who moves. Anyone already standing here when vrc.zip started watching will appear when they leave and come back."
        />
      {:else if rows.length === 0}
        <EmptyState
          icon={UsersIcon}
          title="Nobody has joined since vrc.zip started watching"
          description="An empty roster is not the same as an empty instance: vrc.zip reads arrivals, not a headcount, so people who were already here are invisible until they move."
        />
      {:else if sorted.length === 0}
        <EmptyState
          icon={SearchIcon}
          title="Nobody here matches that"
          description={`None of the ${String(rows.length)} people in this instance match "${query}".`}
        />
      {:else}
        <ul class="divide-y divide-border/60">
          {#each sorted as row (row.key)}
            <RosterRowItem {row} {session} seenThrough={account?.displayName ?? null} />
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</Tooltip.Provider>
