/**
 * Attributes for the people in a live instance, and the rule for attaching them to the log's
 * roster.
 *
 * ## The division of labour, which is the whole design
 *
 * **The game log is the source of truth for who is present.** It is exact and it is live: VRChat
 * writes `OnPlayerJoined` / `OnPlayerLeft` the instant it happens, and `live-sessions.svelte.ts`
 * accumulates it. Nothing in this file is allowed to add a person to a roster or take one away.
 *
 * **`GET /api/instance-users` is the source of truth for what those people are like** — trust rank,
 * age verification, friendship, platform, icon. It is a snapshot rather than a stream, it answers
 * for far fewer instances than one would guess — **VRChat sends a roster only for an instance the
 * asking account created**, so a group or public room you merely walked into has none — and it can
 * disagree with the log by a few seconds in either direction. So it decorates rows; it never
 * decides them, and the common case is that it has nothing to decorate them with.
 *
 * Getting that backwards produces the two failures worth naming: rendering the endpoint's list
 * would silently drop everyone who joined since the last fetch, and would show ghosts for everyone
 * who left. Both look like working software.
 *
 * ## Joining the two lists
 *
 * On **user id** where the log gave one. Ids are canonical; a log row with an id that the endpoint
 * did not return simply has no attributes, and is never quietly matched to some other row.
 *
 * On **display name** when the log gave no id — which is the common case, since VRChat has added
 * and removed the id from that log line more than once (PROGRESS.md §Gotchas). This is safe for a
 * narrow and checkable reason: VRChat display names are unique account-wide at any given moment,
 * and both lists describe *the same instance at the same time*, so a name collision would have to
 * be VRChat contradicting itself. The guard is still written down rather than assumed — a name that
 * appears more than once in the endpoint's own response is dropped from the name index entirely, so
 * an ambiguous name gets no attributes instead of the wrong person's.
 *
 * A name match also recovers the user id, which is worth more than the chips: it is what turns an
 * inert roster row into one that opens a profile.
 *
 * ## The fallback, and why it is a fallback
 *
 * Because `users` comes back only for an instance the account created, the roster endpoint answers
 * `unavailable` for practically every room anyone sits in — which left the chips permanently empty
 * and the endpoint doing nothing for its keep. So when that happens, and only then, this asks the
 * daemon for the observed players one lookup at a time (`GET /api/users?ids=…`, cache-first).
 *
 * It is second, not first, for a reason worth keeping: the roster endpoint describes eighty people
 * in **one** request and this one costs up to eighty. So it runs only after the cheap path has said
 * it has nothing, only for ids the log actually recovered, and only for people not already
 * described. The daemon caches per viewer, so a room that stays put stops costing anything within a
 * few polls.
 */

import { SvelteMap } from "svelte/reactivity";
import { ApiError, api, type InstanceUser, isAbort } from "../api.ts";
import type { ObservedPlayer } from "./live-sessions.svelte.ts";

/**
 * Why a roster has no attributes. Every one of these is an ordinary state with its own sentence —
 * only `error` is a fault, and it is the one case that did not come from the contract.
 */
export type RosterUnavailable =
  /**
   * 200, `source: "unavailable"` — VRChat did not send a roster for this instance.
   *
   * Named for the real rule rather than the one everyone assumes. This said `not-present`, and its
   * sentence told the user no account of theirs was standing in the instance — in front of a user
   * whose own client was sitting in it with sixteen people on screen. **`users` comes back only for
   * an instance the asking account created**; being in the room is not enough. So this is the
   * answer for essentially every instance anyone looks at, and it is not a sign of anything wrong.
   */
  | "not-owner"
  /** 503 `no_account` — vrc.zip holds no account it can ask VRChat through. */
  | "no-account"
  /** 400 `invalid_location` — private, traveling, or otherwise not a real instance. */
  | "invalid-location"
  /** 404/501 — this daemon build predates the route. The UI and daemon ship together but do
   *  not always *build* together, and "your daemon is older" is a truer thing to say than
   *  "something went wrong". */
  | "no-route";

export type RosterStatus = "loading" | "ready" | "unavailable" | "error";

export interface RosterEntry {
  status: RosterStatus;
  /** Set only when `status === "unavailable"`. */
  reason: RosterUnavailable | null;
  /**
   * True once the per-user fallback has filled in what the roster endpoint would not.
   *
   * The status stays `unavailable`, because it is still true that VRChat refused to describe the
   * instance — but the sentence the screen shows changes, since "no attributes for this instance"
   * would be a plain lie next to a column of populated chips.
   */
  filledIndividually: boolean;
  /** Set only when `status === "error"`. */
  error: string | null;
  users: readonly InstanceUser[];
  /** Unix ms of the last completed attempt, successful or not. Null while the first is in flight. */
  fetchedAt: number | null;
}

/** The words for each unavailable reason. One place decides them, as with every other vocabulary. */
export function rosterUnavailableText(reason: RosterUnavailable, filled = false): string {
  switch (reason) {
    case "not-owner":
      return filled
        ? "VRChat would not describe this instance — it hands a roster out only for one your own account created — so these chips were read one person at a time instead. Anyone who joined a moment ago may have none yet."
        : "VRChat hands out a roster only for an instance your own account created, so it sends none for this one — being in the room is not enough, and nothing here is broken. Names and join times below come from the game log and are exact; trust rank, age verification and friendship are what VRChat is withholding.";
    case "no-account":
      return "No signed-in account to ask VRChat through, so there is nothing to attach to these names. The roster itself is read from the game log and is unaffected.";
    case "invalid-location":
      return "This is not an instance VRChat can be asked about — a private world, or a client between worlds. The roster below is still what the game log reported.";
    case "no-route":
      return "This daemon build does not serve instance attributes yet. The roster below comes from the game log, which needs no daemon support at all.";
  }
}

/** How long an answer is reused before a new request is allowed. */
const FRESH_MS = 15_000;

/**
 * The floor under a refetch driven by somebody new being in the room.
 *
 * A join is not "the snapshot is fifteen seconds old", it is "the snapshot is missing a person",
 * and waiting out `FRESH_MS` for that is what left a new arrival with a bare name until the screen
 * was rebuilt. So an undescribed player skips the freshness window — but not all the way to zero:
 * forty people loading into a fresh instance is forty changes to the roster in a second or two, and
 * that has to collapse into one request rather than forty.
 *
 * When the floor does decline a request, a timer picks it up at the deadline. That matters more
 * than the number: without it a person who joins during the floor is undescribed with nothing left
 * to ask again, which is the original bug moved three seconds to the left.
 */
const JOIN_FLOOR_MS = 3_000;

function keyFor(location: string, accountId: string | null): string {
  // `\0` as the separator, written as an escape rather than as a literal NUL byte. The raw byte
  // was in this file, and it made every tool treat the source as binary — `grep -r` skipped it
  // silently, which is the worst way for a file to opt out of a search.
  return `${accountId ?? ""}\0${location}`;
}

function unavailableReason(error: unknown): RosterUnavailable | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 503) return "no-account";
  if (error.status === 400) return "invalid-location";
  if (error.status === 404 || error.status === 501) return "no-route";
  return null;
}

class InstanceRosterState {
  readonly #byKey = new SvelteMap<string, RosterEntry>();
  readonly #inFlight = new Set<string>();
  /** Pending join-driven retries, one per instance. See `#armRetry`. */
  readonly #retries = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * What is known about `location` right now. Pure — safe to call from a `$derived`. It never
   * starts a request; `ensure()` does that, from an `$effect`.
   */
  entry(location: string | null, accountId: string | null): RosterEntry | null {
    if (location === null || location === "") return null;
    return this.#byKey.get(keyFor(location, accountId)) ?? null;
  }

  /**
   * Fetches attributes for `location` unless a recent answer is already held. Call from an
   * `$effect` that reads the location, the account, and the roster size — a player joining is the
   * one event that reliably invalidates an otherwise fine snapshot.
   *
   * "Unless a recent answer is already held" has an exception, and it is the point of the freshness
   * window rather than a hole in it: an answer that does not describe somebody standing in the room
   * is not a recent answer, it is an incomplete one. See `JOIN_FLOOR_MS`.
   */
  ensure(
    location: string | null,
    accountId: string | null,
    /**
     * User ids the game log recovered for this room. The fallback's whole input — a log line
     * without an id (VRChat has shipped it both ways) simply cannot be looked up, and is left with
     * its name and no chips rather than guessed at.
     */
    observedIds: readonly string[] = [],
    force = false,
  ): void {
    if (location === null || location === "") return;
    const key = keyFor(location, accountId);
    if (this.#inFlight.has(key)) return;

    const existing = this.#byKey.get(key);
    if (existing !== undefined && !force) {
      // First, and unconditionally: a daemon that does not have the route will not grow one
      // because somebody walked into a room. Below the freshness check this would be skippable.
      if (existing.reason === "no-route") return;

      const age = existing.fetchedAt === null ? 0 : Date.now() - existing.fetchedAt;
      const window = this.#missesSomeone(existing, observedIds) ? JOIN_FLOOR_MS : FRESH_MS;
      if (existing.fetchedAt !== null && age < window) {
        // Declined, but not dropped: a request refused for being too soon is re-armed for the
        // moment it stops being too soon. `#armRetry` collapses a burst onto one deadline.
        if (window === JOIN_FLOOR_MS) {
          this.#armRetry(key, location, accountId, observedIds, window - age);
        }
        return;
      }
    }

    void this.#load(key, location, accountId, observedIds);
  }

  /** The explicit refresh button. Ignores freshness; still collapses onto a request in flight. */
  refresh(
    location: string | null,
    accountId: string | null,
    observedIds: readonly string[] = [],
  ): void {
    this.ensure(location, accountId, observedIds, true);
  }

  /**
   * Whether anyone the log has identified is absent from what was fetched.
   *
   * Ids only. A log line with no user id cannot be looked up individually, so its row would be
   * "missing" on every single call and would hold the refetch permanently open — the roster size
   * that the caller's `$effect` also watches is what covers those joins, once.
   */
  #missesSomeone(entry: RosterEntry, observedIds: readonly string[]): boolean {
    if (observedIds.length === 0) return false;
    const described = new Set(entry.users.map((user) => user.id));
    return observedIds.some((id) => !described.has(id));
  }

  /**
   * Re-arms a declined request for the end of its floor.
   *
   * One timer per instance, replaced rather than stacked, and always with the *remaining* delay —
   * so ten people loading in over two seconds move the ids without moving the deadline, and the
   * whole burst costs one request.
   */
  #armRetry(
    key: string,
    location: string,
    accountId: string | null,
    observedIds: readonly string[],
    delay: number,
  ): void {
    this.#clearRetry(key);
    const ids = [...observedIds];
    this.#retries.set(
      key,
      setTimeout(
        () => {
          this.#retries.delete(key);
          this.ensure(location, accountId, ids);
        },
        Math.max(delay, 0),
      ),
    );
  }

  #clearRetry(key: string): void {
    const timer = this.#retries.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#retries.delete(key);
  }

  #ensureEntry(key: string): RosterEntry {
    const existing = this.#byKey.get(key);
    if (existing !== undefined) return existing;
    /*
     * `$state` for the same load-bearing reason as `LogSession` next door: `SvelteMap` makes the
     * *set* of keys reactive and says nothing about the objects in it. Every update below mutates
     * an entry that is already in the map, and on a plain object those writes are invisible — the
     * roster would sit on "Reading VRChat…" forever while the data was right there.
     */
    const created: RosterEntry = $state({
      status: "loading",
      reason: null,
      error: null,
      users: [],
      fetchedAt: null,
      filledIndividually: false,
    });
    this.#byKey.set(key, created);
    return created;
  }

  async #load(
    key: string,
    location: string,
    accountId: string | null,
    observedIds: readonly string[],
  ): Promise<void> {
    const entry = this.#ensureEntry(key);
    this.#inFlight.add(key);
    // A request is happening now, so a timer waiting to ask for the same thing is redundant.
    this.#clearRetry(key);
    // A refresh keeps the old rows on screen while it runs, so the chips do not blink out and
    // back for a request that is going to return the same answer.
    if (entry.fetchedAt === null) entry.status = "loading";

    try {
      const answer = await api.instanceUsers(location, accountId);
      if (answer.source === "instance") {
        entry.users = answer.users;
        entry.status = "ready";
        entry.reason = null;
        entry.filledIndividually = false;
      } else {
        /*
         * Keep what the per-user fallback already established rather than blanking it.
         *
         * This was invisible while a refetch happened at most every fifteen seconds — the chips
         * were rebuilt from scratch and looked the same. Now that one person walking in drives a
         * refetch, blanking would mean re-reading the entire room every time anybody joined, and
         * the chips on eighty rows would drop out and come back on each one.
         *
         * People who have left stay in the list. They decorate nothing, because `mergeRoster` only
         * ever looks up rows the log is still reporting, so this is a per-instance cache and not a
         * roster — the file's first rule, that nothing here may add a person, still holds.
         */
        entry.status = "unavailable";
        entry.reason = "not-owner";
        if (!entry.filledIndividually) entry.users = [];
      }
      entry.error = null;
      entry.fetchedAt = answer.fetchedAt;

      // Only when the cheap path came back empty-handed, and only for people it did not describe —
      // which, with the list above kept, is usually just whoever arrived since the last call.
      if (answer.source !== "instance" && observedIds.length > 0) {
        const described = new Set(entry.users.map((user) => user.id));
        const wanted = observedIds.filter((id) => !described.has(id));
        if (wanted.length > 0) {
          const individually = await api.users.batch(wanted, accountId);
          if (individually.length > 0) {
            entry.users = [...entry.users, ...individually];
            entry.filledIndividually = true;
          }
        }
      }
    } catch (cause) {
      if (isAbort(cause)) return;
      const reason = unavailableReason(cause);
      /*
       * What was read stays read. A failed attempt is a fact about this attempt — a blip, or an
       * account signing out — and not grounds to withdraw chips that were true a moment ago; the
       * sentence under the toolbar is what explains the gap. This mattered less when a fetch ran
       * every fifteen seconds and matters now that a join drives one: a single dropped request
       * would otherwise strip every chip in the room.
       */
      entry.fetchedAt = Date.now();
      if (reason !== null) {
        entry.status = "unavailable";
        entry.reason = reason;
        entry.error = null;
      } else {
        entry.status = "error";
        entry.reason = null;
        entry.error = cause instanceof Error ? cause.message : "Something went wrong.";
      }
    } finally {
      this.#inFlight.delete(key);
    }
  }

  clear(): void {
    for (const key of [...this.#retries.keys()]) this.#clearRetry(key);
    this.#byKey.clear();
  }
}

export const instanceRoster = new InstanceRosterState();

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

export interface RosterRow {
  /** Stable across re-renders: the display name, which the log dedupes on. */
  readonly key: string;
  readonly displayName: string;
  /** From the log where it had one, otherwise recovered from a name match. Null when neither. */
  readonly userId: string | null;
  readonly joinedAt: number;
  /** The local player, who joins their own instance and gets no flag in the log for it. */
  readonly isSelf: boolean;
  /** Null when the endpoint said nothing about this person — never a fabricated default. */
  readonly attributes: InstanceUser | null;
  /** How the join was made, for the tooltip that admits a name match is an inference. */
  readonly matchedBy: "id" | "name" | null;
}

interface Index {
  readonly byId: ReadonlyMap<string, InstanceUser>;
  readonly byName: ReadonlyMap<string, InstanceUser>;
}

function indexUsers(users: readonly InstanceUser[]): Index {
  const byId = new Map<string, InstanceUser>();
  const byName = new Map<string, InstanceUser>();
  const ambiguous = new Set<string>();

  for (const user of users) {
    byId.set(user.id, user);
    const name = user.displayName.toLowerCase();
    if (byName.has(name)) ambiguous.add(name);
    byName.set(name, user);
  }
  // A name VRChat listed twice identifies nobody. Drop it rather than pick the last one seen.
  for (const name of ambiguous) byName.delete(name);

  return { byId, byName };
}

/**
 * The log's roster, decorated with whatever the endpoint knew.
 *
 * `ownName` is the session's own display name — the local player is in their own log roster with
 * nothing marking them as such, so the only way to point at them is to compare names, which is
 * what the existing screen already did.
 */
export function mergeRoster(
  players: readonly ObservedPlayer[],
  users: readonly InstanceUser[],
  ownName: string | null,
): RosterRow[] {
  const index = indexUsers(users);
  const own = ownName === null ? null : ownName.toLowerCase();

  return players.map((player) => {
    let attributes: InstanceUser | null = null;
    let matchedBy: RosterRow["matchedBy"] = null;

    if (player.userId !== null) {
      attributes = index.byId.get(player.userId) ?? null;
      if (attributes !== null) matchedBy = "id";
    } else {
      attributes = index.byName.get(player.displayName.toLowerCase()) ?? null;
      if (attributes !== null) matchedBy = "name";
    }

    return {
      key: player.displayName,
      displayName: player.displayName,
      userId: player.userId ?? attributes?.id ?? null,
      joinedAt: player.joinedAt,
      isSelf: own !== null && player.displayName.toLowerCase() === own,
      attributes,
      matchedBy,
    };
  });
}
