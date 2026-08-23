/**
 * The two questions a trigger asks about the world *at the moment it fires*.
 *
 * Both exist for the same reason and both are **synchronous, cached, and free**, which is the whole
 * design constraint. A trigger's map runs inside a bus subscription: `gamelog.player_join` bursts
 * forty times on an instance transition, and every armed graph's map runs for each one. Anything
 * that awaited, hit SQLite in a loop, or reached VRChat would turn a busy public instance into a
 * stall. So the answers come from state the daemon already holds in memory or in one indexed row.
 *
 * `location` is the running client's instance, from the log. That is the only honest source — see
 * `graph-reads.instancePlayers` for the longer version of why VRChat's own answer is about an
 * instance the account *created* rather than the one somebody is sitting in.
 *
 * `isFriend` is the presence service's live map, not `friend_log`. Reading the table would serve
 * stale rows after a restart until the first poll landed, which is the same trap `listFriends`
 * documents. It can be wrong for the seconds between a friendship changing and the next frame, and
 * that is stated on the port rather than hidden.
 */

import type { PresenceService } from "../accounts/presence.ts";
import type { Store } from "../store/index.ts";

/**
 * Declared here and satisfied by {@link createTriggerContext}. `graphs/` redeclares the same shape
 * for itself, the arrangement every other seam in this directory uses.
 */
export interface TriggerContext {
  /** Where the account's running client is, or empty. Never throws, never awaits. */
  location(accountId: string | null): string;
  /** Whether this user is a friend of the account. False when either is unknown. */
  isFriend(accountId: string | null, userId: string): boolean;
}

export interface TriggerContextDeps {
  readonly store: Store;
  readonly presence: PresenceService;
}

export function createTriggerContext(deps: TriggerContextDeps): TriggerContext {
  return {
    location(accountId): string {
      /*
       * Sessions rather than accounts are the unit (PLAN.md §1.7), and the selection matches
       * `self-actions.gameState` and `graph-reads.instancePlayers` exactly: this account's live
       * session if there is one, else the newest live session at all. A client signed into an
       * account vrc.zip does not manage is a normal state and its room is still a real room.
       */
      const live = deps.store.listOpenSessions();
      const session =
        live.find((row) => accountId !== null && row.account_id === accountId) ?? live[0];
      return session?.current_location ?? "";
    },

    isFriend(accountId, userId): boolean {
      if (userId === "") return false;
      // `listAll` when no account is named: a log-derived event often has none, and "is this person
      // a friend of *any* account I manage" is the question somebody actually means by then.
      const records = accountId === null ? deps.presence.listAll() : deps.presence.list(accountId);
      return records.some((record) => record.id === userId);
    },
  };
}
