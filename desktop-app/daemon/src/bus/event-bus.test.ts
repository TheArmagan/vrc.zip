import { describe, expect, test } from "bun:test";
import type { BusEventKind } from "@vrcz/shared";
import { type BusEvent, EventBus } from "./event-bus.ts";

/**
 * Synthetic kinds on purpose.
 *
 * These tests are about the bus's *dispatch* — exact vs `prefix.*` matching, account filtering,
 * delivering once when two filters both hit — and none of that has anything to do with the domain
 * vocabulary. Writing them against real kinds would couple a routing test to a list that changes
 * for unrelated reasons, and would hide the very case worth covering: a kind whose prefix nobody
 * has registered. So the cast is here, at one boundary, rather than the taxonomy being widened for
 * a test's convenience.
 */
function event(kind: string, overrides: Partial<BusEvent> = {}): BusEvent {
  return { kind: kind as BusEventKind, accountId: "usr_a", ts: 1_750_000_000_000, ...overrides };
}

describe("EventBus", () => {
  test("delivers to unfiltered subscribers", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => {
      seen.push(e.kind);
    });

    bus.emit(event("friend.online"));
    bus.emit(event("gamelog.player_join"));
    expect(seen).toEqual(["friend.online", "gamelog.player_join"]);
  });

  test("filters by exact kind", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(
      (e) => {
        seen.push(e.kind);
      },
      { kinds: ["friend.online"] },
    );

    bus.emit(event("friend.online"));
    bus.emit(event("friend.offline"));
    expect(seen).toEqual(["friend.online"]);
  });

  test("filters by prefix wildcard", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(
      (e) => {
        seen.push(e.kind);
      },
      { kinds: ["gamelog.*"] },
    );

    bus.emit(event("gamelog.player_join"));
    bus.emit(event("gamelog.world_enter"));
    bus.emit(event("friend.online"));
    expect(seen).toEqual(["gamelog.player_join", "gamelog.world_enter"]);
  });

  test("a wildcard matches deeper kinds too", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(
      (e) => {
        seen.push(e.kind);
      },
      { kinds: ["a.*"] },
    );

    bus.emit(event("a.b.c"));
    expect(seen).toEqual(["a.b.c"]);
  });

  test("delivers once when several of a subscriber's filters match", () => {
    const bus = new EventBus();
    let calls = 0;
    bus.subscribe(
      () => {
        calls++;
      },
      { kinds: ["gamelog.*", "gamelog.player_join"] },
    );

    bus.emit(event("gamelog.player_join"));
    expect(calls).toBe(1);
  });

  test("an account-scoped subscription never sees another account", () => {
    // A plugin granted one account must not get the other five. PLAN.md §Phase 3 consent.
    const bus = new EventBus();
    const seen: Array<string | null> = [];
    bus.subscribe(
      (e) => {
        seen.push(e.accountId);
      },
      { accountId: "usr_a" },
    );

    bus.emit(event("friend.online", { accountId: "usr_a" }));
    bus.emit(event("friend.online", { accountId: "usr_b" }));
    bus.emit(event("gamelog.player_join", { accountId: null }));
    expect(seen).toEqual(["usr_a"]);
  });

  test("a throwing subscriber does not break the fan-out", () => {
    const bus = new EventBus();
    const errors: unknown[] = [];
    bus.onError((error) => {
      errors.push(error);
    });

    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => {
      seen.push(e.kind);
    });

    bus.emit(event("friend.online"));
    expect(seen).toEqual(["friend.online"]);
    expect(errors).toHaveLength(1);
  });

  test("emit does not await an async subscriber", async () => {
    // A slow subscriber must not stall the pipeline reader — a socket that stops draining is a
    // socket VRChat eventually closes.
    const bus = new EventBus();
    let resolved = false;
    bus.subscribe(async () => {
      await Bun.sleep(20);
      resolved = true;
    });

    bus.emit(event("friend.online"));
    expect(resolved).toBe(false); // emit returned before the subscriber finished

    await Bun.sleep(40);
    expect(resolved).toBe(true);
  });

  test("an async rejection reaches onError instead of becoming unhandled", async () => {
    const bus = new EventBus();
    const errors: unknown[] = [];
    bus.onError((error) => {
      errors.push(error);
    });
    bus.subscribe(() => Promise.reject(new Error("async boom")));

    bus.emit(event("friend.online"));
    await Bun.sleep(10);
    expect(errors).toHaveLength(1);
  });

  test("unsubscribe stops delivery and frees the registration", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const sub = bus.subscribe(
      (e) => {
        seen.push(e.kind);
      },
      { kinds: ["friend.online", "friend.*"] },
    );

    bus.emit(event("friend.online"));
    sub.unsubscribe();
    bus.emit(event("friend.online"));

    expect(seen).toEqual(["friend.online"]);
    expect(bus.subscriberCount).toBe(0);
  });

  test("unsubscribing during dispatch does not disturb the current emit", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const first = bus.subscribe(() => first.unsubscribe());
    bus.subscribe((e) => {
      seen.push(e.kind);
    });

    expect(() => bus.emit(event("friend.online"))).not.toThrow();
    expect(seen).toEqual(["friend.online"]);
  });

  test("subscribing during dispatch does not deliver the in-flight event", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      bus.subscribe((e) => {
        seen.push(`late:${e.kind}`);
      });
    });

    bus.emit(event("friend.online"));
    expect(seen).toEqual([]);

    bus.emit(event("friend.offline"));
    expect(seen).toEqual(["late:friend.offline"]);
  });
});
