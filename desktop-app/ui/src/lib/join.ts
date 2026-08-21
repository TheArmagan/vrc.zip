/**
 * The one place the app acts on "take me there".
 *
 * Two screens and a palette command all offer a join affordance, and all three have to make the
 * same call: a `vrchat://` deep link starts a *new* game client, which is right when none is
 * running and actively harmful when one is — two clients on one account fight over it. So the
 * decision (`planJoin`, in `format.ts`, pure and therefore readable in isolation) lives apart from
 * the doing, and the doing lives here so no caller can accidentally do only half of it.
 *
 * The user must be able to tell which branch ran, because a self-invite changes nothing visible in
 * the browser — the notification appears inside VRChat. Hence a toast on every path but the deep
 * link, where the game window appearing is its own feedback.
 *
 * This module imports `toast` directly, as the screens do. The command registry injects its toast
 * host instead, and deliberately: it must not depend on the shell. That distinction stops here —
 * this is app code, not registry plumbing.
 */

import { toast } from "svelte-sonner";
import { api, describeError } from "./api.ts";
import { planJoin } from "./format.ts";
import { app } from "./state/app.svelte.ts";

const TOAST_MS = 8000;

/**
 * Joins `location`, choosing between a self-invite and the deep link from the live session list.
 *
 * `contextAccountId` is the account the location was seen through — see `planJoin`. Resolves once
 * the user has been told what happened; it never throws.
 */
export async function requestJoin(
  location: string | null,
  contextAccountId: string | null = null,
): Promise<void> {
  if (location === null) return;

  const plan = planJoin(location, app.sessions, contextAccountId);
  if (plan === null || plan.kind === "here") return;

  if (plan.kind === "launch") {
    // No client is running, so this is the case the URI scheme is actually for.
    window.location.href = plan.href;
    return;
  }

  if (plan.kind === "blocked") {
    toast.warning("vrc.zip will not open a second client", {
      description: plan.reason,
      duration: TOAST_MS,
    });
    return;
  }

  const name = app.accountById(plan.accountId)?.displayName ?? "your running client";
  try {
    await api.accounts.inviteSelf(plan.accountId, location);
    toast.success("Invite sent to VRChat", {
      description: `Accept it in ${name}'s client to travel there. Nothing happens in this window — the notification is inside the game.`,
      duration: TOAST_MS,
    });
  } catch (error) {
    toast.error("Could not send the invite", {
      description: describeError(error),
      duration: TOAST_MS,
    });
  }
}
