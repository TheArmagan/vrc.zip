/**
 * One real exported graph, walked by the real engine over the real built-ins.
 *
 * Every other test in `graphs/` asserts one node, or asserts the walk against a fake provider. Both
 * are the right shape for what they cover and both missed decision 278 completely: the extractor
 * did exactly what its unit test said, the walk did exactly what its unit test said, and the graph
 * a user drew produced nothing at all. The gap was between them — a port type the editor accepts,
 * a value the node cannot read, and a skip that reaches the end of the run without an error.
 *
 * So this file takes the document as exported, from the editor, by hand, and runs it: bus event in,
 * VRChat reads and one invite and one toast out. It is deliberately the whole thing rather than a
 * reduction of it, because the reduction is what the other tests already are.
 *
 * The graph is "Invite to avtr.zip group. When they join instance." — a player-join trigger, an
 * instance extractor for the world id, a group extractor for the group's name, an invite, and a
 * desktop notification composed from both.
 */

import { describe, expect, test } from "bun:test";
import type { GraphDocument } from "@vrcz/shared";
import { EventBus } from "../bus/event-bus.ts";
import { MEMORY, Store } from "../store/store.ts";
import type { GraphNotification } from "./builtins/actions.ts";
import { createBuiltinNodes } from "./builtins/index.ts";
import { GraphEngine } from "./engine.ts";

const T0 = 1_700_000_000_000;
const ACCOUNT = "usr_eca8d741-9f5b-45dc-a204-b667500607d7";
const WORLD = "wrld_0ae3e886-52eb-4ee0-aa0c-ef7d5a9fb2d8";
const GROUP = "grp_3392dcb3-ed45-4a6b-85d8-a30032c7c0ea";
const LOCATION = `${WORLD}:47118~region(eu)`;

/** The document exactly as `.vrcz-graph.json` carries it, minus the positions and hashes. */
const DOCUMENT: GraphDocument = {
  nodes: [
    {
      id: "join",
      type: "vrcz/on-player-join",
      position: { x: 0, y: 0 },
      config: { who: "anyone" },
    },
    {
      id: "instance",
      type: "vrcz/extract-instance",
      position: { x: 0, y: 0 },
      config: { fields: JSON.stringify([{ slot: "o2", path: "worldId", label: "worldId" }]) },
    },
    {
      id: "world",
      type: "vrcz/text-value",
      position: { x: 0, y: 0 },
      config: { value: WORLD },
    },
    { id: "same", type: "vrcz/compare", position: { x: 0, y: 0 }, config: { op: "eq" } },
    {
      id: "invite",
      type: "vrcz/invite-to-group",
      position: { x: 0, y: 0 },
      config: { accountId: ACCOUNT },
    },
    { id: "group", type: "vrcz/group-value", position: { x: 0, y: 0 }, config: { value: GROUP } },
    {
      id: "groupName",
      type: "vrcz/extract-group",
      position: { x: 0, y: 0 },
      config: { fields: JSON.stringify([{ slot: "o1", path: "name", label: "groupName" }]) },
    },
    { id: "only", type: "vrcz/gate", position: { x: 0, y: 0 }, config: {} },
    {
      id: "notify",
      type: "vrcz/desktop-notification",
      position: { x: 0, y: 0 },
      config: { title: "vrc.zip", silent: true },
    },
    {
      id: "text",
      type: "vrcz/template",
      position: { x: 0, y: 0 },
      config: {
        slots: 2,
        template: "User {a} automatically invited to {b} group! After they joined the instance.",
      },
    },
  ],
  edges: [
    { id: "e1", from: { node: "join", port: "location" }, to: { node: "instance", port: "value" } },
    { id: "e2", from: { node: "instance", port: "o2" }, to: { node: "same", port: "right" } },
    { id: "e3", from: { node: "world", port: "value" }, to: { node: "same", port: "left" } },
    { id: "e4", from: { node: "group", port: "value" }, to: { node: "invite", port: "group" } },
    { id: "e5", from: { node: "join", port: "user" }, to: { node: "invite", port: "user" } },
    { id: "e6", from: { node: "group", port: "value" }, to: { node: "groupName", port: "value" } },
    { id: "e7", from: { node: "invite", port: "sent" }, to: { node: "only", port: "value" } },
    { id: "e8", from: { node: "only", port: "out" }, to: { node: "notify", port: "after" } },
    { id: "e9", from: { node: "groupName", port: "o1" }, to: { node: "text", port: "b" } },
    { id: "e10", from: { node: "join", port: "name" }, to: { node: "text", port: "a" } },
    { id: "e11", from: { node: "text", port: "text" }, to: { node: "notify", port: "text" } },
    // The world check, and it is the whole graph's filter: `Compare` answers, and the invite runs
    // only if the answer was yes. Decision 281 is what gives this edge that meaning — without it
    // `Compare` produces `result` either way, the edge is never dead, and the invite fires in every
    // world while looking on the canvas exactly as it does now.
    { id: "e12", from: { node: "same", port: "result" }, to: { node: "invite", port: "after" } },
    /*
     * And the group lookup waits on the invite, which is what keeps the wrong world free.
     *
     * `Compose text` takes the joiner's name straight from the trigger, so it sits on a path the
     * world check is not on: without this edge the group is looked up and a line composed on every
     * join anywhere, and only the notification at the end skips. One request per join at a trigger
     * capped at 120 a minute is a real cost for a message nobody sees.
     */
    { id: "e13", from: { node: "invite", port: "sent" }, to: { node: "groupName", port: "after" } },
  ],
};

interface Ran {
  readonly invites: string[];
  readonly toasts: GraphNotification[];
  readonly reads: string[];
  readonly errors: string[];
}

/**
 * One player-join, in whichever world the running client is standing in.
 *
 * The world is the parameter because it is the only thing the graph is asking about: same document,
 * same event, one different room, and the answer has to be an invite or nothing at all.
 */
async function run(world = WORLD): Promise<Ran> {
  const location = `${world}:47118~region(eu)`;
  const store = Store.open(MEMORY);
  store.upsertAccount({
    id: ACCOUNT,
    display_name: "Owner",
    added_at: T0,
    enabled: 1,
    last_seen_at: null,
  });
  const bus = new EventBus();
  const invites: string[] = [];
  const toasts: GraphNotification[] = [];
  const reads: string[] = [];
  const errors: string[] = [];

  const nodes = createBuiltinNodes({
    bus,
    now: () => T0,
    social: {
      invite: async () => await Promise.resolve(),
      requestInvite: async () => await Promise.resolve(),
      boop: async () => await Promise.resolve(),
      inviteToGroup: async (accountId, groupId, userId) => {
        invites.push(`${accountId} ${groupId} ${userId}`);
        await Promise.resolve();
      },
      selectAvatar: async () => await Promise.resolve(),
    },
    notify: async (notification) => {
      toasts.push(notification);
      return await Promise.resolve({ shown: true });
    },
    reads: {
      user: async () => await Promise.resolve({}),
      world: async () => await Promise.resolve({}),
      instance: async (accountId, asked) => {
        reads.push(`instance ${accountId} ${asked}`);
        return await Promise.resolve({ worldId: world, userCount: 12, capacity: 32 });
      },
      avatar: async () => await Promise.resolve({}),
      group: async (accountId, groupId) => {
        reads.push(`group ${accountId} ${groupId}`);
        return await Promise.resolve({ name: "avtr.zip", memberCount: 300 });
      },
      friends: async () => await Promise.resolve([]),
      instancePlayers: () => ({ names: [], users: [] }),
    },
    // The join line says nothing about where it happened, so the instance is the running client's
    // own room. This is the seam that answers that, and without it the extractor gets nothing to
    // extract from — which is a different failure from the one this file is about.
    triggerContext: { location: () => location, isFriend: () => false },
  });

  const engine = new GraphEngine({
    store,
    bus,
    // `BuiltinNodes` satisfies `NodeProvider` structurally, which is decision 206's whole point:
    // the engine cannot tell a built-in from a plugin's node.
    provider: nodes,
    now: () => T0,
    sleep: async () => await Promise.resolve(),
    sweepMs: 0,
    onError: (message) => {
      errors.push(message);
    },
  });

  store.insertGraph({
    id: "g1",
    name: "Invite to avtr.zip group. When they join instance.",
    description: "",
    enabled: 1,
    // Armed, not rehearsing: a dry run is a different assertion, and this file is about whether the
    // values reach the far end at all.
    armed: 1,
    concurrency: "parallel",
    account_id: ACCOUNT,
    definition: JSON.stringify(DOCUMENT),
    created_at: T0,
    updated_at: T0,
  });

  await engine.start();
  bus.emit({
    kind: "gamelog.player_join",
    ts: T0,
    accountId: ACCOUNT,
    subjectId: "usr_ada",
    payload: { displayName: "Ada" },
  });
  // The trigger fires synchronously inside the subscription; the run it starts does not. One turn
  // of the loop per node is more than the walk needs, and waiting on a timer would be a test that
  // passes for a reason nobody can name.
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await engine.stop();

  return { invites, toasts, reads, errors };
}

describe("the exported avtr.zip invite graph", () => {
  test("in the named world, a player join reaches the toast through both extractors", async () => {
    const ran = await run();
    expect(ran.errors).toEqual([]);
    // Decision 278: both extractors were handed an id rather than an object, and both looked it up.
    expect(ran.reads).toEqual([`instance ${ACCOUNT} ${LOCATION}`, `group ${ACCOUNT} ${GROUP}`]);
    expect(ran.invites).toEqual([`${ACCOUNT} ${GROUP} usr_ada`]);
    expect(ran.toasts).toHaveLength(1);
    expect(ran.toasts[0]?.body).toBe(
      "User Ada automatically invited to avtr.zip group! After they joined the instance.",
    );
  });

  test("in any other world, nobody is invited and nothing is shown", async () => {
    // Decision 281. The `Compare` is wired straight into the invite's `run after`, and this is the
    // assertion that says that edge does something: same document, same join, one different room.
    const ran = await run("wrld_ffffffff-0000-0000-0000-000000000000");
    expect(ran.errors).toEqual([]);
    expect(ran.invites).toEqual([]);
    expect(ran.toasts).toEqual([]);
    /*
     * Exactly one read, and it is the one the graph cannot avoid.
     *
     * The instance is read because the graph has to look before it can decide. The group is not,
     * and that is edge `e13` doing its job: the composer's other input comes straight from the
     * trigger, so without it the name would be looked up and a line built for a notification that
     * then skips — every join, in every world, at a trigger capped at 120 a minute.
     */
    expect(ran.reads).toEqual([
      `instance ${ACCOUNT} wrld_ffffffff-0000-0000-0000-000000000000:47118~region(eu)`,
    ]);
  });
});
