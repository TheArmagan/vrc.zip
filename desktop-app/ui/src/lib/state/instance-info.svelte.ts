/**
 * One instance's own record — occupancy, access type, region, queue, whether it is still open.
 *
 * The sibling of `instance-roster.svelte.ts` and deliberately separate from it: the roster answers
 * "who is in there", needs an account *standing in the instance*, and is invalidated by every join
 * and leave; this answers "what is that instance", is readable by any signed-in account, and is
 * stable for as long as a snapshot is worth anything. One cache with two invalidation rules would
 * be one of them being wrong.
 *
 * **Nothing here is fetched by rendering.** A feed page of a hundred rows must not become a hundred
 * instance lookups, so `entry()` is a pure read and the only things that call `ensure()` are a
 * tooltip actually being opened and the world modal actually being opened — both of which are a
 * person asking. An instance link therefore shows occupancy *where it happens to be known*, which
 * is honest, rather than showing it everywhere at the cost of a request per row.
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

  /** What is known right now. Pure — safe in a `$derived`, and it starts nothing. */
  entry(
    location: string | null | undefined,
    accountId: string | null = null,
  ): InstanceEntry | null {
    if (location === null || location === undefined || location === "") return null;
    return this.#byKey.get(keyFor(location, accountId)) ?? null;
  }

  /** Reads the instance unless a recent answer is already held. Only ever called on intent. */
  ensure(
    location: string | null | undefined,
    accountId: string | null = null,
    force = false,
  ): void {
    if (location === null || location === undefined || location === "") return;
    const key = keyFor(location, accountId);
    if (this.#inFlight.has(key)) return;

    const existing = this.#byKey.get(key);
    if (existing !== undefined && !force) {
      if (existing.fetchedAt !== null && Date.now() - existing.fetchedAt < FRESH_MS) return;
      // A daemon does not grow a route between two hovers.
      if (existing.reason === "no-route") return;
      // Nor does a closed instance reopen. Re-asking would be a request per hover, forever.
      if (existing.reason === "closed") return;
    }

    void this.#load(key, location, accountId);
  }

  refresh(location: string | null, accountId: string | null = null): void {
    this.ensure(location, accountId, true);
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
  }
}

export const instanceInfo = new InstanceInfoState();
