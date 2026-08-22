/**
 * Getting a consent request in front of the user.
 *
 * The pairing flow exists because **the user may be somewhere else entirely** — that is the whole
 * premise of PLAN.md §"Pending consent". So the daemon cannot assume a vrc.zip tab is open, and a
 * Web Notification, which only fires from a loaded page, cannot be the only channel.
 *
 * **The OS notification always fires. Only the browser tab is conditional.**
 *
 * An earlier version skipped both when a UI client was connected, reasoning that the app raises its
 * own sheet and a second surface competes with it. That was wrong in the case the flow exists for.
 * "A UI client is connected" only means a browser tab holds the event-stream socket — it says
 * nothing about whether anyone is *looking* at it, and the person logging into a VRChat app is
 * usually in a headset or a game window, not on a vrc.zip tab. The UI's own Web Notification was
 * supposed to cover that, but it fires only from a loaded page and only if the browser granted
 * permission, which is a prompt most people never see and plenty deny. The observable result was a
 * login that sat waiting for a code nobody was ever shown.
 *
 * So the two channels are now split by what they cost:
 *
 *  - **The OS notification is unconditional.** It carries the code, it reaches someone who is not
 *    looking at a browser, and a toast does not steal focus. The worst case is a duplicate of a
 *    sheet the user can already see, which is a far cheaper failure than silence.
 *  - **The browser tab is opened only when nothing is connected.** *That* is the intrusive half:
 *    opening a tab on top of an app the user already has open is the kind of "help" that trains
 *    people to close things without reading them. A Windows toast cannot carry a click handler
 *    without a registered AppUserModelID (see `os/desktop-notification.ts`), so when there is no UI
 *    client the tab is what actually delivers the user and the toast explains why one appeared.
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

    const scopeCount = pending.newScopes.length;
    const result = await notify({
      title: `${pending.app.name} wants to use your VRChat account`,
      body:
        `Code ${pending.code}. Type it into ${pending.app.name} to allow it ` +
        `${scopeCount === 1 ? "one new permission" : `${String(scopeCount)} new permissions`}.`,
    });

    if (!result.shown) {
      // Worth a line: on a desktop this means the toast silently did not happen, and whatever is
      // left — a UI sheet, or the browser tab below — is the only thing the user will see.
      console.warn(`[vrc.zip] consent notification not shown (${result.reason ?? "unknown"})`);
    }

    // Somebody is already looking at the app, which raises its own sheet. Opening a tab on top of
    // it is the intrusive half; the toast above has already carried the code.
    if (options.uiConnected()) return;

    if (options.openBrowser?.() === false) return;
    await open(options.consentUrl(pending.id));
  }

  return () => {
    subscription.unsubscribe();
  };
}
