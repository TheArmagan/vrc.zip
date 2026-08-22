import type { CurrentUser, TwoFactorAuthType } from "@vrcz/api/types";
import type { EventBus } from "../bus/event-bus.ts";
import type { RateLimiter } from "../net/rate-limiter.ts";
import type { RequestContext } from "../net/request.ts";
import { vrcFetch } from "../net/request.ts";
import type { RequestMeter } from "../net/request-meter.ts";
import { pickUserImageUrl } from "../net/user-image.ts";
import type { AccountSecret } from "../security/secrets.ts";
import {
  AuthError,
  fetchCurrentUser,
  type LoginResult,
  loginWithPassword,
  resumeFromCookies,
  verifyTwoFactor,
} from "./auth.ts";
import { CookieJar } from "./cookie-jar.ts";

/**
 * One VRChat account: its cookie jar, its request context, and its authentication state.
 *
 * **Nothing in the daemon touches VRChat except through an Account**, and an Account reaches VRChat
 * only through `vrcFetch`, which means every request is rate limited and carries exactly one
 * account's cookies. See PLAN.md §Conventions.
 */

export type AccountState =
  | "new"
  | "authenticating"
  | "awaiting-2fa"
  | "online"
  | "offline"
  | "error";

export interface AccountSnapshot {
  readonly id: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly state: AccountState;
  readonly lastError: string | null;
  readonly pendingTwoFactorMethods: readonly TwoFactorAuthType[];
  /**
   * The account's own icon as an absolute VRChat image URL, or null. Null until `#user` is
   * populated, which is only after a successful sign-in — a snapshot taken mid-2FA has no user yet.
   * The URL needs the auth cookie and the mandatory UA, so it is loaded through `GET /api/image`.
   */
  readonly iconUrl: string | null;
}

export interface AccountDeps {
  readonly limiter: RateLimiter;
  readonly userAgent: string;
  readonly bus: EventBus;
  readonly baseUrl?: string;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Counts what this account spends. Optional; absent means unmetered, never unsent. */
  readonly meter?: RequestMeter | undefined;
  /** Called whenever cookies change, so the caller can persist them. */
  readonly onSecretChanged?: (id: string, secret: AccountSecret) => void | Promise<void>;
}

export class Account {
  readonly jar: CookieJar;

  #id: string;
  #username: string;
  #password: string | undefined;
  #totpSecret: string | undefined;
  #user: CurrentUser | null = null;
  #state: AccountState = "new";
  #lastError: string | null = null;
  #pending2fa: TwoFactorAuthType[] = [];

  /**
   * The re-auth mutex. PLAN.md §1.3: on 401, re-auth behind a per-account mutex so concurrent
   * requests queue behind one login. Without it, ten in-flight requests hitting an expired session
   * produce ten Basic-auth logins — ten sessions against an undisclosed cap, for one expiry.
   */
  #reauthInFlight: Promise<boolean> | null = null;

  constructor(
    id: string,
    secret: AccountSecret,
    private readonly deps: AccountDeps,
  ) {
    this.#id = id;
    this.#username = secret.username;
    this.#password = secret.password;
    this.#totpSecret = secret.totpSecret;
    this.jar = new CookieJar(secret.cookies);
  }

  get id(): string {
    return this.#id;
  }

  get username(): string {
    return this.#username;
  }

  get user(): CurrentUser | null {
    return this.#user;
  }

  get state(): AccountState {
    return this.#state;
  }

  snapshot(): AccountSnapshot {
    return {
      id: this.#id,
      username: this.#username,
      displayName: this.#user?.displayName ?? null,
      state: this.#state,
      lastError: this.#lastError,
      pendingTwoFactorMethods: [...this.#pending2fa],
      iconUrl: pickUserImageUrl(this.#user),
    };
  }

  /** The auth cookie, for the pipeline socket. Read fresh on every reconnect, never captured. */
  authToken(): string | undefined {
    return this.jar.get("auth");
  }

  /**
   * The request context for ordinary calls. Rebuilt per call rather than cached so that
   * `onUnauthorized` always closes over the current instance state.
   */
  context(): RequestContext {
    return { ...this.#baseContext(), onUnauthorized: () => this.reauthenticate() };
  }

  /**
   * A context with **no 401 hook**, used by the authentication flow itself.
   *
   * This is not a detail. `reauthenticate()` returns a single shared in-flight promise, and the
   * calls it makes to re-authenticate would themselves 401 on a dead session — re-entering
   * `reauthenticate()`, receiving that same promise, and awaiting it from inside itself. The
   * daemon deadlocks, silently, exactly when the session expires. Authentication must never be
   * able to trigger authentication.
   */
  #baseContext(): RequestContext {
    const ctx: RequestContext = {
      accountId: this.#id,
      jar: this.jar,
      userAgent: this.deps.userAgent,
      limiter: this.deps.limiter,
      ...(this.deps.baseUrl !== undefined ? { baseUrl: this.deps.baseUrl } : {}),
      ...(this.deps.fetch !== undefined ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.meter !== undefined ? { meter: this.deps.meter } : {}),
    };
    return ctx;
  }

  /**
   * Startup path. Tries stored cookies first and only falls back to a password login.
   *
   * The ordering is the whole point: `GET /auth` validates a token without minting a session, while
   * a Basic-auth `GET /auth/user` costs one every time. A daemon restarted ten times a day should
   * cost zero sessions, not ten per account.
   */
  async resume(): Promise<boolean> {
    this.#setState("authenticating");
    try {
      const user = await resumeFromCookies(this.#baseContext());
      if (user) {
        this.#adoptUser(user);
        await this.#persist();
        return true;
      }
      this.#setState("offline");
      return false;
    } catch (error) {
      this.#fail(error);
      return false;
    }
  }

  /** Password login. Returns whether 2FA is still required. */
  async login(password?: string): Promise<LoginResult> {
    const secret = password ?? this.#password;
    if (secret === undefined) {
      throw new AuthError("No stored password for this account; a password is required.");
    }

    this.#setState("authenticating");
    try {
      const result = await loginWithPassword(this.#baseContext(), this.#username, secret);

      if (result.status === "requires-2fa") {
        this.#pending2fa = result.methods;
        this.#setState("awaiting-2fa");
      } else {
        this.#adoptUser(result.user);
      }

      // Persist even in the 2FA case: the pre-2FA auth cookie is what the verify step
      // authenticates against, and losing it to a crash means starting the login over.
      if (password !== undefined) this.#password = password;
      await this.#persist();
      return result;
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async verifyTwoFactor(method: TwoFactorAuthType, code: string): Promise<CurrentUser> {
    if (!this.#pending2fa.includes(method)) {
      throw new AuthError(`This account did not ask for "${method}" verification.`);
    }

    try {
      const user = await verifyTwoFactor(this.#baseContext(), method, code);
      this.#adoptUser(user);
      await this.#persist();
      return user;
    } catch (error) {
      // Stay in awaiting-2fa: a wrong code is retryable, and dropping to `error` would make the UI
      // throw away a login that is one correct digit away from working.
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Re-authenticates after a 401, at most once concurrently.
   *
   * Callers all await the same promise. The `finally` clears the slot *after* everyone has resolved,
   * so a second wave of 401s starts a fresh attempt rather than reusing a settled one.
   */
  reauthenticate(): Promise<boolean> {
    if (this.#reauthInFlight) return this.#reauthInFlight;

    const attempt = (async (): Promise<boolean> => {
      try {
        // Try the cheap path first — the 401 may have been a transient upstream blip rather than a
        // dead session, and re-validating costs nothing.
        const resumed = await resumeFromCookies(this.#baseContext());
        if (resumed) {
          this.#adoptUser(resumed);
          await this.#persist();
          return true;
        }

        if (this.#password === undefined) {
          this.#setState("offline");
          this.#lastError = "Session expired and no password is stored. Sign in again.";
          return false;
        }

        const result = await this.login(this.#password);
        if (result.status === "requires-2fa") {
          // Cannot be resolved without the user. The UI picks this up from the state.
          return false;
        }
        return true;
      } catch (error) {
        this.#fail(error);
        return false;
      } finally {
        this.#reauthInFlight = null;
      }
    })();

    this.#reauthInFlight = attempt;
    return attempt;
  }

  /** Refreshes the cached `CurrentUser`. */
  async refresh(): Promise<CurrentUser> {
    const user = await fetchCurrentUser(this.#baseContext());
    this.#adoptUser(user);
    await this.#persist();
    return user;
  }

  /**
   * Marks the account offline locally.
   *
   * **Deliberately does not call `PUT /logout`.** Cookies are kept so the next start can resume
   * without minting a session. PLAN.md §Guardrails: "never call `PUT /logout` on shutdown."
   */
  goOffline(): void {
    this.#setState("offline");
  }

  /**
   * Forgets this account's credentials. The one place a logout *is* correct, because the user asked
   * to remove the account rather than to stop the daemon.
   */
  async signOut(): Promise<void> {
    await vrcFetch(this.#baseContext(), "/logout", { method: "PUT" }).catch(() => undefined);
    this.jar.clear();
    this.#user = null;
    this.#password = undefined;
    this.#setState("offline");
  }

  toSecret(): AccountSecret {
    const secret: AccountSecret = {
      username: this.#username,
      cookies: this.jar.toPersistable(),
      ...(this.#password !== undefined ? { password: this.#password } : {}),
      ...(this.#totpSecret !== undefined ? { totpSecret: this.#totpSecret } : {}),
    };
    return secret;
  }

  #adoptUser(user: CurrentUser): void {
    this.#user = user;
    this.#pending2fa = [];
    this.#lastError = null;

    // A locally-added account learns its real `usr_…` id on first success. The manager re-keys the
    // secrets store to match; doing it here keeps the id authoritative in one place.
    if (this.#id !== user.id) this.#id = user.id;
    this.#setState("online");
  }

  #setState(state: AccountState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.deps.bus.emit({
      kind: "account.state",
      accountId: this.#id,
      ts: Date.now(),
      payload: this.snapshot(),
    });
  }

  #fail(error: unknown): void {
    this.#lastError = error instanceof Error ? error.message : String(error);
    this.#setState("error");
  }

  async #persist(): Promise<void> {
    await this.deps.onSecretChanged?.(this.#id, this.toSecret());
  }
}
