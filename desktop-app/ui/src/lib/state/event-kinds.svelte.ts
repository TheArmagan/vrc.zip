/**
 * The filter vocabulary: which event kinds this database actually holds, and how many of each.
 *
 * Shared because the feed and the game log both build filters out of it, and because it answers a
 * question about the *store* rather than about a screen — two screens counting it separately would
 * be two answers to one question.
 *
 * ## Why it is not derived from the loaded rows
 *
 * The feed's family tabs used to be computed from the page it had just fetched. That reads
 * plausibly and is wrong in a specific, confusing way: a family only got a tab once it happened to
 * appear among the newest rows, and the tab vanished as those rows aged out. So a filter that
 * would have matched two thousand stored events was not offered at all, and one that was offered
 * disappeared while the reader was looking at it.
 *
 * The counts age, and deliberately are not kept live. They are here to say *what is worth
 * filtering by*, and a chip's count being a minute stale changes nothing about that. `refresh()`
 * exists for a screen that wants a fresher number after a retention run.
 */

import { api, EVENT_FAMILIES, type EventFamily, type EventKindCount, familyOf } from "../api.ts";

/** One family, with everything under it. Ordered by `EVENT_FAMILIES`, which is the contract. */
export interface FamilyCount {
  readonly name: EventFamily;
  readonly count: number;
  /** The kinds inside it, commonest first. What a per-kind filter list is drawn from. */
  readonly kinds: readonly EventKindCount[];
}

class EventKindCatalog {
  /** Every kind in the store, commonest first. Empty until the first load lands. */
  kinds = $state<EventKindCount[]>([]);
  loaded = $state(false);

  #inFlight: Promise<void> | null = null;

  /** Families that have at least one stored row, in the app's canonical order. */
  families = $derived.by<FamilyCount[]>(() => {
    const grouped = new Map<string, EventKindCount[]>();
    for (const entry of this.kinds) {
      const family = familyOf(entry.kind);
      const bucket = grouped.get(family);
      if (bucket === undefined) grouped.set(family, [entry]);
      else bucket.push(entry);
    }

    return EVENT_FAMILIES.filter((name) => grouped.has(name)).map((name) => {
      const kinds = grouped.get(name) ?? [];
      return {
        name,
        count: kinds.reduce((total, entry) => total + entry.count, 0),
        kinds,
      };
    });
  });

  /** The kinds under one family, commonest first. Empty for a family with nothing stored. */
  kindsIn(family: EventFamily): readonly EventKindCount[] {
    return this.families.find((entry) => entry.name === family)?.kinds ?? [];
  }

  /**
   * Loads the catalogue once. Safe to call from every screen's mount — concurrent callers share
   * the one request, and a second call after it lands does nothing.
   */
  ensure(): void {
    if (this.loaded || this.#inFlight !== null) return;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = (async () => {
      try {
        this.kinds = await api.eventKinds();
        this.loaded = true;
      } catch {
        // A filter list that failed to load is a screen with fewer filters, not a broken screen.
        // The rows themselves come from a different request and are unaffected, so this stays
        // quiet rather than raising an error banner over a working feed.
      } finally {
        this.#inFlight = null;
      }
    })();
    return this.#inFlight;
  }
}

export const eventKinds = new EventKindCatalog();
