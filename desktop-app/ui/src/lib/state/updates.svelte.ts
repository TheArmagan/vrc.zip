/**
 * Whether a newer vrc.zip exists, and the one button that does something about it.
 *
 * The daemon owns the question — it asks GitHub every six hours and remembers the answer — so this
 * is a reader, not a checker. That split is why the banner can paint on the first frame of a cold
 * tab: `GET /api/update` is a local read of something already known, not a round trip to GitHub.
 *
 * Polled rather than pushed. A release is not an event: it does not need a stream frame, a feed row
 * or a retention window, and half an hour of latency on news that is already up to six hours old
 * costs nothing. The poll exists only so a tab left open for a day eventually notices.
 */

import { api, type UpdateStatus } from "$lib/api.ts";

/** Half an hour. Slower than the daemon's own check, because this is only reading its answer. */
const POLL_MS = 30 * 60 * 1000;

class UpdateState {
  #status = $state<UpdateStatus | null>(null);
  /**
   * The version the user closed the banner on.
   *
   * Deliberately not persisted. Dismissing says "not now", and a tab reopened tomorrow is a new
   * "now" — where a stored dismissal would mean somebody who closed one banner never hears about
   * that release again, which is how an app ends up several versions behind in silence.
   */
  #dismissed = $state<string | null>(null);
  #busy = $state(false);
  /** Set once the swap is done, so the banner can explain the daemon it is about to lose. */
  #restarting = $state(false);
  #failure = $state<string | null>(null);
  #timer: ReturnType<typeof setInterval> | null = null;

  get status(): UpdateStatus | null {
    return this.#status;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get restarting(): boolean {
    return this.#restarting;
  }

  /** The last install or check failure, for the banner to show in place of the offer. */
  get failure(): string | null {
    return this.#failure;
  }

  /** True when there is news the user has not closed. The banner renders on exactly this. */
  readonly visible = $derived(
    this.#restarting ||
      (this.#status?.available === true &&
        this.#status.latest !== null &&
        this.#status.latest !== this.#dismissed),
  );

  start(): () => void {
    void this.refresh();
    this.#timer ??= setInterval(() => {
      void this.refresh();
    }, POLL_MS);
    return () => {
      if (this.#timer !== null) clearInterval(this.#timer);
      this.#timer = null;
    };
  }

  async refresh(): Promise<void> {
    try {
      this.#status = await api.updates.get();
    } catch {
      // A daemon that cannot be reached is already the offline screen's business. An update banner
      // is the last thing that should be reporting the connection.
    }
  }

  /** The "check now" affordance on the settings screen. Failures are shown, not swallowed. */
  async check(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#failure = null;
    try {
      this.#status = await api.updates.check();
      // The daemon's own message, which says whether GitHub was unreachable or rate limiting.
      if (this.#status.error !== null) this.#failure = this.#status.error;
    } catch (error) {
      this.#failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Downloads the release, replaces the executable and restarts the daemon.
   *
   * The reply arrives *before* the restart, which is the only reason this can report anything at
   * all: a moment later there is no daemon on the other end of this page. Nothing here reloads the
   * window, and that is deliberate — the new daemon mints a new session token and opens its own
   * browser tab, so a reload of this one would only land on a page that cannot authenticate.
   */
  async install(): Promise<void> {
    if (this.#busy || this.#restarting) return;
    this.#busy = true;
    this.#failure = null;
    try {
      const result = await api.updates.install();
      if (result.ok && result.restarting) this.#restarting = true;
      else this.#failure = result.reason ?? "The update could not be installed.";
    } catch (error) {
      this.#failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.#busy = false;
    }
  }

  dismiss(): void {
    this.#dismissed = this.#status?.latest ?? null;
  }
}

export const updates = new UpdateState();
