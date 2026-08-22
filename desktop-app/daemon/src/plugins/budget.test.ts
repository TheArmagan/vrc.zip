import { describe, expect, test } from "bun:test";
import type { Scope } from "@vrcz/shared";
import {
  BUDGET_WINDOW_MS,
  DEFAULT_GRANT_BUDGETS,
  MemoryPluginBudgetLedger,
  PluginBudget,
  type PluginBudgetLedger,
} from "./budget.ts";

const START = 1_700_000_000_000;

function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = START;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

describe("PluginBudget", () => {
  test("reuses the proxy's three scopes and their allowances rather than inventing a set", () => {
    // Decision 95's whole point: the budget is on visible-to-other-people abuse, not on volume.
    expect(Object.keys(DEFAULT_GRANT_BUDGETS).sort()).toEqual([
      "friends:write",
      "groups:invite",
      "invite:send",
    ]);
    expect(BUDGET_WINDOW_MS).toBe(60 * 60_000);
  });

  test("an unbudgeted scope is never counted against one", () => {
    const budget = new PluginBudget();
    for (let i = 0; i < 500; i++) budget.charge("p", "friends:read");
    expect(budget.check("p", "friends:read")).toEqual({ ok: true });
    expect(budget.usage("p", "friends:read").limit).toBeNull();
  });

  test("a method with no scope is never budgeted", () => {
    expect(new PluginBudget().check("p", null)).toEqual({ ok: true });
  });

  test("allows exactly the allowance, then refuses with a retryAfterMs", () => {
    const time = clock();
    const budget = new PluginBudget({ now: time.now, limits: { "invite:send": 3 } });
    for (let i = 0; i < 3; i++) {
      expect(budget.check("p", "invite:send").ok).toBe(true);
      budget.charge("p", "invite:send");
      time.advance(1_000);
    }
    const decision = budget.check("p", "invite:send");
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.limit).toBe(3);
      // The oldest call was three seconds ago, so the window frees a slot an hour after *it* —
      // not an hour from now, which is what a flat window would have said.
      expect(decision.retryAfterMs).toBe(BUDGET_WINDOW_MS - 3_000);
    }
  });

  test("the window rolls: an hour later the plugin may spend again", () => {
    const time = clock();
    const budget = new PluginBudget({ now: time.now, limits: { "invite:send": 1 } });
    budget.charge("p", "invite:send");
    expect(budget.check("p", "invite:send").ok).toBe(false);
    time.advance(BUDGET_WINDOW_MS + 1);
    expect(budget.check("p", "invite:send").ok).toBe(true);
  });

  test("one plugin's spending does not touch another's", () => {
    const budget = new PluginBudget({ limits: { "invite:send": 1 } });
    budget.charge("noisy", "invite:send");
    expect(budget.check("noisy", "invite:send").ok).toBe(false);
    expect(budget.check("quiet", "invite:send").ok).toBe(true);
  });

  test("a per-plugin override wins over the build default, on budgeted scopes only", () => {
    const overrides: PluginBudgetLedger = {
      countPluginScopeUsage: () => 0,
      recordPluginScopeUsage: () => undefined,
      pluginBudget: (_pluginId: string, scope: Scope) => (scope === "invite:send" ? 5 : 999),
    };
    const budget = new PluginBudget({ ledger: overrides, limits: { "invite:send": 60 } });
    expect(budget.limitFor("p", "invite:send")).toBe(5);
    // An override on a scope that carries no budget is ignored rather than honoured: a settings
    // page must not be able to invent a budget on `worlds:read`.
    expect(budget.limitFor("p", "worlds:read")).toBeUndefined();
  });

  test("usage reads back as 'n of limit used this hour'", () => {
    const time = clock();
    const budget = new PluginBudget({ now: time.now, limits: { "groups:invite": 30 } });
    budget.charge("p", "groups:invite");
    budget.charge("p", "groups:invite");
    expect(budget.usage("p", "groups:invite")).toEqual({
      used: 2,
      limit: 30,
      windowMs: BUDGET_WINDOW_MS,
    });
  });
});

describe("MemoryPluginBudgetLedger", () => {
  test("forgets entries once nothing is left inside the window", () => {
    const ledger = new MemoryPluginBudgetLedger();
    ledger.recordPluginScopeUsage("p", "invite:send", START);
    expect(ledger.prune(START)).toBe(0);
    expect(ledger.prune(START + BUDGET_WINDOW_MS + 1)).toBe(1);
    expect(ledger.countPluginScopeUsage("p", "invite:send", 0)).toBe(0);
  });

  test("reports the oldest call still inside the window", () => {
    const ledger = new MemoryPluginBudgetLedger();
    ledger.recordPluginScopeUsage("p", "invite:send", START);
    ledger.recordPluginScopeUsage("p", "invite:send", START + 500);
    expect(ledger.oldestPluginScopeUsage("p", "invite:send", START)).toBe(START);
    expect(ledger.oldestPluginScopeUsage("p", "invite:send", START + 100)).toBe(START + 500);
    expect(ledger.oldestPluginScopeUsage("p", "invite:send", START + 1_000)).toBeNull();
  });
});
