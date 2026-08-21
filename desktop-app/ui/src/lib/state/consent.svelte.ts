/**
 * Pending consent requests, as the sheet reads them.
 *
 * Deliberately its own state module rather than a field on `app`: this is the only surface in the
 * UI that holds a live credential-adjacent secret (the pairing code), and keeping it separate makes
 * "who can see a code" a question with a one-file answer.
 *
 * The list is refreshed from the control API on a `consent.pending` frame rather than being built
 * out of that frame, because **the frame deliberately carries no code** — the stream fans out to
 * every client and, later, to plugins, while the code belongs only behind the session token.
 */

import { api, type PendingConsent } from "../api.ts";

/** A request whose clock has run out is gone, not merely stale. */
function isLive(request: PendingConsent, now: number): boolean {
  return request.expiresAt > now;
}

class ConsentState {
  /** Everything waiting on the user, oldest first. */
  pending = $state<PendingConsent[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);

  /** How many are live right now. Drives the sidebar badge. */
  count = $derived(this.pending.length);

  #inFlight: AbortController | null = null;

  async refresh(): Promise<void> {
    // One at a time. A burst of logins from one app would otherwise fire a request per frame, and
    // the last answer to arrive — not the newest — would win.
    this.#inFlight?.abort();
    const controller = new AbortController();
    this.#inFlight = controller;

    this.loading = true;
    try {
      const list = await api.consent.list(controller.signal);
      if (controller.signal.aborted) return;
      this.pending = list.filter((request) => isLive(request, Date.now()));
      this.error = null;
    } catch (error) {
      if (controller.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.#inFlight === controller) {
        this.#inFlight = null;
        this.loading = false;
      }
    }
  }

  get(id: string | null): PendingConsent | null {
    if (id === null) return null;
    return this.pending.find((request) => request.id === id) ?? null;
  }

  /** The user picked an account for a request that arrived without one. */
  async setAccount(pairingId: string, accountId: string): Promise<void> {
    const updated = await api.consent.setAccount(pairingId, accountId);
    this.pending = this.pending.map((request) => (request.id === pairingId ? updated : request));
  }

  async deny(pairingId: string): Promise<void> {
    await api.consent.deny(pairingId);
    // Removed locally rather than waiting for a refresh: the button has to feel final, and the
    // daemon's answer for a denied request is that it no longer exists anyway.
    this.pending = this.pending.filter((request) => request.id !== pairingId);
  }

  /** Drops anything whose code has expired. Called from a ticking effect on the screen. */
  sweep(now = Date.now()): void {
    const live = this.pending.filter((request) => isLive(request, now));
    if (live.length !== this.pending.length) this.pending = live;
  }
}

export const consent = new ConsentState();
