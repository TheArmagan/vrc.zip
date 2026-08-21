/**
 * A stand-in VRChat API for integration tests. PLAN.md §1.10: **CI never hits the live API.**
 *
 * Deliberately a real `Bun.serve` rather than a `fetch` stub. The things most likely to be wrong in
 * this layer are HTTP-level — multiple `Set-Cookie` headers folding into one, header casing, an
 * empty body on a 401 — and a stub would paper over exactly those.
 *
 * It models VRChat's actual behaviours that the daemon depends on:
 *  - `GET /auth/user` is a `oneOf`: `CurrentUser` or `{requiresTwoFactorAuth}`, both 200.
 *  - An `auth` cookie is issued **pre-2FA**, and the verify call authenticates against it.
 *  - A missing User-Agent is a 403 with `waf_code 13799`.
 *  - `GET /auth` validates a token cheaply, without minting a session.
 */

export interface FixtureAccount {
  readonly username: string;
  readonly password: string;
  readonly userId: string;
  readonly displayName: string;
  /** Methods to demand, in VRChat's order. Empty means no 2FA. */
  readonly twoFactorMethods?: readonly ("totp" | "emailOtp" | "otp")[];
  readonly twoFactorCode?: string;
  readonly friends?: readonly FixtureFriend[];
}

export interface FixtureFriend {
  readonly id: string;
  readonly displayName: string;
  readonly online: boolean;
  readonly status?: string;
  readonly location?: string;
  readonly tags?: readonly string[];
  readonly platform?: string;
  /** Absent means the friend has no icon, which VRChat reports as `""`, not by omission. */
  readonly userIcon?: string;
}

export interface FixtureOptions {
  readonly accounts: readonly FixtureAccount[];
  /** Force the next N requests to 429, to exercise backoff. */
  readonly rateLimitNext?: number;
}

interface IssuedSession {
  readonly account: FixtureAccount;
  twoFactorSatisfied: boolean;
}

export interface VrchatFixture {
  readonly baseUrl: string;
  /** Every request the daemon made, in order. Assert against this. */
  readonly requests: Array<{ method: string; path: string; headers: Headers }>;
  /** How many Basic-auth logins were performed — i.e. how many sessions were minted. */
  readonly sessionsMinted: () => number;
  /**
   * The newest `auth` cookie value issued to this account, or null if it never logged in. Tests
   * need it to tell one account's pipeline socket from another's — the token is the only thing on
   * that handshake that identifies who opened it.
   */
  readonly authTokenFor: (userId: string) => string | null;
  readonly setRateLimitNext: (count: number) => void;
  /** Makes the next login fail with VRChat's error envelope, for diagnostics tests. */
  readonly setNextLoginFailure: (status: number, message: string) => void;
  /** Invalidates every issued session, so the next call 401s. */
  readonly expireAllSessions: () => void;
  readonly stop: () => void;
}

export function startVrchatFixture(options: FixtureOptions): VrchatFixture {
  const sessions = new Map<string, IssuedSession>();
  const trustedDevices = new Set<string>();
  const requests: VrchatFixture["requests"] = [];

  const latestToken = new Map<string, string>();
  let sessionCounter = 0;
  let minted = 0;
  let rateLimitRemaining = options.rateLimitNext ?? 0;
  let nextLoginFailure: { status: number; message: string } | null = null;

  function json(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  }

  function currentUser(account: FixtureAccount): Record<string, unknown> {
    return {
      id: account.userId,
      displayName: account.displayName,
      username: account.username,
      bio: "",
      currentAvatarImageUrl: "",
      state: "online",
      status: "active",
      tags: [],
    };
  }

  function cookiesFrom(header: string | null): Map<string, string> {
    const out = new Map<string, string>();
    if (!header) return out;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    return out;
  }

  function sessionFor(request: Request): IssuedSession | undefined {
    const token = cookiesFrom(request.headers.get("Cookie")).get("auth");
    return token ? sessions.get(token) : undefined;
  }

  function issueSession(account: FixtureAccount, twoFactorSatisfied: boolean): string {
    sessionCounter += 1;
    const token = `authcookie_${account.userId}_${String(sessionCounter)}`;
    sessions.set(token, { account, twoFactorSatisfied });
    latestToken.set(account.userId, token);
    return token;
  }

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/1/, "");
      requests.push({ method: request.method, path, headers: request.headers });

      // VRChat rejects a missing UA outright, on every route. Modelled because forgetting the
      // header is a whole class of bug that otherwise only shows up against the live API.
      const ua = request.headers.get("User-Agent");
      if (!ua || ua.trim() === "") {
        return json(
          { error: { message: "Forbidden", status_code: 403, waf_code: 13799 } },
          {
            status: 403,
          },
        );
      }

      if (rateLimitRemaining > 0) {
        rateLimitRemaining -= 1;
        return json(
          { error: { message: "Too Many Requests", status_code: 429 } },
          {
            status: 429,
            headers: { "Retry-After": "1" },
          },
        );
      }

      if (path === "/auth/user" && request.method === "GET") {
        const authorization = request.headers.get("Authorization");

        if (authorization?.startsWith("Basic ")) {
          if (nextLoginFailure !== null) {
            const failure = nextLoginFailure;
            nextLoginFailure = null;
            // VRChat double-encodes `message`: the wire carries a JSON string *inside* the JSON.
            return json(
              { error: { message: JSON.stringify(failure.message), status_code: failure.status } },
              { status: failure.status },
            );
          }
          minted += 1;
          const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
          const split = decoded.indexOf(":");
          const username = decodeURIComponent(decoded.slice(0, split));
          const password = decodeURIComponent(decoded.slice(split + 1));

          const account = options.accounts.find(
            (a) => a.username === username && a.password === password,
          );
          if (!account) {
            return json(
              { error: { message: "Invalid Username or Password", status_code: 401 } },
              {
                status: 401,
              },
            );
          }

          const methods = account.twoFactorMethods ?? [];
          const deviceTrusted = trustedDevices.has(
            cookiesFrom(request.headers.get("Cookie")).get("twoFactorAuth") ?? "",
          );
          const needs2fa = methods.length > 0 && !deviceTrusted;

          // The auth cookie is issued here either way — pre-2FA included. This is the behaviour
          // the daemon depends on for the verify step.
          const token = issueSession(account, !needs2fa);
          const headers = { "Set-Cookie": `auth=${token}; Path=/; HttpOnly` };

          return needs2fa
            ? json({ requiresTwoFactorAuth: methods }, { headers })
            : json(currentUser(account), { headers });
        }

        const session = sessionFor(request);
        if (!session)
          return json(
            { error: { message: "Missing Credentials", status_code: 401 } },
            { status: 401 },
          );
        if (!session.twoFactorSatisfied) {
          return json({ requiresTwoFactorAuth: session.account.twoFactorMethods ?? [] });
        }
        return json(currentUser(session.account));
      }

      if (path === "/auth" && request.method === "GET") {
        const session = sessionFor(request);
        if (!session?.twoFactorSatisfied) {
          return json(
            { error: { message: "Missing Credentials", status_code: 401 } },
            { status: 401 },
          );
        }
        return json({ ok: true, token: "authcookie_real_do_not_leak" });
      }

      const verifyMatch = /^\/auth\/twofactorauth\/(totp|emailotp|otp)\/verify$/.exec(path);
      if (verifyMatch && request.method === "POST") {
        const session = sessionFor(request);
        if (!session)
          return json(
            { error: { message: "Missing Credentials", status_code: 401 } },
            { status: 401 },
          );

        const body = (await request.json()) as { code?: string };
        if (body.code !== (session.account.twoFactorCode ?? "123456")) {
          return json({ verified: false });
        }

        session.twoFactorSatisfied = true;
        const device = `tfa_${session.account.userId}`;
        trustedDevices.add(device);
        return json(
          { verified: true },
          { headers: { "Set-Cookie": `twoFactorAuth=${device}; Max-Age=2592000; Path=/` } },
        );
      }

      if (path === "/logout" && request.method === "PUT") {
        const token = cookiesFrom(request.headers.get("Cookie")).get("auth");
        if (token) sessions.delete(token);
        return json({ success: { message: "Ok!", status_code: 200 } });
      }

      if (path === "/auth/user/friends" && request.method === "GET") {
        const session = sessionFor(request);
        if (!session?.twoFactorSatisfied) {
          return json(
            { error: { message: "Missing Credentials", status_code: 401 } },
            { status: 401 },
          );
        }
        // `offline` is a filter, not a field: one pass returns only half the list. Modelled
        // faithfully because a client that fetches only one half looks correct until every offline
        // friend silently disappears from the UI.
        const wantOffline = url.searchParams.get("offline") === "true";
        const n = Number(url.searchParams.get("n") ?? "100");
        const offset = Number(url.searchParams.get("offset") ?? "0");

        const all = (
          session.account.friends ?? [
            // Deliberately keyed on the account: a cross-account cache bug shows up here.
            {
              id: `usr_friend_of_${session.account.userId}`,
              displayName: "A Friend",
              online: true,
            },
          ]
        ).filter((f) => f.online !== wantOffline);

        return json(
          all.slice(offset, offset + n).map((f) => ({
            id: f.id,
            displayName: f.displayName,
            status: f.status ?? (f.online ? "active" : "offline"),
            statusDescription: "",
            location: f.location ?? (f.online ? "wrld_example:12345" : "offline"),
            tags: f.tags ?? [],
            platform: f.platform ?? "standalonewindows",
            // VRChat sends empty strings for unset images rather than omitting the field. Modelled
            // faithfully, because a `??` chain over these looks correct right up until it hands the
            // UI a blank `src`.
            userIcon: f.userIcon ?? "",
            profilePicOverride: "",
            currentAvatarImageUrl: "",
          })),
        );
      }

      return json({ error: { message: "Not Found", status_code: 404 } }, { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${String(server.port)}/api/1`,
    requests,
    sessionsMinted: () => minted,
    authTokenFor: (userId) => latestToken.get(userId) ?? null,
    setRateLimitNext: (count) => {
      rateLimitRemaining = count;
    },
    setNextLoginFailure: (status, message) => {
      nextLoginFailure = { status, message };
    },
    expireAllSessions: () => sessions.clear(),
    stop: () => {
      server.stop(true);
    },
  };
}
