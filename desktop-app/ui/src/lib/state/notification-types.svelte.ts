/**
 * The inbox's filter vocabulary: which notification types this database holds, and how many of
 * each. The notification counterpart of `event-kinds.svelte.ts`, and the same argument.
 *
 * Counting the loaded page instead would offer a type only while it happened to be among the
 * newest rows and withdraw it as they aged out — so a filter matching two hundred stored
 * notifications might not be offered at all.
 */

import { api, type NotificationTypeCount } from "../api.ts";

class NotificationTypeCatalog {
  /** Every type in the store, commonest first. Empty until the first load lands. */
  types = $state<NotificationTypeCount[]>([]);
  loaded = $state(false);

  #inFlight: Promise<void> | null = null;

  /** Loads once. Concurrent callers share the request; a later call does nothing. */
  ensure(): void {
    if (this.loaded || this.#inFlight !== null) return;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = (async () => {
      try {
        this.types = await api.notifications.types();
        this.loaded = true;
      } catch {
        // A filter list that failed to load is a screen with fewer filters, not a broken screen.
        // The rows come from a different request and are unaffected.
      } finally {
        this.#inFlight = null;
      }
    })();
    return this.#inFlight;
  }
}

export const notificationTypes = new NotificationTypeCatalog();
