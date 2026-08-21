import { describe, expect, test } from "bun:test";
import {
  hashProxyToken,
  isProxyToken,
  looksLikeRealAuthCookie,
  mintPairingCode,
  mintProxyToken,
  secretsMatch,
  VRCZIP_TOKEN_SUFFIX,
} from "./proxy-tokens.ts";

describe("proxy tokens", () => {
  test("wear VRChat's shape with our suffix", () => {
    const { token } = mintProxyToken();
    // Clients that sanity-check the prefix or parse the uuid keep working; the suffix is what makes
    // a leaked token inert against api.vrchat.cloud and greppable in a user's logs.
    expect(token).toMatch(
      /^authcookie_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_vrczip$/,
    );
    expect(token.endsWith(VRCZIP_TOKEN_SUFFIX)).toBe(true);
  });

  test("are unique per mint", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintProxyToken().token));
    expect(tokens.size).toBe(200);
  });

  test("carry their own hash, and the hash is stable", () => {
    const { token, hash } = mintProxyToken();
    expect(hash).toBe(hashProxyToken(token));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
  });

  test("classify ours and VRChat's apart by shape alone", () => {
    const ours = mintProxyToken().token;
    const theirs = "authcookie_2e0a5f9c-1b3d-4a77-9f0e-6c1d2b3a4e5f";

    expect(isProxyToken(ours)).toBe(true);
    expect(looksLikeRealAuthCookie(ours)).toBe(false);

    expect(isProxyToken(theirs)).toBe(false);
    expect(looksLikeRealAuthCookie(theirs)).toBe(true);

    // Not an authcookie at all — a session token, a bearer, anything else.
    expect(looksLikeRealAuthCookie("some-other-value")).toBe(false);
  });
});

describe("pairing codes", () => {
  test("are six digits, zero-padded", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(mintPairingCode().token).toMatch(/^\d{6}$/);
    }
  });

  test("keep leading zeros rather than collapsing to a shorter code", () => {
    // A code that renders as "42" in the UI and is typed as "42" but stored as "000042" is a
    // pairing that can never succeed.
    expect(mintPairingCode(() => 42).token).toBe("000042");
  });

  test("cover the whole range", () => {
    expect(mintPairingCode(() => 0).token).toBe("000000");
    expect(mintPairingCode(() => 999_999).token).toBe("999999");
  });

  test("are hashed like tokens, so the store never holds a live code", () => {
    const code = mintPairingCode(() => 123_456);
    expect(code.hash).toBe(hashProxyToken("123456"));
  });
});

describe("secretsMatch", () => {
  test("compares equal-length secrets", () => {
    expect(secretsMatch("123456", "123456")).toBe(true);
    expect(secretsMatch("123456", "123457")).toBe(false);
  });

  test("returns false rather than throwing on a length mismatch", () => {
    // `timingSafeEqual` throws on unequal lengths, and an exception on the verify path would be a
    // 500 where a plain "wrong code" belongs.
    expect(secretsMatch("123456", "1234")).toBe(false);
    expect(secretsMatch("", "123456")).toBe(false);
  });
});
