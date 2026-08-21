/**
 * Pending consent — the pairing-code flow. PLAN.md §Phase 2 "Pending consent".
 *
 * Consent is asynchronous and the proxy is not: a login arrives, the user may be AFK, and the app
 * needs an answer now. VRChat's own 2FA mechanism is the channel. The app is told
 * `{"requiresTwoFactorAuth":["totp"]}`, prompts its own user for a code exactly as it would against
 * real VRChat, and the user reads that code off the vrc.zip consent sheet. **Typing the code is the
 * consent gesture** — it proves the person operating the app is the person at the vrc.zip UI.
 *
 * The durable record lives in `pairing_requests`; this registry holds the part that must not be
 * durable. **The plaintext code is in memory only.** The store keeps its hash, for the same reason
 * grant tokens are hashed: a six-digit code sitting in a readable table is a bypass of the whole
 * gesture. A daemon restart therefore drops every pending code, which is correct — they expire in
 * minutes anyway, and an app that was mid-pairing simply logs in again.
 */

import type { Scope } from "@vrcz/shared";
import type { EventBus } from "../bus/event-bus.ts";
import {
  hashProxyToken,
  mintPairingCode,
  mintProxyToken,
  secretsMatch,
} from "../security/proxy-tokens.ts";
import type { Store } from "../store/store.ts";
import type { AppIdentity } from "./identity.ts";

/** How long a pairing code stays live. Long enough to walk to the other screen, not much longer. */
export const PAIRING_TTL_MS = 5 * 60_000;

/**
 * Wrong codes tolerated per app identity per window before pairing is refused outright.
 *
 * Six digits is twenty bits, which is only safe with a brake on it. The window is the TTL rather
 * than something longer, so an app that is merely being retried by a confused user recovers on its
 * own instead of needing a restart.
 */
export const MAX_PAIRING_ATTEMPTS = 8;

/** A pending consent request, as the UI renders it. Carries the plaintext code. */
export interface PendingConsent {
  readonly id: string;
  /** Null while the user still has to pick an account, or add the one the app named. */
  readonly accountId: string | null;
  /** What the app put in the username field, shown verbatim so the user recognises it. */
  readonly requestedUsername: string;
  readonly app: AppIdentity;
  /** Everything the app asked for. */
  readonly scopes: readonly Scope[];
  /**
   * The scopes it does not already hold. On a first grant this equals `scopes`; on an escalation it
   * is the delta, and the delta is all the sheet shows — re-listing what the user already approved
   * makes the new ask harder to see, not easier.
   */
  readonly newScopes: readonly Scope[];
  /** Six digits. Never persisted. */
  readonly code: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** What `open()` hands back to the handshake. */
export interface OpenedConsent {
  readonly pending: PendingConsent;
  /** The half-authenticated `auth` cookie value to return with the 2FA challenge. */
  readonly halfToken: string;
}

export interface ConsentRegistryOptions {
  readonly store: Store;
  readonly bus?: EventBus | undefined;
  readonly now?: (() => number) | undefined;
  readonly ttlMs?: number | undefined;
  /** Injected so a test can assert against a known code rather than fishing one out of the log. */
  readonly mintCode?: (() => { token: string; hash: string }) | undefined;
}

/** Why a pairing attempt failed. `wrong-code` is the only one the app is told apart from success. */
export type PairingFailure = "unknown" | "expired" | "wrong-code" | "no-account" | "rate-limited";

export type PairingResult =
  | { readonly ok: true; readonly pending: PendingConsent }
  | { readonly ok: false; readonly reason: PairingFailure };

export class ConsentRegistry {
  readonly #store: Store;
  readonly #bus: EventBus | undefined;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #mintCode: () => { token: string; hash: string };

  /** Pending requests by id. The plaintext code lives here and nowhere else. */
  readonly #pending = new Map<string, PendingConsent>();
  /** Half-token hash → request id, so a login's cookie finds its sheet in one step. */
  readonly #byHalfToken = new Map<string, string>();

  constructor(options: ConsentRegistryOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? PAIRING_TTL_MS;
    this.#mintCode = options.mintCode ?? (() => mintPairingCode());
  }

  /** Everything currently awaiting the user, newest last. Expired entries are swept first. */
  list(): PendingConsent[] {
    this.sweep();
    return [...this.#pending.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): PendingConsent | null {
    this.sweep();
    return this.#pending.get(id) ?? null;
  }

  /**
   * Raises a consent sheet and returns the half-authenticated cookie for the 2FA challenge.
   *
   * `accountId` may be null: the app used the reserved "let the user choose" username, or named an
   * account vrc.zip does not manage yet. Both are normal — the request is real before there is an
   * account to point it at, and the sheet is where that gets resolved.
   */
  open(request: {
    accountId: string | null;
    requestedUsername: string;
    app: AppIdentity;
    scopes: readonly Scope[];
    newScopes: readonly Scope[];
  }): OpenedConsent {
    const now = this.#now();
    const id = crypto.randomUUID();
    const half = mintProxyToken();
    const code = this.#mintCode();

    this.#store.insertPairingRequest({
      id,
      account_id: request.accountId,
      requested_username: request.requestedUsername,
      app_name: request.app.name,
      app_version: request.app.version,
      app_contact: request.app.contact,
      scopes: JSON.stringify(request.scopes),
      half_token_hash: half.hash,
      code_hash: code.hash,
      created_at: now,
      expires_at: now + this.#ttlMs,
    });

    const pending: PendingConsent = {
      id,
      accountId: request.accountId,
      requestedUsername: request.requestedUsername,
      app: request.app,
      scopes: [...request.scopes],
      newScopes: [...request.newScopes],
      code: code.token,
      createdAt: now,
      expiresAt: now + this.#ttlMs,
    };
    this.#pending.set(id, pending);
    this.#byHalfToken.set(half.hash, id);

    // The UI is a subscriber like anything else. A consent sheet that only appeared because some
    // screen happened to be polling would miss the case the flow exists for: the user is elsewhere.
    this.#bus?.emit({
      kind: "consent.pending",
      accountId: request.accountId,
      ts: now,
      subjectId: id,
      payload: {
        id,
        app: { ...request.app },
        scopes: [...request.scopes],
        newScopes: [...request.newScopes],
        requestedUsername: request.requestedUsername,
      },
    });

    return { pending, halfToken: half.token };
  }

  /** The pending request a half-authenticated cookie belongs to, or null. */
  byHalfToken(halfToken: string): PendingConsent | null {
    this.sweep();
    const id = this.#byHalfToken.get(hashProxyToken(halfToken));
    return id === undefined ? null : (this.#pending.get(id) ?? null);
  }

  /**
   * The user picked an account at the sheet, or added the one the app named.
   *
   * Until this lands, a correct code is still refused: the code is only *shown* once there is an
   * account for it to authorise, and pairing to nothing would either fail later or — much worse —
   * pick an account on the user's behalf.
   */
  attachAccount(id: string, accountId: string): boolean {
    const pending = this.#pending.get(id);
    if (pending === undefined) return false;
    this.#pending.set(id, { ...pending, accountId });
    this.#store.setPairingAccount(id, accountId);
    return true;
  }

  /**
   * Checks a code typed into the app.
   *
   * Wrong codes are counted per app identity, not per request, so an app cannot buy itself more
   * guesses by opening fresh logins. A rate-limited app gets the same `verified: false` an app with
   * a wrong code gets — telling it apart would tell a brute-forcer exactly when to back off.
   */
  verify(halfToken: string, code: string): PairingResult {
    this.sweep();
    const pending = this.byHalfToken(halfToken);
    if (pending === null) return { ok: false, reason: "unknown" };

    const now = this.#now();
    if (pending.expiresAt <= now) {
      this.#resolve(pending.id, "expired", null);
      return { ok: false, reason: "expired" };
    }

    const attempts = this.#store.countPairingAttempts(
      pending.app.name,
      pending.app.contact,
      now - this.#ttlMs,
    );
    if (attempts >= MAX_PAIRING_ATTEMPTS) return { ok: false, reason: "rate-limited" };

    if (!secretsMatch(code.trim(), pending.code)) {
      this.#store.bumpPairingAttempts(pending.id);
      return { ok: false, reason: "wrong-code" };
    }

    if (pending.accountId === null) return { ok: false, reason: "no-account" };
    return { ok: true, pending };
  }

  /** Marks an approved request done and ties it to the grant it became. Single-use from here on. */
  approve(id: string, grantId: string): void {
    this.#resolve(id, "approved", grantId);
  }

  /** The user said no at the sheet. */
  deny(id: string): boolean {
    const existed = this.#pending.has(id);
    this.#resolve(id, "denied", null);
    return existed;
  }

  /** Drops lapsed requests from memory and marks them expired in the store. */
  sweep(): void {
    const now = this.#now();
    for (const [id, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#resolve(id, "expired", null);
    }
  }

  #resolve(id: string, outcome: "approved" | "denied" | "expired", grantId: string | null): void {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    for (const [hash, mapped] of this.#byHalfToken) {
      if (mapped === id) this.#byHalfToken.delete(hash);
    }
    this.#store.resolvePairing(id, this.#now(), outcome, grantId);

    if (pending !== undefined) {
      this.#bus?.emit({
        kind: "consent.resolved",
        accountId: pending.accountId,
        ts: this.#now(),
        subjectId: id,
        payload: { id, outcome, grantId },
      });
    }
  }
}
