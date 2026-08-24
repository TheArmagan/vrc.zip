/**
 * A press on one of the daemon's own toasts, put on the bus.
 *
 * Twelve lines, and they exist so that `os/desktop-notification.ts` does not have to know what an
 * EventBus is. The notifier is an OS shim: it knows about WinRT, apartments and `.lnk` files, and it
 * reports what happened through a callback. This is the adapter that turns that callback into an
 * event, which is the same shape every other subsystem in `wiring/` has.
 *
 * The pay-off is that the graph trigger needs no special case. It subscribes to a kind, like the
 * twenty-eight triggers before it, and so can a plugin, a webhook filter and the feed.
 *
 * **Activation only.** The notifier also knows when a toast was dismissed and when the platform
 * refused one, and neither goes on the spine: a press is a person acting on something, and the rest
 * is a toast's own weather.
 */

import { DESKTOP_ACTIVATION_KIND } from "@vrcz/shared";
import type { EventBus } from "../bus/event-bus.ts";
import type { NotificationActivation } from "../os/desktop-notification.ts";

export interface NotificationActivationOptions {
  readonly bus: EventBus;
  /** Subscribes to presses. The notifier's own `onActivation`, passed rather than imported. */
  readonly onActivation: (handler: (activation: NotificationActivation) => void) => () => void;
}

/** Subscribes to the notifier and publishes. Returns a detach function. */
export function attachNotificationActivations(options: NotificationActivationOptions): () => void {
  return options.onActivation((activation) => {
    options.bus.emit({
      kind: DESKTOP_ACTIVATION_KIND,
      // A toast belongs to the machine, not to a VRChat account. The graph that raised it knows
      // which account it was acting as; the press does not, and inventing one here would let a
      // trigger filter by an account that had nothing to do with it.
      accountId: null,
      ts: activation.at,
      // The tag, so a webhook filter or the feed can group presses by what kind of notification
      // they were on without opening the payload. Blank when the caller set none.
      subjectId: activation.tag === "" ? activation.id : activation.tag,
      payload: {
        notificationId: activation.id,
        tag: activation.tag,
        button: activation.button,
        label: activation.label,
        action: activation.action,
        argument: activation.argument,
        // Whatever the caller attached to the toast, handed back untouched. Omitted rather than
        // nulled when there was none: a payload key that is always there says every press carries
        // something, and most of them carry nothing.
        ...(activation.data === undefined ? {} : { data: activation.data }),
      },
    });
  });
}
