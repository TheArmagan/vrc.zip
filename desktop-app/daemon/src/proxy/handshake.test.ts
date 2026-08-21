import { beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "../bus/event-bus.ts";
import { createProxyApp, MIRROR_PREFIX } from "../servers/proxy.ts";
import { MEMORY, Store } from "../store/store.ts";
import { ConsentRegistry } from "./consent.ts";
import { guardEgress } from "./egress-filter.ts";
import type { ProxyDeps } from "./handshake.ts";

/**
 * The login handshake, end to end through the real mirror app **and the real egress guard**.
 *
 * The guard is not optional scenery here. The proxy's cookies only exist because the filter emits
 * them from marker headers, and the filter strips `Set-Cookie` unconditionally — so a handshake
 * tested without it would pass while shipping a login that sets no cookie at all.
 *
 * Written from the app's point of view throughout: a stock VRChat client library sends a Basic
 * auth login, branches on `requiresTwoFactorAuth`, POSTs a code, and gets a cookie. Every
 * assertion here is something such a client would actually observe.
 */

const PORT = 7774;
const UA = "MyApp/1.2.3 me@somewhere.dev";
const OTHER_UA = "OtherApp/0.1 other@somewhere.dev";

let store: Store;
let consent: ConsentRegistry;
let bus: EventBus;
let deps: ProxyDeps;
let fetchProxy: (path: string, init?: RequestInit) => Promise<Response>;
/** Codes are random by design; a test needs a known one, so the mint is injected. */
let nextCode = "424242";

beforeEach(() => {
  store = Store.open(MEMORY);
  bus = new EventBus();
  for (const [id, name] of [
    ["usr_alice", "Alice"],
    ["usr_bob", "Bob"],
  ] as const) {
    store.upsertAccount({
      id,
      display_name: name,
      added_at: 1,
      enabled: 1,
      last_seen_at: null,
    });
  }

  nextCode = "424242";
  consent = new ConsentRegistry({
    store,
    bus,
    mintCode: () => ({ token: nextCode, hash: hashOf(nextCode) }),
  });

  deps = {
    consent,
    grants: store,
    resolveAccount: (username) => {
      const map: Record<string, { id: string; displayName: string }> = {
        "alice@somewhere.dev": { id: "usr_alice", displayName: "Alice" },
        usr_alice: { id: "usr_alice", displayName: "Alice" },
        "bob@somewhere.dev": { id: "usr_bob", displayName: "Bob" },
      };
      return map[username] ?? null;
    },
    currentUser: (accountId) => ({
      id: accountId,
      displayName: accountId === "usr_alice" ? "Alice" : "Bob",
    }),
  };

  const app = createProxyApp({ port: PORT, deps });
  const guarded = guardEgress((request) => app.fetch(request));
  fetchProxy = (path, init) =>
    Promise.resolve(
      guarded(
        new Request(`http://127.0.0.1:${String(PORT)}${MIRROR_PREFIX}${path}`, {
          ...init,
          // A `Request` built by hand carries no `Host`, and `hostGuard` rejects an absent one —
          // correctly, since a real HTTP/1.1 request always has it. Supplying it here is what makes
          // these tests requests a browser or a client library could actually send.
          headers: { Host: `127.0.0.1:${String(PORT)}`, ...(init?.headers ?? {}) },
        }),
      ),
    );
});

function hashOf(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value, "utf8").digest("hex");
}

/** `b64(urlencode(username):urlencode(scopes))` — VRChat's own encoding, scopes where the password goes. */
function basic(username: string, scopes: string): string {
  const raw = `${encodeURIComponent(username)}:${encodeURIComponent(scopes)}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

function login(
  username: string,
  scopes: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetchProxy("/auth/user", {
    headers: { "User-Agent": UA, Authorization: basic(username, scopes), ...extra },
  });
}

/** The `auth` or `twoFactorAuth` value out of a response's cookies. */
function cookie(response: Response, name: string): string | null {
  for (const line of response.headers.getSetCookie()) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** The whole flow, as a client library performs it: login → code → cookie. */
async function pair(username = "alice@somewhere.dev", scopes = "friends:read"): Promise<string> {
  const challenge = await login(username, scopes);
  const half = cookie(challenge, "auth");
  const pending = consent.list()[0];
  const verify = await fetchProxy("/auth/twofactorauth/totp/verify", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Cookie: `auth=${half ?? ""}`,
    },
    body: JSON.stringify({ code: pending?.code }),
  });
  return cookie(verify, "auth") ?? "";
}

describe("GET /auth/user — the login", () => {
  test("answers a first login with VRChat's own pre-2FA response", async () => {
    const response = await login("alice@somewhere.dev", "friends:read,users:read");

    // Byte-for-byte what real VRChat sends, so the client's existing branch takes over from here
    // with no idea anything unusual happened.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requiresTwoFactorAuth: ["totp"] });
    expect(cookie(response, "auth")).toMatch(/^authcookie_.+_vrczip$/);
  });

  test("raises a consent sheet naming the app and everything it asked for", async () => {
    await login("alice@somewhere.dev", "friends:read,invite:send");

    const pending = consent.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.app).toEqual({
      name: "MyApp",
      version: "1.2.3",
      contact: "me@somewhere.dev",
    });
    expect(pending[0]?.scopes).toEqual(["friends:read", "invite:send"]);
    expect(pending[0]?.accountId).toBe("usr_alice");
    expect(pending[0]?.code).toBe("424242");
  });

  test("announces the sheet on the bus, because the user is probably elsewhere", async () => {
    // A consent prompt that only appears when some screen happens to be polling misses exactly the
    // case the pairing flow exists for.
    const seen: string[] = [];
    bus.subscribe(
      (event) => {
        seen.push(event.kind);
      },
      { kinds: ["consent.pending"] },
    );

    await login("alice@somewhere.dev", "friends:read");
    expect(seen).toEqual(["consent.pending"]);
  });

  test("a malformed User-Agent is VRChat's 403, waf_code and all", async () => {
    // Both byte-faithful and the correct thing to teach: an app that gets this from the proxy
    // learns it would get the same from VRChat.
    const response = await fetchProxy("/auth/user", {
      headers: { "User-Agent": "MyApp", Authorization: basic("alice@somewhere.dev", "") },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { waf_code: number; message: string } };
    expect(body.error.waf_code).toBe(13799);
    // VRChat double-encodes `message` — a JSON string inside the JSON.
    expect(body.error.message).toBe('"Forbidden"');
  });

  test("an unrecognised username is a 401, never a fallback to some other account", async () => {
    // An app silently acting as the wrong account is the worst failure mode this system can have.
    const response = await login("nobody@somewhere.dev", "friends:read");

    expect(response.status).toBe(401);
    expect(consent.list()).toHaveLength(0);
  });

  test("an unknown scope is refused outright rather than dropped", async () => {
    const response = await login("alice@somewhere.dev", "friends:read,friends:reed");

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; unknownScopes: string[] } };
    expect(body.error.code).toBe("unknown_scope");
    expect(body.error.unknownScopes).toEqual(["friends:reed"]);
    expect(consent.list()).toHaveLength(0);
  });

  test("the reserved username defers the account choice to the sheet", async () => {
    const response = await login("*", "friends:read");

    expect(response.status).toBe(200);
    expect(consent.list()[0]?.accountId).toBeNull();
    expect(consent.list()[0]?.requestedUsername).toBe("*");
  });

  test("an empty scope list means the minimal read-only default", async () => {
    await login("alice@somewhere.dev", "");
    expect(consent.list()[0]?.scopes).toContain("friends:read");
    expect(consent.list()[0]?.scopes).not.toContain("invite:send");
  });
});

describe("POST /auth/twofactorauth/:method/verify — the consent gesture", () => {
  test("the right code mints a grant and returns both cookies", async () => {
    const challenge = await login("alice@somewhere.dev", "friends:read");
    const half = cookie(challenge, "auth");

    const response = await fetchProxy("/auth/twofactorauth/totp/verify", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Cookie: `auth=${half ?? ""}`,
      },
      body: JSON.stringify({ code: "424242" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verified: true });

    const token = cookie(response, "auth");
    expect(token).toMatch(/^authcookie_.+_vrczip$/);
    expect(token).not.toBe(half);
    // Device trust, so the app's next start looks normal rather than re-prompting.
    expect(cookie(response, "twoFactorAuth")).toMatch(/^authcookie_.+_vrczip$/);

    const grant = store.grantByTokenHash(hashOf(token ?? ""));
    expect(grant?.account_id).toBe("usr_alice");
    expect(JSON.parse(grant?.scopes ?? "[]")).toEqual(["friends:read"]);
  });

  test("all three verifiers work, because a client picks whichever it prefers", async () => {
    for (const method of ["totp", "emailotp", "otp"]) {
      const challenge = await login("alice@somewhere.dev", "friends:read");
      const half = cookie(challenge, "auth");
      const pending = consent.list().at(-1);

      const response = await fetchProxy(`/auth/twofactorauth/${method}/verify`, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/json",
          Cookie: `auth=${half ?? ""}`,
        },
        body: JSON.stringify({ code: pending?.code }),
      });
      expect(await response.json()).toEqual({ verified: true });
    }
  });

  test("a wrong code is byte-faithfully false and issues nothing", async () => {
    const challenge = await login("alice@somewhere.dev", "friends:read");
    const half = cookie(challenge, "auth");

    const response = await fetchProxy("/auth/twofactorauth/totp/verify", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Cookie: `auth=${half ?? ""}`,
      },
      body: JSON.stringify({ code: "000000" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verified: false });
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(store.listGrants()).toHaveLength(0);
  });

  test("a code is single-use", async () => {
    const challenge = await login("alice@somewhere.dev", "friends:read");
    const half = cookie(challenge, "auth");
    const body = JSON.stringify({ code: "424242" });
    const headers = {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Cookie: `auth=${half ?? ""}`,
    };

    const first = await fetchProxy("/auth/twofactorauth/totp/verify", {
      method: "POST",
      headers,
      body,
    });
    const second = await fetchProxy("/auth/twofactorauth/totp/verify", {
      method: "POST",
      headers,
      body,
    });

    expect(await first.json()).toEqual({ verified: true });
    expect(await second.json()).toEqual({ verified: false });
    expect(store.listGrants()).toHaveLength(1);
  });

  test("a correct code with no account chosen yet still refuses", async () => {
    // The code is only *shown* once there is an account for it to authorise. Pairing to nothing
    // would either fail later or — far worse — pick an account on the user's behalf.
    const challenge = await login("*", "friends:read");
    const half = cookie(challenge, "auth");

    const response = await fetchProxy("/auth/twofactorauth/totp/verify", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Cookie: `auth=${half ?? ""}`,
      },
      body: JSON.stringify({ code: "424242" }),
    });

    expect(await response.json()).toEqual({ verified: false });
    expect(store.listGrants()).toHaveLength(0);
  });

  test("the account picked at the sheet is the one the grant binds to", async () => {
    const challenge = await login("*", "friends:read");
    const half = cookie(challenge, "auth");
    const pending = consent.list()[0];
    consent.attachAccount(pending?.id ?? "", "usr_bob");

    const response = await fetchProxy("/auth/twofactorauth/totp/verify", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Cookie: `auth=${half ?? ""}`,
      },
      body: JSON.stringify({ code: "424242" }),
    });

    const token = cookie(response, "auth");
    expect(store.grantByTokenHash(hashOf(token ?? ""))?.account_id).toBe("usr_bob");
  });

  test("a verify with no cookie at all is missing credentials, not a wrong code", async () => {
    const response = await fetchProxy("/auth/twofactorauth/totp/verify", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "424242" }),
    });
    expect(response.status).toBe(401);
  });

  test("an unparseable body is a failed verification, not a 500", async () => {
    const challenge = await login("alice@somewhere.dev", "friends:read");
    const half = cookie(challenge, "auth");

    const response = await fetchProxy("/auth/twofactorauth/totp/verify", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Cookie: `auth=${half ?? ""}`,
      },
      body: "not json",
    });
    expect(await response.json()).toEqual({ verified: false });
  });

  test("a verifier VRChat does not have is a 404", async () => {
    const response = await fetchProxy("/auth/twofactorauth/carrierpigeon/verify", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });
});

describe("after the pairing", () => {
  test("GET /auth/user with the cookie returns the CurrentUser", async () => {
    const token = await pair();

    const response = await fetchProxy("/auth/user", {
      headers: { "User-Agent": UA, Cookie: `auth=${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "usr_alice", displayName: "Alice" });
  });

  test("GET /auth returns our token, never the real one", async () => {
    // Returning the upstream body verbatim here is one of PLAN.md's named leak paths: it hands the
    // app the real session in a field it was only asking us to confirm.
    const token = await pair();

    const response = await fetchProxy("/auth", {
      headers: { "User-Agent": UA, Cookie: `auth=${token}` },
    });

    expect(await response.json()).toEqual({ ok: true, token });
    expect(token).toEndWith("_vrczip");
  });

  test("PUT /logout revokes the grant and nothing else", async () => {
    const token = await pair();

    const response = await fetchProxy("/logout", {
      method: "PUT",
      headers: { "User-Agent": UA, Cookie: `auth=${token}` },
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { success: unknown }).toHaveProperty("success");
    expect(store.grantByTokenHash(hashOf(token))).toBeNull();

    // And the token is dead immediately, not at the next restart.
    const after = await fetchProxy("/auth/user", {
      headers: { "User-Agent": UA, Cookie: `auth=${token}` },
    });
    expect(after.status).toBe(401);
  });

  test("a revoked grant's app can log in again, and gets a fresh consent sheet", async () => {
    const token = await pair();
    await fetchProxy("/logout", {
      method: "PUT",
      headers: { "User-Agent": UA, Cookie: `auth=${token}` },
    });

    const response = await login("alice@somewhere.dev", "friends:read");
    expect(await response.json()).toEqual({ requiresTwoFactorAuth: ["totp"] });
  });

  test("an unknown cookie is missing credentials", async () => {
    const response = await fetchProxy("/auth/user", {
      headers: { "User-Agent": UA, Cookie: "auth=authcookie_made-up_vrczip" },
    });
    expect(response.status).toBe(401);
  });
});

describe("device trust", () => {
  async function pairWithDevice(): Promise<{ auth: string; device: string }> {
    const challenge = await login("alice@somewhere.dev", "friends:read");
    const half = cookie(challenge, "auth");
    const verify = await fetchProxy("/auth/twofactorauth/totp/verify", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Cookie: `auth=${half ?? ""}`,
      },
      body: JSON.stringify({ code: "424242" }),
    });
    return { auth: cookie(verify, "auth") ?? "", device: cookie(verify, "twoFactorAuth") ?? "" };
  }

  test("a trusted device logs straight in, with no second consent sheet", async () => {
    const { device } = await pairWithDevice();

    const response = await login("alice@somewhere.dev", "friends:read", {
      Cookie: `twoFactorAuth=${device}`,
    });

    expect(await response.json()).toEqual({ id: "usr_alice", displayName: "Alice" });
    expect(cookie(response, "auth")).toMatch(/^authcookie_.+_vrczip$/);
    expect(consent.list()).toHaveLength(0);
  });

  test("a wider scope request re-prompts even on a trusted device", async () => {
    // Escalation must not ride in on device trust; the point of the sheet is the *new* ask.
    const { device } = await pairWithDevice();

    const response = await login("alice@somewhere.dev", "friends:read,invite:send", {
      Cookie: `twoFactorAuth=${device}`,
    });

    expect(await response.json()).toEqual({ requiresTwoFactorAuth: ["totp"] });
    // And the sheet shows only the delta, not the scope the user already approved.
    expect(consent.list()[0]?.newScopes).toEqual(["invite:send"]);
    expect(consent.list()[0]?.scopes).toEqual(["friends:read", "invite:send"]);
  });

  test("another app cannot ride in on a device cookie it got hold of", async () => {
    // Any local process can send another app's User-Agent, which is exactly why an existing grant
    // is not itself proof of identity.
    const { device } = await pairWithDevice();

    const response = await fetchProxy("/auth/user", {
      headers: {
        "User-Agent": OTHER_UA,
        Authorization: basic("alice@somewhere.dev", "friends:read"),
        Cookie: `twoFactorAuth=${device}`,
      },
    });

    expect(await response.json()).toEqual({ requiresTwoFactorAuth: ["totp"] });
  });

  test("a device cookie cannot be pointed at a different account", async () => {
    const { device } = await pairWithDevice();

    const response = await login("bob@somewhere.dev", "friends:read", {
      Cookie: `twoFactorAuth=${device}`,
    });

    expect(await response.json()).toEqual({ requiresTwoFactorAuth: ["totp"] });
  });

  test("an existing grant alone never skips consent", async () => {
    // The app has a grant but presents no device cookie — a restarted app that lost its cookies,
    // or something wearing its name. Either way the sheet is the only way through.
    await pair();

    const response = await login("alice@somewhere.dev", "friends:read");
    expect(await response.json()).toEqual({ requiresTwoFactorAuth: ["totp"] });
  });

  test("re-logging in issues a new grant and leaves the running one working", async () => {
    // Rotating the existing grant's token would kill a running instance of the app mid-request.
    const first = await pairWithDevice();
    const second = await login("alice@somewhere.dev", "friends:read", {
      Cookie: `twoFactorAuth=${first.device}`,
    });

    const secondToken = cookie(second, "auth") ?? "";
    expect(store.grantByTokenHash(hashOf(first.auth))).not.toBeNull();
    expect(store.grantByTokenHash(hashOf(secondToken))).not.toBeNull();
    expect(secondToken).not.toBe(first.auth);
  });
});

describe("the rest of the mirror", () => {
  test("a known operation says it is not built yet, and names itself", async () => {
    const response = await fetchProxy("/users/usr_bob", { headers: { "User-Agent": UA } });

    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: { operationId: string; scope: string } };
    expect(body.error.operationId).toBe("getUser");
    expect(body.error.scope).toBe("users:read");
  });

  test("an unknown path is VRChat's real 404, not a catch-all's guess", async () => {
    const response = await fetchProxy("/no/such/endpoint", { headers: { "User-Agent": UA } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { message: '"Not Found"', status_code: 404 } });
  });

  test("a control route is not reachable on the mirror port", async () => {
    // The separation PLAN.md §1.8 insists on, restated now that the port actually serves things.
    const response = await Promise.resolve(
      guardEgress((request) => createProxyApp({ port: PORT, deps }).fetch(request))(
        new Request(`http://127.0.0.1:${String(PORT)}/api/status`, {
          headers: { Host: `127.0.0.1:${String(PORT)}`, "User-Agent": UA },
        }),
      ),
    );
    expect(response.status).toBe(404);
  });

  test("a rebinding Host is refused before anything else runs", async () => {
    const app = createProxyApp({ port: PORT, deps });
    const response = await app.fetch(
      new Request(`http://evil.example.com/${MIRROR_PREFIX}/auth/user`, {
        headers: { Host: "evil.example.com", "User-Agent": UA },
      }),
    );
    expect(response.status).toBe(403);
  });
});
