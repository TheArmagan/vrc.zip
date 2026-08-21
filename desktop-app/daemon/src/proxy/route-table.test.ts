import { describe, expect, test } from "bun:test";
import { ROUTES } from "@vrcz/api";
import { isHardDenied, matchRoute, scopeFor } from "./route-table.ts";

/**
 * Matching a request against the generated route table.
 *
 * The table itself is codegen output and has its own test in `packages/api`; this is the read side.
 * The thing worth being careful about here is that a request lands on the *same* operation the
 * mirror would forward it to upstream — a mismatch means the scope check runs against one endpoint
 * while VRChat serves another.
 */

describe("matchRoute", () => {
  test("matches a literal path", () => {
    const matched = matchRoute("GET", "/auth/user");
    expect(matched?.route.operationId).toBe("getCurrentUser");
    expect(matched?.params).toEqual({});
  });

  test("pulls path parameters out", () => {
    const matched = matchRoute("GET", "/users/usr_01234567-89ab-cdef-0123-456789abcdef");
    expect(matched?.route.operationId).toBe("getUser");
    expect(matched?.params).toEqual({ userId: "usr_01234567-89ab-cdef-0123-456789abcdef" });
  });

  test("a literal segment beats a parameter that would also match", () => {
    // `/worlds/{worldId}` and `/worlds/active` both match `/worlds/active`, and every router —
    // VRChat's included — prefers the literal. Getting this backwards would turn a real endpoint
    // into a world lookup for a world called "active", under the same scope, silently.
    expect(matchRoute("GET", "/worlds/active")?.route.operationId).toBe("getActiveWorlds");
    expect(matchRoute("GET", "/worlds/favorites")?.route.operationId).toBe("getFavoritedWorlds");
    expect(matchRoute("GET", "/worlds/wrld_x")?.route.operationId).toBe("getWorld");
  });

  test("a segment holding two parameters splits correctly", () => {
    // `/instances/{worldId}:{instanceId}` is one segment with two parameters and a separator — the
    // shape a "starts with { and ends with }" test reads as a single parameter, capturing the whole
    // segment and naming it `worldId}:{instanceId`. Found by this suite, fixed in `compileSegment`.
    const matched = matchRoute("GET", "/instances/wrld_x:12345~region(us)");
    expect(matched?.route.operationId).toBe("getInstance");
    expect(matched?.params).toEqual({ worldId: "wrld_x", instanceId: "12345~region(us)" });
  });

  test("the method is part of the match", () => {
    // Same path, different operations, different scopes. `GET /avatars` reads; `POST /avatars`
    // creates — treating them as one route would grant a write on a read consent.
    expect(matchRoute("GET", "/avatars")?.route.operationId).toBe("searchAvatars");
    expect(matchRoute("POST", "/avatars")?.route.operationId).toBe("createAvatar");
    expect(matchRoute("DELETE", "/avatars")).toBeNull();
  });

  test("segment count must agree, so no prefix ever matches by accident", () => {
    expect(matchRoute("GET", "/users")).not.toBeNull();
    expect(matchRoute("GET", "/users/usr_x/extra/segments")).toBeNull();
  });

  test("an empty segment is not a parameter value", () => {
    // `/users//friends` would otherwise match with an empty id and be forwarded upstream malformed.
    expect(matchRoute("GET", "/users//friends")).toBeNull();
  });

  test("trailing slashes and a leading slash are normalised", () => {
    expect(matchRoute("GET", "auth/user")?.route.operationId).toBe("getCurrentUser");
    expect(matchRoute("GET", "/auth/user/")?.route.operationId).toBe("getCurrentUser");
  });

  test("a percent-encoded segment is decoded", () => {
    const matched = matchRoute("GET", "/users/usr%20space");
    expect(matched?.params.userId).toBe("usr space");
  });

  test("an unknown path matches nothing, which is what earns VRChat's real 404", () => {
    expect(matchRoute("GET", "/no/such/endpoint")).toBeNull();
    expect(matchRoute("BREW", "/auth/user")).toBeNull();
  });

  test("the method is matched case-insensitively", () => {
    expect(matchRoute("get", "/auth/user")?.route.operationId).toBe("getCurrentUser");
  });
});

describe("scopeFor", () => {
  test("returns the scope the proxy will demand", () => {
    expect(scopeFor("GET", "/auth/user/friends")).toBe("friends:read");
    expect(scopeFor("DELETE", "/auth/user/friends/usr_x")).toBe("friends:write");
    expect(scopeFor("GET", "/no/such/endpoint")).toBeNull();
  });

  test("every route in the table is reachable through the matcher", () => {
    // The guarantee that makes the codegen scope test meaningful at runtime: a route the table
    // declares but the matcher cannot reach is a scope check that silently never runs.
    const unreachable = ROUTES.filter((route) => {
      const concrete = route.pathTemplate.replace(/\{([^}]+)\}/g, (_, name: string) => `x_${name}`);
      return matchRoute(route.method, concrete) === null;
    });
    expect(unreachable.map((route) => `${route.method} ${route.pathTemplate}`)).toEqual([]);
  });
});

describe("hard denials", () => {
  test("account deletion and disabling 2FA are denied regardless of scope", () => {
    // PLAN.md §Enforcement names these two by hand. They are data on the route table rather than a
    // condition someone has to remember to write.
    expect(isHardDenied("PUT", "/users/usr_x/delete")).toBe(true);
    expect(isHardDenied("DELETE", "/auth/twofactorauth")).toBe(true);
  });

  test("ordinary operations are not", () => {
    expect(isHardDenied("GET", "/auth/user/friends")).toBe(false);
    expect(isHardDenied("GET", "/no/such/endpoint")).toBe(false);
  });
});
