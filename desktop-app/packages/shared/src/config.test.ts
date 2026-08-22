import { describe, expect, test } from "bun:test";
import { launchUrl, TOKEN_QUERY_PARAM } from "./config.ts";

describe("launchUrl", () => {
  test("attaches the token to the UI origin", () => {
    expect(launchUrl("http://127.0.0.1:7773", "plain-token")).toBe(
      "http://127.0.0.1:7773/?token=plain-token",
    );
  });

  test("escapes a token the query string could not carry verbatim", () => {
    // The regression this test exists for: the composition root built this URL inline without
    // encoding, so a `+` reached the daemon as a space and the token stopped matching.
    const url = launchUrl("http://127.0.0.1:7773", "a+b/c=d&e#f");
    expect(url).toBe("http://127.0.0.1:7773/?token=a%2Bb%2Fc%3Dd%26e%23f");

    // The round trip is the property that actually matters: whatever the daemon minted is what the
    // page reads back out.
    expect(new URL(url).searchParams.get(TOKEN_QUERY_PARAM)).toBe("a+b/c=d&e#f");
  });

  test("uses the shared parameter name rather than a literal", () => {
    expect(launchUrl("http://127.0.0.1:7773", "t")).toContain(`?${TOKEN_QUERY_PARAM}=`);
  });
});
