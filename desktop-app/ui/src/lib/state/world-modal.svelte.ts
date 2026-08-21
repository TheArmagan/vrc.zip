/**
 * The one world modal, and everything it knows.
 *
 * The same shape as `user-modal.svelte.ts`, for the same reasons: every location in the app is a
 * control that opens this, from four screens and from rows a live socket re-renders, so there is
 * exactly one `<Dialog>` — mounted by `App.svelte` — and this module is the only thing that decides
 * what it shows. Callers say `worldModal.open(worldId, …)` and nothing else.
 *
 * Three outcomes are modelled rather than caught, because each is ordinary:
 *  - **a deleted world** (404). Common. VRChat worlds are unpublished and removed all the time, and
 *    a log line from last year is exactly where a dead id comes from. The verdict is handed to the
 *    name resolver so the rest of the app stops asking.
 *  - **no account online** (503, on a cache miss). A world can be read from cache with nobody
 *    signed in; a world nobody has looked at cannot.
 *  - **a closed instance**. Every instance closes eventually. The world half of the dialog is still
 *    worth showing, so the instance half says so in a sentence and the rest stays.
 *
 * And, as with the user modal: closed and reopened faster than the network. Every load carries an
 * `AbortSignal` aborted the moment the target changes or the dialog closes, and a generation
 * counter drops a resolved response for a target that is no longer current rather than rendering it
 * over the new one.
 */

import {
  ApiError,
  api,
  describeError,
  type InstanceInfo,
  isAbort,
  isNoAccountOnline,
  isNotFound,
  isOffline,
  type WorldDetail,
} from "../api.ts";
import { parseLocation, shortId } from "../format.ts";
import { worldNames } from "./world-names.svelte.ts";

export type WorldLoadPhase = "idle" | "loading" | "ready" | "error";

/**
 * The instance half's phase, and it has no `error` on purpose.
 *
 * Nothing about an instance lookup is a fault worth drawing as one: it is either read, or it is
 * `unavailable` for a reason that has its own sentence. `instanceFailure` says which.
 */
export type InstancePhase = "idle" | "loading" | "ready" | "unavailable";

/** Why the world could not be shown. Only `other` is a genuine fault. */
export type WorldLoadFailure = "no-account" | "not-found" | "offline" | "other";

/** Why the instance could not be shown. `closed` is the ordinary end of every instance. */
export type InstanceLoadFailure =
  | "closed"
  | "no-account"
  | "invalid-location"
  | "offline"
  | "other";

export interface OpenWorldOptions {
  /**
   * The full location string this was opened from, when there was one. It is what turns the dialog
   * from "a world" into "that instance of that world" — and only a real instance has live counts.
   */
  readonly location?: string | null | undefined;
  /**
   * The name the caller already had on screen — usually the game log's, which is the only source of
   * world names when nothing has been fetched. Shown while the world loads, so the dialog opens
   * with the world's name in it rather than a spinner over an id.
   */
  readonly name?: string | null | undefined;
  /** The account this location was seen through; it decides whose credentials the lookups spend. */
  readonly accountId?: string | null | undefined;
}

class WorldModalState {
  open = $state(false);
  worldId = $state<string | null>(null);
  /** The instance this was opened from, or null when only a world was named. */
  location = $state<string | null>(null);
  hintName = $state<string | null>(null);
  accountId = $state<string | null>(null);

  world = $state<WorldDetail | null>(null);
  phase = $state<WorldLoadPhase>("idle");
  failure = $state<WorldLoadFailure | null>(null);
  error = $state<string | null>(null);

  instance = $state<InstanceInfo | null>(null);
  instancePhase = $state<InstancePhase>("idle");
  instanceFailure = $state<InstanceLoadFailure | null>(null);
  instanceError = $state<string | null>(null);
  instanceFetchedAt = $state<number | null>(null);

  #controller: AbortController | null = null;
  /** Guards against a slow response for a world the dialog has already moved off. */
  #generation = 0;

  /** The name for the title bar: the loaded one, the caller's hint, or the short id. */
  title = $derived(this.world?.name ?? this.hintName ?? shortId(this.worldId, 18));

  /** The parsed half of the location, so the header can name the instance without re-parsing. */
  parsed = $derived(parseLocation(this.location));

  /** True when the dialog was opened from something with a real instance in it. */
  hasInstance = $derived(this.location !== null && !this.parsed.opaque);

  /**
   * Everything the dialog is holding, as a plain object — what the copy button copies.
   *
   * The same reasoning as the user modal's Raw JSON: the layout above is a curated reading of the
   * data, and when the curation and the data disagree, this is how anyone finds out.
   */
  snapshot = $derived({
    worldId: this.worldId,
    location: this.location,
    seenThroughAccountId: this.accountId,
    world: this.world,
    instance: this.instance,
  });

  /** Opens the dialog on `worldId`, replacing whatever it was showing. */
  openWorld(worldId: string, options: OpenWorldOptions = {}): void {
    const location = options.location ?? null;
    const same = this.worldId === worldId && this.location === location && this.phase === "ready";
    this.worldId = worldId;
    this.location = location;
    this.hintName = options.name ?? (same ? this.hintName : null);
    this.accountId = options.accountId ?? null;
    this.open = true;
    if (!same) void this.#load(worldId);
  }

  close(): void {
    this.open = false;
    this.#abort();
  }

  /** Re-reads both halves. The error state's retry button. */
  retry(): void {
    if (this.worldId !== null) void this.#load(this.worldId);
  }

  /** Re-reads the live instance counts only. The world record has not changed. */
  refreshInstance(): void {
    const worldId = this.worldId;
    if (worldId === null || !this.hasInstance) return;
    void this.#loadInstance(this.#generation, this.#controller?.signal);
  }

  #abort(): void {
    this.#controller?.abort();
    this.#controller = null;
  }

  #reset(): void {
    this.world = null;
    this.failure = null;
    this.error = null;
    this.instance = null;
    this.instancePhase = "idle";
    this.instanceFailure = null;
    this.instanceError = null;
    this.instanceFetchedAt = null;
  }

  async #load(worldId: string): Promise<void> {
    this.#abort();
    this.#reset();
    this.#generation += 1;
    const generation = this.#generation;
    const controller = new AbortController();
    this.#controller = controller;

    this.phase = "loading";

    /*
     * Two requests, in parallel and independent.
     *
     * A deleted world still has no instance and a closed instance still has a world, so chaining
     * them would mean one ordinary outcome erasing the other's answer. The daemon serves the world
     * from cache without any account signed in, which is the case that most needs the split.
     */
    await Promise.all([
      this.#loadWorld(worldId, generation, controller.signal),
      this.hasInstance ? this.#loadInstance(generation, controller.signal) : Promise.resolve(),
    ]);
  }

  async #loadWorld(worldId: string, generation: number, signal: AbortSignal): Promise<void> {
    try {
      const world = await api.worlds.get(worldId, this.accountId, signal);
      if (generation !== this.#generation) return;
      this.world = world;
      this.phase = "ready";
      // Every row in the app naming this world gets the name for free.
      worldNames.prime(world);
    } catch (cause) {
      if (isAbort(cause) || generation !== this.#generation) return;
      const failure = classifyWorld(cause);
      this.failure = failure;
      this.error = describeError(cause);
      this.phase = "error";
      // The only place a *verdict* is available: the batch route cannot say "gone", this one can.
      if (failure === "not-found") worldNames.markUnresolved(worldId);
    }
  }

  async #loadInstance(generation: number, signal: AbortSignal | undefined): Promise<void> {
    const location = this.location;
    if (location === null) return;
    this.instancePhase = "loading";
    try {
      const detail = await api.instance(location, this.accountId, signal);
      if (generation !== this.#generation) return;
      this.instanceFetchedAt = detail.fetchedAt;
      if (detail.source === "instance" && detail.instance !== null) {
        this.instance = detail.instance;
        this.instanceFailure = null;
        this.instancePhase = "ready";
        worldNames.prime(detail.instance.world);
      } else {
        this.instance = null;
        this.instanceFailure = "closed";
        this.instancePhase = "unavailable";
      }
    } catch (cause) {
      if (isAbort(cause) || generation !== this.#generation) return;
      this.instance = null;
      this.instanceFailure = classifyInstance(cause);
      this.instanceError = describeError(cause);
      this.instancePhase = "unavailable";
      this.instanceFetchedAt = Date.now();
    }
  }
}

function classifyWorld(error: unknown): WorldLoadFailure {
  if (isNoAccountOnline(error)) return "no-account";
  if (isNotFound(error)) return "not-found";
  if (isOffline(error)) return "offline";
  return "other";
}

function classifyInstance(error: unknown): InstanceLoadFailure {
  if (isNoAccountOnline(error)) return "no-account";
  // A 404 here is the daemon's `unknown_instance`, which is a closed instance, not a fault.
  if (isNotFound(error)) return "closed";
  if (isOffline(error)) return "offline";
  if (error instanceof ApiError && error.status === 400) return "invalid-location";
  return "other";
}

export const worldModal = new WorldModalState();
