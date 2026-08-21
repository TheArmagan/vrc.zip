/**
 * A cookie jar, one per account.
 *
 * **Isolation is the whole point.** `GET /users/{id}` returns *different fields* depending on
 * whether the authenticated caller is a friend of that user, so anything shared across accounts and
 * keyed on URL alone is a correctness bug, not just a privacy one. There are deliberately no shared
 * fetch defaults and no shared HTTP cache anywhere in the daemon — every request carries exactly one
 * account's jar. See PLAN.md §1.3.
 *
 * Only what VRChat actually uses is implemented: `auth`, `twoFactorAuth`, and whatever else the API
 * sets. Path matching, domain matching, and the public-suffix list are out of scope — one jar talks
 * to exactly one host.
 */

export interface Cookie {
  readonly name: string;
  readonly value: string;
  /** Unix ms. `null` means a session cookie: kept in memory, never persisted. */
  readonly expiresAt: number | null;
}

/** The session cookie. Reused across restarts so we don't mint a new VRChat session every boot. */
export const AUTH_COOKIE = "auth";
/**
 * Long-lived device trust. Losing this means re-prompting for 2FA on every restart, which is both
 * user-hostile and, because each Basic-auth login mints a session, wasteful of an undisclosed cap.
 */
export const TWO_FACTOR_COOKIE = "twoFactorAuth";

/** Cookie names whose values must never be logged, echoed, or returned on the proxy ports. */
export const SENSITIVE_COOKIES: readonly string[] = [AUTH_COOKIE, TWO_FACTOR_COOKIE];

/**
 * Parses one `Set-Cookie` header value.
 *
 * `Max-Age` wins over `Expires` when both are present — that is what RFC 6265 §5.3 requires, and
 * getting it backwards means honouring a stale absolute date over a fresh relative one.
 * Returns `null` for a header we can't make sense of; a malformed cookie is dropped, never guessed.
 */
export function parseSetCookie(header: string, now: number = Date.now()): Cookie | null {
  const parts = header.split(";");
  const pair = parts[0];
  if (!pair) return null;

  const eq = pair.indexOf("=");
  if (eq <= 0) return null;

  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (name === "") return null;

  let expires: number | null = null;
  let maxAge: number | null = null;

  for (const attr of parts.slice(1)) {
    const attrEq = attr.indexOf("=");
    const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq === -1 ? "" : attr.slice(attrEq + 1).trim();

    if (attrName === "max-age") {
      const seconds = Number.parseInt(attrValue, 10);
      // A non-numeric Max-Age is ignored per RFC; a zero or negative one expires immediately.
      if (Number.isFinite(seconds)) maxAge = now + seconds * 1000;
    } else if (attrName === "expires") {
      const parsed = Date.parse(attrValue);
      if (Number.isFinite(parsed)) expires = parsed;
    }
  }

  return { name, value, expiresAt: maxAge ?? expires };
}

export class CookieJar {
  readonly #cookies = new Map<string, Cookie>();

  constructor(initial: readonly Cookie[] = []) {
    for (const cookie of initial) this.#cookies.set(cookie.name, cookie);
  }

  /**
   * Absorbs every `Set-Cookie` on a response.
   *
   * `Headers.getSetCookie()` is the only correct way to read these — `headers.get("set-cookie")`
   * folds multiple cookies into one comma-joined string, and cookie dates legitimately contain
   * commas, so splitting that back apart is unreliable by construction.
   */
  applyResponse(headers: Headers, now: number = Date.now()): void {
    for (const header of headers.getSetCookie()) {
      const cookie = parseSetCookie(header, now);
      if (!cookie) continue;

      // An expired or empty-valued cookie is a deletion.
      if (cookie.value === "" || (cookie.expiresAt !== null && cookie.expiresAt <= now)) {
        this.#cookies.delete(cookie.name);
        continue;
      }
      this.#cookies.set(cookie.name, cookie);
    }
  }

  set(cookie: Cookie): void {
    this.#cookies.set(cookie.name, cookie);
  }

  get(name: string, now: number = Date.now()): string | undefined {
    const cookie = this.#cookies.get(name);
    if (!cookie) return undefined;
    if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
      this.#cookies.delete(name);
      return undefined;
    }
    return cookie.value;
  }

  delete(name: string): void {
    this.#cookies.delete(name);
  }

  clear(): void {
    this.#cookies.clear();
  }

  /** The `Cookie:` request header value, or `undefined` when the jar has nothing live to send. */
  header(now: number = Date.now()): string | undefined {
    const live: string[] = [];
    for (const cookie of this.#cookies.values()) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.#cookies.delete(cookie.name);
        continue;
      }
      live.push(`${cookie.name}=${cookie.value}`);
    }
    return live.length > 0 ? live.join("; ") : undefined;
  }

  /**
   * Everything worth writing to the encrypted store.
   *
   * Session cookies (no expiry) are included deliberately: VRChat's `auth` cookie arrives without a
   * `Max-Age`, and dropping it on shutdown would force a fresh Basic-auth login — and therefore a
   * fresh session against an undisclosed cap — on every start. That is exactly the cost PLAN.md
   * §Guardrails says to avoid.
   */
  toPersistable(now: number = Date.now()): Cookie[] {
    const out: Cookie[] = [];
    for (const cookie of this.#cookies.values()) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) continue;
      out.push(cookie);
    }
    return out;
  }

  get size(): number {
    return this.#cookies.size;
  }
}
