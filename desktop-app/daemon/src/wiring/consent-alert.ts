/**
 * Getting a consent request in front of the user.
 *
 * The pairing flow exists because **the user may be somewhere else entirely** — that is the whole
 * premise of PLAN.md §"Pending consent". So the daemon cannot assume a vrc.zip tab is open, and a
 * Web Notification, which only fires from a loaded page, cannot be the only channel.
 *
 * Two channels, and which one runs depends on whether anyone is actually watching:
 *
 *  - **A UI client is connected.** The consent sheet appears in the app on its own, and the UI
 *    raises a Web Notification if its tab is hidden. Nothing happens here: opening a second browser
 *    tab on top of an app the user already has open is the kind of "help" that trains people to
 *    close things without reading them.
 *  - **Nothing is connected.** An OS notification says who is asking, and the browser is opened on
 *    the consent screen. The notification alone would not be enough — a Windows toast cannot carry
 *    a click handler without a registered AppUserModelID (see `os/desktop-notification.ts`), so the
 *    tab is what actually delivers the user, and the toast is what explains why a tab just opened.
 *
 * Both halves are best-effort and neither can fail the login that triggered them. A daemon on a
 * headless box has no browser and no notification daemon, and the pairing still works — the code is
 * on the control API for anything that asks.
 */

import type { BusEvent, EventBus, Subscription } from "../bus/event-bus.ts";
import { notifyDesktop } from "../os/desktop-notification.ts";
import { openUrl } from "../os/open-url.ts";
import type { ConsentRegistry } from "../proxy/consent.ts";

export interface ConsentAlertOptions {
  readonly bus: EventBus;
  readonly consent: ConsentRegistry;
  /** Whether any UI client currently holds an event-stream socket. */
  readonly uiConnected: () => boolean;
  /** Builds the URL that lands on the consent screen for one request, token included. */
  readonly consentUrl: (pairingId: string) => string;
  /** Test seams. Both default to the real thing. */
  readonly notify?: typeof notifyDesktop | undefined;
  readonly open?: typeof openUrl | undefined;
  /** The user can switch the browser half off; the notification half stays. */
  readonly openBrowser?: (() => boolean) | undefined;
}

/** Subscribes to `consent.pending` and alerts the user. Returns a detach function. */
export function attachConsentAlerts(options: ConsentAlertOptions): () => void {
  const notify = options.notify ?? notifyDesktop;
  const open = options.open ?? openUrl;

  const subscription: Subscription = options.bus.subscribe(
    (event) => {
      void alert(event);
    },
    { kinds: ["consent.pending"] },
  );

  async function alert(event: BusEvent): Promise<void> {
    const id = event.subjectId;
    if (id === null || id === undefined) return;

    // Read the registry rather than the event payload: the payload is a wire shape that has to stay
    // free of the code, and the code is the whole point of the notification.
    const pending = options.consent.get(id);
    if (pending === null) return;

    // Somebody is already looking. The app raises its own sheet, and a second surface competing
    // with it is worse than none.
    if (options.uiConnected()) return;

    const scopeCount = pending.newScopes.length;
    const result = await notify({
      title: `${pending.app.name} wants to use your VRChat account`,
      body:
        `Code ${pending.code} — type it into ${pending.app.name} to allow it ` +
        `${scopeCount === 1 ? "one new permission" : `${String(scopeCount)} new permissions`}.`,
    });

    if (!result.shown) {
      // Worth a line: on a desktop this means the toast silently did not happen, and the browser
      // tab below is then the only thing the user will see.
      console.warn(`[vrc.zip] consent notification not shown (${result.reason ?? "unknown"})`);
    }

    if (options.openBrowser?.() === false) return;
    await open(options.consentUrl(pending.id));
  }

  return () => {
    subscription.unsubscribe();
  };
}
