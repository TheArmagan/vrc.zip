import { describe, expect, test } from "bun:test";
import { DEFAULT_SCOPES } from "@vrcz/shared";
import {
  isAccountPicker,
  missingScopes,
  parseAppIdentity,
  parseBasicAuth,
  parseScopeRequest,
} from "./identity.ts";

describe("parseAppIdentity", () => {
  test("parses VRChat's mandated User-Agent shape", () => {
    expect(parseAppIdentity("MyApp/1.2.3 me@somewhere.dev")).toEqual({
      name: "MyApp",
      version: "1.2.3",
      contact: "me@somewhere.dev",
    });
  });

  test("accepts the parenthesised contact most clients actually send", () => {
    // `vrc.zip/0.1.0 (me@somewhere.dev)` is the form our own UA builder emits, so the proxy would
    // reject its own shape if this were not handled.
    expect(parseAppIdentity("MyApp/1.0 (me@somewhere.dev)")?.contact).toBe("me@somewhere.dev");
  });

  test("rejects a UA that cannot identify who to blame", () => {
    for (const ua of [null, undefined, "", "   ", "MyApp", "MyApp/1.0", "/1.0 me@somewhere.dev"]) {
      expect(parseAppIdentity(ua)).toBeNull();
    }
  });

  test("rejects the placeholder contacts from copy-pasted sample code", () => {
    // A contact nobody reads is the same as no contact, and these two are everywhere.
    expect(parseAppIdentity("MyApp/1.0 someone@example.com")).toBeNull();
    expect(parseAppIdentity("MyApp/1.0 your@email.here")).toBeNull();
  });
});

describe("parseBasicAuth", () => {
  function basic(username: string, secret: string): string {
    const raw = `${encodeURIComponent(username)}:${encodeURIComponent(secret)}`;
    return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }

  test("round-trips VRChat's own url-encoded encoding", () => {
    expect(parseBasicAuth(basic("me+tag@somewhere.dev", "friends:read,users:read"))).toEqual({
      username: "me+tag@somewhere.dev",
      secret: "friends:read,users:read",
    });
  });

  test("splits on the first colon, so a scope list keeps its colons", () => {
    expect(parseBasicAuth(basic("alice", "invite:send"))?.secret).toBe("invite:send");
  });

  test("rejects malformed headers rather than guessing", () => {
    expect(parseBasicAuth(null)).toBeNull();
    expect(parseBasicAuth("Bearer abc")).toBeNull();
    // No colon at all: there is no username/secret split to make.
    expect(parseBasicAuth(`Basic ${Buffer.from("nocolon").toString("base64")}`)).toBeNull();
    // A stray `%` that is not a valid escape.
    expect(parseBasicAuth(`Basic ${Buffer.from("a%zz:b").toString("base64")}`)).toBeNull();
  });
});

describe("parseScopeRequest", () => {
  test("an empty request means the minimal read-only default set", () => {
    const result = parseScopeRequest("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(DEFAULT_SCOPES);
  });

  test("a wildcard never reaches a dangerous scope", () => {
    const result = parseScopeRequest("*");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopes).toContain("friends:read");
      // The list PLAN.md §Enforcement names as never wildcard-reachable.
      for (const dangerous of [
        "account:credentials",
        "account:destroy",
        "moderation:write",
        "files:delete",
        "invite:send",
        "groups:owner",
        "favorites:group:clear",
        "instances:close",
        "economy:write",
      ]) {
        expect(result.scopes).not.toContain(dangerous);
      }
    }
  });

  test("an unknown scope is a hard failure, never silently dropped", () => {
    // The failure mode this exists for: `friends:reed` accepted, then a 403 hours later somewhere
    // unrelated that nobody can trace back to a typo.
    const result = parseScopeRequest("friends:read,friends:reed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unknown).toEqual(["friends:reed"]);
  });

  test("deduplicates and tolerates whitespace", () => {
    const result = parseScopeRequest(" friends:read , friends:read ,users:read");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(["friends:read", "users:read"]);
  });
});

test("the reserved usernames mean let-the-user-choose", () => {
  expect(isAccountPicker("")).toBe(true);
  expect(isAccountPicker("*")).toBe(true);
  expect(isAccountPicker("alice@somewhere.dev")).toBe(false);
});

test("missingScopes is the delta a re-consent sheet shows", () => {
  expect(missingScopes(["friends:read"], ["friends:read", "invite:send"])).toEqual(["invite:send"]);
  expect(missingScopes(["friends:read", "invite:send"], ["friends:read"])).toEqual([]);
});
