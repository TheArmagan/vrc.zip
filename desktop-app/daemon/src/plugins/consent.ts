/**
 * The plugin consent gesture: what a person is asked, and how their answer reaches the installer.
 *
 * ## Blocking, not queued
 *
 * `POST /api/plugins` parks until this resolves and then returns the outcome — one request, one
 * answer. The alternative, mirroring the third-party app flow, was a persisted pending row the
 * caller polls. That shape exists for apps because *VRChat's own login* drives it: the app is a
 * separate process holding a half-authenticated session, and nobody may be at the keyboard. A
 * plugin install has a human on the other end of the same session, one they started deliberately.
 *
 * The consequence is that a pending request lives in memory and dies with the daemon. That is
 * correct rather than a limitation: a half-answered consent question surviving a restart, and being
 * answered by someone who has forgotten what they were installing, is worse than asking again.
 *
 * ## What the answer may say
 *
 * An approval **narrows** and can never widen. The accounts are chosen from nothing — a grant with
 * no accounts is legal and means a plugin that cannot act as anyone — and the scopes, capabilities
 * and event patterns default to what the manifest asked for, with anything outside that request
 * refused rather than silently ignored. That refusal matters: a UI bug that sent a scope the plugin
 * never asked for would otherwise mint authority nobody requested, and it would look like consent.
 */

import type { PluginManifest } from "@vrcz/plugin-api";

/** How long a request waits for a person before it gives up. */
export const CONSENT_TIMEOUT_MS = 5 * 60_000;

/** One plugin waiting to be approved, as the consent sheet renders it. */
export interface PendingPluginConsent {
  readonly id: string;
  /** The manifest **as parsed at install**, so the sheet shows what was actually accepted. */
  readonly manifest: PluginManifest;
  /** Whether a grant already exists for this exact (plugin, version, hash) — an update or a repeat. */
  readonly isUpdate: boolean;
  /** Scopes this version asks for that the previous grant did not have. Empty on a first install. */
  readonly newScopes: readonly string[];
  readonly requestedAt: number;
  /** Where it is being installed from, shown so "which copy is this" has an answer. */
  readonly source: string;
}

/** What the user chose. Every field narrows the manifest's request; none may exceed it. */
export interface ConsentApproval {
  readonly accountIds: readonly string[];
  /** Defaults to everything the manifest asked for. Anything outside that request is refused. */
  readonly scopes?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly events?: readonly string[];
}

export type ConsentOutcome =
  | { readonly ok: true; readonly approval: ConsentApproval }
  | { readonly ok: false; readonly reason: "denied" | "timeout" | "shutdown" };

interface Waiting {
  readonly pending: PendingPluginConsent;
  readonly settle: (outcome: ConsentOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ConsentBrokerOptions {
  readonly timeoutMs?: number;
  /** Raised when a request appears, so the UI can open the sheet or the OS can be notified. */
  readonly onPending?: (pending: PendingPluginConsent) => void;
  readonly now?: () => number;
}

/**
 * Holds the questions that are currently being asked.
 *
 * One per daemon, owned by `wiring/plugin-host.ts`. It knows nothing about HTTP, the store, or the
 * installer — it is the rendezvous between "something wants approval" and "a person answered".
 */
export class PluginConsentBroker {
  readonly #waiting = new Map<string, Waiting>();
  readonly #timeoutMs: number;
  readonly #onPending: ((pending: PendingPluginConsent) => void) | undefined;
  readonly #now: () => number;
  #nextId = 1;

  constructor(options: ConsentBrokerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? CONSENT_TIMEOUT_MS;
    this.#onPending = options.onPending;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Everything currently waiting, oldest first. The sheet's list. */
  pending(): PendingPluginConsent[] {
    return [...this.#waiting.values()]
      .map((entry) => entry.pending)
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /**
   * Asks, and resolves when someone answers or the request times out.
   *
   * Never rejects. A consent question that throws would have to be caught by the installer and
   * turned back into a denial, and a missed `catch` there would be an install that proceeded
   * because asking failed.
   */
  ask(request: Omit<PendingPluginConsent, "id" | "requestedAt">): Promise<ConsentOutcome> {
    const id = `pc${this.#nextId}`;
    this.#nextId += 1;
    const pending: PendingPluginConsent = { ...request, id, requestedAt: this.#now() };

    return new Promise<ConsentOutcome>((resolve) => {
      const settle = (outcome: ConsentOutcome): void => {
        const entry = this.#waiting.get(id);
        if (entry === undefined) return;
        this.#waiting.delete(id);
        clearTimeout(entry.timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        settle({ ok: false, reason: "timeout" });
      }, this.#timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      this.#waiting.set(id, { pending, settle, timer });
      try {
        this.#onPending?.(pending);
      } catch {
        // A notification that throws must not take the request with it. The sheet can still be
        // reached by listing pending requests.
      }
    });
  }

  /** True if the id was still waiting. False means it timed out, or was already answered. */
  approve(id: string, approval: ConsentApproval): boolean {
    const entry = this.#waiting.get(id);
    if (entry === undefined) return false;
    entry.settle({ ok: true, approval });
    return true;
  }

  deny(id: string): boolean {
    const entry = this.#waiting.get(id);
    if (entry === undefined) return false;
    entry.settle({ ok: false, reason: "denied" });
    return true;
  }

  /**
   * Fails every waiting request. Called on shutdown.
   *
   * Denial rather than approval is the only defensible default here, and it is worth saying why it
   * is not even a close call: an unanswered question is not a yes.
   */
  shutdown(): void {
    for (const id of [...this.#waiting.keys()]) {
      this.#waiting.get(id)?.settle({ ok: false, reason: "shutdown" });
    }
  }
}

/**
 * Applies an approval to a manifest, refusing anything the manifest did not ask for.
 *
 * The narrowing rule in one function, so the installer cannot express a widening grant even by
 * mistake. Returns the exact lists to store.
 */
export function narrowToRequest(
  manifest: PluginManifest,
  approval: ConsentApproval,
): {
  readonly scopes: string[];
  readonly capabilities: string[];
  readonly events: string[];
  readonly accountIds: string[];
} {
  const requested = manifest.permissions;
  const keep = (asked: readonly string[], chosen: readonly string[] | undefined): string[] =>
    chosen === undefined ? [...asked] : asked.filter((value) => chosen.includes(value));

  return {
    scopes: keep(requested.scopes, approval.scopes),
    capabilities: keep(requested.capabilities, approval.capabilities),
    events: keep(requested.events, approval.events),
    // Accounts are the one list with nothing to narrow *against* — the manifest asks for "one" or
    // "many", never for named accounts, because an author cannot know the user's account ids. The
    // caller's list is taken as given and de-duplicated.
    accountIds: [...new Set(approval.accountIds)],
  };
}
