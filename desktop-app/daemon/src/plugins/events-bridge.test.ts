/**
 * The events bridge, driven against a real {@link EventBus} and a fake channel.
 *
 * The channel is fake and the bus is not, which is the split that matters: the bus's bucketed
 * dispatch is half of "one `===` per event, no wakeup for irrelevant ones", so a test that faked it
 * would be asserting the bridge's *intent* rather than the behaviour. The flush timer is injected so
 * "per tick" is a thing a test can step rather than sleep through.
 */

import { describe, expect, test } from "bun:test";
import {
  applyOverflow,
  type DeliveryPolicy,
  type DroppedFrame,
  type Envelope,
  type EventFilter,
  type EventFrame,
  type PluginEvent,
  type PluginGrant,
} from "@vrcz/plugin-api";
import type { BusEventKind, Scope } from "@vrcz/shared";
import { type BusEvent, EventBus } from "../bus/event-bus.ts";
import {
  compileAuthority,
  missingScopeFor,
  PluginEventsBridge,
  toPluginEvent,
} from "./events-bridge.ts";

const PLUGIN = "test.plugin";
const ACCOUNT = "usr_alpha";
const OTHER = "usr_beta";

function grantOf(
  scopes: readonly Scope[] = ["friends:read", "sessions:read"],
  accountIds: readonly string[] = [ACCOUNT],
): PluginGrant {
  return { pluginId: PLUGIN, scopes, accountIds };
}

const DEFAULT_DELIVERY: DeliveryPolicy = { credits: 100, maxBatch: 32, overflow: "drop-oldest" };

interface Harness {
  readonly bus: EventBus;
  readonly sent: Envelope[];
  /** Runs whatever the bridge scheduled. One call is one tick. */
  readonly tick: () => void;
  readonly bridge: PluginEventsBridge;
  readonly subscribe: (
    filter: EventFilter,
    delivery?: Partial<DeliveryPolicy>,
    sub?: string,
  ) => void;
  readonly emit: (event: Partial<BusEvent> & { kind: BusEventKind }) => void;
  readonly events: () => EventFrame[];
  readonly drops: () => DroppedFrame[];
  /** Swap the live grant, as a revoke or a re-consent would. */
  setGrant: (grant: PluginGrant | null) => void;
  /** Make the channel refuse frames, as a dead peer or an oversized frame does. */
  refuseSends: (predicate: ((frame: Envelope) => boolean) | null) => void;
}

function harness(initial: PluginGrant | null = grantOf()): Harness {
  const bus = new EventBus();
  const sent: Envelope[] = [];
  let scheduled: Array<() => void> = [];
  let grant = initial;
  let refuse: ((frame: Envelope) => boolean) | null = null;

  const bridge = new PluginEventsBridge({
    bus,
    grants: () => grant,
    schedule: (run) => {
      scheduled.push(run);
    },
  });
  bridge.attach({
    pluginId: PLUGIN,
    send: (frame) => {
      if (refuse?.(frame) === true) return false;
      sent.push(frame);
      return true;
    },
  });

  let nextId = 1;
  const api: Harness = {
    bus,
    sent,
    bridge,
    tick: () => {
      const due = scheduled;
      scheduled = [];
      for (const run of due) run();
    },
    subscribe: (filter, delivery = {}, sub = "s1") => {
      bridge.handleFrame(PLUGIN, {
        t: "subscribe",
        id: `p${String(nextId++)}`,
        deadline: Date.now() + 5_000,
        sub,
        filter,
        delivery: { ...DEFAULT_DELIVERY, ...delivery },
      });
    },
    emit: (event) => {
      bus.emit({ accountId: ACCOUNT, ts: 1_700_000_000_000, ...event });
    },
    events: () => sent.filter((frame): frame is EventFrame => frame.t === "event"),
    drops: () => sent.filter((frame): frame is DroppedFrame => frame.t === "dropped"),
    setGrant: (next) => {
      grant = next;
    },
    refuseSends: (predicate) => {
      refuse = predicate;
    },
  };
  return api;
}

/** Every event the plugin actually received, flattened across batches. */
function delivered(h: Harness): PluginEvent[] {
  return h.events().flatMap((frame) => frame.events);
}

function errors(h: Harness): string[] {
  return h.sent.filter((frame) => frame.t === "err").map((frame) => frame.error.code);
}

// ---------------------------------------------------------------------------------------------

describe("the scope filter", () => {
  test("is default-deny and reuses the /app stream's family mapping", () => {
    const grant = grantOf(["friends:read"], [ACCOUNT]);
    const allows = compileAuthority(grant);

    expect(allows(toPluginEvent({ kind: "friend.online", accountId: ACCOUNT, ts: 1 }))).toBe(true);
    // Held scope, wrong account.
    expect(allows(toPluginEvent({ kind: "friend.online", accountId: OTHER, ts: 1 }))).toBe(false);
    // Right account, unheld scope.
    expect(allows(toPluginEvent({ kind: "gamelog.player_join", accountId: ACCOUNT, ts: 1 }))).toBe(
      false,
    );
    // An unmapped family is dropped rather than passed, which is the half of decision 135 that
    // decides what a *future* daemon's events do here.
    expect(allows(toPluginEvent({ kind: "consent.pending", accountId: ACCOUNT, ts: 1 }))).toBe(
      false,
    );
  });

  test("an unlinked event needs sessions:unlinked, which is not a bypass of the kind gate", () => {
    const withUnlinked = compileAuthority(grantOf(["sessions:read", "sessions:unlinked"], []));
    const withoutUnlinked = compileAuthority(grantOf(["sessions:read"], []));
    const unlinked = toPluginEvent({ kind: "gamelog.player_join", accountId: null, ts: 1 });

    expect(withUnlinked(unlinked)).toBe(true);
    expect(withoutUnlinked(unlinked)).toBe(false);

    // `sessions:unlinked` alone buys nothing: the kind still has to map to a scope that is held.
    const onlyUnlinked = compileAuthority(grantOf(["sessions:unlinked"], []));
    expect(onlyUnlinked(unlinked)).toBe(false);
  });

  test("events the grant does not cover are never queued at all", () => {
    const h = harness(grantOf(["friends:read"], [ACCOUNT]));
    h.subscribe({});

    h.emit({ kind: "friend.online", subjectId: "usr_1" });
    h.emit({ kind: "gamelog.player_join", accountId: null });
    h.emit({ kind: "friend.online", accountId: OTHER, subjectId: "usr_2" });
    h.tick();

    expect(delivered(h).map((event) => event.subjectId)).toEqual(["usr_1"]);
    // And nothing was reported as dropped: these were never this plugin's events to lose.
    expect(h.drops()).toEqual([]);
  });
});

describe("subscribe", () => {
  test("refuses a filter whose kinds are all outside the grant, naming the scope", () => {
    const h = harness(grantOf(["friends:read"], [ACCOUNT]));
    h.subscribe({ kinds: ["gamelog.*"] });

    expect(errors(h)).toEqual(["E_SCOPE_DENIED"]);
    const failure = h.sent.find((frame) => frame.t === "err");
    expect(failure?.t === "err" ? failure.error.message : "").toContain("sessions:read");
    expect(h.bridge.subscriptionCount(PLUGIN)).toBe(0);
  });

  test("accepts a filter where any one kind is readable", () => {
    const h = harness(grantOf(["friends:read"], [ACCOUNT]));
    h.subscribe({ kinds: ["gamelog.*", "friend.online"] });
    expect(errors(h)).toEqual([]);
    expect(h.bridge.subscriptionCount(PLUGIN)).toBe(1);
  });

  test("an omitted kind list is serviceable — the per-event gate narrows it", () => {
    expect(missingScopeFor({}, grantOf(["friends:read"], []))).toBeNull();
    expect(missingScopeFor({ kinds: [] }, grantOf([], []))).toBeNull();
    // A family with no scope at all cannot be fixed by granting anything.
    expect(
      missingScopeFor({ kinds: ["consent.*"] }, grantOf(["friends:read"], [])),
    ).toBeUndefined();
  });

  test("naming an account outside the grant is refused, not silently narrowed", () => {
    const h = harness();
    h.subscribe({ accountIds: [OTHER] });
    expect(errors(h)).toEqual(["E_ACCOUNT_DENIED"]);
  });

  test("a duplicate sub id and an over-full plugin are both refused", () => {
    const h = harness();
    h.subscribe({}, {}, "same");
    h.subscribe({}, {}, "same");
    expect(errors(h)).toEqual(["E_BAD_REQUEST"]);
    expect(h.bridge.subscriptionCount(PLUGIN)).toBe(1);

    for (let i = 0; i < 20; i++) h.subscribe({}, {}, `s${String(i)}`);
    expect(h.bridge.subscriptionCount(PLUGIN)).toBe(16);
  });

  test("a plugin with no grant cannot subscribe", () => {
    const h = harness(null);
    h.subscribe({});
    expect(errors(h)).toEqual(["E_SCOPE_DENIED"]);
  });

  test("unsubscribe is idempotent and always answered", () => {
    const h = harness();
    h.subscribe({});
    h.bridge.handleFrame(PLUGIN, {
      t: "unsubscribe",
      id: "u1",
      deadline: Date.now() + 1000,
      sub: "s1",
    });
    h.bridge.handleFrame(PLUGIN, {
      t: "unsubscribe",
      id: "u2",
      deadline: Date.now() + 1000,
      sub: "s1",
    });
    expect(h.sent.filter((frame) => frame.t === "res")).toHaveLength(3);
    expect(errors(h)).toEqual([]);
    expect(h.bridge.subscriptionCount(PLUGIN)).toBe(0);
  });

  test("the bus never wakes a subscription whose kind it does not match", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.location"] });
    // The bus buckets on kind, so this dispatch does not reach the bridge at all — and the proof it
    // did not is that no flush was ever scheduled, so the tick produces nothing.
    h.emit({ kind: "gamelog.player_join" });
    h.tick();
    expect(h.sent.filter((frame) => frame.t === "event" || frame.t === "dropped")).toEqual([]);
  });

  test("a subscription is forgotten when the plugin detaches", () => {
    const h = harness();
    h.subscribe({});
    expect(h.bus.subscriberCount).toBe(1);
    h.bridge.detachAll();
    expect(h.bus.subscriberCount).toBe(0);
    expect(h.bridge.subscriptionCount(PLUGIN)).toBe(0);
  });
});

describe("per-tick batching", () => {
  test("a burst is one frame, not one frame per event", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { maxBatch: 64 });

    for (let i = 0; i < 40; i++) h.emit({ kind: "friend.online", subjectId: `usr_${String(i)}` });
    // Nothing has been sent yet: `emit` queues, the tick delivers.
    expect(h.events()).toEqual([]);

    h.tick();
    expect(h.events()).toHaveLength(1);
    expect(h.events()[0]?.events).toHaveLength(40);
    expect(h.events()[0]?.seq).toBe(0);
  });

  test("maxBatch splits a burst across ticks, and seq keeps counting", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { maxBatch: 10, credits: 100 });
    for (let i = 0; i < 25; i++) h.emit({ kind: "friend.online" });

    h.tick();
    h.tick();
    h.tick();
    expect(h.events().map((frame) => frame.events.length)).toEqual([10, 10, 5]);
    expect(h.events().map((frame) => frame.seq)).toEqual([0, 10, 20]);
  });
});

describe("the credit window", () => {
  test("a plugin that never credits stops receiving, and is told what it missed", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { credits: 2, maxBatch: 10, overflow: "drop-newest" });

    for (let i = 0; i < 6; i++) h.emit({ kind: "friend.online", subjectId: `usr_${String(i)}` });
    h.tick();

    // Two delivered — the whole window — and the four that did not fit are reported rather than
    // vanishing.
    expect(delivered(h).map((event) => event.subjectId)).toEqual(["usr_0", "usr_1"]);
    expect(h.drops()).toHaveLength(1);
    expect(h.drops()[0]).toMatchObject({ count: 4, reason: "overflow", sub: "s1", seq: 2 });

    // Nothing more arrives, however many ticks pass, until credit comes back.
    h.tick();
    h.tick();
    expect(delivered(h)).toHaveLength(2);

    h.bridge.handleFrame(PLUGIN, { t: "credit", sub: "s1", credits: 2 });
    h.emit({ kind: "friend.online", subjectId: "usr_after" });
    h.tick();
    expect(delivered(h).map((event) => event.subjectId)).toContain("usr_after");
  });

  test("over-crediting cannot buy more than the window", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { credits: 2, maxBatch: 10 });
    h.emit({ kind: "friend.online" });
    h.emit({ kind: "friend.online" });
    h.tick();

    h.bridge.handleFrame(PLUGIN, { t: "credit", sub: "s1", credits: 4000 });
    for (let i = 0; i < 5; i++) h.emit({ kind: "friend.online" });
    h.tick();
    expect(h.events().at(-1)?.events).toHaveLength(2);
  });
});

describe("overflow policies", () => {
  const burst = (h: Harness, users: number, moves: number): void => {
    for (let move = 0; move < moves; move++) {
      for (let user = 0; user < users; user++) {
        h.emit({
          kind: "friend.location",
          subjectId: `usr_${String(user)}`,
          payload: { userId: `usr_${String(user)}`, location: `wrld_${String(move)}` },
        });
      }
    }
  };

  test("coalesce gives a slow plugin each friend's current location, not the path", () => {
    const h = harness();
    h.subscribe(
      { kinds: ["friend.location"] },
      { credits: 100, maxBatch: 100, overflow: "coalesce", keyPath: "userId" },
    );

    // PLAN.md's motivating case: 900 moves across three friends into a window of 100.
    burst(h, 3, 300);
    h.tick();

    const received = delivered(h);
    expect(received).toHaveLength(3);
    for (const event of received) {
      expect(event.payload).toMatchObject({ location: "wrld_299" });
    }
    // 900 in, 3 out, and the host says so rather than letting the plugin believe it saw everything.
    expect(h.drops()).toHaveLength(1);
    expect(h.drops()[0]).toMatchObject({ count: 897, reason: "coalesced" });
  });

  test("coalesce keeps each key's first position, so a chatty key cannot starve a quiet one", () => {
    const h = harness();
    h.subscribe(
      { kinds: ["friend.location"] },
      { credits: 100, maxBatch: 100, overflow: "coalesce", keyPath: "userId" },
    );

    h.emit({ kind: "friend.location", payload: { userId: "quiet", location: "a" } });
    for (let i = 0; i < 10; i++) {
      h.emit({ kind: "friend.location", payload: { userId: "chatty", location: `c${String(i)}` } });
    }
    h.tick();

    expect(delivered(h).map((event) => (event.payload as { userId: string }).userId)).toEqual([
      "quiet",
      "chatty",
    ]);
  });

  test("coalesce with all-distinct keys degrades to a ring buffer rather than growing", () => {
    const h = harness();
    h.subscribe(
      { kinds: ["friend.location"] },
      { credits: 4, maxBatch: 100, overflow: "coalesce", keyPath: "userId" },
    );

    for (let i = 0; i < 10; i++) {
      h.emit({ kind: "friend.location", payload: { userId: `usr_${String(i)}`, location: "x" } });
    }
    h.tick();

    // The last four, which is `drop-oldest` — and reported as `overflow`, not as `coalesced`, since
    // nothing was superseded.
    expect(delivered(h).map((event) => (event.payload as { userId: string }).userId)).toEqual([
      "usr_6",
      "usr_7",
      "usr_8",
      "usr_9",
    ]);
    expect(h.drops()[0]).toMatchObject({ count: 6, reason: "overflow" });
  });

  test("an event with no resolvable key is uncoalescable and queues normally", () => {
    const h = harness();
    h.subscribe(
      { kinds: ["friend.location"] },
      { credits: 100, maxBatch: 100, overflow: "coalesce", keyPath: "userId" },
    );

    h.emit({ kind: "friend.location", payload: { location: "a" } });
    h.emit({ kind: "friend.location", payload: { location: "b" } });
    h.tick();
    expect(delivered(h)).toHaveLength(2);
    expect(h.drops()).toEqual([]);
  });

  test("drop-newest keeps the first window and sheds the rest", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { credits: 3, maxBatch: 100, overflow: "drop-newest" });
    for (let i = 0; i < 8; i++) h.emit({ kind: "friend.online", subjectId: `usr_${String(i)}` });
    h.tick();
    expect(delivered(h).map((event) => event.subjectId)).toEqual(["usr_0", "usr_1", "usr_2"]);
  });

  test("disconnect closes the subscription and reports everything it never saw", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { credits: 3, maxBatch: 100, overflow: "disconnect" });
    for (let i = 0; i < 8; i++) h.emit({ kind: "friend.online" });
    h.tick();

    // Closed rather than starved, and the plugin is told: three queued plus five refused.
    expect(h.bridge.subscriptionCount(PLUGIN)).toBe(0);
    expect(h.bus.subscriberCount).toBe(0);
    const closure = h.drops().at(-1);
    expect(closure?.count).toBeGreaterThanOrEqual(5);
  });

  test("the queue evolves exactly as applyOverflow says it does", () => {
    /*
     * The conformance check. `applyOverflow` is the protocol package's *reference semantics* for
     * every policy, and the bridge deliberately does not call it — see `PendingQueue`'s header for
     * the quadratic that would buy. So the two are compared instead, event for event, over a run
     * long enough to cross every window boundary in both directions.
     */
    for (const overflow of ["drop-newest", "drop-oldest", "coalesce"] as const) {
      const policy: DeliveryPolicy = {
        credits: 5,
        maxBatch: 100,
        overflow,
        ...(overflow === "coalesce" ? { keyPath: "userId" } : {}),
      };

      const input: BusEvent[] = [];
      for (let i = 0; i < 200; i++) {
        input.push({
          kind: "friend.location",
          accountId: ACCOUNT,
          ts: 1_700_000_000_000 + i,
          // A deliberately lumpy key distribution: some keys repeat hard, some appear once.
          payload: { userId: `usr_${String(i % 7 === 0 ? i : i % 4)}`, seq: i },
        });
      }

      let reference: PluginEvent[] = [];
      for (const event of input) {
        reference = applyOverflow(reference, toPluginEvent(event), policy).queue;
      }

      const h = harness();
      h.subscribe({ kinds: ["friend.location"] }, policy);
      for (const event of input) h.bus.emit(event);
      h.tick();

      expect([overflow, delivered(h)]).toEqual([overflow, reference]);
    }
  });
});

describe("the emit path", () => {
  test("emit never awaits and never writes to the channel", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { credits: 10, maxBatch: 10 });
    const before = h.sent.length;

    /*
     * The invariant, asserted the only way it can be: `emit` is synchronous by signature, so what is
     * left to prove is that nothing plugin-related happens *inside* it. Nothing is sent, and the
     * only work is queueing.
     */
    for (let i = 0; i < 5_000; i++) h.emit({ kind: "friend.online" });
    expect(h.sent.length).toBe(before);

    h.tick();
    expect(h.events()).toHaveLength(1);
  });

  test("a plugin that never credits cannot grow the host's queue past its window", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { credits: 4, maxBatch: 4, overflow: "drop-oldest" });

    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 500; i++) h.emit({ kind: "friend.online" });
      h.tick();
    }

    // One window's worth was ever delivered, because nothing was ever credited back.
    expect(delivered(h)).toHaveLength(4);
    /*
     * And every one of the other 9,996 is accounted for: shed and reported, or still sitting in the
     * window waiting for credit that never came. Nothing is unaccounted for, and the host's whole
     * footprint for this plugin is those four pending events.
     */
    const shed = h.drops().reduce((total, frame) => total + frame.count, 0);
    const stillPending = 4;
    expect(shed + delivered(h).length + stillPending).toBe(10_000);
  });

  test("a payload that is not JSON costs the payload, not the event", () => {
    const cyclic: Record<string, unknown> = { userId: "usr_1" };
    cyclic.self = cyclic;
    const converted = toPluginEvent({
      kind: "friend.location",
      accountId: ACCOUNT,
      ts: 1,
      payload: cyclic,
    });
    expect(converted.payload).toBeUndefined();
    expect(converted.kind).toBe("friend.location");
  });
});

describe("the grant, re-read per tick", () => {
  test("a revoke closes every subscription and says so", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { credits: 100, maxBatch: 100 });
    h.emit({ kind: "friend.online" });

    h.setGrant(null);
    h.tick();

    expect(h.bridge.subscriptionCount(PLUGIN)).toBe(0);
    expect(h.bus.subscriberCount).toBe(0);
    expect(h.drops().at(-1)).toMatchObject({ reason: "shutdown", count: 1 });
    expect(delivered(h)).toEqual([]);
  });

  test("a narrowed grant purges what is already queued", () => {
    const h = harness();
    h.subscribe({}, { credits: 100, maxBatch: 100 });
    h.emit({ kind: "friend.online", subjectId: "usr_1" });
    h.emit({ kind: "gamelog.player_join", subjectId: "usr_2" });

    // The user unticked "read your game sessions" between the burst and the tick.
    h.setGrant(grantOf(["friends:read"], [ACCOUNT]));
    h.tick();

    expect(delivered(h).map((event) => event.subjectId)).toEqual(["usr_1"]);
    expect(h.drops()[0]).toMatchObject({ reason: "shutdown", count: 1 });
  });
});

describe("a channel that refuses a frame", () => {
  test("an oversized batch is halved until it fits, rather than being lost", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { credits: 100, maxBatch: 100 });
    for (let i = 0; i < 8; i++) h.emit({ kind: "friend.online", subjectId: `usr_${String(i)}` });

    // Stands in for `encodeEnvelope` refusing anything over the byte cap.
    h.refuseSends((frame) => frame.t === "event" && frame.events.length > 2);
    // Each flush schedules the next while a remainder is left, so a fixed number of ticks is enough
    // and there is nothing to sleep on.
    for (let i = 0; i < 12; i++) h.tick();

    expect(delivered(h).map((event) => event.subjectId)).toEqual([
      "usr_0",
      "usr_1",
      "usr_2",
      "usr_3",
      "usr_4",
      "usr_5",
      "usr_6",
      "usr_7",
    ]);
  });

  test("a dead peer drains the queue instead of retrying it forever", () => {
    const h = harness();
    h.subscribe({ kinds: ["friend.*"] }, { credits: 100, maxBatch: 100 });
    for (let i = 0; i < 4; i++) h.emit({ kind: "friend.online" });

    h.refuseSends(() => true);
    for (let i = 0; i < 10; i++) h.tick();
    h.refuseSends(null);
    h.emit({ kind: "friend.online", subjectId: "usr_after" });
    h.tick();

    // The four that could not be handed over are gone and counted; the queue is not wedged behind
    // them.
    expect(delivered(h).map((event) => event.subjectId)).toEqual(["usr_after"]);
  });
});
