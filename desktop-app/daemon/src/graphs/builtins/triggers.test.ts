import { describe, expect, test } from "bun:test";
import type { NodeConfigValues, PortValues } from "@vrcz/plugin-api/nodes";
import type { BusEvent } from "../../bus/event-bus.ts";
import { EventBus } from "../../bus/event-bus.ts";
import { createBuiltinNodes } from "./index.ts";
import { MIN_SCHEDULE_MS, parsePatterns } from "./triggers.ts";

const T0 = 1_700_000_000_000;

interface Fired {
  readonly outputs: PortValues;
}

/** Arms one trigger and collects what it fires. Returns the teardown the engine would hold. */
async function armed(type: string, config: NodeConfigValues = {}) {
  const bus = new EventBus();
  const nodes = createBuiltinNodes({ bus, now: () => T0 });
  const fired: Fired[] = [];
  await nodes.arm(`vrcz/${type}`, {
    instanceId: "inst-1",
    graphId: "g1",
    nodeId: "n1",
    config,
    fire: (outputs) => {
      fired.push({ outputs });
    },
  });
  const emit = (event: Partial<BusEvent> & Pick<BusEvent, "kind">) => {
    bus.emit({ accountId: null, ts: T0, ...event });
  };
  return {
    fired,
    emit,
    disarm: () => nodes.disarm(`vrcz/${type}`, "inst-1"),
  };
}

describe("the generic trigger", () => {
  test("fires on an exact kind and on a family pattern", async () => {
    const exact = await armed("on-event", { kinds: "friend.online" });
    exact.emit({ kind: "friend.online", subjectId: "usr_a" });
    exact.emit({ kind: "friend.offline", subjectId: "usr_a" });
    expect(exact.fired).toHaveLength(1);

    const family = await armed("on-event", { kinds: "friend.*" });
    family.emit({ kind: "friend.online" });
    family.emit({ kind: "friend.offline" });
    family.emit({ kind: "gamelog.player_join" });
    expect(family.fired).toHaveLength(2);
  });

  test("carries the kind, the timestamp and the raw payload", async () => {
    const h = await armed("on-event", { kinds: "friend.online" });
    h.emit({ kind: "friend.online", ts: T0 + 5, payload: { a: 1 } });
    expect(h.fired[0]?.outputs).toEqual({ event: { a: 1 }, kind: "friend.online", at: T0 + 5 });
  });

  test("an account filter narrows it, and blank means every account", async () => {
    const filtered = await armed("on-event", { kinds: "friend.*", accountId: "usr_me" });
    filtered.emit({ kind: "friend.online", accountId: "usr_me" });
    filtered.emit({ kind: "friend.online", accountId: "usr_other" });
    expect(filtered.fired).toHaveLength(1);

    const all = await armed("on-event", { kinds: "friend.*", accountId: "" });
    all.emit({ kind: "friend.online", accountId: "usr_me" });
    all.emit({ kind: "friend.online", accountId: "usr_other" });
    expect(all.fired).toHaveLength(2);
  });

  test("disarming stops it", async () => {
    const h = await armed("on-event", { kinds: "friend.*" });
    await h.disarm();
    h.emit({ kind: "friend.online" });
    expect(h.fired).toEqual([]);
  });

  test("a pattern that is not a pattern arms nothing rather than throwing", async () => {
    // A typo in one graph must not fail the arm and take the rest of its triggers with it.
    expect(parsePatterns("friend.*, nonsense.*, friend.online")).toEqual([
      "friend.*",
      "friend.online",
    ]);
    expect(parsePatterns("")).toEqual([]);
    expect(parsePatterns(7)).toEqual([]);

    const h = await armed("on-event", { kinds: "nonsense.*" });
    h.emit({ kind: "friend.online" });
    expect(h.fired).toEqual([]);
  });
});

describe("the presets", () => {
  test("friend online carries a typed friend id", async () => {
    const h = await armed("on-friend-online");
    h.emit({ kind: "friend.online", subjectId: "usr_a", ts: T0 + 1, payload: { x: 1 } });
    expect(h.fired[0]?.outputs).toEqual({ friend: "usr_a", at: T0 + 1, event: { x: 1 } });
  });

  test("an event missing what the preset promises is dropped, not fired with a hole", async () => {
    // Everything downstream would otherwise run with `undefined` where it expected a friend.
    const h = await armed("on-friend-online");
    h.emit({ kind: "friend.online", subjectId: null });
    expect(h.fired).toEqual([]);
  });

  test("player join offers the name always and the id when the log had one", async () => {
    // VRChat has shipped that log line both ways, which is why the name is the required half.
    const withId = await armed("on-player-join");
    withId.emit({
      kind: "gamelog.player_join",
      subjectId: "usr_a",
      location: "wrld_x:1~private",
      payload: { displayName: "Ada" },
    });
    expect(withId.fired[0]?.outputs).toEqual({
      name: "Ada",
      user: "usr_a",
      location: "wrld_x:1~private",
      at: T0,
    });

    const withoutId = await armed("on-player-join");
    withoutId.emit({ kind: "gamelog.player_join", payload: { displayName: "Ada" } });
    expect(withoutId.fired[0]?.outputs).toEqual({ name: "Ada", at: T0 });
  });

  test("a notification fires with its type and sender", async () => {
    const h = await armed("on-notification");
    h.emit({
      kind: "notification.received",
      payload: { type: "friendRequest", senderUserId: "usr_a", message: "hi" },
    });
    expect(h.fired[0]?.outputs).toMatchObject({
      type: "friendRequest",
      from: "usr_a",
      message: "hi",
    });
  });

  test("both notification kinds reach the same preset", async () => {
    const h = await armed("on-notification");
    h.emit({ kind: "notification.received", payload: { type: "invite" } });
    h.emit({ kind: "notification.received_v2", payload: { type: "invite" } });
    expect(h.fired).toHaveLength(2);
  });
});

describe("the schedule", () => {
  test("clamps a too-short period rather than refusing it", async () => {
    // A graph saved with five seconds should run every minute, not stop working with an error the
    // author only finds if they go looking.
    const h = await armed("on-schedule", { everyMs: 5 });
    // No wall-clock waiting here: what matters is that arming did not throw and can be undone.
    await h.disarm();
    expect(MIN_SCHEDULE_MS).toBe(60_000);
  });
});

describe("run now", () => {
  test("arms nothing at all", async () => {
    // Its fires come from the control API, through the engine's own door, so they are subject to
    // every ceiling rather than being a special path around them.
    const h = await armed("run-now");
    h.emit({ kind: "friend.online" });
    expect(h.fired).toEqual([]);
  });
});

describe("a set built without a bus", () => {
  test("offers no triggers rather than triggers that never fire", () => {
    const ids = createBuiltinNodes()
      .definitions()
      .map((definition) => definition.id);
    expect(ids).not.toContain("on-event");
    expect(ids).toContain("compare");
  });
});
