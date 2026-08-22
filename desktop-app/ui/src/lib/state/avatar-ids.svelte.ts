/**
 * Turning a picture into an avatar id.
 *
 * VRChat tells you what an avatar *looks like* — `currentAvatarImageUrl` and its thumbnail — and
 * never which avatar it is. There is no avatar id anywhere on a public user, which is why a
 * "changed avatar" row could say only that. avtr.zip maps the image's file id back to an `avtr_…`
 * id, and that id is what `GET /api/avatars/:id` needs.
 *
 * ## Why this is a resolver and not a call
 *
 * The same avatar picture appears on a profile, in a feed row, and again in the row above it, so
 * the interesting work is all deduplication. This follows the shape the other resolvers use, with
 * one difference worth stating: **there is no batch endpoint**, so `ensure` queues rather than
 * coalescing. The daemon's own resolver holds avtr.zip's 10/s ceiling and a persistent cache, so
 * what this queue protects is the browser's connection pool and nothing more.
 *
 * ## Null is an answer
 *
 * A file that resolves to nothing is the *ordinary* outcome: profile icons, banners and gallery
 * images are not avatars, and asking about them is how you find out. So a null is cached exactly
 * like an id, and the UI reads it as "this picture is not an avatar" rather than as a failure. The
 * setting being off produces the same null, deliberately — see `api.avatars.byFile`.
 */

import { SvelteMap } from "svelte/reactivity";
import { api, fileIdFromImageUrl, isAbort } from "../api.ts";

export type AvatarIdStatus = "loading" | "resolved" | "unresolved" | "error";

export interface AvatarIdEntry {
  readonly status: AvatarIdStatus;
  /** The `avtr_…` id, or null when this file is not an avatar (or could not be asked about). */
  readonly avatarId: string | null;
  readonly error: string | null;
}

/**
 * How many lookups may be in flight at once.
 *
 * Three, matching `instance-info.svelte.ts`, and for the same reason rather than by imitation: a
 * profile can name three pictures and a feed page can name thirty, and none of them is what the
 * reader is waiting on.
 */
const MAX_CONCURRENT = 3;

class AvatarIdState {
  readonly #byFile = new SvelteMap<string, AvatarIdEntry>();
  readonly #inFlight = new Set<string>();
  #queue: string[] = [];
  readonly #queued = new Set<string>();
  #active = 0;

  /** What is known right now. Pure, so it is safe inside a `$derived`, and it starts nothing. */
  entry(fileId: string | null): AvatarIdEntry | null {
    if (fileId === null) return null;
    return this.#byFile.get(fileId) ?? null;
  }

  /** The resolved id, or null for "not an avatar", "not asked yet" and "could not ask" alike. */
  get(fileId: string | null): string | null {
    return this.entry(fileId)?.avatarId ?? null;
  }

  /**
   * The id for whichever of these pictures turns out to be an avatar.
   *
   * Callers hand over every picture they have — the worn avatar first, then the icon, then the
   * banner — because only one of them is usually an avatar and which one is not knowable in
   * advance. The first *resolved* answer wins; a file still being asked about does not block a
   * later one that has already come back.
   */
  resolveAny(urls: readonly (string | null | undefined)[]): string | null {
    for (const url of urls) {
      const fileId = url === null || url === undefined ? null : fileIdFromImageUrl(url);
      const found = this.get(fileId);
      if (found !== null) return found;
    }
    return null;
  }

  /** True while any of these is still being asked about, so a caller can say "looking" honestly. */
  pending(urls: readonly (string | null | undefined)[]): boolean {
    return urls.some((url) => {
      const fileId = url === null || url === undefined ? null : fileIdFromImageUrl(url);
      const status = this.entry(fileId)?.status;
      return status === "loading";
    });
  }

  /** Queues a lookup for every one of these pictures that is a file id at all. */
  ensureAll(urls: readonly (string | null | undefined)[]): void {
    for (const url of urls) {
      if (url === null || url === undefined || url === "") continue;
      this.ensure(fileIdFromImageUrl(url));
    }
  }

  /** Queues one lookup unless the answer is already held or already on the way. */
  ensure(fileId: string | null): void {
    if (fileId === null || fileId === "") return;
    if (this.#inFlight.has(fileId) || this.#queued.has(fileId)) return;
    // Both answers latch for the session. An avatar's file does not stop being that avatar's file,
    // and a picture that is not an avatar does not become one.
    if (this.#byFile.has(fileId)) return;

    this.#byFile.set(fileId, { status: "loading", avatarId: null, error: null });
    this.#queued.add(fileId);
    this.#queue.push(fileId);
    this.#pump();
  }

  #pump(): void {
    while (this.#active < MAX_CONCURRENT) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      this.#queued.delete(next);
      if (this.#inFlight.has(next)) continue;
      this.#active += 1;
      void this.#load(next).finally(() => {
        this.#active -= 1;
        this.#pump();
      });
    }
  }

  async #load(fileId: string): Promise<void> {
    this.#inFlight.add(fileId);
    try {
      const answer = await api.avatars.byFile(fileId);
      this.#byFile.set(fileId, {
        status: answer.avatarId === null ? "unresolved" : "resolved",
        avatarId: answer.avatarId,
        error: null,
      });
    } catch (cause) {
      if (isAbort(cause)) {
        // Abandoned work is not failed work, and `loading` is a state nothing retries from. Drop
        // the entry so a later `ensure` can ask again. Same rule as the entity modals.
        this.#byFile.delete(fileId);
        return;
      }
      this.#byFile.set(fileId, {
        status: "error",
        avatarId: null,
        error: cause instanceof Error ? cause.message : "Something went wrong.",
      });
    } finally {
      this.#inFlight.delete(fileId);
    }
  }

  clear(): void {
    this.#byFile.clear();
    this.#queue = [];
    this.#queued.clear();
  }
}

export const avatarIds = new AvatarIdState();
