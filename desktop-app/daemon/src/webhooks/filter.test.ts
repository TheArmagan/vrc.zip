import { describe, expect, test } from "bun:test";
import type { BusEvent } from "../bus/event-bus.ts";
import { matchesKind, normaliseKindPatterns, parseKindPatterns, webhookMatches } from "./filter.ts";

function event(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    kind: "friend.online",
    accountId: "usr_alice",
    ts: 1_700_000_000_000,
    ...overrides,
  } as BusEvent;
}

describe("matchesKind", () => {
  test("matches an exact kind, a family prefix, and the bare wildcard", () => {
    expect(matchesKind(["friend.online"], "friend.online")).toBe(true);
    expect(matchesKind(["friend.online"], "friend.offline")).toBe(false);
    expect(matchesKind(["friend.*"], "friend.offline")).toBe(true);
    expect(matchesKind(["*"], "gamelog.player_join")).toBe(true);
  });

  test("a family prefix does not leak into a longer family with the same start", () => {
    // The bug a `startsWith("friend")` would ship with, and it would look correct in every test
    // written before a `friendship.*` kind existed.
    expect(matchesKind(["friend.*"], "friendship.created")).toBe(false);
  });

  test("multi-segment prefixes work, and an empty pattern list matches nothing", () => {
    expect(matchesKind(["gamelog.player.*"], "gamelog.player.join")).toBe(true);
    expect(matchesKind(["gamelog.player.*"], "gamelog.world_load")).toBe(false);
    expect(matchesKind([], "friend.online")).toBe(false);
  });
});

describe("normaliseKindPatterns", () => {
  test("lowercases, trims, and de-duplicates", () => {
    expect(normaliseKindPatterns([" Friend.Online ", "friend.online", "user.updated"])).toEqual([
      "friend.online",
      "user.updated",
    ]);
  });

  test("a wildcard collapses the list, because nothing can widen it further", () => {
    expect(normaliseKindPatterns(["friend.online", "*"])).toEqual(["*"]);
  });

  test("drops shapes that could never match a dotted kind", () => {
    expect(normaliseKindPatterns(["friend online", "friend.*.online", "", "a/b"])).toEqual([]);
  });
});

describe("parseKindPatterns", () => {
  test("a corrupt or non-array value yields no patterns, so the webhook fires for nothing", () => {
    // Failing closed. The alternative — defaulting to `*` — would start sending a user's whole
    // event stream to an endpoint that asked for one kind of it.
    expect(parseKindPatterns("not json")).toEqual([]);
    expect(parseKindPatterns(`{"kinds":["*"]}`)).toEqual([]);
    expect(parseKindPatterns(`["friend.*", 7, "", "user.updated"]`)).toEqual([
      "friend.*",
      "user.updated",
    ]);
  });
});

describe("webhookMatches", () => {
  test("the account filter and the kind filter both have to pass", () => {
    const scoped = { kinds: ["friend.*"], accountId: "usr_alice" };

    expect(webhookMatches(scoped, event())).toBe(true);
    expect(webhookMatches(scoped, event({ accountId: "usr_bob" }))).toBe(false);
    expect(webhookMatches(scoped, event({ kind: "user.updated" }))).toBe(false);
  });

  test("a null account filter sees every account, including the unattributed events", () => {
    const all = { kinds: ["*"], accountId: null };

    expect(webhookMatches(all, event({ accountId: "usr_bob" }))).toBe(true);
    // A game client signed into an account vrc.zip does not manage. PLAN.md §1.7.
    expect(webhookMatches(all, event({ accountId: null, kind: "gamelog.player_join" }))).toBe(true);
  });

  test("a scoped webhook never sees the unattributed events", () => {
    const scoped = { kinds: ["*"], accountId: "usr_alice" };
    expect(webhookMatches(scoped, event({ accountId: null }))).toBe(false);
  });
});
