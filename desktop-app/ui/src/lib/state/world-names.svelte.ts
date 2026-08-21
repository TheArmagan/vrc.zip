/**
 * World names, for every row in the app that shows a location.
 *
 * ## Why this is a resolver and not a fetch in a component
 *
 * Outside a live game session vrc.zip has no world *name* for a location at all — names only ever
 * arrive on the game log's `Entering Room:` line, so a feed row, a friend's presence and a stored
 * session all fall back to `wrld_0ae3e886-52e…`, which means nothing to a reader. The name has to
 * be fetched, and the shape of the demand is the whole problem: a feed page is a hundred rows
 * naming maybe twenty distinct worlds, all mounting in the same frame.
 *
 * So this module owns four properties that a per-component fetch cannot have:
 *
 *  - **Batching.** Ids requested within a tick are coalesced and sent as one
 *    `GET /api/worlds?ids=…` (fifty per request, the daemon's cap). Twenty worlds is one request,
 *    not a hundred.
 *  - **In-flight de-duplication.** Twenty rows naming the same world queue it once. An id already
 *    being fetched is never queued again.
 *  - **A session cache.** A world resolved on the feed is already named when the friends screen
 *    asks, with no request at all.
 *  - **A memory for failure.** An id that does not come back is remembered, so a render loop
 *    cannot turn one deleted world into a request per frame for the life of the tab.
 *
 * ## Why "unresolvable" is a cooldown and not a verdict
 *
 * The batch endpoint answers with a *map*, and an id that could not be resolved is simply absent
 * from it — that is the contract, and it is the right one, because one deleted world must not cost
 * the other forty-nine their names. But absence has two causes and the response cannot tell them
 * apart: the world is gone, or the daemon had no signed-in account to ask VRChat through and
 * answered from its cache alone (`listWorlds` in `wiring/control-deps.ts` does exactly that). A
 * permanent verdict would therefore freeze every world name in the app for the whole session
 * whenever the first page happened to render before an account connected. A long cooldown gets the
 * property that actually matters — no retry on render — while still healing once someone is online.
 *
 * ## Reactivity
 *
 * `SvelteMap` makes *structural* change reactive and says **nothing** about mutations to the
 * objects inside it (PROGRESS.md §Gotchas — this froze the live roster once already). Entries are
 * created with `$state` and mutated in place, which is the only reason a row re-renders when its
 * name lands rather than when some other world is inserted.
 */

import { SvelteMap } from "svelte/reactivity";
import { api, isAbort, MAX_WORLD_IDS, type WorldSummary } from "../api.ts";

/**
 * What is known about one world id.
 *
 * `unresolved` is not an error state and does not render as one: the row keeps its short-id
 * fallback, which is what an unresolved world should look like.
 */
export type WorldNameStatus = "unknown" | "loading" | "ready" | "unresolved" | "failed";

interface WorldEntry {
  status: WorldNameStatus;
  world: WorldSummary | null;
  /** Unix ms before which `ensure` will not ask again. Zero for a resolved world. */
  retryAt: number;
}

/**
 * How long an id absent from a batch answer is left alone. Long enough that scrolling a feed of
 * deleted worlds costs nothing, short enough that signing an account in fixes the page by itself.
 */
const UNRESOLVED_COOLDOWN = 5 * 60_000;

/** A request that never reached the daemon is a fact about the network, not about the world. */
const FAILED_COOLDOWN = 30_000;

class WorldNamesState {
  readonly #byId = new SvelteMap<string, WorldEntry>();
  /** Ids waiting for the next flush, each with the account whose eyes first asked. */
  readonly #queue = new Map<string, string | null>();
  readonly #inFlight = new Set<string>();
  #flushScheduled = false;

  /**
   * The summary for a world, or null when there is not one yet. Pure — safe inside a `$derived`,
   * and it never starts a request. `ensure()` does that, from an `$effect`.
   */
  get(worldId: string | null | undefined): WorldSummary | null {
    if (worldId === null || worldId === undefined || worldId === "") return null;
    return this.#byId.get(worldId)?.world ?? null;
  }

  /** Whether a name is coming, already here, or is not going to arrive. Also pure. */
  status(worldId: string | null | undefined): WorldNameStatus {
    if (worldId === null || worldId === undefined || worldId === "") return "unknown";
    return this.#byId.get(worldId)?.status ?? "unknown";
  }

  /**
   * Asks for a world's name unless it is already held, already in flight, or in a cooldown.
   *
   * Call from an `$effect`. Twenty rows calling this for the same id in the same frame produce one
   * queue entry and one request.
   */
  ensure(worldId: string | null | undefined, accountId: string | null = null): void {
    if (worldId === null || worldId === undefined || worldId === "") return;
    if (this.#inFlight.has(worldId) || this.#queue.has(worldId)) return;

    const existing = this.#byId.get(worldId);
    if (existing !== undefined) {
      if (existing.status === "ready" || existing.status === "loading") return;
      if (Date.now() < existing.retryAt) return;
      existing.status = "loading";
    } else {
      // `$state`, and load-bearing: the map's reactivity covers insertion, never the object.
      const created: WorldEntry = $state({ status: "loading", world: null, retryAt: 0 });
      this.#byId.set(worldId, created);
    }

    this.#queue.set(worldId, accountId);
    this.#schedule();
  }

  /**
   * Records a world somebody else already paid for.
   *
   * The world modal's full fetch and the instance record's embedded world both carry a summary,
   * and dropping it would mean re-fetching a name we are holding in our hand.
   */
  prime(world: WorldSummary | null | undefined): void {
    if (world === null || world === undefined || world.id === "") return;
    const entry = this.#byId.get(world.id);
    if (entry === undefined) {
      const created: WorldEntry = $state({ status: "ready", world, retryAt: 0 });
      this.#byId.set(world.id, created);
      return;
    }
    entry.world = world;
    entry.status = "ready";
    entry.retryAt = 0;
  }

  /**
   * Records that VRChat says this world does not exist.
   *
   * The single-world route answers a deleted world with a 404, which the batch route cannot — so
   * this is the one place a genuine verdict is available, and the modal hands it back rather than
   * letting every row keep asking about a world it has been told is gone.
   */
  markUnresolved(worldId: string): void {
    const entry = this.#byId.get(worldId);
    const retryAt = Date.now() + UNRESOLVED_COOLDOWN;
    if (entry === undefined) {
      const created: WorldEntry = $state({ status: "unresolved", world: null, retryAt });
      this.#byId.set(worldId, created);
      return;
    }
    entry.status = "unresolved";
    entry.world = null;
    entry.retryAt = retryAt;
  }

  clear(): void {
    this.#byId.clear();
    this.#queue.clear();
  }

  /**
   * Coalesces everything asked for in this tick into one flush.
   *
   * A microtask rather than a timeout: every row of a page mounts in the same task, so the queue is
   * complete by the time the microtask runs, and nothing is delayed by a timer the user can feel.
   */
  #schedule(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      this.#flush();
    });
  }

  #flush(): void {
    if (this.#queue.size === 0) return;

    // Grouped by the account that asked, because `accountId` decides whose credentials the daemon
    // spends — not what the answer is. One bucket is the overwhelmingly common case.
    const buckets = new Map<string, string[]>();
    for (const [worldId, accountId] of this.#queue) {
      const key = accountId ?? "";
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [worldId]);
      else bucket.push(worldId);
      this.#inFlight.add(worldId);
    }
    this.#queue.clear();

    for (const [accountId, ids] of buckets) {
      // The daemon 400s on more than `MAX_WORLD_IDS` rather than silently truncating, so the
      // chunking is ours to do.
      for (let index = 0; index < ids.length; index += MAX_WORLD_IDS) {
        void this.#load(
          ids.slice(index, index + MAX_WORLD_IDS),
          accountId === "" ? null : accountId,
        );
      }
    }
  }

  async #load(ids: readonly string[], accountId: string | null): Promise<void> {
    try {
      const worlds = await api.worlds.list(ids, accountId);
      const now = Date.now();
      for (const worldId of ids) {
        const world = worlds[worldId] ?? null;
        const entry = this.#byId.get(worldId);
        if (entry === undefined) continue;
        if (world === null) {
          // Absent from the map. Not an error, and not proof the world is gone — see the header.
          entry.status = "unresolved";
          entry.world = null;
          entry.retryAt = now + UNRESOLVED_COOLDOWN;
        } else {
          entry.status = "ready";
          entry.world = world;
          entry.retryAt = 0;
        }
      }
    } catch (cause) {
      if (isAbort(cause)) return;
      const retryAt = Date.now() + FAILED_COOLDOWN;
      for (const worldId of ids) {
        const entry = this.#byId.get(worldId);
        if (entry === undefined) continue;
        entry.status = "failed";
        entry.retryAt = retryAt;
      }
    } finally {
      for (const worldId of ids) this.#inFlight.delete(worldId);
    }
  }
}

export const worldNames = new WorldNamesState();
