/**
 * Avatar records by id, so a row can print a name instead of offering to go and find one.
 *
 * The sibling of `avatar-ids.svelte.ts` and deliberately separate from it. That one answers "which
 * avatar is this picture?" and asks a third party; this one answers "what is that avatar?" and asks
 * VRChat through the daemon. They cache different things, fail for different reasons, and one is a
 * setting the user can turn off while the other is not.
 *
 * ## Why a resolver rather than a call in the modal
 *
 * The modal already fetches the avatar it is showing. What it cannot do is tell a profile what the
 * avatar somebody is *wearing* is called, and that is the common case: a name and its author read
 * far better than a button admitting the app has an id and nothing else. Several profiles in one
 * session frequently name the same avatar — a popular public avatar shows up constantly — so the
 * work is mostly deduplication, which is what a resolver is for.
 *
 * ## What is cached, and what latches
 *
 * A record caches for the session: an avatar's name and author do not move. A **404 latches too**,
 * which is the departure from `world-names` and is deliberate. There, an unresolvable world is a
 * cooldown because the batch endpoint omits what it cannot serve and would omit everything with no
 * account signed in. Here a 404 is VRChat answering, through an account, that this avatar is not
 * visible to it — and the daemon has already tried every signed-in account before saying so. Asking
 * again on the next render would spend a request per account per profile to hear the same thing.
 *
 * `no-account` does **not** latch, for the mirror-image reason: nobody was asked, so nothing was
 * answered, and signing in must be allowed to change the result.
 */

import { SvelteMap } from "svelte/reactivity";
import { type AvatarDetail, api, isAbort, isNoAccountOnline, isNotFound } from "../api.ts";

export type AvatarRecordStatus = "loading" | "ready" | "unavailable" | "error";

/** Why there is no record. Each is an ordinary outcome except `error`. */
export type AvatarRecordFailure =
  /** VRChat 404s: deleted, or private to an author none of your accounts is. */
  | "not-visible"
  /** Nothing is signed in, so nobody was asked. Not a verdict, and not cached. */
  | "no-account";

export interface AvatarRecordEntry {
  readonly status: AvatarRecordStatus;
  readonly avatar: AvatarDetail | null;
  readonly failure: AvatarRecordFailure | null;
  readonly error: string | null;
}

/** Matching the other resolvers: enough to fill a screen quickly, few enough to stay polite. */
const MAX_CONCURRENT = 3;

class AvatarRecordState {
  readonly #byId = new SvelteMap<string, AvatarRecordEntry>();
  readonly #inFlight = new Set<string>();
  #queue: { avatarId: string; accountId: string | null }[] = [];
  readonly #queued = new Set<string>();
  #active = 0;

  /** Pure: safe inside a `$derived`, and it starts nothing. */
  entry(avatarId: string | null): AvatarRecordEntry | null {
    if (avatarId === null) return null;
    return this.#byId.get(avatarId) ?? null;
  }

  get(avatarId: string | null): AvatarDetail | null {
    return this.entry(avatarId)?.avatar ?? null;
  }

  /** Queues a read unless the answer is held, latched, or already on the way. */
  ensure(avatarId: string | null, accountId: string | null = null): void {
    if (avatarId === null || avatarId === "") return;
    if (this.#inFlight.has(avatarId) || this.#queued.has(avatarId)) return;

    const held = this.#byId.get(avatarId);
    if (held !== undefined) {
      // Everything latches except "nobody was asked", which signing in can change.
      if (held.failure !== "no-account") return;
    }

    this.#byId.set(avatarId, {
      status: "loading",
      avatar: held?.avatar ?? null,
      failure: null,
      error: null,
    });
    this.#queued.add(avatarId);
    this.#queue.push({ avatarId, accountId });
    this.#pump();
  }

  #pump(): void {
    while (this.#active < MAX_CONCURRENT) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      this.#queued.delete(next.avatarId);
      if (this.#inFlight.has(next.avatarId)) continue;
      this.#active += 1;
      void this.#load(next.avatarId, next.accountId).finally(() => {
        this.#active -= 1;
        this.#pump();
      });
    }
  }

  async #load(avatarId: string, accountId: string | null): Promise<void> {
    this.#inFlight.add(avatarId);
    try {
      const avatar = await api.avatars.get(avatarId, accountId);
      this.#byId.set(avatarId, { status: "ready", avatar, failure: null, error: null });
    } catch (cause) {
      if (isAbort(cause)) {
        // Abandoned work is not failed work, and `loading` is a state nothing retries from.
        this.#byId.delete(avatarId);
        return;
      }
      const failure: AvatarRecordFailure | null = isNotFound(cause)
        ? "not-visible"
        : isNoAccountOnline(cause)
          ? "no-account"
          : null;
      this.#byId.set(avatarId, {
        status: failure === null ? "error" : "unavailable",
        avatar: null,
        failure,
        error: cause instanceof Error ? cause.message : "Something went wrong.",
      });
    } finally {
      this.#inFlight.delete(avatarId);
    }
  }

  clear(): void {
    this.#byId.clear();
    this.#queue = [];
    this.#queued.clear();
  }
}

export const avatarRecords = new AvatarRecordState();
