/**
 * The triggers about your own account, and the game-log lines that got names.
 *
 * Separate from `triggers.test.ts` because that file covers the *machinery* — patterns, account
 * filters, arming, the ceilings — and this covers a catalogue. The split keeps a failure legible:
 * one says the subscription mechanism broke, the other says one node maps its payload wrong.
 *
 * Thin on purpose, and the three things it actually guards are the three that are easy to get
 * wrong: the double subscription that keeps a multi-aspect frame from being missed, a filter that
 * fails *closed* when it should fail open, and a teardown that quietly leaves a subscription live.
 */

import { describe, expect, test } from "bun:test";
import type { NodeConfigValues, PortValues } from "@vrcz/plugin-api/nodes";
import { BUS_EVENT_KINDS } from "@vrcz/shared";
import type { BusEvent } from "../../bus/event-bus.ts";
import { EventBus } from "../../bus/event-bus.ts";
import { createBuiltinNodes } from "./index.ts";

const T0 = 1_700_000_000_000;

interface Fired {
  readonly outputs: PortValues;
}

/**
 * Arms one trigger, with a canned {@link TriggerContext} behind it.
 *
 * Both context answers are constants, because what is under test here is whether a trigger *asks*.
 * The real implementation is two in-memory reads and belongs to the store and presence suites.
 */
async function armed(
  type: string,
  config: NodeConfigValues = {},
  context?: { location?: string; friends?: readonly string[] },
) {
  const bus = new EventBus();
  const nodes = createBuiltinNodes({
    bus,
    now: () => T0,
    ...(context === undefined
      ? {}
      : {
          triggerContext: {
            location: () => context.location ?? "",
            isFriend: (_accountId: string | null, userId: string) =>
              (context.friends ?? []).includes(userId),
          },
        }),
  });
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
  return {
    fired,
    emit: (event: Partial<BusEvent> & Pick<BusEvent, "kind">) => {
      bus.emit({ accountId: null, ts: T0, ...event });
    },
  };
}

/** Every id this file is responsible for. Also the roster the two blanket tests below walk. */
const NEW_TRIGGERS = [
  "on-my-status-change",
  "on-my-status-message-change",
  "on-my-avatar-change",
  "on-my-icon-change",
  "on-my-bio-change",
  "on-my-name-change",
  "on-my-trust-change",
  "on-my-platform-change",
  "on-my-location-change",
  "on-my-vrc-plus-change",
  "on-my-balance-change",
  "on-account-signed-in",
  "on-account-problem",
  "on-i-joined-a-group",
  "on-i-left-a-group",
  "on-my-group-membership-change",
  "on-my-group-role-change",
  "on-i-joined-a-queue",
  "on-my-queue-ready",
  "on-portal-spawn",
  "on-destination-set",
  "on-left-room",
  "on-join-failed",
  "on-screenshot",
  "on-game-start",
  "on-game-quit",
  "on-vr-mode-change",
  "on-client-authenticated",
];

describe("my profile changing", () => {
  const AVATAR = "avtr_00000000-1111-2222-3333-444444444444";

  test("fires on the refined kind, with the typed value and the before and after", async () => {
    const h = await armed("on-my-status-change", {}, { location: "wrld_x:1" });
    h.emit({
      kind: "user.updated.status",
      payload: { status: "busy", changes: [{ aspect: "status", from: "active", to: "busy" }] },
    });
    expect(h.fired[0]?.outputs).toEqual({
      status: "busy",
      from: "active",
      to: "busy",
      where: "wrld_x:1",
      at: T0,
      event: { status: "busy", changes: [{ aspect: "status", from: "active", to: "busy" }] },
    });
  });

  test("also fires on the generic kind when its aspect is one of several that moved", async () => {
    // The daemon keeps `user.updated` when a frame moved more than one thing, because picking a
    // headline would be arbitrary. An exact-kind-only subscription misses every such frame, which
    // is the common case when somebody edits their profile properly.
    const h = await armed("on-my-status-change");
    h.emit({
      kind: "user.updated",
      payload: {
        status: "busy",
        changes: [
          { aspect: "bio", from: "a", to: "b" },
          { aspect: "status", from: "active", to: "busy" },
        ],
      },
    });
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]?.outputs).toMatchObject({ status: "busy", to: "busy" });
  });

  test("ignores a generic frame that did not move its own aspect", async () => {
    const h = await armed("on-my-status-change");
    h.emit({ kind: "user.updated", payload: { changes: [{ aspect: "bio", from: "a", to: "b" }] } });
    expect(h.fired).toEqual([]);
  });

  test("the avatar node hands back a real avatar id, not the rendered change", async () => {
    // `FieldChange` carries rendered strings — an image URL here — but the whole user object is in
    // the payload beside it, so the typed port can be something `Look up an avatar` accepts.
    const h = await armed("on-my-avatar-change");
    h.emit({
      kind: "user.updated.avatar",
      payload: {
        currentAvatar: AVATAR,
        changes: [{ aspect: "avatar", from: "https://a/1.png", to: "https://a/2.png" }],
      },
    });
    expect(h.fired[0]?.outputs).toMatchObject({ avatar: AVATAR });
  });

  test("trust has no payload field of its own and falls back to the rendered rank", async () => {
    const h = await armed("on-my-trust-change");
    h.emit({
      kind: "user.updated.trust",
      payload: { changes: [{ aspect: "trust", from: "known", to: "trusted" }] },
    });
    expect(h.fired[0]?.outputs).toMatchObject({ trust: "trusted", from: "known" });
  });

  test("the eight share one output shape beside their typed port", () => {
    const nodes = createBuiltinNodes({ bus: new EventBus() });
    for (const id of NEW_TRIGGERS.filter((entry) => entry.endsWith("-change")).slice(0, 8)) {
      const definition = nodes.definition(`vrcz/${id}`);
      const outputs = (definition?.outputs ?? []).map((port) => port.id);
      expect(outputs.slice(1), id).toEqual(["from", "to", "where", "at", "event"]);
    }
  });
});

describe("the who filter on the player triggers", () => {
  const JOIN = { kind: "gamelog.player_join" as const, subjectId: "usr_a" };
  const PAYLOAD = { displayName: "Ada" };

  test("anyone is the default and fires for everybody", async () => {
    const h = await armed("on-player-join", {}, {});
    h.emit({ ...JOIN, payload: PAYLOAD });
    expect(h.fired).toHaveLength(1);
  });

  test("friends and strangers are opposites, and the port agrees with the filter", async () => {
    const friends = await armed("on-player-join", { who: "friends" }, { friends: ["usr_a"] });
    friends.emit({ ...JOIN, payload: PAYLOAD });
    expect(friends.fired[0]?.outputs).toMatchObject({ isFriend: true });

    const strangers = await armed("on-player-join", { who: "strangers" }, { friends: ["usr_a"] });
    strangers.emit({ ...JOIN, payload: PAYLOAD });
    expect(strangers.fired).toEqual([]);
  });

  test("a named person narrows further, whatever the who says", async () => {
    const h = await armed("on-player-join", { only: "usr_b" }, {});
    h.emit({ ...JOIN, payload: PAYLOAD });
    h.emit({ kind: "gamelog.player_join", subjectId: "usr_b", payload: { displayName: "Bea" } });
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]?.outputs).toMatchObject({ name: "Bea" });
  });

  test("somebody the log did not name passes anyone, but neither narrowing", async () => {
    // No id, no verdict — and refusing them under *strangers* would be as wrong as under *friends*.
    const anyone = await armed("on-player-join", {}, {});
    anyone.emit({ kind: "gamelog.player_join", payload: PAYLOAD });
    expect(anyone.fired).toHaveLength(1);

    const strangers = await armed("on-player-join", { who: "strangers" }, {});
    strangers.emit({ kind: "gamelog.player_join", payload: PAYLOAD });
    expect(strangers.fired).toEqual([]);
  });

  test("with no context at all the filter stays open rather than closing", async () => {
    // A build that cannot tell who is a friend should fire for everybody, not silently for nobody.
    const h = await armed("on-player-join", { who: "friends" });
    h.emit({ ...JOIN, payload: PAYLOAD });
    expect(h.fired).toHaveLength(1);
  });
});

describe("the notification type filter", () => {
  test("blank means anything, and a type narrows it", async () => {
    const any = await armed("on-notification");
    any.emit({ kind: "notification.received", payload: { type: "invite", id: "not_1" } });
    any.emit({ kind: "notification.received", payload: { type: "friendRequest", id: "not_2" } });
    expect(any.fired).toHaveLength(2);

    const invites = await armed("on-notification", { type: "invite" });
    invites.emit({ kind: "notification.received", payload: { type: "invite", id: "not_1" } });
    invites.emit({
      kind: "notification.received",
      payload: { type: "friendRequest", id: "not_2" },
    });
    expect(invites.fired).toHaveLength(1);
  });

  test("carries the id the accept and decline nodes take", async () => {
    // It was missing before: a graph could watch an invite arrive and had no way to hand it to the
    // node that answers it.
    const h = await armed("on-notification");
    h.emit({ kind: "notification.received", payload: { type: "invite", id: "not_1" } });
    expect(h.fired[0]?.outputs).toMatchObject({ id: "not_1" });
  });
});

describe("the rest of the Me triggers", () => {
  test("VRC+ reports whether it is on now, not the direction of travel", async () => {
    const on = await armed("on-my-vrc-plus-change");
    on.emit({
      kind: "economy.update.vrchat_plus",
      payload: { changes: [{ aspect: "vrchat_plus", from: "false", to: "true" }] },
    });
    expect(on.fired[0]?.outputs).toMatchObject({ active: true, from: "false", to: "true" });

    const off = await armed("on-my-vrc-plus-change");
    off.emit({
      kind: "economy.update.vrchat_plus",
      payload: { changes: [{ aspect: "vrchat_plus", from: "true", to: "false" }] },
    });
    expect(off.fired[0]?.outputs).toMatchObject({ active: false });
  });

  test("a balance change reports the delta, and omits it with nothing to compare to", async () => {
    const h = await armed("on-my-balance-change");
    h.emit({
      kind: "economy.update.wallet_balance",
      payload: { changes: [{ aspect: "wallet_balance", from: "100", to: "175" }] },
    });
    expect(h.fired[0]?.outputs).toMatchObject({ balance: 175, was: 100, delta: 75 });

    const first = await armed("on-my-balance-change");
    first.emit({
      kind: "economy.update.wallet_balance",
      payload: { changes: [{ aspect: "wallet_balance", from: null, to: "175" }] },
    });
    expect("delta" in (first.fired[0]?.outputs ?? {})).toBe(false);
  });

  test("the account triggers split the good transitions from the bad", async () => {
    const problem = await armed("on-account-problem");
    problem.emit({ kind: "account.state", payload: { id: "acc_1", state: "online" } });
    problem.emit({ kind: "account.state", payload: { id: "acc_1", state: "offline" } });
    expect(problem.fired).toHaveLength(1);
    expect(problem.fired[0]?.outputs).toMatchObject({ account: "acc_1", state: "offline" });

    const signin = await armed("on-account-signed-in");
    signin.emit({ kind: "account.ready", payload: { id: "acc_1", displayName: "Ada" } });
    expect(signin.fired[0]?.outputs).toMatchObject({ account: "acc_1", name: "Ada" });
  });

  test("the location trigger honours its source picker", async () => {
    const log = await armed("on-my-location-change", { source: "log" });
    log.emit({ kind: "gamelog.location_join", location: "wrld_x:1" });
    log.emit({ kind: "user.location", location: "wrld_y:2" });
    expect(log.fired).toHaveLength(1);
    expect(log.fired[0]?.outputs).toMatchObject({ location: "wrld_x:1", source: "log" });

    const either = await armed("on-my-location-change", { source: "both" });
    either.emit({ kind: "gamelog.location_join", location: "wrld_x:1" });
    either.emit({ kind: "user.location", location: "wrld_y:2" });
    expect(either.fired).toHaveLength(2);
  });

  test("a ready queue carries the instance", async () => {
    const h = await armed("on-my-queue-ready");
    h.emit({ kind: "instance.queue_ready", payload: { instanceLocation: "wrld_x:1" } });
    expect(h.fired[0]?.outputs).toMatchObject({ location: "wrld_x:1" });
  });

  test("group joins and role changes reach their own nodes", async () => {
    const joined = await armed("on-i-joined-a-group");
    joined.emit({ kind: "group.joined", payload: { groupId: "grp_1" } });
    expect(joined.fired[0]?.outputs).toMatchObject({ group: "grp_1" });

    const role = await armed("on-my-group-role-change");
    role.emit({
      kind: "group.role_updated",
      payload: { role: { groupId: "grp_1", id: "grol_1", name: "Moderator" } },
    });
    expect(role.fired[0]?.outputs).toMatchObject({ group: "grp_1", role: "Moderator" });
  });
});

describe("the game-log triggers", () => {
  test("a portal fires even when the line named neither half", async () => {
    const full = await armed("on-portal-spawn");
    full.emit({
      kind: "gamelog.portal_spawn",
      payload: { spawnerDisplayName: "Ada", destination: "wrld_x:1~region(eu)" },
    });
    expect(full.fired[0]?.outputs).toMatchObject({
      by: "Ada",
      destination: "wrld_x:1~region(eu)",
      world: "wrld_x",
    });

    // An unproduced port kills only the branch that needed it, so a graph wired through "a portal
    // appeared" still runs on a line that never said where it went.
    const bare = await armed("on-portal-spawn");
    bare.emit({ kind: "gamelog.portal_spawn", payload: {} });
    expect(bare.fired).toHaveLength(1);
    const outputs = bare.fired[0]?.outputs ?? {};
    expect("by" in outputs).toBe(false);
    expect("destination" in outputs).toBe(false);
  });

  test("a failed join carries VRChat's own reason", async () => {
    const h = await armed("on-join-failed");
    h.emit({ kind: "gamelog.join_failed", payload: { reason: "That instance is full." } });
    expect(h.fired[0]?.outputs).toMatchObject({ reason: "That instance is full." });
  });

  test("vr mode gives both the word and the boolean", async () => {
    const h = await armed("on-vr-mode-change");
    h.emit({ kind: "gamelog.vr_mode", payload: { vrMode: "desktop" } });
    expect(h.fired[0]?.outputs).toMatchObject({ mode: "desktop", inVr: false });
  });

  test("a screenshot with no path is dropped rather than fired with a hole", async () => {
    const h = await armed("on-screenshot");
    h.emit({ kind: "gamelog.screenshot", payload: {} });
    expect(h.fired).toEqual([]);
  });
});

describe("every new trigger", () => {
  test("is registered, is a trigger, and carries the account picker", () => {
    const nodes = createBuiltinNodes({ bus: new EventBus() });
    for (const id of NEW_TRIGGERS) {
      const definition = nodes.definition(`vrcz/${id}`);
      expect(definition, id).not.toBeNull();
      expect(definition?.kind, id).toBe("trigger");
      expect(definition?.category, id).toBe("Triggers");
      const account = definition?.config?.find((field) => field.id === "accountId");
      expect(account?.kind, id).toBe("account");
    }
  });

  test("arms and tears down without leaving a subscription behind", async () => {
    const bus = new EventBus();
    const nodes = createBuiltinNodes({ bus, now: () => T0 });
    for (const id of NEW_TRIGGERS) {
      let fires = 0;
      await nodes.arm(`vrcz/${id}`, {
        instanceId: `inst-${id}`,
        graphId: "g1",
        nodeId: "n1",
        config: {},
        fire: () => {
          fires += 1;
        },
      });
      await nodes.disarm(`vrcz/${id}`, `inst-${id}`);
      // Every kind this build knows, at a disarmed trigger. A teardown that did not run shows up
      // here rather than as a graph that keeps firing after the user switched it off.
      for (const kind of BUS_EVENT_KINDS) {
        bus.emit({ kind, accountId: null, ts: T0, payload: {} });
      }
      expect(fires, id).toBe(0);
    }
  });
});
