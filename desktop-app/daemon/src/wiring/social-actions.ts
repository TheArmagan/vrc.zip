/**
 * The things vrc.zip does *as* the user: invite, request an invite, boop.
 *
 * These lived inside the `createControlDeps` closure and were reachable from nothing but their own
 * routes. Phase 4 needs them from a second caller — a graph's action nodes — and a runtime holding
 * a whole `ControlDeps` to reach three methods would be the wrong shape twice over: the graph engine
 * has no business with the control API, and the control API has no business being a library.
 *
 * So they are here, in `wiring/`, where the adapters between subsystems live. The control deps use
 * this module; the graph actions are handed the same object through an interface they declare
 * themselves, so `graphs/` still does not know that `wiring/` exists.
 *
 * **Nothing about the behaviour changed in the move.** Same request, same three upstream answers
 * kept apart, same sentences — a refactor that quietly reworded a 403 would be a refactor that broke
 * a message the UI branches on.
 */

import type { JsonValue } from "@vrcz/shared";
import type { Account } from "../accounts/account.ts";
import type { AccountManager } from "../accounts/manager.ts";
import { vrcFetch } from "../net/request.ts";
import { ControlError } from "../servers/control.ts";
import type { Store } from "../store/index.ts";

/** Where an invite points. The world and instance halves, unjoined. */
export interface InviteTargetRef {
  readonly worldId: string;
  readonly instanceId: string;
}

/**
 * The three outbound social actions, as anything that wants to perform them sees them.
 *
 * Structural on purpose: `graphs/builtins/actions.ts` declares the same shape and is handed this
 * implementation by `app.ts`, so the graph runtime depends on a shape rather than on this module.
 */
export interface SocialActions {
  invite(
    accountId: string,
    userId: string,
    target: InviteTargetRef,
    messageSlot?: number,
  ): Promise<void>;
  requestInvite(accountId: string, userId: string, requestSlot?: number): Promise<void>;
  boop(accountId: string, userId: string): Promise<void>;
  /** Wears an avatar. The one of the four that acts on the user rather than on somebody else. */
  selectAvatar(accountId: string, avatarId: string): Promise<void>;
}

/**
 * The account named, if it can actually act right now.
 *
 * Never falls back to another account: these calls act *as* a named person, so guessing which
 * person would be the worst possible kind of helpful. Both checks are made **before** the request
 * rather than letting `vrcFetch` discover them — an account sitting on a 2FA challenge has no auth
 * cookie, and a 401 inside the request would trigger a re-auth into a challenge nobody is watching.
 */
export function requireOnlineAccount(
  accounts: AccountManager,
  accountId: string,
  doing: string,
): Account {
  const account = accounts.get(accountId);
  if (!account) throw new ControlError(404, "unknown_account");
  if (account.snapshot().state !== "online") {
    throw new ControlError(
      409,
      "account_offline",
      `That account is not signed in, so vrc.zip cannot ${doing}.`,
    );
  }
  return account;
}

/**
 * A POST made in the user's name, with the three upstream answers that mean different things kept
 * apart.
 *
 * 403 and 404 are *outcomes*, not faults: the person has invites off, or they are not there any
 * more. Collapsing them into one "it failed" is what makes an app feel broken when it is in fact
 * working and the answer is simply no. Everything else is a 502, because it is VRChat's problem and
 * the user can do nothing about it.
 */
export async function sendAsUser(
  account: Account,
  path: string,
  body: Record<string, JsonValue>,
  what: string,
): Promise<void> {
  const response = await vrcFetch(account.context(), path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Drained either way: an undrained body holds the connection open, and the success signal here is
  // the status rather than the notification object VRChat hands back.
  const text = await response.text().catch(() => "");
  if (response.ok) return;

  if (response.status === 403) {
    throw new ControlError(
      403,
      "send_forbidden",
      `VRChat will not deliver that ${what}. They may not accept them from you.`,
    );
  }
  if (response.status === 404) {
    throw new ControlError(404, "unknown_target", "VRChat does not know that user any more.");
  }
  throw new ControlError(
    502,
    "send_failed",
    `VRChat returned ${String(response.status)}${text === "" ? "" : `: ${text.slice(0, 200)}`}`,
  );
}

export function createSocialActions(deps: {
  readonly accounts: AccountManager;
  /** Only for the avatar cache invalidation below. */
  readonly store: Store;
}): SocialActions {
  return {
    async invite(accountId, userId, target, messageSlot): Promise<void> {
      const account = requireOnlineAccount(deps.accounts, accountId, "send the invite");
      await sendAsUser(
        account,
        `/invite/${userId}`,
        {
          instanceId: `${target.worldId}:${target.instanceId}`,
          ...(messageSlot === undefined ? {} : { messageSlot }),
        },
        "invite",
      );
    },

    async requestInvite(accountId, userId, requestSlot): Promise<void> {
      const account = requireOnlineAccount(deps.accounts, accountId, "ask for the invite");
      await sendAsUser(
        account,
        `/requestInvite/${userId}`,
        requestSlot === undefined ? {} : { requestSlot },
        "invite request",
      );
    },

    async boop(accountId, userId): Promise<void> {
      const account = requireOnlineAccount(deps.accounts, accountId, "send the boop");
      // An empty body on purpose: `emojiId` and `inventoryItemId` decorate a boop, and nothing in
      // the UI has a picker for one. Sending `{}` is the plain boop, which is the thing being asked.
      await sendAsUser(account, `/users/${userId}/boop`, {}, "boop");
    },

    async selectAvatar(accountId, avatarId): Promise<void> {
      const account = deps.accounts.get(accountId);
      if (!account) throw new ControlError(404, "unknown_account");
      if (account.snapshot().state !== "online") {
        throw new ControlError(
          409,
          "account_offline",
          "That account is not signed in, so VRChat has nobody to change the avatar for.",
        );
      }

      // `PUT`, matching upstream. The control API exposes it as a POST because a POST is what a
      // browser form and the app's own fetch wrapper do; the mapping stops here.
      const response = await vrcFetch(account.context(), `/avatars/${avatarId}/select`, {
        method: "PUT",
      });

      // Drained either way: an undrained body holds the connection open, and the caller wants the
      // outcome rather than VRChat's copy of the user record back.
      const body = await response.text().catch(() => "");
      if (response.ok) {
        // The worn avatar just changed, so the cached user record is stale in the one field this
        // action exists to move. Dropping it is cheaper than patching it and cannot go stale wrong.
        deps.store.deleteUserCache(account.id, account.id);
        return;
      }

      if (response.status === 404) {
        throw new ControlError(
          404,
          "unknown_avatar",
          "VRChat has no such avatar, or this account cannot see it.",
        );
      }
      if (response.status === 403) {
        throw new ControlError(
          403,
          "avatar_forbidden",
          "VRChat will not let this account wear that avatar.",
        );
      }
      throw new ControlError(
        502,
        "avatar_select_failed",
        `VRChat returned ${String(response.status)}${body === "" ? "" : `: ${body.slice(0, 200)}`}`,
      );
    },
  };
}
