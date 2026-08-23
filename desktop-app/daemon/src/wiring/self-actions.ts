/**
 * The things vrc.zip does *to the user's own account*, rather than to somebody else.
 *
 * `social-actions.ts` is the other half of this pair, and the split is the point rather than a
 * filing convenience. An invite, a boop and an invite request all put something with the user's name
 * on it into a stranger's inbox; everything here changes only what the user's own account looks
 * like or holds. That is a different kind of act, it wants different error sentences, and it is why
 * the graph palette groups them apart under **Me**.
 *
 * ## Why this exists rather than the generated API nodes
 *
 * A graph could already do all of this through the 286 `(API)` nodes, and that is exactly the
 * problem: `Update user (API)` takes a `json` body the author has to build by hand out of VRChat's
 * field names, hands back an untyped blob, and reports a 403 as a number. These are the same calls
 * with typed ports, VRChat's own refusal turned into a sentence, and a name somebody can find in a
 * palette search. The generated nodes stay as the floor — see `graphs/builtins/api.ts`.
 *
 * ## Reads come from the cache, writes go upstream
 *
 * {@link SelfActions.me} answers from the `CurrentUser` the account already holds, refreshed on
 * every sign-in and every presence update. It costs no request, which is what makes it safe to put
 * a "Me" node at the top of a graph that fires on every `player_join` in a public instance. A
 * caller that genuinely needs it fresh asks for `refresh`, and pays for it.
 *
 * Every write here is one upstream call and no retry, matching decision 206: re-running a chain
 * that already blocked somebody is worse than failing.
 */

import type { JsonValue } from "@vrcz/shared";
import type { Account } from "../accounts/account.ts";
import type { AccountManager } from "../accounts/manager.ts";
import { type RequestOptions, vrcFetch } from "../net/request.ts";
import { ControlError } from "../servers/control.ts";
import type { Store } from "../store/index.ts";
import { requireOnlineAccount } from "./social-actions.ts";

/** A moderation VRChat keeps as a row on the user's own account, keyed by type. */
export type SelfModeration = "block" | "mute" | "hideAvatar";

/** The four things VRChat lets an account favourite, in its own spelling. */
export type FavoriteKind = "world" | "avatar" | "friend" | "group";

/** One of the user's accounts, as a graph sees it. Deliberately not the full `AccountSnapshot`. */
export interface SelfAccountSummary {
  readonly id: string;
  readonly displayName: string;
  readonly username: string;
  readonly online: boolean;
}

/**
 * Whether a VRChat client is actually running, and where it is. **From the log, not from VRChat.**
 *
 * The log is the only honest source for this, for the same reason `instancePlayers` uses it: VRChat
 * knows what its own API was last told, and the client on this machine is the thing that knows it
 * is open. `platform` is the log's `vr_mode` — `vr` or `desktop` — and is empty when nothing is
 * running or the log has not said yet.
 */
export interface SelfGameState {
  readonly running: boolean;
  readonly platform: string;
  /** The instance the running client is in, or empty. */
  readonly location: string;
}

/**
 * What the graph runtime needs in order to act as the user on the user's own account.
 *
 * Declared as an interface here and satisfied structurally by {@link createSelfActions}, the same
 * arrangement `SocialActions` and `GraphReads` use: `graphs/` states a shape, `wiring/` implements
 * it, and neither knows the other exists.
 */
export interface SelfActions {
  /** The cached `CurrentUser`. No request unless `refresh` is asked for. */
  me(accountId: string, refresh?: boolean): Promise<Record<string, unknown>>;
  /** Every account vrc.zip manages, for the "my accounts" node. No request at all. */
  accounts(): SelfAccountSummary[];
  /** Is a game client running for this account right now, and on which platform. */
  gameState(accountId: string | null): SelfGameState;

  /** `PUT /users/{id}` with only the fields the caller actually set. */
  updateProfile(accountId: string, patch: Record<string, JsonValue>): Promise<void>;

  unfriend(accountId: string, userId: string): Promise<void>;
  /** `on` false is the `unplayermoderate` half. One method, because they are one gesture. */
  moderate(accountId: string, userId: string, type: SelfModeration, on: boolean): Promise<void>;

  favorite(
    accountId: string,
    kind: FavoriteKind,
    targetId: string,
    group: string | null,
  ): Promise<void>;
  unfavorite(accountId: string, targetId: string): Promise<void>;

  notifications(accountId: string): Promise<Record<string, unknown>[]>;
  acceptNotification(accountId: string, notificationId: string): Promise<void>;
  declineNotification(accountId: string, notificationId: string): Promise<void>;
  markNotificationRead(accountId: string, notificationId: string): Promise<void>;
  clearNotifications(accountId: string): Promise<void>;
  respondToInvite(accountId: string, notificationId: string, responseSlot: number): Promise<void>;

  groups(accountId: string): Promise<Record<string, unknown>[]>;
  joinGroup(accountId: string, groupId: string): Promise<Record<string, unknown>>;
  leaveGroup(accountId: string, groupId: string): Promise<void>;
  representGroup(accountId: string, groupId: string, representing: boolean): Promise<void>;
  postToGroup(
    accountId: string,
    groupId: string,
    post: { title: string; text: string; notify: boolean; visibility: string },
  ): Promise<Record<string, unknown>>;

  /** Puts an invite to `location` in the user's own notifications, so a running client can travel. */
  inviteSelfTo(accountId: string, location: string): Promise<void>;
}

export interface SelfActionDeps {
  readonly accounts: AccountManager;
  /**
   * Two jobs: dropping the cached copy of the user's own record after a write that changes it, and
   * answering {@link SelfActions.gameState} from the open game sessions.
   */
  readonly store: Store;
}

/* -------------------------------------------------------------------------------------------- */
/* Shared plumbing                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * One call made as the user, with the answer parsed and VRChat's refusals kept apart.
 *
 * The three statuses that get their own sentence are the three that are *outcomes* rather than
 * faults: 403 is "VRChat will not let you", 404 is "that is not there any more", and 400 is usually
 * a limit — a full favourite group, a status VRChat does not accept. Everything else is a 502,
 * because it is VRChat's problem and the user can do nothing about it.
 *
 * **A 400 is passed through verbatim.** That is deliberate and it is the VRC+ guardrail: when a
 * favourite group is full, the honest thing is VRChat's own sentence about the user's own
 * entitlements, not a locally invented one and certainly not a way around it. See PLAN.md
 * §Guardrails.
 */
async function callAsUser(
  account: Account,
  path: string,
  init: RequestOptions,
  what: string,
): Promise<unknown> {
  const response = await vrcFetch(account.context(), path, init);

  // Drained either way: an undrained body holds the connection open.
  const body = await response.text().catch(() => "");
  if (response.ok) {
    if (body === "") return null;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  }

  const excerpt = body === "" ? "" : `: ${vrchatMessage(body)}`;
  if (response.status === 403) {
    throw new ControlError(
      403,
      "self_forbidden",
      `VRChat will not let this account ${what}${excerpt}.`,
    );
  }
  if (response.status === 404) {
    throw new ControlError(404, "unknown_target", `VRChat has nothing there to ${what}${excerpt}.`);
  }
  if (response.status === 400) {
    throw new ControlError(400, "self_refused", `VRChat refused to ${what}${excerpt}.`);
  }
  throw new ControlError(
    502,
    "self_failed",
    `VRChat returned ${String(response.status)} trying to ${what}${excerpt}`,
  );
}

/**
 * VRChat's own wording out of an error body.
 *
 * Its errors are `{"error":{"message":"...","status_code":400}}`, and the message is frequently the
 * only thing that says *why* — "You have reached your favorite limit" rather than "400". A body this
 * cannot parse is quoted raw and capped, because an error message is not a place to store data.
 */
function vrchatMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error = (parsed as { error: unknown }).error;
      if (typeof error === "string") return error.slice(0, 200);
      if (typeof error === "object" && error !== null && "message" in error) {
        const message = (error as { message: unknown }).message;
        if (typeof message === "string") return message.slice(0, 200);
      }
    }
  } catch {
    // Falls through to the raw excerpt.
  }
  return body.slice(0, 200);
}

function json(body: Record<string, JsonValue>): RequestOptions {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** An unknown answer as a list of objects. VRChat lists are arrays; anything else is nothing. */
function objectList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The world and instance halves of a location, for the paths that quote them separately.
 *
 * `wrld_x:12345~region(eu)` splits at the **first** colon, matching `wiring/graph-reads.ts`. A
 * string this cannot parse is an error rather than a guess: travelling to the wrong place is worse
 * than not travelling.
 */
function splitLocation(location: string): { worldId: string; instanceId: string } | null {
  const colon = location.indexOf(":");
  if (colon <= 0 || colon === location.length - 1) return null;
  return { worldId: location.slice(0, colon), instanceId: location.slice(colon + 1) };
}

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export function createSelfActions(deps: SelfActionDeps): SelfActions {
  /** The account, online, plus the user record it is holding. Every write needs both. */
  function online(accountId: string, doing: string): Account {
    return requireOnlineAccount(deps.accounts, accountId, doing);
  }

  /**
   * The user's own record has changed upstream, so the copy vrc.zip holds is stale in exactly the
   * field the write moved. Dropping it is cheaper than patching it and cannot go stale wrong — the
   * same reasoning, and the same call, as `selectAvatar` in `social-actions.ts`.
   */
  function forgetSelf(account: Account): void {
    deps.store.deleteUserCache(account.id, account.id);
  }

  return {
    async me(accountId, refresh = false): Promise<Record<string, unknown>> {
      const account = online(accountId, "read your own profile");
      if (refresh) return object(await account.refresh());
      const user = account.user;
      if (user === null) {
        throw new ControlError(
          409,
          "no_current_user",
          "That account is signed in but vrc.zip has not read its profile yet.",
        );
      }
      return object(user);
    },

    accounts(): SelfAccountSummary[] {
      return deps.accounts.list().map((snapshot) => ({
        id: snapshot.id,
        displayName: snapshot.displayName ?? snapshot.username,
        username: snapshot.username,
        online: snapshot.state === "online",
      }));
    },

    gameState(accountId): SelfGameState {
      /*
       * No account required, and a shut game is an answer rather than an error.
       *
       * Sessions rather than accounts are the unit (PLAN.md §1.7), and the selection matches
       * `graph-reads.instancePlayers` exactly: this account's live session if there is one, else the
       * newest live session at all — a client signed into an account vrc.zip does not manage is a
       * normal state, and it is still a running game.
       */
      const live = deps.store.listOpenSessions();
      const session =
        live.find((row) => accountId !== null && row.account_id === accountId) ?? live[0];
      if (session === undefined) return { running: false, platform: "", location: "" };
      return {
        running: true,
        platform: session.vr_mode ?? "",
        location: session.current_location ?? "",
      };
    },

    async updateProfile(accountId, patch): Promise<void> {
      const account = online(accountId, "change your profile");
      if (Object.keys(patch).length === 0) return;
      await callAsUser(
        account,
        `/users/${account.id}`,
        { ...json(patch), method: "PUT" },
        "change your profile",
      );
      forgetSelf(account);
    },

    async unfriend(accountId, userId): Promise<void> {
      const account = online(accountId, "unfriend somebody");
      await callAsUser(
        account,
        `/auth/user/friends/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
        "unfriend them",
      );
    },

    async moderate(accountId, userId, type, on): Promise<void> {
      const account = online(accountId, "moderate somebody");
      const path = on ? "/auth/user/playermoderations" : "/auth/user/unplayermoderate";
      await callAsUser(
        account,
        path,
        { ...json({ moderated: userId, type }), method: on ? "POST" : "PUT" },
        on ? `${type} them` : `un-${type} them`,
      );
    },

    async favorite(accountId, kind, targetId, group): Promise<void> {
      const account = online(accountId, "favourite that");
      await callAsUser(
        account,
        "/favorites",
        json({
          type: kind,
          favoriteId: targetId,
          // VRChat requires a group and rejects an unknown one, so an unset field falls back to the
          // group every account has by default. `tags` is an array upstream even for the one.
          tags: [group === null || group === "" ? `${kind}s1` : group],
        }),
        "favourite that",
      );
    },

    async unfavorite(accountId, targetId): Promise<void> {
      const account = online(accountId, "unfavourite that");
      // The favourite id and the object id are interchangeable here, which is what makes one node
      // per kind possible without first reading the favourite back.
      await callAsUser(
        account,
        `/favorites/${encodeURIComponent(targetId)}`,
        { method: "DELETE" },
        "unfavourite that",
      );
    },

    async notifications(accountId): Promise<Record<string, unknown>[]> {
      const account = online(accountId, "read your notifications");
      return objectList(
        await callAsUser(
          account,
          "/auth/user/notifications",
          { method: "GET" },
          "read your notifications",
        ),
      );
    },

    async acceptNotification(accountId, notificationId): Promise<void> {
      const account = online(accountId, "accept that");
      await callAsUser(
        account,
        `/auth/user/notifications/${encodeURIComponent(notificationId)}/accept`,
        { method: "PUT" },
        "accept that",
      );
    },

    async declineNotification(accountId, notificationId): Promise<void> {
      const account = online(accountId, "decline that");
      // VRChat calls declining "hide". Same row, same effect, and the node says decline because
      // that is what the user is doing.
      await callAsUser(
        account,
        `/auth/user/notifications/${encodeURIComponent(notificationId)}/hide`,
        { method: "PUT" },
        "decline that",
      );
    },

    async markNotificationRead(accountId, notificationId): Promise<void> {
      const account = online(accountId, "mark that read");
      await callAsUser(
        account,
        `/auth/user/notifications/${encodeURIComponent(notificationId)}/see`,
        { method: "PUT" },
        "mark that read",
      );
    },

    async clearNotifications(accountId): Promise<void> {
      const account = online(accountId, "clear your notifications");
      await callAsUser(
        account,
        "/auth/user/notifications/clear",
        { method: "PUT" },
        "clear your notifications",
      );
    },

    async respondToInvite(accountId, notificationId, responseSlot): Promise<void> {
      const account = online(accountId, "respond to that invite");
      await callAsUser(
        account,
        `/invite/${encodeURIComponent(notificationId)}/response`,
        json({ responseSlot }),
        "respond to that invite",
      );
    },

    async groups(accountId): Promise<Record<string, unknown>[]> {
      const account = online(accountId, "list your groups");
      return objectList(
        await callAsUser(
          account,
          `/users/${account.id}/groups`,
          { method: "GET" },
          "list your groups",
        ),
      );
    },

    async joinGroup(accountId, groupId): Promise<Record<string, unknown>> {
      const account = online(accountId, "join that group");
      return object(
        await callAsUser(
          account,
          `/groups/${encodeURIComponent(groupId)}/join`,
          json({}),
          "join that group",
        ),
      );
    },

    async leaveGroup(accountId, groupId): Promise<void> {
      const account = online(accountId, "leave that group");
      await callAsUser(
        account,
        `/groups/${encodeURIComponent(groupId)}/leave`,
        json({}),
        "leave that group",
      );
    },

    async representGroup(accountId, groupId, representing): Promise<void> {
      const account = online(accountId, "change which group you represent");
      await callAsUser(
        account,
        `/groups/${encodeURIComponent(groupId)}/representation`,
        { ...json({ isRepresenting: representing }), method: "PUT" },
        "change which group you represent",
      );
      forgetSelf(account);
    },

    async postToGroup(accountId, groupId, post): Promise<Record<string, unknown>> {
      const account = online(accountId, "post to that group");
      return object(
        await callAsUser(
          account,
          `/groups/${encodeURIComponent(groupId)}/posts`,
          json({
            title: post.title,
            text: post.text,
            sendNotification: post.notify,
            visibility: post.visibility,
            roleIds: [],
          }),
          "post to that group",
        ),
      );
    },

    async inviteSelfTo(accountId, location): Promise<void> {
      const account = online(accountId, "invite you there");
      const target = splitLocation(location);
      if (target === null) {
        throw new ControlError(400, "bad_location", `"${location}" is not an instance.`);
      }
      // The path quotes the location whole, colon included, so each half is encoded separately and
      // the colon is written literally — encoding the joined string would send `%3A` and 404.
      await callAsUser(
        account,
        `/invite/myself/to/${encodeURIComponent(target.worldId)}:${encodeURIComponent(target.instanceId)}`,
        json({}),
        "invite you there",
      );
    },
  };
}
