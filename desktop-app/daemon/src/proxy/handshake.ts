/**
 * The login handshake. PLAN.md §Phase 2 "The login handshake — this is the core mechanism".
 *
 * A third-party app does not register a token out of band. **It performs a normal VRChat login
 * against the proxy**, and vrc.zip turns that into a consent flow. Everything an app already does
 * — Basic auth, a `requiresTwoFactorAuth` branch, a verify POST, an `auth` cookie — happens
 * unmodified; only the meaning changes underneath it.
 *
 * The four routes here are the whole of it:
 *
 *   GET  /auth/user                        Basic auth → consent, or a cookie → CurrentUser
 *   POST /auth/twofactorauth/{m}/verify    the pairing code; typing it *is* the consent gesture
 *   GET  /auth                             validates the proxy token, returns **our** token
 *   PUT  /logout                           revokes the grant, and nothing upstream
 *
 * `PUT /logout` never reaches VRChat. Session frugality is the reason the proxy exists at all: one
 * real VRChat session per account no matter how many apps are connected, and an app logging out of
 * the proxy must not cost the user the session every other app is sharing.
 */

import type { Scope } from "@vrcz/shared";
import { hashProxyToken as hash, mintProxyToken } from "../security/proxy-tokens.ts";
import type { GrantRow } from "../store/types.ts";
import type { ConsentRegistry, PendingConsent } from "./consent.ts";
import {
  isAccountPicker,
  missingScopes,
  parseAppIdentity,
  parseBasicAuth,
  parseScopeRequest,
} from "./identity.ts";
import type { PassthroughDeps } from "./passthrough.ts";
import type { PipelineMirror } from "./pipeline-mirror.ts";
import {
  invalidCredentials,
  missingCredentials,
  requiresTwoFactorAuth,
  verified,
  vrchatSuccess,
  vrczipError,
  wafForbidden,
} from "./vrchat-shapes.ts";

/** An account the proxy may bind a grant to. */
export interface ProxyAccount {
  readonly id: string;
  readonly displayName: string;
}

export interface ProxyDeps {
  readonly consent: ConsentRegistry;
  /** Grant persistence. Narrowed to what the handshake uses, so a test needs no real database. */
  readonly grants: GrantStore;
  /**
   * Resolves what the app typed in the username field — a VRChat user id, a login username, or a
   * display name — to a managed account, or null.
   */
  readonly resolveAccount: (username: string) => ProxyAccount | null;
  /**
   * The `CurrentUser` body for a bound account, or null if the account has not signed in yet.
   *
   * A cached object rather than a proxied upstream response, deliberately: this endpoint's response
   * is *ours*, synthesised for a login that never reaches VRChat, so there are no upstream bytes to
   * be faithful to. §2.7's pass-through routes are where byte-fidelity starts mattering, and this
   * stays a dep so that change lands in one place.
   */
  readonly currentUser: (accountId: string) => unknown | null;
  /**
   * The pass-through's collaborators. Absent before first-run setup, when there is no honest
   * User-Agent and so nothing may reach VRChat — every non-handshake route answers 503 then, rather
   * than sending a request VRChat would reject with `waf_code 13799` anyway.
   */
  readonly passthrough?: PassthroughDeps | undefined;
  /**
   * The pipeline mirror. Absent, the WebSocket route answers with VRChat's dead-session frame and
   * closes, which is a client's normal "reconnect later" path rather than a broken handshake.
   */
  readonly pipeline?: PipelineMirror | undefined;
  readonly now?: (() => number) | undefined;
}

/** The slice of the store the handshake touches. */
export interface GrantStore {
  insertGrant(grant: {
    id: string;
    account_id: string;
    app_name: string;
    app_version: string;
    app_contact: string;
    scopes: string;
    token_hash: string;
    two_factor_hash: string | null;
    created_at: number;
  }): void;
  grantByTokenHash(hash: string): GrantRow | null;
  grantByTwoFactorHash(hash: string): GrantRow | null;
  findGrantForApp(accountId: string, appName: string, appContact: string): GrantRow | null;
  revokeGrant(id: string, at: number): void;
  touchGrant(id: string, at: number): void;
}

/** What the proxy sets on a response so the egress filter emits the cookie. See `egress-filter`. */
export const AUTH_COOKIE_HEADER = "X-Vrcz-Set-Auth";
export const TWO_FACTOR_COOKIE_HEADER = "X-Vrcz-Set-Two-Factor";

/**
 * The 2FA methods the proxy advertises.
 *
 * Always `totp`, always exactly one. A client that sees several may prompt for a choice, and there
 * is only one thing to type; a client that sees `emailOtp` may sit and wait for an email that is
 * never coming. `totp` is the method whose UX — "open the other thing, read six digits" — is
 * already exactly what we are asking the user to do.
 */
export const ADVERTISED_2FA_METHODS = ["totp"] as const;

export type RequestLike = {
  readonly method: string;
  header(name: string): string | undefined;
  cookie(name: string): string | undefined;
  json(): Promise<unknown>;
};

/**
 * `GET /auth/user` — both halves of it.
 *
 * With Basic auth it is a login; with a cookie it is "who am I". VRChat serves both from this one
 * path, so the mirror must too.
 */
export async function getCurrentUser(request: RequestLike, deps: ProxyDeps): Promise<Response> {
  const app = parseAppIdentity(request.header("user-agent"));
  if (app === null) return wafForbidden();

  const basic = parseBasicAuth(request.header("authorization"));
  if (basic === null) {
    // No credentials offered: this is the "who am I" call an app makes after logging in.
    const grant = liveGrant(request, deps);
    if (grant === null) return missingCredentials();
    deps.grants.touchGrant(grant.id, now(deps));

    const user = deps.currentUser(grant.account_id);
    if (user === null) return missingCredentials();
    return json(user);
  }

  const requested = parseScopeRequest(basic.secret);
  if (!requested.ok) {
    // Never silently dropped. An app that asked for `friends:reed` and got a working grant without
    // it fails later, somewhere unrelated, with a 403 nobody can trace back to a typo.
    return vrczipError(
      400,
      "unknown_scope",
      `Unknown scope${requested.unknown.length > 1 ? "s" : ""}: ${requested.unknown.join(", ")}`,
      { unknownScopes: requested.unknown },
    );
  }

  const picker = isAccountPicker(basic.username);
  const account = picker ? null : deps.resolveAccount(basic.username);
  if (!picker && account === null) {
    // Deliberately no "default account" fallback: an app silently acting as the wrong account is
    // the worst failure mode this system can have. VRChat's real invalid-credentials shape.
    return invalidCredentials();
  }

  // Device trust, and the *only* thing that skips consent.
  //
  // An existing grant on its own is not enough. Any local process can send another app's
  // User-Agent, so treating "this app already has a grant" as proof of identity would hand a
  // working token to whoever asked in its name. The `twoFactorAuth` cookie is the thing an
  // impersonator does not have, which is exactly what device trust means upstream too.
  const trusted = deviceTrustedGrant(request, deps, app, account);
  if (
    trusted !== null &&
    missingScopes(parseScopes(trusted.scopes), requested.scopes).length === 0
  ) {
    const issued = issueGrant(deps, {
      accountId: trusted.account_id,
      app,
      scopes: parseScopes(trusted.scopes),
    });
    const user = deps.currentUser(trusted.account_id);
    if (user === null) return missingCredentials();
    return withCookies(json(user), issued);
  }

  const existing =
    account === null ? null : deps.grants.findGrantForApp(account.id, app.name, app.contact);
  const held = existing === null ? [] : parseScopes(existing.scopes);

  const { halfToken } = deps.consent.open({
    accountId: account?.id ?? null,
    requestedUsername: basic.username,
    app,
    scopes: requested.scopes,
    // Only the delta. Re-listing what the user already approved makes the new ask harder to see.
    newScopes: missingScopes(held, requested.scopes),
  });

  // Byte-for-byte what real VRChat sends pre-2FA, including the cookie. The app's own code path
  // takes it from here and prompts its user for a code, with no idea anything unusual happened.
  return withCookies(requiresTwoFactorAuth(ADVERTISED_2FA_METHODS), { token: halfToken });
}

/**
 * `POST /auth/twofactorauth/{totp,emailotp,otp}/verify`.
 *
 * A wrong code, an expired sheet, an unknown cookie, and a rate-limited app all return the same
 * `{"verified": false}`. Distinguishing them would be more helpful to a brute-forcer than to a
 * developer, and it is byte-faithful either way — VRChat's body has exactly one field.
 */
export async function verifyTwoFactor(request: RequestLike, deps: ProxyDeps): Promise<Response> {
  const app = parseAppIdentity(request.header("user-agent"));
  if (app === null) return wafForbidden();

  const halfToken = request.cookie("auth");
  if (halfToken === undefined) return missingCredentials();

  let code = "";
  try {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body.code === "string") code = body.code;
  } catch {
    // A body we cannot parse carries no code, which is a failed verification rather than a 400 —
    // that is what VRChat does, and an app that sent junk learns the same thing either way.
  }

  const result = deps.consent.verify(halfToken, code);
  if (!result.ok) return verified(false);

  const pending: PendingConsent = result.pending;
  // `verify` refuses a pending request with no account, so this is narrowing, not a fallback.
  if (pending.accountId === null) return verified(false);

  const issued = issueGrant(deps, {
    accountId: pending.accountId,
    app,
    scopes: pending.scopes,
  });
  deps.consent.approve(pending.id, issued.grantId);

  // Both cookies, so device-trust round-trips look normal to the client on its next start.
  return withCookies(verified(true), issued);
}

/**
 * `GET /auth` — the cheap "is this session still good" call.
 *
 * The `token` field is **ours**, echoed back. Returning the upstream body verbatim here is one of
 * the named leak paths in PLAN.md: it hands the app the real session in a field it was only ever
 * asking us to confirm.
 */
export function verifyAuthToken(request: RequestLike, deps: ProxyDeps): Response {
  const app = parseAppIdentity(request.header("user-agent"));
  if (app === null) return wafForbidden();

  const token = request.cookie("auth");
  const grant = token === undefined ? null : deps.grants.grantByTokenHash(hash(token));
  if (grant === null || token === undefined) return missingCredentials();

  deps.grants.touchGrant(grant.id, now(deps));
  return json({ ok: true, token });
}

/**
 * `PUT /logout` — revokes the proxy grant and stops there.
 *
 * PLAN.md §Guardrails: never `PUT /logout` upstream. The real session is shared by every app
 * connected to this account and by the daemon itself, and one app signing out must not cost it.
 */
export function logout(request: RequestLike, deps: ProxyDeps): Response {
  const app = parseAppIdentity(request.header("user-agent"));
  if (app === null) return wafForbidden();

  const token = request.cookie("auth");
  const grant = token === undefined ? null : deps.grants.grantByTokenHash(hash(token));
  if (grant !== null) deps.grants.revokeGrant(grant.id, now(deps));

  // VRChat answers a logout with no session the same way it answers a real one.
  return vrchatSuccess();
}

// --- internals ---------------------------------------------------------------

interface IssuedGrant {
  readonly grantId: string;
  readonly token: string;
  readonly twoFactorToken: string;
}

/**
 * Mints a grant and its credentials.
 *
 * A re-login by an app that already holds a grant issues a **new** one rather than rotating the old
 * one's token. Rotation would kill a running instance of that app mid-request; PLAN.md's escalation
 * flow says the existing grant keeps working throughout, and this is what makes that true. The user
 * sees both in "Connected apps" and can revoke either.
 */
function issueGrant(
  deps: ProxyDeps,
  request: {
    accountId: string;
    app: { name: string; version: string; contact: string };
    scopes: readonly Scope[];
  },
): IssuedGrant {
  const id = crypto.randomUUID();
  const token = mintProxyToken();
  const device = mintProxyToken();

  deps.grants.insertGrant({
    id,
    account_id: request.accountId,
    app_name: request.app.name,
    app_version: request.app.version,
    app_contact: request.app.contact,
    // Stored as granted, never re-derived: a later registry change must not widen or narrow a
    // grant the user already approved.
    scopes: JSON.stringify(request.scopes),
    token_hash: token.hash,
    two_factor_hash: device.hash,
    created_at: now(deps),
  });

  return { grantId: id, token: token.token, twoFactorToken: device.token };
}

/** The live grant behind the request's `auth` cookie, or null. */
function liveGrant(request: RequestLike, deps: ProxyDeps): GrantRow | null {
  const token = request.cookie("auth");
  return token === undefined ? null : deps.grants.grantByTokenHash(hash(token));
}

/**
 * The grant a valid `twoFactorAuth` cookie proves continuity with — but only if it is the same app
 * and, when the app named one, the same account.
 *
 * Both checks matter. Without the app check, a device-trust cookie leaked from one app would let
 * another mint grants in its name; without the account check, an app could quietly bind to a
 * different account than the user typed.
 */
function deviceTrustedGrant(
  request: RequestLike,
  deps: ProxyDeps,
  app: { name: string; contact: string },
  account: ProxyAccount | null,
): GrantRow | null {
  const cookie = request.cookie("twoFactorAuth");
  if (cookie === undefined) return null;

  const grant = deps.grants.grantByTwoFactorHash(hash(cookie));
  if (grant === null) return null;
  if (grant.app_name !== app.name || grant.app_contact !== app.contact) return null;
  if (account !== null && grant.account_id !== account.id) return null;
  return grant;
}

function parseScopes(raw: string): Scope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.filter((s) => typeof s === "string") as Scope[]) : [];
  } catch {
    return [];
  }
}

/** Attaches the marker headers the egress filter turns into real `Set-Cookie` lines. */
function withCookies(
  response: Response,
  issued: { token: string; twoFactorToken?: string },
): Response {
  response.headers.set(AUTH_COOKIE_HEADER, issued.token);
  if (issued.twoFactorToken !== undefined) {
    response.headers.set(TWO_FACTOR_COOKIE_HEADER, issued.twoFactorToken);
  }
  return response;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function now(deps: ProxyDeps): number {
  return (deps.now ?? Date.now)();
}
