import { describe, expect, test } from "bun:test";
import type { BusEvent } from "../bus/event-bus.ts";
import { EventBus } from "../bus/event-bus.ts";
import { attachWebhookBridge } from "./webhook-bridge.ts";

function event(kind: BusEvent["kind"], ts = 1_700_000_000_000): BusEvent {
  return { kind, accountId: "usr_test", ts };
}

describe("attachWebhookBridge", () => {
  test("hands every bus event to the manager, unfiltered", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    attachWebhookBridge({ bus, manager: { onEvent: (e) => seen.push(e.kind) } });

    bus.emit(event("friend.online"));
    bus.emit(event("gamelog.player_join"));
    bus.emit(event("notification.received"));

    // No kind filter here on purpose: which kinds matter is the individual webhook's `kinds`
    // pattern, and duplicating that decision in the wiring is how the two drift apart.
    expect(seen).toEqual(["friend.online", "gamelog.player_join", "notification.received"]);
  });

  test("passes the event through unchanged", () => {
    const bus = new EventBus();
    const seen: BusEvent[] = [];
    attachWebhookBridge({ bus, manager: { onEvent: (e) => seen.push(e) } });

    const sent: BusEvent = {
      kind: "friend.location",
      accountId: "usr_a",
      ts: 42,
      subjectId: "usr_b",
      location: "wrld_x:123",
      payload: { travelingToLocation: "" },
    };
    bus.emit(sent);

    expect(seen).toEqual([sent]);
  });

  test("teardown unsubscribes", () => {
    const bus = new EventBus();
    let count = 0;
    const detach = attachWebhookBridge({ bus, manager: { onEvent: () => count++ } });

    bus.emit(event("friend.online"));
    detach();
    bus.emit(event("friend.offline"));

    expect(count).toBe(1);
    expect(bus.subscriberCount).toBe(0);
  });

  test("teardown is idempotent", () => {
    const bus = new EventBus();
    const detach = attachWebhookBridge({ bus, manager: { onEvent: () => {} } });
    detach();
    expect(() => detach()).not.toThrow();
    expect(bus.subscriberCount).toBe(0);
  });

  test("a throwing manager reaches onError and does not break the emit", () => {
    const bus = new EventBus();
    const errors: Array<[unknown, string]> = [];
    const other: string[] = [];
    // Subscribed after the bridge so an unhandled throw would have to skip it to fail this.
    attachWebhookBridge({
      bus,
      manager: {
        onEvent: () => {
          throw new Error("SQLITE_BUSY");
        },
      },
      onError: (error, e) => errors.push([error, e.kind]),
    });
    bus.subscribe((e) => {
      other.push(e.kind);
    });

    expect(() => bus.emit(event("friend.online"))).not.toThrow();

    expect(errors).toHaveLength(1);
    const [reported, kind] = errors[0] ?? [];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe("SQLITE_BUSY");
    expect(kind).toBe("friend.online");
    expect(other).toEqual(["friend.online"]);
  });

  test("a throwing manager on one event does not stop the next one", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    let fail = true;
    attachWebhookBridge({
      bus,
      manager: {
        onEvent: (e) => {
          if (fail) {
            fail = false;
            throw new Error("first one blew up");
          }
          seen.push(e.kind);
        },
      },
      onError: () => {},
    });

    bus.emit(event("friend.online"));
    bus.emit(event("friend.offline"));

    expect(seen).toEqual(["friend.offline"]);
  });

  test("a slow manager cannot stall emit", async () => {
    const bus = new EventBus();
    let released = false;
    // A stand-in that never settles while emit is on the stack. `onEvent` is typed `void`, so
    // returning a promise is only reachable through a cast — which is exactly the shape that would
    // stall the bus if `emit()` ever started awaiting its subscribers.
    const pending = new Promise<void>((resolve) => {
      setTimeout(() => {
        released = true;
        resolve();
      }, 25).unref?.();
    });
    attachWebhookBridge({
      bus,
      manager: { onEvent: (() => pending) as unknown as (e: BusEvent) => void },
    });

    const before = Date.now();
    bus.emit(event("friend.online"));
    const elapsed = Date.now() - before;

    // Returned to the caller with the manager's promise still outstanding. The bound is generous
    // because CI clocks are not: what is being asserted is "did not wait 25ms", not a latency SLO.
    expect(released).toBe(false);
    expect(elapsed).toBeLessThan(20);

    await pending;
    expect(released).toBe(true);
  });
});
