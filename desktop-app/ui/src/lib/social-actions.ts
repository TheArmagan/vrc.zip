/**
 * The three things you can do *to another person*: invite them, ask them for an invite, boop them.
 *
 * Written down once here because they are reached from three places that share nothing else — the
 * command palette, the right-click menu on any display name, and the user modal's overflow menu —
 * and because all three have the same two awkward questions that a plain `api.accounts.boop(…)`
 * call would leave to whichever caller thought of them:
 *
 *  - **Which account is asking?** These arrive in a stranger's inbox with a *name* on them, so
 *    getting it wrong is not a UI glitch, it is the wrong person appearing to have messaged them.
 *    With one account signed in there is no question; with two there is, and the honest answer when
 *    the caller has not said is to refuse rather than pick.
 *  - **Where is "my instance"?** An invite needs a location, and the only place the app knows one is
 *    a running game client. A user with no client running cannot invite anybody anywhere, and
 *    saying so is the whole answer.
 *
 * Everything here reports its outcome. A social action that appears to do nothing is
 * indistinguishable from one that failed, and these are the actions where "did that send?" is the
 * question the user is left holding.
 */

import { toast } from "svelte-sonner";
import { api, describeError } from "./api.ts";
import { parseLocation } from "./format.ts";
import { app } from "./state/app.svelte.ts";

/**
 * The account that should act, or null when the app must not guess.
 *
 * `preferred` is the caller's answer when it has one — the account whose eyes a profile was loaded
 * through, say. It is honoured only if that account is actually connected: an id belonging to an
 * account that is signed out would otherwise become a 409 from the daemon for a reason the user
 * cannot see from the button they pressed.
 *
 * With no preference, exactly one connected account is an unambiguous answer and two or more is
 * not. Silently taking the first would put an arbitrary one of the user's identities on an invite.
 */
export function actingAccountId(preferred?: string | null): string | null {
  const connected = app.connectedAccounts;
  if (preferred !== undefined && preferred !== null) {
    return connected.some((account) => account.id === preferred) ? preferred : null;
  }
  return connected.length === 1 ? (connected[0]?.id ?? null) : null;
}

/** True when the app can act without asking which account. Drives whether a menu item is shown. */
export function canAct(preferred?: string | null): boolean {
  return actingAccountId(preferred) !== null;
}

/**
 * Where to invite someone, and which account owns that instance.
 *
 * An opaque location is skipped rather than sent: `private`, `traveling` and the offline placeholder
 * all parse, and none of them is somewhere a second person can be invited to.
 */
export function myInstance(): { accountId: string; location: string } | null {
  for (const session of app.sessions) {
    const location = session.currentLocation;
    if (location === null || parseLocation(location).opaque) continue;
    if (session.accountId === null) continue;
    return { accountId: session.accountId, location };
  }
  return null;
}

/** The sentence shown when there is nobody to act as. Shared so all three read alike. */
const NO_ACCOUNT =
  "vrc.zip will not guess which of your accounts is asking. Sign one in, or use the menu on a profile you opened through a specific account.";

function failed(what: string, cause: unknown): void {
  toast.error(`Could not ${what}`, { description: describeError(cause), duration: 8000 });
}

export async function boop(userId: string, name: string, preferred?: string | null): Promise<void> {
  const accountId = actingAccountId(preferred);
  if (accountId === null) {
    toast.warning("No account to boop from", { description: NO_ACCOUNT, duration: 8000 });
    return;
  }
  try {
    await api.accounts.boop(accountId, userId);
    toast.success(`Booped ${name}`, { duration: 3000 });
  } catch (cause) {
    failed(`boop ${name}`, cause);
  }
}

export async function requestInvite(
  userId: string,
  name: string,
  preferred?: string | null,
): Promise<void> {
  const accountId = actingAccountId(preferred);
  if (accountId === null) {
    toast.warning("No account to ask from", { description: NO_ACCOUNT, duration: 8000 });
    return;
  }
  try {
    await api.accounts.requestInvite(accountId, userId);
    toast.success(`Asked ${name} for an invite`, {
      description: "They will see it as a notification in game.",
      duration: 4000,
    });
  } catch (cause) {
    failed(`ask ${name} for an invite`, cause);
  }
}

/**
 * Invites someone to wherever a running client is.
 *
 * The acting account is **the one whose client is in that instance**, not the caller's preference:
 * inviting to a room from an account that is not in it is a request VRChat would refuse, and it
 * would refuse it for a reason nobody could see from this side.
 */
export async function inviteToMyInstance(userId: string, name: string): Promise<void> {
  const target = myInstance();
  if (target === null) {
    toast.warning("You are not anywhere to invite anyone to", {
      description:
        "vrc.zip invites people to an instance a running VRChat client is in. Nothing is running, or the client is somewhere private.",
      duration: 8000,
    });
    return;
  }
  try {
    await api.accounts.invite(target.accountId, userId, target.location);
    toast.success(`Invited ${name}`, { duration: 3000 });
  } catch (cause) {
    failed(`invite ${name}`, cause);
  }
}
