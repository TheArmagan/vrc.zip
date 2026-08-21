/**
 * VRChat profiles, cached, for the places that show a person *without* being a profile page.
 *
 * The user modal already fetches a profile, but it fetches the one profile a click asked for and
 * throws it away on close. That is the wrong shape for a screen like Live sessions, which wants
 * the small facts about somebody — their icon, their trust rank, whether VRChat has age-verified
 * them — sitting next to their name before anyone clicks anything.
 *
 * The rules are the ones `instance-info.svelte.ts` records, for the same reasons:
 *
 *  - `entry()` is **pure**. It is safe inside a `$derived` and starts nothing.
 *  - `ensure()` is the only thing that fetches, is de-duplicated per user, and refuses to re-ask
 *    inside `FRESH_MS`. A screen may therefore call it from an `$effect` — but only a screen with a
 *    *bounded* number of people on it. A hundred-row list must not become a hundred lookups; the
 *    running-clients rail is at most a handful, which is why that screen is allowed to.
 *  - Failure is modelled rather than caught. `no-account` (503) and `not-found` (404) are ordinary
 *    answers about the world, not faults, and callers are expected to render nothing for them.
 *
 * A profile is keyed by user *and* by the account it was read through, because VRChat answers
 * `GET /users/{id}` with different fields depending on who is asking — `isFriend` is a statement
 * about the asking account, and a shorter body comes back for a non-friend (PROGRESS.md §Gotchas).
 * Two accounts asking about the same person are two answers, and merging them would invent one.
 */

import { SvelteMap } from "svelte/reactivity";
import { ApiError, api, isAbort, type UserProfile } from "../api.ts";
import { app } from "./app.svelte.ts";

export type ProfileStatus = "loading" | "ready" | "unavailable" | "error";

/** Why there is no profile. Only `error` is a fault; the rest are VRChat answering honestly. */
export type ProfileUnavailable =
  /** 503 — vrc.zip holds no signed-in account to ask VRChat through. */
  | "no-account"
  /** 404 — VRChat looked and knows nobody by that id. */
  | "not-found";

export interface ProfileEntry {
  status: ProfileStatus;
  profile: UserProfile | null;
  reason: ProfileUnavailable | null;
  error: string | null;
  /** Unix ms of the last completed attempt. Null while the first is still in flight. */
  fetchedAt: number | null;
}

/**
 * How long an answer is reused.
 *
 * A minute, which is chosen against the fields that move: presence status and location. Trust,
 * icon and age verification change on the scale of months, so a longer window would be fine for
 * them and would make the status line stale enough to be misleading.
 */
const FRESH_MS = 60_000;

function keyFor(userId: string, accountId: string | null): string {
  return `${accountId ?? ""} ${userId}`;
}

function unavailableReason(error: unknown): ProfileUnavailable | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 503) return "no-account";
  if (error.status === 404) return "not-found";
  return null;
}

class UserProfilesState {
  readonly #byKey = new SvelteMap<string, ProfileEntry>();
  readonly #inFlight = new Set<string>();

  /** What is known right now. Pure — safe in a `$derived`, and it starts nothing. */
  entry(userId: string | null | undefined, accountId: string | null = null): ProfileEntry | null {
    if (userId === null || userId === undefined || userId === "") return null;
    return this.#byKey.get(keyFor(userId, this.#eyes(userId, accountId))) ?? null;
  }

  /** The profile itself when one has landed, else null. Also pure. */
  get(userId: string | null | undefined, accountId: string | null = null): UserProfile | null {
    return this.entry(userId, accountId)?.profile ?? null;
  }

  /** Reads the profile unless a recent answer is already held. */
  ensure(userId: string | null | undefined, accountId: string | null = null, force = false): void {
    if (userId === null || userId === undefined || userId === "") return;
    const eyes = this.#eyes(userId, accountId);
    const key = keyFor(userId, eyes);
    if (this.#inFlight.has(key)) return;

    const existing = this.#byKey.get(key);
    if (existing !== undefined && !force) {
      if (existing.fetchedAt !== null && Date.now() - existing.fetchedAt < FRESH_MS) return;
      // VRChat does not start knowing a user id it has already denied knowing.
      if (existing.reason === "not-found") return;
    }

    void this.#load(key, userId, eyes);
  }

  refresh(userId: string | null, accountId: string | null = null): void {
    this.ensure(userId, accountId, true);
  }

  /**
   * Whose credentials to spend.
   *
   * One of our own accounts is looked up through *itself*, the same rule the user modal follows:
   * VRChat returns the full profile to the account it belongs to and a trimmed one to everybody
   * else, so asking about your own account through a different one loses fields for no reason.
   */
  #eyes(userId: string, accountId: string | null): string | null {
    const own = app.accounts.find((account) => account.id === userId);
    if (own !== undefined) return own.id;
    return accountId;
  }

  #ensureEntry(key: string): ProfileEntry {
    const existing = this.#byKey.get(key);
    if (existing !== undefined) return existing;
    // `$state` for the reason in PROGRESS.md §Gotchas: the map's reactivity covers insertion and
    // says nothing about the object, and every update below mutates one already in the map.
    const created: ProfileEntry = $state({
      status: "loading",
      profile: null,
      reason: null,
      error: null,
      fetchedAt: null,
    });
    this.#byKey.set(key, created);
    return created;
  }

  async #load(key: string, userId: string, accountId: string | null): Promise<void> {
    const entry = this.#ensureEntry(key);
    this.#inFlight.add(key);
    if (entry.fetchedAt === null) entry.status = "loading";

    try {
      const profile = await api.users.get(userId, accountId ?? undefined);
      entry.profile = profile;
      entry.status = "ready";
      entry.reason = null;
      entry.error = null;
      entry.fetchedAt = Date.now();
    } catch (cause) {
      if (isAbort(cause)) return;
      const reason = unavailableReason(cause);
      entry.fetchedAt = Date.now();
      if (reason !== null) {
        // The previous answer is kept rather than blanked: a momentary 503 while an account
        // reconnects should not strip the icon and rank off a header that already had them.
        entry.status = "unavailable";
        entry.reason = reason;
        entry.error = null;
        if (reason === "not-found") entry.profile = null;
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
    this.#byKey.clear();
  }
}

export const userProfiles = new UserProfilesState();
