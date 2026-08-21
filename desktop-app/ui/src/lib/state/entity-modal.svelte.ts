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
 *
 * ## The three are one screen, and it has history
 *
 * They are separate singletons but they are not separate *places*. Opening a group from inside a
 * profile used to leave the profile mounted and open underneath it, so two dialogs stacked, two
 * scrims doubled up into near-black, and the X closed the top one onto a profile the reader had
 * already navigated away from. Three peers with no relationship between them is the wrong model
 * for what is plainly one drill-down.
 *
 * So the three share one screen and a back stack. Opening anything sets aside whatever was showing
 * and pushes a way back to it; every close gesture — the X, Escape, a click outside — pops one
 * level and puts that subject back, and closing the last level dismisses. This is browser history,
 * not window management, which is why `close()` is also the back button: there is one control
 * because there is one thing it can mean.
 *
 * Coming back is usually free. A modal that was suspended rather than re-targeted still holds its
 * subject, so its own `open…` guard recognises it and keeps what is already loaded. Only a chain
 * through the *same* modal — profile to profile through mutual friends — has to re-read, because
 * a singleton cannot hold two subjects at once.
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
 * A subject set aside, and how to come back to it.
 *
 * `restore` is a closure over the subject as it was, built before the modal is re-targeted —
 * capturing the values rather than reading them back later, because by then the singleton is
 * holding somebody else.
 */
export interface ResumePoint {
  /** What to call the destination on the back control. The subject's own title. */
  readonly label: string;
  readonly restore: () => void;
}

/**
 * The back stack, newest last.
 *
 * `$state` because the header reads the top of it to label its back control — see `modalBack`.
 */
const suspended = $state<ResumePoint[]>([]);

/**
 * Which modal owns the screen, or null when none does.
 *
 * Deliberately not `$state`: nothing renders it. It exists so that opening any modal can set aside
 * whichever of the three was showing without the three needing to know about each other.
 */
let active: EntityModalState | null = null;

/**
 * How deep the stack may go.
 *
 * A drill-down of any honest depth is far below this; the cap is here because the chain is driven
 * by clicks and nothing else bounds it — a profile names a group whose owner is a profile — and an
 * unbounded array of closures over abandoned subjects is a leak with a long fuse. Overflow drops
 * the *oldest* entry, so the levels nearest the reader are the ones that survive.
 */
const MAX_DEPTH = 16;

/**
 * Where a close gesture would land, or null when it would dismiss.
 *
 * Reactive: call it inside a `$derived`. The header uses it to name the back control, which is what
 * makes the stack legible — a close that reopens something is a bug unless the reader was told
 * where it goes.
 */
export function modalBack(): ResumePoint | null {
  return suspended.at(-1) ?? null;
}

/**
 * The base every modal's state class extends.
 *
 * It owns the dialog's open flag, the account the subject was seen through, the primary load's
 * phase, the abort/generation pair described at the top of this file, and this modal's place in
 * the shared back stack. Subclasses own their subject, their payload, and their words.
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

  /**
   * Hands the screen to this modal, setting aside whatever was on it.
   *
   * **Call it first, before overwriting the subject.** The resume point is built out of what the
   * outgoing modal is holding *now*, and the outgoing modal is frequently this one — a profile
   * opening another profile — so a single assignment ahead of this call is a back button that
   * returns to where the reader already is.
   *
   * `changing` is false when the caller is re-opening the subject already on screen, which is not
   * navigation and must not push anything: `openUser(sameUser)` from three different rows would
   * otherwise build three levels of stack that all lead to the current page.
   */
  protected takeScreen(changing: boolean): void {
    if (changing && active !== null) {
      const point = active.suspend();
      if (point !== null) {
        suspended.push(point);
        if (suspended.length > MAX_DEPTH) suspended.shift();
      }
    }
    active = this;
    this.open = true;
  }

  /**
   * Takes this modal off the screen without dismissing it, and says how to come back.
   *
   * The in-flight load is aborted: nothing about it is visible any more, and if the reader does
   * come back, `restore` re-enters through the ordinary `open…` path. When the subject was never
   * re-targeted that path recognises it and keeps what is already loaded, so a step back is
   * usually free — see the note at the top of this file.
   *
   * Setting `open` false here and true again in the same `takeScreen` call is deliberate for the
   * same-modal case: Svelte batches the pair, so the dialog never sees the closed frame and the
   * subject swaps in place rather than the whole dialog animating out and back in.
   */
  private suspend(): ResumePoint | null {
    this.open = false;
    this.abort();
    return this.resumePoint();
  }

  /**
   * Closes the dialog, or steps back one level when there is one.
   *
   * This is every close gesture and the back control both, because they are the same action — see
   * the note at the top of this file about there being one screen rather than three.
   */
  close(): void {
    this.open = false;
    this.abort();
    if (active === this) active = null;
    const previous = suspended.pop();
    // `restore` re-enters `open…`, which calls `takeScreen`. `active` is null by now, so nothing
    // is pushed and the level just popped does not come straight back.
    previous?.restore();
  }

  /**
   * Empties the stack and closes. Nothing in the UI calls this yet; it is what a route change or a
   * sign-out should use, because those invalidate every level rather than one.
   */
  dismiss(): void {
    suspended.length = 0;
    this.close();
  }

  /** Re-reads everything. The error state's retry button, in every modal. */
  abstract retry(): void;

  /**
   * How to come back to what this modal is showing right now, and what to call it.
   *
   * Null when there is nothing worth returning to — no subject yet, which is the state before the
   * first open. Subclasses capture their subject **by value**: the closure runs after the singleton
   * has been re-targeted, so anything it reads off `this` at call time is the wrong subject.
   */
  protected abstract resumePoint(): ResumePoint | null;

  /**
   * Clears whatever the subclass is holding about the previous subject.
   *
   * Called before every load, and it must be thorough: anything left behind flashes under the new
   * subject's name for as long as the fetch takes.
   */
  protected abstract resetPayload(): void;
}
