import { describe, expect, test } from "bun:test";
import { AUTH_COOKIE, CookieJar, parseSetCookie, TWO_FACTOR_COOKIE } from "./cookie-jar.ts";

const NOW = 1_750_000_000_000;

describe("parseSetCookie", () => {
  test("parses a bare name=value as a session cookie", () => {
    expect(parseSetCookie("auth=authcookie_abc", NOW)).toEqual({
      name: "auth",
      value: "authcookie_abc",
      expiresAt: null,
    });
  });

  test("Max-Age wins over Expires when both are present", () => {
    // RFC 6265 §5.3. Getting this backwards honours a stale absolute date over a fresh relative one.
    const cookie = parseSetCookie(
      "auth=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600; Path=/",
      NOW,
    );
    expect(cookie?.expiresAt).toBe(NOW + 3_600_000);
  });

  test("falls back to Expires when there is no Max-Age", () => {
    const cookie = parseSetCookie("auth=x; Expires=Wed, 15 Jun 2033 10:00:00 GMT", NOW);
    expect(cookie?.expiresAt).toBe(Date.parse("Wed, 15 Jun 2033 10:00:00 GMT"));
  });

  test("ignores a non-numeric Max-Age rather than treating it as zero", () => {
    const cookie = parseSetCookie("auth=x; Max-Age=forever", NOW);
    expect(cookie?.expiresAt).toBeNull();
  });

  test("keeps values that contain '=' intact", () => {
    // Base64 payloads end in padding; splitting on every '=' would truncate them.
    expect(parseSetCookie("t=YWJjZA==; Path=/", NOW)?.value).toBe("YWJjZA==");
  });

  test("returns null for malformed headers rather than guessing", () => {
    expect(parseSetCookie("", NOW)).toBeNull();
    expect(parseSetCookie("novalue", NOW)).toBeNull();
    expect(parseSetCookie("=orphaned", NOW)).toBeNull();
  });
});

describe("CookieJar", () => {
  function headersWith(...setCookies: string[]): Headers {
    const headers = new Headers();
    for (const value of setCookies) headers.append("Set-Cookie", value);
    return headers;
  }

  test("absorbs multiple Set-Cookie headers from one response", () => {
    // getSetCookie() is load-bearing: headers.get("set-cookie") folds these into one comma-joined
    // string, and cookie dates contain commas, so splitting it back apart is unreliable.
    const jar = new CookieJar();
    jar.applyResponse(
      headersWith(
        "auth=authcookie_abc; Path=/; HttpOnly",
        "twoFactorAuth=tfa_xyz; Max-Age=2592000; Path=/",
      ),
      NOW,
    );
    expect(jar.get(AUTH_COOKIE, NOW)).toBe("authcookie_abc");
    expect(jar.get(TWO_FACTOR_COOKIE, NOW)).toBe("tfa_xyz");
  });

  test("treats an empty value or a past expiry as a deletion", () => {
    const jar = new CookieJar([{ name: "auth", value: "old", expiresAt: null }]);
    jar.applyResponse(headersWith("auth=; Path=/"), NOW);
    expect(jar.get(AUTH_COOKIE, NOW)).toBeUndefined();

    jar.set({ name: "auth", value: "again", expiresAt: null });
    jar.applyResponse(headersWith("auth=whatever; Max-Age=-1"), NOW);
    expect(jar.get(AUTH_COOKIE, NOW)).toBeUndefined();
  });

  test("drops expired cookies lazily on read and on serialize", () => {
    const jar = new CookieJar([
      { name: "live", value: "1", expiresAt: NOW + 1000 },
      { name: "dead", value: "2", expiresAt: NOW - 1000 },
    ]);
    expect(jar.get("dead", NOW)).toBeUndefined();
    expect(jar.header(NOW)).toBe("live=1");
    expect(jar.size).toBe(1);
  });

  test("header() is undefined when nothing is live, not an empty string", () => {
    // An empty `Cookie:` header is not the same as sending none; VRChat sees the difference.
    expect(new CookieJar().header(NOW)).toBeUndefined();
    expect(
      new CookieJar([{ name: "x", value: "1", expiresAt: NOW - 1 }]).header(NOW),
    ).toBeUndefined();
  });

  test("persists session cookies, because VRChat's auth cookie has no Max-Age", () => {
    // Dropping it on shutdown would force a Basic-auth login on every start, minting a new session
    // against an undisclosed cap. See PLAN.md §Guardrails "Session frugality".
    const jar = new CookieJar();
    jar.applyResponse(headersWith("auth=authcookie_abc; Path=/; HttpOnly"), NOW);
    expect(jar.toPersistable(NOW)).toEqual([
      { name: "auth", value: "authcookie_abc", expiresAt: null },
    ]);
  });

  test("two jars never share state", () => {
    // The isolation this class exists for: GET /users/{id} returns different fields depending on
    // whether the caller is a friend, so cross-account bleed is a correctness bug.
    const a = new CookieJar();
    const b = new CookieJar();
    a.applyResponse(headersWith("auth=account_a"), NOW);
    b.applyResponse(headersWith("auth=account_b"), NOW);

    expect(a.header(NOW)).toBe("auth=account_a");
    expect(b.header(NOW)).toBe("auth=account_b");

    a.clear();
    expect(b.get(AUTH_COOKIE, NOW)).toBe("account_b");
  });

  test("round-trips through persistence", () => {
    const original = new CookieJar();
    original.applyResponse(
      headersWith("auth=authcookie_abc", "twoFactorAuth=tfa_xyz; Max-Age=2592000"),
      NOW,
    );
    const restored = new CookieJar(original.toPersistable(NOW));
    expect(restored.header(NOW)).toBe(original.header(NOW));
  });
});
