/**
 * One instance's own record — occupancy, access type, region, queue, whether it is still open.
 *
 * The sibling of `instance-roster.svelte.ts` and deliberately separate from it: the roster answers
 * "who is in there", needs an account that *created* the instance, and is invalidated by every join
 * and leave; this answers "what is that instance", is readable by any signed-in account, and is
 * stable for as long as a snapshot is worth anything. One cache with two invalidation rules would
 * be one of them being wrong.
 *
 * ## Rendering may fetch here, and what pays for that
 *
 * This resolver used to refuse to fetch on render, because a feed page of a hundred rows would
 * become a hundred instance lookups. The consequence was an occupancy count that appeared only on
 * rows somebody had already hovered, so a screenful showed a number on two rows out of forty and
 * nothing on the rest — which reads as missing data rather than as an unasked question.
 *
 * So `ensure()` is now safe to call while rendering, and the amplification is answered directly
 * instead of by refusing. `entry()` is still pure and still starts nothing; `ensure()` no longer
 * starts a request, it joins a queue that drains `MAX_CONCURRENT` at a time. A hundred rows are
 * therefore a hundred *queued* lookups and three in flight, which the daemon's rate limiter can
 * absorb without the per-account bucket (PLAN.md §1.4) ever seeing a burst.
 *
 * Four properties make that bounded rather than merely slow, and all four already existed:
 * identical locations collapse to one request (rows in a feed overwhelmingly share an instance),
 * `FRESH_MS` stops a re-render re-asking, a closed instance latches and is never asked about again,
 * and a missing route latches for the session. The queue is the fifth and the only new one.
 *
 * A person's hover still beats the queue — see the `urgent` option. Waiting behind thirty
 * background lookups for the tooltip you just opened would be the same bug in a new place.
 *
 * `source: "unavailable"` is an ordinary answer and not an error: instances close, and a location
 * string from an hour ago points at exactly that.
 */

import { SvelteMap } from "svelte/reactivity";
import { ApiError, api, type InstanceInfo, isAbort } from "../api.ts";
import { worldNames } from "./world-names.svelte.ts";

export type InstanceStatus = "loading" | "ready" | "unavailable" | "error";

/** Why there is no instance record. Every one of these is a normal outcome except `error`. */
export type InstanceUnavailable =
  /** 200 `source: "unavailable"` — the instance is closed, or VRChat does not recognise the id. */
  | "closed"
  /** 503 — vrc.zip holds no signed-in account to ask VRChat through. */
  | "no-account"
  /** 400 — private, traveling, or otherwise not a location anyone can be asked about. */
  | "invalid-location"
  /** 404/501 — this daemon build predates the route. Older daemon, not broken software. */
  | "no-route";

export interface InstanceEntry {
  status: InstanceStatus;
  instance: InstanceInfo | null;
  reason: InstanceUnavailable | null;
  error: string | null;
  /** Unix ms of the last completed attempt. Null while the first is still in flight. */
  fetchedAt: number | null;
}

export function instanceUnavailableText(reason: InstanceUnavailable): string {
  switch (reason) {
    case "closed":
      return "VRChat has no record of this instance any more. Instances close when the last person leaves, so this is the ordinary fate of every location string given enough time.";
    case "no-account":
      return "No signed-in account to ask VRChat through, so the live counts for this instance cannot be read.";
    case "invalid-location":
      return "This is not an instance VRChat can be asked about.";
    case "no-route":
      return "This daemon build does not serve instance records yet.";
  }
}

/** How long an answer is reused. Occupancy moves, but not so fast that a hover should re-ask. */
const FRESH_MS = 15_000;

/**
 * How many instance lookups may be in flight at once.
 *
 * Three, not one: a single slot makes a long list drain visibly row by row, and not ten, because
 * `GET /api/instances` is one upstream VRChat call per location and the per-account ceiling is 20
 * requests a second defaulting to 80% of that. Three keeps a screenful arriving within a second or
 * two while leaving the bucket's headroom for the things a person is actively doing.
 */
const MAX_CONCURRENT = 3;

interface Pending {
  key: string;
  location: string;
  accountId: string | null;
}

export interface EnsureOptions {
  /** Ask again even if the held answer is fresh, or latched as closed or route-less. */
  force?: boolean;
  /**
   * Jump the queue. For a person's own gesture — opening a tooltip or a modal — which must not
   * wait behind the background sweep that filled in the rest of the list.
   */
  urgent?: boolean;
}

function keyFor(location: string, accountId: string | null): string {
  return `${accountId ?? ""} ${location}`;
}

function unavailableReason(error: unknown): InstanceUnavailable | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 503) return "no-account";
  if (error.status === 400) return "invalid-location";
  if (error.status === 404 || error.status === 501) return "no-route";
  return null;
}

class InstanceInfoState {
  readonly #byKey = new SvelteMap<string, InstanceEntry>();
  readonly #inFlight = new Set<string>();

  /** Waiting to be asked, oldest first. `#queued` is the same set, for an O(1) membership test. */
  #queue: Pending[] = [];
  readonly #queued = new Set<string>();
  #active = 0;

  /** What is known right now. Pure — safe in a `$derived`, and it starts nothing. */
  entry(
    location: string | null | undefined,
    accountId: string | null = null,
  ): InstanceEntry | null {
    if (location === null || location === undefined || location === "") return null;
    return this.#byKey.get(keyFor(location, accountId)) ?? null;
  }

  /**
   * Queues a read unless a recent answer is already held.
   *
   * Safe to call while rendering and safe to call on every pass: everything below is a cheap
   * rejection, and the one path that survives appends to a queue rather than opening a socket.
   */
  ensure(
    location: string | null | undefined,
    accountId: string | null = null,
    options: EnsureOptions = {},
  ): void {
    if (location === null || location === undefined || location === "") return;
    const key = keyFor(location, accountId);
    if (this.#inFlight.has(key)) return;

    const existing = this.#byKey.get(key);
    if (existing !== undefined && options.force !== true) {
      if (existing.fetchedAt !== null && Date.now() - existing.fetchedAt < FRESH_MS) return;
      // A daemon does not grow a route between two hovers.
      if (existing.reason === "no-route") return;
      // Nor does a closed instance reopen. Re-asking would be a request per hover, forever.
      if (existing.reason === "closed") return;
    }

    if (this.#queued.has(key)) {
      // Already waiting. An urgent caller does not add a second entry, it moves the one there is:
      // this is the tooltip opening on a row the background sweep had already lined up.
      if (options.urgent === true) this.#promote(key);
      return;
    }

    // Created now rather than when the request starts, so a queued row can say "reading" instead
    // of looking like an instance nobody ever asked about.
    this.#ensureEntry(key);
    this.#queued.add(key);
    const pending: Pending = { key, location, accountId };
    if (options.urgent === true) this.#queue.unshift(pending);
    else this.#queue.push(pending);
    this.#pump();
  }

  refresh(location: string | null, accountId: string | null = null): void {
    this.ensure(location, accountId, { force: true, urgent: true });
  }

  #promote(key: string): void {
    const at = this.#queue.findIndex((pending) => pending.key === key);
    if (at <= 0) return;
    const [pending] = this.#queue.splice(at, 1);
    if (pending !== undefined) this.#queue.unshift(pending);
  }

  /** Starts as many queued reads as the concurrency budget allows. Called on every state change. */
  #pump(): void {
    while (this.#active < MAX_CONCURRENT) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      this.#queued.delete(next.key);
      // A key can be dequeued after something else already answered it — a modal fetching the same
      // instance directly, say. Re-checking here is cheaper than trying to keep the queue clean.
      if (this.#inFlight.has(next.key)) continue;
      this.#active += 1;
      void this.#load(next.key, next.location, next.accountId).finally(() => {
        this.#active -= 1;
        this.#pump();
      });
    }
  }

  #ensureEntry(key: string): InstanceEntry {
    const existing = this.#byKey.get(key);
    if (existing !== undefined) return existing;
    // `$state` for the reason in PROGRESS.md §Gotchas: the map's reactivity covers insertion and
    // says nothing about the object, and every update below mutates one already in the map.
    const created: InstanceEntry = $state({
      status: "loading",
      instance: null,
      reason: null,
      error: null,
      fetchedAt: null,
    });
    this.#byKey.set(key, created);
    return created;
  }

  async #load(key: string, location: string, accountId: string | null): Promise<void> {
    const entry = this.#ensureEntry(key);
    this.#inFlight.add(key);
    if (entry.fetchedAt === null) entry.status = "loading";

    try {
      const answer = await api.instance(location, accountId);
      entry.instance = answer.instance;
      entry.status = answer.source === "instance" ? "ready" : "unavailable";
      entry.reason = answer.source === "instance" ? null : "closed";
      entry.error = null;
      entry.fetchedAt = answer.fetchedAt;
      // VRChat embeds the whole world record in the instance response, so this name is already
      // paid for — handing it to the resolver saves the batch a round trip.
      worldNames.prime(answer.instance?.world);
    } catch (cause) {
      if (isAbort(cause)) return;
      const reason = unavailableReason(cause);
      entry.instance = null;
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
    this.#byKey.clear();
    // The queue holds keys into the map that no longer exist, so it has to go with it. Requests
    // already in flight are left alone: they resolve against entries `#ensureEntry` recreates,
    // which is harmless, and cancelling them would need an `AbortController` per key for no gain.
    this.#queue = [];
    this.#queued.clear();
  }
}

export const instanceInfo = new InstanceInfoState();
