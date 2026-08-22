import { describe, expect, test } from "bun:test";
import type { PluginGrant, RequestFrame } from "@vrcz/plugin-api";
import type { JsonValue } from "@vrcz/shared";
import {
  createScopeGate,
  defineGatedMethod,
  type GatedMethodTable,
  isShadowed,
  resolveAccount,
} from "./scope-gate.ts";

const NOW = 1_700_000_000_000;

function table(): GatedMethodTable {
  return {
    "test.free": defineGatedMethod("none", {
      scope: null,
      capability: null,
      cost: 0,
      parse: (raw) => ({ ok: true, value: raw }),
      handle: () => Promise.resolve("free"),
    }),
    "test.friends": defineGatedMethod("required", {
      scope: "friends:read",
      capability: null,
      cost: 1,
      parse: (raw) => ({ ok: true, value: raw }),
      handle: () => Promise.resolve("friends"),
    }),
  };
}

function grantWith(
  scopes: PluginGrant["scopes"],
  accountIds: string[],
  capabilities: PluginGrant["capabilities"] = [],
): PluginGrant {
  return { pluginId: "p", scopes, accountIds, capabilities, events: ["*"] };
}

function req(method: string, params?: JsonValue): RequestFrame {
  return { t: "req", id: "1", method, deadline: NOW + 1000, ...(params ? { params } : {}) };
}

describe("createScopeGate", () => {
  test("refuses a method that is not in the table", () => {
    const gate = createScopeGate(table());
    const result = gate.check(req("test.nope"), grantWith(["friends:read"], ["usr_a"]), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_UNKNOWN_METHOD");
  });

  test("refuses a method whose scope the grant does not hold", () => {
    const gate = createScopeGate(table());
    const result = gate.check(req("test.friends"), grantWith(["users:read"], ["usr_a"]), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_SCOPE_DENIED");
  });

  test("refuses a call whose deadline already passed, before the scope is even considered", () => {
    const gate = createScopeGate(table());
    const frame: RequestFrame = { ...req("test.friends"), deadline: NOW - 1 };
    const result = gate.check(frame, grantWith(["friends:read"], ["usr_a"]), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_TIMEOUT");
  });

  test("allows a granted method and resolves the only granted account", () => {
    const gate = createScopeGate(table());
    const result = gate.check(req("test.friends"), grantWith(["friends:read"], ["usr_a"]), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.accountId).toBe("usr_a");
  });

  test("a scope-free method needs no scope and carries no account", () => {
    const gate = createScopeGate(table());
    const result = gate.check(req("test.free"), grantWith([], ["usr_a"]), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.accountId).toBeUndefined();
  });

  test("throws at construction on a method declaring a scope outside the shared registry", () => {
    const bad = {
      "test.bogus": defineGatedMethod("none", {
        // The cast is the point of the test: a table can only get here by lying about its type,
        // and the gate must still refuse to be built rather than deny at runtime.
        scope: "plugin:invented" as PluginGrant["scopes"][number],
        capability: null,
        cost: 0,
        parse: (raw: JsonValue | undefined) => ({ ok: true as const, value: raw }),
        handle: () => Promise.resolve(null),
      }),
    };
    expect(() => createScopeGate(bad)).toThrow(/not a known scope/);
  });
});

describe("the account check", () => {
  const grant = grantWith(["friends:read"], ["usr_a", "usr_b"]);

  test("an account outside the grant is denied, not ignored", () => {
    const gate = createScopeGate(table());
    const result = gate.check(req("test.friends", { accountId: "usr_stranger" }), grant, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_ACCOUNT_DENIED");
  });

  test("an account inside the grant is used", () => {
    const gate = createScopeGate(table());
    const result = gate.check(req("test.friends", { accountId: "usr_b" }), grant, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.accountId).toBe("usr_b");
  });

  test("more than one granted account and none named is a bad request, never a guess", () => {
    const gate = createScopeGate(table());
    const result = gate.check(req("test.friends"), grant, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_BAD_REQUEST");
  });

  test("a grant covering no accounts cannot act as one", () => {
    const result = resolveAccount(undefined, grantWith(["friends:read"], []), "required");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_ACCOUNT_DENIED");
  });

  test("a scope-free method still refuses a foreign account rather than dropping the field", () => {
    const result = resolveAccount({ accountId: "usr_stranger" }, grant, "none");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_ACCOUNT_DENIED");
  });
});

describe("isShadowed", () => {
  test("is false for an unscoped method and for a scope that was never shadowed", () => {
    const grant: PluginGrant = {
      pluginId: "p",
      scopes: ["invite:send", "friends:read"],
      accountIds: ["usr_a"],
      capabilities: [],
      events: ["*"],
      dryRunScopes: ["invite:send"],
    };
    expect(isShadowed(grant, null)).toBe(false);
    expect(isShadowed(grant, "friends:read")).toBe(false);
    expect(isShadowed(grant, "invite:send")).toBe(true);
  });
});
