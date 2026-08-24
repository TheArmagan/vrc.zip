/**
 * The triggers about other people: the eight profile aspects again, plus moving, being added,
 * being dropped and waking up.
 *
 * Split from `triggers-me.test.ts` for the same reason that file is split from `triggers.test.ts` —
 * one covers the machinery, one covers your own account, this one covers everybody else's — and the
 * split keeps a failure legible. What it actually guards is the handful of things that differ from
 * the self family and are therefore easy to get wrong: the payload's nested `user` object, the
 * subject id spelled four ways, the who-filter, and the one node whose subject is deliberately not
 * typed as a friend.
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

/** The same harness `triggers-me.test.ts` uses, with a canned {@link TriggerContext} behind it. */
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

/** Every id this file is responsible for. Also the roster the blanket tests below walk. */
const OTHER_TRIGGERS = [
  "on-someone-status-change",
  "on-someone-status-message-change",
  "on-someone-avatar-change",
  "on-someone-icon-change",
  "on-someone-bio-change",
  "on-someone-name-change",
  "on-someone-trust-change",
  "on-someone-platform-change",
  "on-someone-goes-somewhere",
  "on-someone-becomes-active",
  "on-someone-becomes-a-friend",
  "on-someone-stops-being-a-friend",
];

const AVATAR = "avtr_00000000-1111-2222-3333-444444444444";

/** A `friend-update` frame as the bridge actually publishes it: the fields live under `user`. */
function frame(user: Record<string, unknown>, changes: readonly unknown[]) {
  return { userId: "usr_a", user: { id: "usr_a", displayName: "Ada", ...user }, changes };
}

describe("somebody else's profile changing", () => {
  test("fires on the refined kind, with who it was and the typed value", async () => {
    const h = await armed("on-someone-status-change");
    h.emit({
      kind: "friend.updated.status",
      subjectId: "usr_a",
      payload: frame({ status: "busy" }, [{ aspect: "status", from: "active", to: "busy" }]),
    });
    expect(h.fired[0]?.outputs).toMatchObject({
      friend: "usr_a",
      name: "Ada",
      status: "busy",
      from: "active",
      to: "busy",
      at: T0,
    });
  });

  test("also fires on the generic kind when its aspect is one of several that moved", async () => {
    const h = await armed("on-someone-status-change");
    h.emit({
      kind: "friend.updated",
      subjectId: "usr_a",
      payload: frame({ status: "busy" }, [
        { aspect: "bio", from: "a", to: "b" },
        { aspect: "status", from: "active", to: "busy" },
      ]),
    });
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]?.outputs).toMatchObject({ status: "busy", to: "busy" });
  });

  test("ignores a generic frame that did not move its own aspect", async () => {
    const h = await armed("on-someone-status-change");
    h.emit({
      kind: "friend.updated",
      subjectId: "usr_a",
      payload: frame({}, [{ aspect: "bio", from: "a", to: "b" }]),
    });
    expect(h.fired).toEqual([]);
  });

  test("ignores the self half of the vocabulary entirely", async () => {
    // `user.updated.*` is the same aspect about you. Two families, two subscriptions, no overlap.
    const h = await armed("on-someone-status-change");
    h.emit({
      kind: "user.updated.status",
      payload: { status: "busy", changes: [{ aspect: "status", from: "active", to: "busy" }] },
    });
    expect(h.fired).toEqual([]);
  });

  test("reads the value out of the nested user object, not the flat payload", async () => {
    const h = await armed("on-someone-status-change");
    h.emit({
      kind: "friend.updated.status",
      subjectId: "usr_a",
      // Same field on the flat payload, holding the wrong answer. A read that ignored the nesting
      // would take this one.
      payload: { ...frame({ status: "busy" }, []), status: "away" },
    });
    expect(h.fired[0]?.outputs).toMatchObject({ status: "busy" });
  });

  test("somebody else's avatar port is unset, because the frame cannot name the avatar", async () => {
    /*
     * A `friend-update` frame's `user` is a public `PipelineUser`: it carries
     * `currentAvatarThumbnailImageUrl` and no `currentAvatar`, because VRChat does not tell you
     * which avatar id somebody else is wearing. The rendered change beside it is that same URL, so
     * falling back to it put an image address in a port typed `avatar`. Nothing is the honest
     * answer, and the node still fires for the branches that wanted the before and after.
     */
    const h = await armed("on-someone-avatar-change");
    h.emit({
      kind: "friend.updated.avatar",
      subjectId: "usr_a",
      payload: frame({ currentAvatarThumbnailImageUrl: "https://a/2.png" }, [
        { aspect: "avatar", from: "https://a/1.png", to: "https://a/2.png" },
      ]),
    });
    expect(h.fired).toHaveLength(1);
    expect("avatar" in (h.fired[0]?.outputs ?? {})).toBe(false);
    expect(h.fired[0]?.outputs).toMatchObject({ friend: "usr_a", to: "https://a/2.png" });
  });

  test("an avatar id in the frame does reach the port", async () => {
    // Kept because the port is not dead: a frame that does carry an `avtr_` id fills it.
    const h = await armed("on-someone-avatar-change");
    h.emit({
      kind: "friend.updated.avatar",
      subjectId: "usr_a",
      payload: frame({ currentAvatar: AVATAR }, [
        { aspect: "avatar", from: "https://a/1.png", to: "https://a/2.png" },
      ]),
    });
    expect(h.fired[0]?.outputs).toMatchObject({ avatar: AVATAR, to: "https://a/2.png" });
  });

  test("trust has no field of its own and falls back to the rendered rank", async () => {
    const h = await armed("on-someone-trust-change");
    h.emit({
      kind: "friend.updated.trust",
      subjectId: "usr_a",
      payload: frame({}, [{ aspect: "trust", from: "known", to: "trusted" }]),
    });
    expect(h.fired[0]?.outputs).toMatchObject({ trust: "trusted", from: "known" });
  });

  test("the display-name node has one name port, not two that disagree", async () => {
    // Its value port *is* the name, so a separate `name` output would be the same string twice and
    // a duplicate port id besides.
    const nodes = createBuiltinNodes({ bus: new EventBus() });
    const outputs = (nodes.definition("vrcz/on-someone-name-change")?.outputs ?? []).map(
      (port) => port.id,
    );
    expect(outputs).toEqual(["friend", "name", "from", "to", "at", "event"]);
    expect(new Set(outputs).size).toBe(outputs.length);

    const h = await armed("on-someone-name-change");
    h.emit({
      kind: "friend.updated.name",
      subjectId: "usr_a",
      payload: frame({ displayName: "Bea" }, [{ aspect: "name", from: "Ada", to: "Bea" }]),
    });
    expect(h.fired[0]?.outputs).toMatchObject({ name: "Bea", from: "Ada" });
  });

  test("a frame with no subject at all is dropped rather than fired without one", async () => {
    const h = await armed("on-someone-status-change");
    h.emit({
      kind: "friend.updated.status",
      payload: { changes: [{ aspect: "status", from: "active", to: "busy" }] },
    });
    expect(h.fired).toEqual([]);
  });

  test("the subject port is a friend, which widens into any user port", async () => {
    const nodes = createBuiltinNodes({ bus: new EventBus() });
    for (const id of OTHER_TRIGGERS.filter(
      (entry) => entry !== "on-someone-stops-being-a-friend",
    )) {
      const first = nodes.definition(`vrcz/${id}`)?.outputs?.[0];
      expect(first?.id, id).toBe("friend");
      expect(first?.type, id).toBe("friend");
    }
  });
});

describe("the who filter on the other-people triggers", () => {
  const UPDATE = {
    kind: "friend.updated.status" as const,
    subjectId: "usr_a",
    payload: frame({ status: "busy" }, [{ aspect: "status", from: "active", to: "busy" }]),
  };

  test("anyone is the default and fires for everybody", async () => {
    const h = await armed("on-someone-status-change", {}, { friends: [] });
    h.emit(UPDATE);
    expect(h.fired).toHaveLength(1);
  });

  test("a named person narrows to that one person", async () => {
    const h = await armed("on-someone-status-change", { only: "usr_b" });
    h.emit(UPDATE);
    expect(h.fired).toEqual([]);

    const wanted = await armed("on-someone-status-change", { only: "usr_a" });
    wanted.emit(UPDATE);
    expect(wanted.fired).toHaveLength(1);
  });

  test("strangers selects nothing, because VRChat only pushes these for friends", async () => {
    // Documented rather than fixed: the filter is doing exactly what it says over an empty set.
    const h = await armed("on-someone-status-change", { who: "strangers" }, { friends: ["usr_a"] });
    h.emit(UPDATE);
    expect(h.fired).toEqual([]);
  });

  test("with no context at all the filter stays open rather than closing", async () => {
    const h = await armed("on-someone-status-change", { who: "friends" });
    h.emit(UPDATE);
    expect(h.fired).toHaveLength(1);
  });
});

describe("the rest of the other-people triggers", () => {
  test("a move carries the instance, the world, and where they are headed", async () => {
    const h = await armed("on-someone-goes-somewhere");
    h.emit({
      kind: "friend.location",
      subjectId: "usr_a",
      location: "wrld_x:1~region(eu)",
      payload: {
        userId: "usr_a",
        user: { id: "usr_a", displayName: "Ada" },
        location: "wrld_x:1~region(eu)",
        travelingToLocation: "wrld_y:2",
      },
    });
    expect(h.fired[0]?.outputs).toMatchObject({
      friend: "usr_a",
      name: "Ada",
      location: "wrld_x:1~region(eu)",
      world: "wrld_x",
      travellingTo: "wrld_y:2",
    });
  });

  test("going offline is not going somewhere, but going private is", async () => {
    const off = await armed("on-someone-goes-somewhere");
    off.emit({ kind: "friend.location", subjectId: "usr_a", location: "offline", payload: {} });
    expect(off.fired).toEqual([]);

    const private_ = await armed("on-someone-goes-somewhere");
    private_.emit({
      kind: "friend.location",
      subjectId: "usr_a",
      location: "private",
      payload: {},
    });
    expect(private_.fired).toHaveLength(1);
    expect("world" in (private_.fired[0]?.outputs ?? {})).toBe(false);
  });

  test("becoming active reads the id through VRChat's own lowercase typo", async () => {
    // `friend-active` spells it `userid`. Reading only the correct spelling drops every one of them.
    const h = await armed("on-someone-becomes-active");
    h.emit({
      kind: "friend.active",
      payload: { userid: "usr_a", user: { id: "usr_a", displayName: "Ada" }, platform: "android" },
    });
    expect(h.fired[0]?.outputs).toMatchObject({
      friend: "usr_a",
      name: "Ada",
      platform: "android",
    });
  });

  test("being added and being dropped reach their own nodes", async () => {
    const added = await armed("on-someone-becomes-a-friend");
    added.emit({
      kind: "friend.added",
      subjectId: "usr_a",
      payload: { userId: "usr_a", user: { id: "usr_a", displayName: "Ada" } },
    });
    expect(added.fired[0]?.outputs).toMatchObject({ friend: "usr_a", name: "Ada" });

    const removed = await armed("on-someone-stops-being-a-friend");
    removed.emit({ kind: "friend.removed", subjectId: "usr_a", payload: { userId: "usr_a" } });
    expect(removed.fired[0]?.outputs).toMatchObject({ user: "usr_a" });
  });

  test("the ex-friend node hands back a user, not a friend, and asks nothing about friendship", () => {
    // By the time it fires the relationship is the thing that ended, so a `friend` port would flow
    // into nodes that need one and fail. The Friends/Strangers picker is absent for the same reason:
    // it would race the presence map this very event is updating.
    const nodes = createBuiltinNodes({ bus: new EventBus() });
    const definition = nodes.definition("vrcz/on-someone-stops-being-a-friend");
    expect(definition?.outputs?.[0]).toMatchObject({ id: "user", type: "user" });
    expect(definition?.config?.map((field) => field.id)).toEqual(["accountId", "only"]);
  });
});

describe("every other-people trigger", () => {
  test("is registered, is a trigger, and carries the account picker", () => {
    const nodes = createBuiltinNodes({ bus: new EventBus() });
    for (const id of OTHER_TRIGGERS) {
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
    for (const id of OTHER_TRIGGERS) {
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
      for (const kind of BUS_EVENT_KINDS) {
        bus.emit({ kind, accountId: null, ts: T0, subjectId: "usr_a", payload: {} });
      }
      expect(fires, id).toBe(0);
    }
  });
});
