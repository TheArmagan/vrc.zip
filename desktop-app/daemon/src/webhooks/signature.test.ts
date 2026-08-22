import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  mintWebhookSecret,
  signingPayload,
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_SECRET_PREFIX,
  webhookKeyHash,
} from "./signature.ts";

describe("mintWebhookSecret", () => {
  test("mints a prefixed secret and a key that is not the secret", () => {
    const { secret, keyHash } = mintWebhookSecret();

    expect(secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(keyHash).toBe(webhookKeyHash(secret));
    expect(keyHash).not.toContain(secret);
    // Two registrations must never collide.
    expect(mintWebhookSecret().secret).not.toBe(secret);
  });
});

describe("signWebhookBody", () => {
  test("is HMAC-SHA256 over the timestamp, a dot, and the body, spelled out independently", () => {
    // Recomputed here from primitives rather than by calling the implementation, so this test
    // fails if the scheme changes rather than agreeing with whatever it became.
    const key = webhookKeyHash("whsec_abc");
    const body = `{"kind":"friend.online"}`;
    const expected = createHmac("sha256", key)
      .update(`1700000000000.${body}`, "utf8")
      .digest("hex");

    expect(signWebhookBody(key, 1_700_000_000_000, body)).toBe(`sha256=${expected}`);
    expect(signingPayload(1_700_000_000_000, body)).toBe(`1700000000000.${body}`);
  });

  test("the timestamp is covered, so a replay cannot be re-stamped", () => {
    const key = webhookKeyHash("whsec_abc");
    expect(signWebhookBody(key, 1, "x")).not.toBe(signWebhookBody(key, 2, "x"));
  });
});

describe("verifyWebhookSignature", () => {
  test("accepts a signature made from the same secret and rejects everything else", () => {
    const { secret, keyHash } = mintWebhookSecret();
    const body = `{"id":"e1"}`;
    const signature = signWebhookBody(keyHash, 42, body);

    expect(verifyWebhookSignature(secret, 42, body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, 43, body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, 42, `${body} `, signature)).toBe(false);
    expect(verifyWebhookSignature(mintWebhookSecret().secret, 42, body, signature)).toBe(false);
  });

  test("a malformed header is a rejection, not a throw", () => {
    // `timingSafeEqual` throws on a length mismatch, which would turn a junk header into a 500.
    const { secret } = mintWebhookSecret();
    expect(verifyWebhookSignature(secret, 42, "x", "")).toBe(false);
    expect(verifyWebhookSignature(secret, 42, "x", "sha256=nope")).toBe(false);
  });
});
