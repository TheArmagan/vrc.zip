/**
 * Turning an id into the thing it names.
 *
 * A trigger hands you a `user` — an id with host-known meaning, which is what the port types are
 * (see `nodes.md`). It does not hand you a display name, a status, or where they are. These nodes
 * are how a graph gets from one to the other.
 *
 * ## They cost a request, and that shapes them
 *
 * Every one of these is a live VRChat read through the acting account, so it passes the rate limiter
 * like everything else. Three consequences, all deliberate:
 *
 * - **A resolver is not a source.** Each takes an id input, so it only runs when the run reaches it.
 *   The one exception is the friend list, which takes nothing — and the engine's source rule already
 *   says a source only runs when something reachable consumes it, so a friend list wired into a
 *   branch this run never took costs nothing.
 * - **Each has a `json` output beside the typed ones.** The typed ports cover what a graph asks for
 *   nine times out of ten; the blob is there so `Read field` can reach the tenth without this file
 *   growing a port per VRChat field.
 * - **A failure throws** rather than gating, because "VRChat said no" is a thing the author should
 *   see on the run, and the error port is right there for anyone who would rather handle it.
 */

import type { NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import type { ExecuteContext } from "../types.ts";
import { ME_CATEGORY } from "./me.ts";
import type { BuiltinNode } from "./types.ts";

/**
 * What the graph runtime needs to read from VRChat, and from the game log.
 *
 * Declared here and satisfied by `wiring/graph-reads.ts`, the same arrangement the social actions
 * use: `graphs/` states a shape, `wiring/` implements it, and neither knows the other exists.
 */
export interface GraphReads {
  user(accountId: string, userId: string): Promise<Record<string, unknown>>;
  world(accountId: string, worldId: string): Promise<Record<string, unknown>>;
  instance(accountId: string, location: string): Promise<Record<string, unknown>>;
  avatar(accountId: string, avatarId: string): Promise<Record<string, unknown>>;
  group(accountId: string, groupId: string): Promise<Record<string, unknown>>;
  /** The account's friends, as vrc.zip already holds them. No request. */
  friends(accountId: string): Promise<{ id: string; displayName: string; status: string }[]>;
  /**
   * Who is in this account's instance right now, from the game log rather than from VRChat.
   *
   * The log is the only honest source: VRChat's own roster answers for an instance the account
   * *created*, which is almost never the one somebody is sitting in.
   */
  instancePlayers(accountId: string | null): { names: string[]; users: string[] };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function requireAccount(context: ExecuteContext, doing: string): string {
  if (context.accountId === null || context.accountId === "") {
    throw new Error(`No account is set for this graph, so vrc.zip cannot ${doing}.`);
  }
  return context.accountId;
}

function idInput(id: string, label: string, type: NodeDefinition["outputs"][number]["type"]) {
  return [{ id, label, type, required: true }] as const;
}

/* -------------------------------------------------------------------------------------------- */
/* Definitions                                                                                    */
/* -------------------------------------------------------------------------------------------- */

const GET_USER: NodeDefinition = {
  id: "get-user",
  kind: "action",
  title: "Look up a user",
  description: "Name, status, trust rank and where they are.",
  category: "VRChat",
  inputs: [...idInput("user", "User", "user")],
  outputs: [
    { id: "name", label: "Name", type: "string" },
    { id: "status", label: "Status", type: "string" },
    { id: "statusMessage", label: "Status message", type: "string" },
    { id: "trust", label: "Trust", type: "string" },
    { id: "location", label: "Instance", type: "instance" },
    { id: "isFriend", label: "Is a friend", type: "boolean" },
    { id: "user", label: "Everything", type: "json" },
  ],
  body: [
    { kind: "literal", text: "look up " },
    { kind: "port", port: "user" },
  ],
};

const GET_WORLD: NodeDefinition = {
  id: "get-world",
  kind: "action",
  title: "Look up a world",
  description: "Name, author and capacity.",
  category: "VRChat",
  inputs: [...idInput("world", "World", "world")],
  outputs: [
    { id: "name", label: "Name", type: "string" },
    { id: "author", label: "Author", type: "string" },
    { id: "capacity", label: "Capacity", type: "number" },
    { id: "world", label: "Everything", type: "json" },
  ],
  body: [
    { kind: "literal", text: "look up " },
    { kind: "port", port: "world" },
  ],
};

const GET_INSTANCE: NodeDefinition = {
  id: "get-instance",
  kind: "action",
  title: "Look up an instance",
  description: "Who owns it, how full it is, and which world it is in.",
  category: "VRChat",
  inputs: [...idInput("instance", "Instance", "instance")],
  outputs: [
    { id: "world", label: "World", type: "world" },
    { id: "type", label: "Access", type: "string" },
    { id: "region", label: "Region", type: "string" },
    { id: "users", label: "People here", type: "number" },
    { id: "capacity", label: "Capacity", type: "number" },
    { id: "full", label: "Is full", type: "boolean" },
    { id: "instance", label: "Everything", type: "json" },
  ],
  body: [
    { kind: "literal", text: "look up " },
    { kind: "port", port: "instance" },
  ],
};

const GET_AVATAR: NodeDefinition = {
  id: "get-avatar",
  kind: "action",
  title: "Look up an avatar",
  description: "Name and author.",
  category: "VRChat",
  inputs: [...idInput("avatar", "Avatar", "avatar")],
  outputs: [
    { id: "name", label: "Name", type: "string" },
    { id: "author", label: "Author", type: "string" },
    { id: "avatar", label: "Everything", type: "json" },
  ],
  body: [
    { kind: "literal", text: "look up " },
    { kind: "port", port: "avatar" },
  ],
};

const GET_GROUP: NodeDefinition = {
  id: "get-group",
  kind: "action",
  title: "Look up a group",
  description: "Name and member count.",
  category: "VRChat",
  inputs: [...idInput("group", "Group", "group")],
  outputs: [
    { id: "name", label: "Name", type: "string" },
    { id: "members", label: "Members", type: "number" },
    { id: "group", label: "Everything", type: "json" },
  ],
  body: [
    { kind: "literal", text: "look up " },
    { kind: "port", port: "group" },
  ],
};

const FRIENDS: NodeDefinition = {
  id: "friends",
  kind: "action",
  title: "My friends",
  description: "Everyone this account is friends with, as vrc.zip already knows them.",
  // **Me**, like the other two nodes here whose subject is the user rather than an id they were
  // handed. Both take no input for exactly that reason: there is nothing to name, because the
  // answer is about you. See `me.ts`.
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "friends", label: "Friends", type: "list<friend>" },
    { id: "names", label: "Names", type: "list<string>" },
    { id: "count", label: "How many", type: "number" },
  ],
  body: [{ kind: "literal", text: "my friends" }],
};

const INSTANCE_PLAYERS: NodeDefinition = {
  id: "instance-players",
  kind: "action",
  title: "Who is here",
  description: "The people in your instance right now, from the running game client's log.",
  category: ME_CATEGORY,
  inputs: [],
  outputs: [
    { id: "names", label: "Names", type: "list<string>" },
    { id: "users", label: "Users", type: "list<user>", description: "Only those the log named." },
    { id: "count", label: "How many", type: "number" },
  ],
  body: [{ kind: "literal", text: "who is here" }],
};

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export function resolverNodes(reads: GraphReads | undefined): BuiltinNode[] {
  function require(): GraphReads {
    if (reads === undefined) {
      throw new Error("This daemon cannot read from VRChat.");
    }
    return reads;
  }

  return [
    {
      definition: GET_USER,
      execute: async (inputs, _config, context): Promise<PortValues> => {
        const account = requireAccount(context, "look that person up");
        const user = await require().user(account, text(inputs.user));
        return {
          name: text(user.displayName),
          status: text(user.status),
          statusMessage: text(user.statusDescription),
          trust: text(user.trustLevel),
          // Absent rather than empty when VRChat is not telling: an empty `instance` would flow
          // into an invite node and produce a request about nowhere.
          ...(text(user.location) === "" ? {} : { location: user.location }),
          isFriend: user.isFriend === true,
          user,
        };
      },
    },
    {
      definition: GET_WORLD,
      execute: async (inputs, _config, context): Promise<PortValues> => {
        const account = requireAccount(context, "look that world up");
        const world = await require().world(account, text(inputs.world));
        return {
          name: text(world.name),
          author: text(world.authorName),
          capacity: numberOr(world.capacity, 0),
          world,
        };
      },
    },
    {
      definition: GET_INSTANCE,
      execute: async (inputs, _config, context): Promise<PortValues> => {
        const account = requireAccount(context, "look that instance up");
        const instance = await require().instance(account, text(inputs.instance));
        return {
          ...(text(instance.worldId) === "" ? {} : { world: instance.worldId }),
          type: text(instance.type),
          region: text(instance.region),
          users: numberOr(instance.userCount, 0),
          capacity: numberOr(instance.capacity, 0),
          full: instance.full === true,
          instance,
        };
      },
    },
    {
      definition: GET_AVATAR,
      execute: async (inputs, _config, context): Promise<PortValues> => {
        const account = requireAccount(context, "look that avatar up");
        const avatar = await require().avatar(account, text(inputs.avatar));
        return { name: text(avatar.name), author: text(avatar.authorName), avatar };
      },
    },
    {
      definition: GET_GROUP,
      execute: async (inputs, _config, context): Promise<PortValues> => {
        const account = requireAccount(context, "look that group up");
        const group = await require().group(account, text(inputs.group));
        return { name: text(group.name), members: numberOr(group.memberCount, 0), group };
      },
    },
    {
      definition: FRIENDS,
      execute: async (_inputs, _config, context): Promise<PortValues> => {
        const account = requireAccount(context, "list your friends");
        const friends = await require().friends(account);
        return {
          friends: friends.map((friend) => friend.id),
          names: friends.map((friend) => friend.displayName),
          count: friends.length,
        };
      },
    },
    {
      definition: INSTANCE_PLAYERS,
      execute: (_inputs, _config, context): PortValues => {
        // No account required: a game client signed into an account vrc.zip does not manage is a
        // normal state, and its log is still the truth about who is in the room.
        const present = require().instancePlayers(context.accountId);
        return { names: present.names, users: present.users, count: present.names.length };
      },
    },
  ];
}
