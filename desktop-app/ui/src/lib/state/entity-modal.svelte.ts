/**
 * What the three entity modals — user, world, group — all have to get right, in one place.
 *
 * Each of them is a singleton `<Dialog>` mounted by `App.svelte` and re-targeted at a new subject
 * without ever unmounting, and that one design decision is the source of every hazard here:
 *
 *  - **A response can outlive its question.** Click a name, close the dialog, click another name;
 *    the first request is still in flight and will resolve into a modal that has moved on. So every
 *    load carries an `AbortSignal` that is aborted the moment the target changes or the dialog
 *    closes, *and* a generation counter, because an abort is not instantaneous — a `fetch` that has
 *    already resolved is not going to be stopped by aborting it, and the `await` after it will run.
 *    Two mechanisms for two different moments, and dropping either one puts the previous subject's
 *    data under the current subject's name.
 *  - **A load is not the only thing with a phase.** A modal's tabs load lazily and fail
 *    independently, so the phase and the failure classification are per-section, not per-modal.
 *  - **Most failures are not faults.** `no-account` is a 503 that means "nobody is signed in right
 *    now", which is a fact about this moment rather than about the thing being looked up, and
 *    `not-found` for a world or a user id out of an old log line is the ordinary end of that
 *    record's life. Both get sentences, not apologies — see `FailureNote`.
 *
 * Each modal keeps its own subject-specific state and its own words. This holds the machinery.
 */

import { describeError, isAbort, isNoAccountOnline, isNotFound, isOffline } from "../api.ts";

/**
 * Where a load is. `idle` is load-bearing rather than a starting value: a lazily-loaded section
 * that was aborted must go back to `idle` and not stay at `loading`, because `idle` is the only
 * state its `ensure…` guard will run from again. A section left at `loading` after an abort is a
 * spinner with no way out of it, which is a bug this codebase has already shipped once.
 */
export type LoadPhase = "idle" | "loading" | "ready" | "error";

/**
 * Why something could not be read.
 *
 * Only `other` is a genuine fault. `no-account` and `not-found` are ordinary outcomes and `offline`
 * is the shell's story, already told at the top of the app — each modal maps these to its own
 * sentences rather than to a shared generic one, because what they mean depends on what was being
 * looked up.
 */
export type LoadFailure = "no-account" | "not-found" | "offline" | "other";

/** The one definition of which HTTP outcome is which failure. */
export function classifyFailure(error: unknown): LoadFailure {
  if (isNoAccountOnline(error)) return "no-account";
  if (isNotFound(error)) return "not-found";
  if (isOffline(error)) return "offline";
  return "other";
}

/**
 * First-wins deduplication by `id`.
 *
 * Every list in a modal is a keyed `{#each}`, and Svelte 5 treats a duplicate key as a **hard
 * runtime error** rather than a warning — the section stops rendering entirely. VRChat can
 * legitimately answer with the same group twice, a paged list can shift under a read and repeat a
 * row, and two endpoints can each contribute the same record. "The server would never send that"
 * is not a safe thing to render on.
 */
export function dedupeById<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
}

/**
 * The base every modal's state class extends.
 *
 * It owns the dialog's open flag, the account the subject was seen through, the primary load's
 * phase, and the abort/generation pair described at the top of this file. Subclasses own their
 * subject, their payload, and their words.
 */
export abstract class EntityModalState {
  open = $state(false);

  /**
   * The account this subject was seen through — a screen's filter, a notification's recipient, an
   * event row's account.
   *
   * It is not bookkeeping: VRChat genuinely answers differently per caller. `GET /users/{id}`
   * returns fewer fields to a non-friend, a group list is filtered by what the asking account may
   * see, and an instance roster is only filled in for the account that created the instance. Which
   * account asks is part of the question.
   */
  accountId = $state<string | null>(null);

  phase = $state<LoadPhase>("idle");
  failure = $state<LoadFailure | null>(null);
  error = $state<string | null>(null);

  /** Aborts everything in flight for the current subject. Replaced on each new load. */
  protected controller: AbortController | null = null;

  /**
   * Bumped on every new load. A resolved response whose generation is stale is dropped rather than
   * rendered — see the note at the top about why the signal alone is not enough.
   */
  protected generation = 0;

  /** The signal to hang follow-up requests — a lazy tab, a "load more" — off. */
  protected get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  /** True while `generation` is still the one this caller started under. */
  protected isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  protected abort(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * Starts a load: aborts the last one, clears the subject-specific state, and takes a fresh
   * generation and signal. Subclasses call this and then fetch.
   */
  protected beginLoad(): { generation: number; signal: AbortSignal } {
    this.abort();
    this.resetPayload();
    this.failure = null;
    this.error = null;
    this.generation += 1;
    const controller = new AbortController();
    this.controller = controller;
    this.phase = "loading";
    return { generation: this.generation, signal: controller.signal };
  }

  /**
   * Records a failed primary load, or does nothing when the load was abandoned.
   *
   * Abandonment is not failure, and the distinction matters twice over: an aborted request must not
   * paint an error over a dialog the user already closed, and a superseded generation owns nothing
   * — `beginLoad` has already reset the new subject's state, so writing here would corrupt it.
   * Returns whether the failure was actually recorded, for callers with more to do.
   */
  protected recordFailure(cause: unknown, generation: number): boolean {
    if (isAbort(cause) || !this.isCurrent(generation)) return false;
    this.failure = classifyFailure(cause);
    this.error = describeError(cause);
    this.phase = "error";
    return true;
  }

  close(): void {
    this.open = false;
    this.abort();
  }

  /** Re-reads everything. The error state's retry button, in every modal. */
  abstract retry(): void;

  /**
   * Clears whatever the subclass is holding about the previous subject.
   *
   * Called before every load, and it must be thorough: anything left behind flashes under the new
   * subject's name for as long as the fetch takes.
   */
  protected abstract resetPayload(): void;
}
