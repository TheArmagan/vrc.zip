/**
 * What the resolver nodes read, in terms of things that already exist.
 *
 * The control deps already know how to fetch a user, a world, an instance, an avatar and a group —
 * with the per-account cache, the rate limiter and the error translation that go with each. Building
 * a second path to VRChat for the graph runtime would be a second place for "did you remember the
 * cache is keyed per viewer?" to be got wrong, so this is an adapter and nothing more.
 *
 * The one thing it *does* own is presence: who is in the instance right now. Nothing else in the
 * daemon answers that question, because until now nothing asked it.
 */

import type { GraphReads } from "../graphs/builtins/index.ts";
import type { ControlDeps } from "../servers/control.ts";
import type { Store } from "../store/index.ts";

/** A row's payload, defensively. A row that will not parse is a row with nothing to say. */
function payload(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The instance half of an `InviteTarget`, from a location string.
 *
 * `wrld_x:12345~region(eu)` splits at the **first** colon: everything after it is the instance id
 * with its tags, which is how VRChat quotes it and what `getInstance` expects back.
 */
function splitLocation(location: string): { worldId: string; instanceId: string } | null {
  const colon = location.indexOf(":");
  if (colon <= 0 || colon === location.length - 1) return null;
  return { worldId: location.slice(0, colon), instanceId: location.slice(colon + 1) };
}

export function createGraphReads(deps: ControlDeps, store: Store): GraphReads {
  return {
    user: async (accountId, userId) =>
      (await deps.getUser(userId, accountId)) as unknown as Record<string, unknown>,

    world: async (accountId, worldId) =>
      (await deps.getWorld(worldId, accountId)) as unknown as Record<string, unknown>,

    instance: async (accountId, location) => {
      const target = splitLocation(location);
      if (target === null) throw new Error(`"${location}" is not an instance.`);
      return (await deps.getInstance(target, accountId)) as unknown as Record<string, unknown>;
    },

    avatar: async (accountId, avatarId) =>
      (await deps.getAvatar(avatarId, accountId)) as unknown as Record<string, unknown>,

    group: async (accountId, groupId) =>
      (await deps.getGroup(groupId, accountId)) as unknown as Record<string, unknown>,

    friends: async (accountId) => {
      const friends = await deps.listFriends(accountId);
      return friends.map((friend) => ({
        id: friend.id,
        displayName: friend.displayName,
        status: friend.status ?? "",
      }));
    },

    /**
     * Who is in the instance, folded from the game log.
     *
     * **The log, not VRChat.** `GET /instances/:id` answers with a user list only for an instance
     * the account *created*, which is almost never the one somebody is sitting in; the log names
     * everybody who walks in regardless. It is also free, and this runs on every fire of a graph
     * that uses it.
     *
     * Sessions rather than accounts are the unit here (PLAN.md §1.7): the session for the acting
     * account if there is one, and otherwise the newest live session — a client signed into an
     * account vrc.zip does not manage is a normal state, and its room is still a real room.
     */
    instancePlayers: (accountId) => {
      const live = store.listOpenSessions();
      const session =
        live.find((entry) => accountId !== null && entry.account_id === accountId) ?? live[0];
      if (session === undefined) return { names: [], users: [] };

      // A Map rather than a Set: a name can arrive with an id or without one depending on the log
      // line, and the last sighting is the one worth keeping.
      const present = new Map<string, string | null>();
      for (const row of store.listSessionPresence(session.id)) {
        const data = payload(row.payload);
        const name = typeof data.displayName === "string" ? data.displayName : null;
        if (name === null) continue;
        if (row.kind === "gamelog.player_leave") present.delete(name);
        else present.set(name, typeof data.userId === "string" ? data.userId : null);
      }

      return {
        names: [...present.keys()],
        // Only the ones the log actually named. A `user` port has to carry a real id or nothing —
        // half a roster of empty strings would be worse than a shorter honest list.
        users: [...present.values()].filter((id): id is string => id !== null),
      };
    },
  };
}
