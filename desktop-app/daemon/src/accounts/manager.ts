import type { CurrentUser, TwoFactorAuthType } from "@vrcz/api/types";
import type { EventBus } from "../bus/event-bus.ts";
import type { RateLimiter } from "../net/rate-limiter.ts";
import type { RequestMeter } from "../net/request-meter.ts";
import type { SecretsStore } from "../security/secrets.ts";
import { Account, type AccountDeps, type AccountSnapshot } from "./account.ts";
import { AuthError, type LoginResult } from "./auth.ts";

/**
 * Owns every `Account`. See PLAN.md §Architecture.
 *
 * Multiple accounts are the normal case, not a mode — there is no "current account" here. The UI
 * has a selection; the daemon keeps all of them live and equal.
 */

export interface AccountManagerDeps {
  readonly secrets: SecretsStore;
  readonly limiter: RateLimiter;
  readonly bus: EventBus;
  readonly userAgent: string;
  readonly baseUrl?: string;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Counts what every account spends. See `net/request-meter.ts`. */
  readonly meter?: RequestMeter | undefined;
}

/** Ids for accounts added but not yet successfully logged in, before VRChat tells us the real one. */
let pendingCounter = 0;
function nextPendingId(): string {
  pendingCounter += 1;
  return `pending-${String(pendingCounter)}-${Date.now().toString(36)}`;
}

export class AccountManager {
  readonly #accounts = new Map<string, Account>();

  constructor(private readonly deps: AccountManagerDeps) {}

  /**
   * Loads every stored account and resumes it from cookies.
   *
   * Resumes run **concurrently** — they are independent accounts, and the rate limiter is what
   * paces them. Serializing would make startup scale linearly with account count for no benefit.
   * A failure is recorded on the account, not thrown: one bad account must not stop the daemon.
   */
  async loadAll(): Promise<void> {
    const ids = this.deps.secrets.accountIds();

    await Promise.all(
      ids.map(async (id) => {
        const secret = this.deps.secrets.get(id);
        if (!secret) return;

        const account = new Account(id, secret, this.#accountDeps());
        this.#accounts.set(id, account);

        await account.resume();
        await this.#rekeyIfNeeded(id, account);
        this.#announceReady(account);
      }),
    );
  }

  list(): AccountSnapshot[] {
    return [...this.#accounts.values()].map((account) => account.snapshot());
  }

  get(id: string): Account | undefined {
    return this.#accounts.get(id);
  }

  /** Resolves by VRChat user id or by login username. The proxy's account selector needs both. */
  resolve(identifier: string): Account | undefined {
    const byId = this.#accounts.get(identifier);
    if (byId) return byId;

    const lowered = identifier.toLowerCase();
    for (const account of this.#accounts.values()) {
      if (account.username.toLowerCase() === lowered) return account;
      if (account.user?.displayName.toLowerCase() === lowered) return account;
    }
    return undefined;
  }

  /**
   * Adds an account and logs it in.
   *
   * The account is registered under a pending id first, so that a login which stops at 2FA is still
   * addressable — the verify call needs to find it, and it carries the pre-2FA auth cookie.
   */
  async add(
    username: string,
    password: string,
  ): Promise<{ result: LoginResult; account: Account }> {
    const existing = this.resolve(username);
    if (existing) {
      const result = await existing.login(password);
      await this.#rekeyIfNeeded(existing.id, existing);
      this.#announceReady(existing);
      return { result, account: existing };
    }

    const id = nextPendingId();
    const account = new Account(id, { username, cookies: [] }, this.#accountDeps());
    this.#accounts.set(id, account);

    try {
      const result = await account.login(password);
      await this.#rekeyIfNeeded(id, account);
      this.#announceReady(account);
      return { result, account };
    } catch (error) {
      // Don't leave a half-added account behind for a wrong password — the UI would show a broken
      // row the user can't act on. A 2FA prompt is not an error and does not reach here.
      this.#accounts.delete(id);
      await this.deps.secrets.remove(id).catch(() => undefined);
      throw error;
    }
  }

  async verifyTwoFactor(
    accountId: string,
    method: TwoFactorAuthType,
    code: string,
  ): Promise<CurrentUser> {
    const account = this.#accounts.get(accountId);
    if (!account) throw new AuthError(`No account ${accountId}.`);

    const user = await account.verifyTwoFactor(method, code);
    await this.#rekeyIfNeeded(accountId, account);
    this.#announceReady(account);
    return user;
  }

  /** Removes an account: signs it out upstream, then forgets its credentials locally. */
  async remove(id: string): Promise<void> {
    const account = this.#accounts.get(id);
    if (!account) return;

    await account.signOut();
    this.#accounts.delete(id);
    await this.deps.secrets.remove(id);
    this.deps.bus.emit({ kind: "account.removed", accountId: id, ts: Date.now() });
  }

  /**
   * Marks every account offline without logging out.
   *
   * Cookies survive, so the next start resumes instead of re-authenticating. PLAN.md §Guardrails.
   */
  shutdown(): void {
    for (const account of this.#accounts.values()) account.goOffline();
  }

  #accountDeps(): AccountDeps {
    const deps: AccountDeps = {
      limiter: this.deps.limiter,
      userAgent: this.deps.userAgent,
      bus: this.deps.bus,
      onSecretChanged: async (id, secret) => {
        await this.deps.secrets.put(id, secret);
      },
      ...(this.deps.baseUrl !== undefined ? { baseUrl: this.deps.baseUrl } : {}),
      ...(this.deps.fetch !== undefined ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.meter !== undefined ? { meter: this.deps.meter } : {}),
    };
    return deps;
  }

  /**
   * Announces that an account is fully registered under its real id **and** online.
   *
   * This is a different fact from `account.state`, and the difference is load-bearing. `Account`
   * emits `account.state` from inside `login()`, at which point the manager still has it filed
   * under its pending id — so a subscriber that reacts by calling `accounts.get(realId)` gets
   * `undefined` and silently does nothing. Only the manager knows when the rekey has landed, so
   * only the manager can emit this.
   */
  #announceReady(account: Account): void {
    if (account.state !== "online") return;
    this.deps.bus.emit({
      kind: "account.ready",
      accountId: account.id,
      ts: Date.now(),
      payload: account.snapshot(),
    });
  }

  /**
   * Moves an account from its pending id to the real `usr_…` once VRChat has told us what it is.
   *
   * Doing this eagerly matters: the id is the key for events, sessions, and grants, and a row keyed
   * `pending-3-abc` that later becomes `usr_…` would orphan everything written in between.
   */
  async #rekeyIfNeeded(previousId: string, account: Account): Promise<void> {
    if (account.id === previousId) return;

    this.#accounts.delete(previousId);

    const alreadyPresent = this.#accounts.get(account.id);
    if (alreadyPresent && alreadyPresent !== account) {
      // The same VRChat account was added twice under different usernames (id vs email). Keep the
      // established instance and drop the duplicate rather than clobbering live state.
      await this.deps.secrets.remove(previousId).catch(() => undefined);
      return;
    }

    this.#accounts.set(account.id, account);

    // Write the live account's own state under the new id, then drop the old row.
    //
    // Deliberately NOT `secrets.rename`: the pending row is a *stale snapshot* taken before the
    // login finished. A 2FA login persists twice — once pre-2FA under the pending id, once after
    // verify under the real id — and renaming would move the older row over the newer one,
    // silently discarding the twoFactorAuth cookie and re-prompting for 2FA on every restart.
    // The in-memory account is always the freshest truth.
    await this.deps.secrets.put(account.id, account.toSecret());
    if (previousId !== account.id) {
      await this.deps.secrets.remove(previousId).catch(() => undefined);
    }
  }
}
