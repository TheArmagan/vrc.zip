/**
 * `vrczip://` links: what they say, and doing what they say.
 *
 * ## One link, so far
 *
 * `vrczip://selectavatar/<avtr_id>[/<account index>]` puts an account into an avatar. It exists so an
 * avatar search site, a Discord message or a stream deck button can say "wear this" without knowing
 * anything about vrc.zip beyond the scheme.
 *
 * ## The account index is the Accounts screen's order, from 0
 *
 * A link cannot carry a `usr_` id: it is written by somebody who does not know which accounts the
 * reader has. An index is the one thing both sides can agree on, and the order it counts in is the
 * order `GET /api/accounts` returns, which is the order the Accounts screen draws. Left off, it is
 * 0. It is never "whichever account is online": a link that dresses a different person depending on
 * who happened to be signed in is the guess `selectAvatar` refuses to make everywhere else.
 *
 * ## Every outcome is a toast
 *
 * Nobody is watching the daemon when a link arrives. The click happened in a browser, and the
 * process the operating system started for it has either handed the link over and exited or is a
 * console window behind that browser, so a toast is the only thing that can say what happened. That
 * includes the failures: a link that silently did nothing reads as a link that is broken.
 *
 * ## Nothing here trusts the link
 *
 * Any web page can fire a `vrczip://` URL, so the parser is an exact shape, not a URL library. The
 * avatar id gets the same pattern the control API validates with, and anything that does not match
 * the whole string is refused before it reaches an account.
 */

import type { AccountSnapshot } from "../accounts/account.ts";
import type { DesktopNotification } from "../os/desktop-notification.ts";
import { DEEP_LINK_SCHEME } from "../os/url-scheme.ts";
import { ControlError } from "../servers/control.ts";
import type { SocialActions } from "./social-actions.ts";

export interface SelectAvatarLink {
  readonly action: "selectAvatar";
  readonly avatarId: string;
  /** Position in the account list, from 0. Null when the link left it off. */
  readonly accountIndex: number | null;
}

export type DeepLink = SelectAvatarLink;

/**
 * The whole link, start to end, or nothing.
 *
 * The trailing slash is tolerated because some launchers add one. The scheme and the action are
 * case-insensitive because Windows lowercases neither consistently; the avatar id is kept as given,
 * since that is what VRChat is asked for.
 */
const SELECT_AVATAR = /^vrczip:\/\/selectavatar\/(avtr_[0-9A-Za-z_-]{1,64})(?:\/(\d{1,3}))?\/?$/i;

/** Parses a `vrczip://` link. Null for anything that is not exactly one this build understands. */
export function parseDeepLink(raw: string): DeepLink | null {
  const match = SELECT_AVATAR.exec(raw.trim());
  if (match === null) return null;
  const [, avatarId, index] = match;
  if (avatarId === undefined) return null;
  return {
    action: "selectAvatar",
    avatarId,
    accountIndex: index === undefined ? null : Number.parseInt(index, 10),
  };
}

/** The first argument that is a `vrczip:` link, or null. The scheme is matched, not the shape. */
export function findDeepLinkArg(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`)) ?? null;
}

export interface DeepLinkOutcome {
  readonly action: DeepLink["action"];
  readonly avatarId: string;
  readonly accountId: string;
}

export interface DeepLinkDeps {
  readonly accounts: { list(): readonly AccountSnapshot[] };
  readonly social: Pick<SocialActions, "selectAvatar">;
  readonly notify: (notification: DesktopNotification) => Promise<unknown>;
  /**
   * The avatar's name and thumbnail, for the toast. Best-effort: a throw falls back to the bare id,
   * because the avatar is already on and a missing label is not a reason to say otherwise.
   */
  readonly describeAvatar?: (avatarId: string, accountId: string) => Promise<AvatarLabel>;
}

export interface AvatarLabel {
  readonly name: string;
  /** Anything the notifier's image resolver accepts. Null for no picture. */
  readonly image: string | null;
}

/** The tag every link toast shares, so a second click replaces the first toast rather than stacking. */
const TOAST_TAG = "deeplink";

/**
 * Builds the function that carries a link out.
 *
 * Resolves with what was done, and rejects with a `ControlError` whose message is the sentence the
 * toast already showed, so the control route and the toast never disagree about what went wrong.
 */
export function createDeepLinkHandler(
  deps: DeepLinkDeps,
): (raw: string) => Promise<DeepLinkOutcome> {
  const fail = async (error: ControlError): Promise<never> => {
    await deps
      .notify({ title: "vrc.zip: could not change avatar", body: error.message, tag: TOAST_TAG })
      .catch(() => undefined);
    throw error;
  };

  return async (raw) => {
    const link = parseDeepLink(raw);
    if (link === null) {
      return await fail(
        new ControlError(400, "invalid_deeplink", "vrc.zip does not understand that link."),
      );
    }

    const accounts = deps.accounts.list();
    const index = link.accountIndex ?? 0;
    const account = accounts[index];
    if (account === undefined) {
      return await fail(
        accounts.length === 0
          ? new ControlError(409, "no_account", "No account is added to vrc.zip yet.")
          : new ControlError(
              404,
              "unknown_account",
              `The link asks for account ${String(index)}, and vrc.zip has ${String(accounts.length)} (numbered from 0).`,
            ),
      );
    }

    try {
      await deps.social.selectAvatar(account.id, link.avatarId);
    } catch (error) {
      return await fail(
        error instanceof ControlError
          ? error
          : new ControlError(502, "select_failed", "VRChat did not change the avatar."),
      );
    }

    const label = await deps.describeAvatar?.(link.avatarId, account.id).catch(() => null);
    const who = account.displayName ?? account.username;
    const image = label?.image ?? null;
    await deps
      .notify({
        title: "vrc.zip: avatar changed",
        body: `${who} is now wearing ${label?.name ?? link.avatarId}.`,
        tag: TOAST_TAG,
        silent: true,
        ...(image === null || image === "" ? {} : { image }),
      })
      .catch(() => undefined);

    return { action: link.action, avatarId: link.avatarId, accountId: account.id };
  };
}
