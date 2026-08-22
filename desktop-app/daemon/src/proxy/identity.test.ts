import { describe, expect, test } from "bun:test";
import { ALL_SCOPES, DEFAULT_SCOPES, expandSuperWildcard, expandWildcard } from "@vrcz/shared";
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

  test("parses the space-separated shape VRCX actually sends", () => {
    // The exact string off a real VRCX build. The strict `Name/Version contact` rule answered this
    // with waf_code 13799, which VRChat itself does not — VRCX works against the real API with it.
    expect(parseAppIdentity("VRCX 2026.07.18")).toEqual({
      name: "VRCX",
      version: "2026.07.18",
      contact: "",
    });
  });

  test("accepts a name with no version and no contact", () => {
    expect(parseAppIdentity("MyApp")).toEqual({ name: "MyApp", version: "", contact: "" });
    expect(parseAppIdentity("MyApp/1.0")).toEqual({ name: "MyApp", version: "1.0", contact: "" });
  });

  test("takes the second word as a version only when it looks like one", () => {
    expect(parseAppIdentity("My App")).toEqual({ name: "My", version: "", contact: "App" });
    expect(parseAppIdentity("Tool v2 me@somewhere.dev")).toEqual({
      name: "Tool",
      version: "v2",
      contact: "me@somewhere.dev",
    });
  });

  test("rejects a UA that names nothing at all", () => {
    for (const ua of [null, undefined, "", "   "]) {
      expect(parseAppIdentity(ua)).toBeNull();
    }
  });

  test("rejects an HTTP library advertising itself instead of an app", () => {
    // The half of the old strict rule worth keeping: these name a library, not something a user
    // could recognise on a consent sheet, and VRChat's WAF blocks several of them outright.
    for (const ua of ["python-requests/2.31.0", "curl/8.4.0", "axios/1.6.2", "okhttp/4.12.0"]) {
      expect(parseAppIdentity(ua)).toBeNull();
    }
  });

  test("drops a placeholder contact rather than failing the whole app", () => {
    // Same judgement as before — a contact nobody reads is the same as no contact — applied to a
    // field that is now optional, so it costs the app its contact and not its login.
    expect(parseAppIdentity("MyApp/1.0 someone@example.com")).toEqual({
      name: "MyApp",
      version: "1.0",
      contact: "",
    });
    expect(parseAppIdentity("MyApp/1.0 your@email.here")?.contact).toBe("");
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

describe("a password is not a typo'd scope list", () => {
  test("a real password gets the minimal default set, not a 400", () => {
    // PLAN.md claims a stock VRChat client works unmodified. An unmodified client puts a real
    // password here, because it has never heard of vrc.zip. VRCX is exactly this case.
    expect(parseScopeRequest("hunter2")).toEqual({ ok: true, scopes: DEFAULT_SCOPES });
    expect(parseScopeRequest("P@ssw0rd!, with a comma")).toEqual({
      ok: true,
      scopes: DEFAULT_SCOPES,
    });
    // Even one containing a colon, as long as it names no resource the registry knows.
    expect(parseScopeRequest("correct:horse:battery")).toEqual({
      ok: true,
      scopes: DEFAULT_SCOPES,
    });
  });

  test("a typo among real scopes is still a hard failure", () => {
    // The distinction that makes the fallback safe: `friends` is a resource the registry knows, so
    // this was plainly meant as scopes and `reed` is a mistake worth naming.
    expect(parseScopeRequest("friends:reed")).toEqual({ ok: false, unknown: ["friends:reed"] });
    expect(parseScopeRequest("users:read,friends:reed")).toEqual({
      ok: false,
      unknown: ["friends:reed"],
    });
  });

  test("the default set can draw every picture a client shows", () => {
    // Without files:read the default grant produces an app whose every avatar is a 403.
    expect(DEFAULT_SCOPES).toContain("files:read");
  });
});

describe("wildcards", () => {
  test("* grants every scope that is not dangerous", () => {
    const result = parseScopeRequest("*");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scopes).toEqual(expandWildcard());
    // The rule `*` exists to enforce: dangerous scopes must be asked for by name.
    expect(result.scopes).not.toContain("account:destroy");
    expect(result.scopes).toContain("friends:read");
  });

  test("** grants every scope, dangerous ones included", () => {
    const result = parseScopeRequest("**");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.scopes].sort()).toEqual([...ALL_SCOPES].sort());
    expect(result.scopes).toContain("account:destroy");
    expect(result.scopes).toContain("moderation:write");
  });

  test("** is strictly wider than *", () => {
    // Ordering matters in the parser: matching `*` first would make `**` silently mean `*`.
    expect(expandSuperWildcard().length).toBeGreaterThan(expandWildcard().length);
  });

  test("a wildcard mixed with anything else is not a wildcard", () => {
    // `*,friends:read` is not a request for everything; `*` is only a wildcard on its own.
    expect(parseScopeRequest("*,friends:read")).toEqual({ ok: false, unknown: ["*"] });
    expect(parseScopeRequest("**,friends:read")).toEqual({ ok: false, unknown: ["**"] });
  });
});
