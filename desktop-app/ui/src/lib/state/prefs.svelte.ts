/**
 * Browser-local preferences.
 *
 * Deliberately not daemon settings. Which event families raise a desktop toast, and how dense the
 * feed is, are properties of *this browser on this machine* — a second window on a second machine
 * should be free to disagree, and none of it is worth a round trip. Daemon settings are the ones
 * the daemon itself acts on (contact string, ports, log directories).
 */

import { familyOf } from "../api.ts";

const KEY = "vrcz.prefs";

interface StoredPrefs {
  notifyFamilies?: string[];
  denseFeed?: boolean;
}

/** Friend presence and inbound notifications are the two things worth interrupting someone for. */
const DEFAULT_FAMILIES = ["friend", "notification"];

function read(): StoredPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as StoredPrefs) : {};
  } catch {
    return {};
  }
}

class Prefs {
  #notifyFamilies = $state<string[]>([]);
  #denseFeed = $state(false);

  constructor() {
    const stored = read();
    this.#notifyFamilies = stored.notifyFamilies ?? [...DEFAULT_FAMILIES];
    this.#denseFeed = stored.denseFeed ?? false;
  }

  get notifyFamilies(): readonly string[] {
    return this.#notifyFamilies;
  }

  get denseFeed(): boolean {
    return this.#denseFeed;
  }

  setDenseFeed(dense: boolean): void {
    this.#denseFeed = dense;
    this.#persist();
  }

  isNotifyFamily(family: string): boolean {
    return this.#notifyFamilies.includes(family);
  }

  toggleNotifyFamily(family: string): void {
    this.#notifyFamilies = this.#notifyFamilies.includes(family)
      ? this.#notifyFamilies.filter((entry) => entry !== family)
      : [...this.#notifyFamilies, family];
    this.#persist();
  }

  /** The predicate `notifyForEvent` takes: a full dotted kind in, a yes/no out. */
  shouldNotify = (kind: string): boolean => this.#notifyFamilies.includes(familyOf(kind));

  #persist(): void {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ notifyFamilies: this.#notifyFamilies, denseFeed: this.#denseFeed }),
      );
    } catch {
      /* private mode — the in-memory value still holds for this session */
    }
  }
}

export const prefs = new Prefs();
