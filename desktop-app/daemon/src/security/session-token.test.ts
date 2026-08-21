import { describe, expect, test } from "bun:test";
import {
  generateSessionToken,
  isWellFormedSessionToken,
  SESSION_TOKEN_LENGTH,
  sessionTokensMatch,
} from "./session-token.ts";

describe("session tokens", () => {
  test("are 32 bytes of hex and unique per call", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).toHaveLength(SESSION_TOKEN_LENGTH);
    expect(isWellFormedSessionToken(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  test("compare equal only to themselves", () => {
    const token = generateSessionToken();
    expect(sessionTokensMatch(token, token)).toBe(true);
    expect(sessionTokensMatch(token, generateSessionToken())).toBe(false);
  });

  test("compare without throwing on mismatched lengths", () => {
    // The naive `timingSafeEqual` on raw buffers throws here, which would turn a hostile token into
    // a 500 and leak the expected length.
    const token = generateSessionToken();
    expect(sessionTokensMatch("", token)).toBe(false);
    expect(sessionTokensMatch("x".repeat(4096), token)).toBe(false);
    expect(sessionTokensMatch(token.slice(0, -1), token)).toBe(false);
  });

  test("reject malformed tokens as ill-formed", () => {
    expect(isWellFormedSessionToken("")).toBe(false);
    expect(isWellFormedSessionToken("Z".repeat(SESSION_TOKEN_LENGTH))).toBe(false);
    expect(isWellFormedSessionToken(generateSessionToken().toUpperCase())).toBe(false);
  });
});
