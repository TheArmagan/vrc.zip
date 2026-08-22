import { describe, expect, test } from "bun:test";
import { classifyIpLiteral, validateWebhookUrl, WebhookUrlError } from "./url.ts";

/**
 * The SSRF boundary. Every case here is a URL that, without the check, would make the daemon issue
 * an unauthenticated request inside the user's own network and hand the response back in
 * `last_error` — see the header on `url.ts`.
 */

function reasonFor(raw: string): string {
  try {
    validateWebhookUrl(raw);
  } catch (error) {
    if (error instanceof WebhookUrlError) return error.reason;
    throw error;
  }
  return "accepted";
}

describe("validateWebhookUrl", () => {
  test("accepts a public https endpoint and returns it normalised", () => {
    expect(validateWebhookUrl("https://hooks.example.com/vrcz")).toBe(
      "https://hooks.example.com/vrcz",
    );
    // `URL` lowercases the host and adds the root path; the *stored* value must be the one the
    // checks ran against, so normalisation happening here rather than at the call site matters.
    expect(validateWebhookUrl("https://HOOKS.Example.COM")).toBe("https://hooks.example.com/");
  });

  test("allows plain http only to loopback", () => {
    expect(validateWebhookUrl("http://127.0.0.1:9000/hook")).toBe("http://127.0.0.1:9000/hook");
    expect(validateWebhookUrl("http://localhost:9000/hook")).toBe("http://localhost:9000/hook");
    expect(validateWebhookUrl("http://[::1]:9000/hook")).toBe("http://[::1]:9000/hook");

    expect(reasonFor("http://hooks.example.com/vrcz")).toBe("insecure_scheme");
  });

  test("refuses the private and reserved ranges an SSRF would aim at", () => {
    for (const host of [
      "10.0.0.1",
      "172.16.4.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // the cloud metadata address
      "100.64.0.1", // carrier-grade NAT
      "0.0.0.0",
      "224.0.0.1", // multicast
      "255.255.255.255",
    ]) {
      expect(reasonFor(`https://${host}/hook`)).toBe("private_address");
    }
  });

  test("sees through the alternate spellings `URL` canonicalises", () => {
    // `URL` turns both of these into 127.0.0.1 before we ever look, which is why the check is on
    // the parsed hostname and not on the string the caller typed.
    expect(reasonFor("http://2130706433/hook")).toBe("accepted");
    expect(reasonFor("http://0x7f000001/hook")).toBe("accepted");
  });

  test("refuses IPv6 private, link-local, multicast, and IPv4-mapped private addresses", () => {
    for (const host of ["[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[ff02::1]", "[::]"]) {
      expect(reasonFor(`https://${host}/hook`)).toBe("private_address");
    }

    // The one a v6 check without IPv4-mapped support waves straight through.
    expect(reasonFor("https://[::ffff:169.254.169.254]/hook")).toBe("private_address");
    expect(reasonFor("http://[::ffff:127.0.0.1]/hook")).toBe("accepted");
  });

  test("refuses LAN-shaped names, credentials, other schemes, and non-URLs", () => {
    expect(reasonFor("http://nas/hook")).toBe("private_address");
    expect(reasonFor("http://printer.local/hook")).toBe("private_address");
    expect(reasonFor("https://user:pass@hooks.example.com/")).toBe("credentials_in_url");
    expect(reasonFor("ftp://hooks.example.com/")).toBe("bad_scheme");
    expect(reasonFor("file:///etc/passwd")).toBe("bad_scheme");
    expect(reasonFor("not a url")).toBe("invalid_url");
    expect(reasonFor("")).toBe("invalid_url");
    expect(reasonFor(`https://hooks.example.com/${"x".repeat(3000)}`)).toBe("invalid_url");
  });
});

describe("classifyIpLiteral", () => {
  test("returns null for anything that is not an address, so names fall through to the name rules", () => {
    expect(classifyIpLiteral("hooks.example.com")).toBeNull();
    expect(classifyIpLiteral("1.2.3")).toBeNull();
    expect(classifyIpLiteral("999.1.1.1")).toBeNull();
    expect(classifyIpLiteral("[gggg::1]")).toBeNull();
  });

  test("classifies the loopback forms", () => {
    expect(classifyIpLiteral("127.0.0.1")).toBe("loopback");
    expect(classifyIpLiteral("127.13.9.2")).toBe("loopback");
    expect(classifyIpLiteral("[::1]")).toBe("loopback");
  });

  test("classifies a routable address as public", () => {
    expect(classifyIpLiteral("93.184.216.34")).toBe("public");
    expect(classifyIpLiteral("[2606:2800:220:1::1]")).toBe("public");
  });
});
