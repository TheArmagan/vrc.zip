import type { CurrentUser, TwoFactorAuthType } from "@vrcz/api/types";
import type { RequestContext } from "../net/request.ts";
import { vrcFetch } from "../net/request.ts";
import { AUTH_COOKIE, TWO_FACTOR_COOKIE } from "./cookie-jar.ts";

/**
 * The VRChat login flow, exactly as PLAN.md §1.3 specifies it.
 *
 * The shape that matters: `GET /auth/user` returns a `oneOf` — either a `CurrentUser` or
 * `{requiresTwoFactorAuth: [...]}`. We narrow on the presence of the discriminating key rather than
 * on the status code, because both are 200.
 *
 * **Every Basic-auth `GET /auth/user` mints a new session** against an undisclosed cap. That is why
 * `resumeFromCookies` exists and is tried first everywhere, and why nothing here calls
 * `PUT /logout`.
 */

/** The three verify endpoints, keyed by the method VRChat told us to use. */
const VERIFY_PATH: Record<TwoFactorAuthType, string> = {
  totp: "/auth/twofactorauth/totp/verify",
  emailOtp: "/auth/twofactorauth/emailotp/verify",
  otp: "/auth/twofactorauth/otp/verify",
};

export type LoginResult =
  | { readonly status: "ok"; readonly user: CurrentUser }
  | { readonly status: "requires-2fa"; readonly methods: TwoFactorAuthType[] };

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AuthError";
  }
}

function isRequiresTwoFactor(
  body: unknown,
): body is { requiresTwoFactorAuth: TwoFactorAuthType[] } {
  return (
    typeof body === "object" &&
    body !== null &&
    "requiresTwoFactorAuth" in body &&
    Array.isArray((body as { requiresTwoFactorAuth: unknown }).requiresTwoFactorAuth)
  );
}

function isCurrentUser(body: unknown): body is CurrentUser {
  return typeof body === "object" && body !== null && "id" in body && "displayName" in body;
}

/**
 * Pulls VRChat's own explanation out of an error response.
 *
 * VRChat's envelope is `{error: {message, status_code, waf_code?}}`, and `message` is **JSON-encoded
 * a second time** — the wire literally carries `"\"Invalid Username/Email or Password\""`. Showing
 * that to a user verbatim is nearly as unhelpful as showing nothing, so the outer quotes come off.
 *
 * This matters more than it looks. Without it every non-2xx becomes "Login failed (403)", and a 403
 * from VRChat is never self-explanatory: it might be the User-Agent WAF, an unverified email, a
 * login from an unrecognised place, or a temporary block. The user cannot act on a status code, and
 * they can act on VRChat's sentence.
 */
async function vrchatErrorMessage(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => "");
  if (text === "") return null;

  try {
    const body = JSON.parse(text) as { error?: { message?: unknown; waf_code?: unknown } };
    const raw = body.error?.message;
    if (typeof raw !== "string") return null;

    let message = raw;
    if (message.startsWith('"') && message.endsWith('"')) {
      try {
        message = JSON.parse(message) as string;
      } catch {
        message = message.slice(1, -1);
      }
    }

    const waf = body.error?.waf_code;
    return typeof waf === "number" ? `${message} (waf_code ${String(waf)})` : message;
  } catch {
    // A non-JSON error body is usually an infrastructure page (Cloudflare, a proxy). Keep a short
    // prefix rather than the whole HTML document.
    return text.slice(0, 200);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new AuthError(`VRChat returned a non-JSON body (${response.status})`, response.status, {
      cause,
    });
  }
}

/**
 * Step 1: Basic-auth login.
 *
 * The jar is **not** cleared first and cookies are not sent (`vrcFetch` suppresses them when
 * `basicAuth` is set). An `auth` cookie is issued here *pre-2FA* and must be kept — the verify call
 * in step 2 authenticates against it.
 */
export async function loginWithPassword(
  ctx: RequestContext,
  username: string,
  password: string,
): Promise<LoginResult> {
  const response = await vrcFetch(ctx, "/auth/user", {
    basicAuth: { username, password },
  });

  if (!response.ok) {
    const upstream = await vrchatErrorMessage(response);

    if (response.status === 401) {
      throw new AuthError(upstream ?? "Incorrect username or password.", 401);
    }
    // Everything else keeps VRChat's own wording. A 403 in particular is never self-explanatory,
    // and the sentence VRChat sends is the only thing that tells the user what to do next.
    throw new AuthError(
      upstream === null
        ? `VRChat rejected the sign-in (${String(response.status)}).`
        : `VRChat says: ${upstream}`,
      response.status,
    );
  }

  const body = await readJson(response);

  if (isRequiresTwoFactor(body)) {
    if (ctx.jar.get(AUTH_COOKIE) === undefined) {
      // Without the pre-2FA auth cookie the verify step has nothing to authenticate against, and
      // would fail in a way that looks like a wrong code. Fail here, where the cause is legible.
      throw new AuthError("VRChat asked for 2FA but issued no auth cookie.");
    }
    return { status: "requires-2fa", methods: body.requiresTwoFactorAuth };
  }

  if (!isCurrentUser(body)) {
    throw new AuthError("VRChat returned an unrecognized login response.");
  }
  return { status: "ok", user: body };
}

/**
 * Step 2 and 3: verify one factor, then re-fetch the user.
 *
 * **Branches explicitly on the method** rather than firing all three verifiers and taking whichever
 * sticks. Firing in parallel works, but it makes email-OTP and TOTP indistinguishable in the UI —
 * and the UI has to say which one it is, because the user has to go and find the code somewhere
 * different for each.
 */
export async function verifyTwoFactor(
  ctx: RequestContext,
  method: TwoFactorAuthType,
  code: string,
): Promise<CurrentUser> {
  const path = VERIFY_PATH[method];
  if (!path) throw new AuthError(`Unknown two-factor method "${String(method)}".`);

  const response = await vrcFetch(ctx, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim() }),
  });

  if (!response.ok) {
    const upstream = await vrchatErrorMessage(response);
    throw new AuthError(
      upstream === null
        ? `That code was not accepted (${String(response.status)}).`
        : `VRChat says: ${upstream}`,
      response.status,
    );
  }

  const body = (await readJson(response)) as { verified?: boolean };
  if (body.verified !== true) {
    throw new AuthError("That code was not accepted.");
  }

  // The twoFactorAuth cookie arrived on that response and is already in the jar. It is long-lived
  // device trust: losing it means re-prompting 2FA on every restart, which costs a session each
  // time. `CookieJar.toPersistable` keeps it; the caller must actually save.
  if (ctx.jar.get(TWO_FACTOR_COOKIE) === undefined) {
    // Not fatal — login still works — but the user will be asked for a code again next start.
    // Surfaced rather than silent so this shows up in a bug report instead of as a mystery.
    console.warn("[auth] VRChat issued no twoFactorAuth cookie; 2FA will be required again.");
  }

  return await fetchCurrentUser(ctx);
}

/** `GET /auth/user` with cookies. Also step 5 of the login flow. */
export async function fetchCurrentUser(ctx: RequestContext): Promise<CurrentUser> {
  const response = await vrcFetch(ctx, "/auth/user");

  if (response.status === 401) throw new AuthError("Session is no longer valid.", 401);
  if (!response.ok)
    throw new AuthError(`Could not load account (${response.status}).`, response.status);

  const body = await readJson(response);
  if (isRequiresTwoFactor(body)) {
    throw new AuthError("VRChat still requires two-factor verification.");
  }
  if (!isCurrentUser(body)) throw new AuthError("VRChat returned an unrecognized user response.");

  return body;
}

/**
 * Startup path: validate stored cookies instead of re-authenticating.
 *
 * `GET /auth` is a cheap token check that does **not** mint a session, unlike a Basic-auth
 * `GET /auth/user`. Preferring it is the difference between costing a session on every daemon
 * restart and costing none.
 */
export async function resumeFromCookies(ctx: RequestContext): Promise<CurrentUser | null> {
  if (ctx.jar.get(AUTH_COOKIE) === undefined) return null;

  const response = await vrcFetch(ctx, "/auth");
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    return null;
  }

  const body = (await readJson(response)) as { ok?: boolean };
  if (body.ok !== true) return null;

  try {
    return await fetchCurrentUser(ctx);
  } catch {
    return null;
  }
}
