/**
 * Web Notifications, for alerts while a tab is open.
 *
 * Deliberately not a replacement for the tray notifications the daemon raises — this only fires
 * while the page is loaded, and only while it is *not* the visible tab. Notifying about
 * something the user is already looking at is noise.
 */

import type { FeedEvent } from "./api.ts";
import { eventLabel, subjectName } from "./format.ts";

export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

export function notificationSupport(): NotificationPermissionState {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * Must be called from a user gesture — browsers reject a permission prompt raised on load, and
 * an auto-prompt on first paint is the fastest way to earn a permanent "denied" anyway.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export interface NotifyOptions {
  readonly title: string;
  readonly body?: string;
  /** Same tag replaces rather than stacks — one notification per friend, not forty. */
  readonly tag?: string;
  readonly onClick?: () => void;
}

export function notify(options: NotifyOptions): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  // The user is looking at the app; a desktop toast on top of it is pure noise.
  if (document.visibilityState === "visible") return;

  const init: NotificationOptions = { silent: false };
  if (options.body !== undefined) init.body = options.body;
  if (options.tag !== undefined) init.tag = options.tag;

  let handle: Notification;
  try {
    handle = new Notification(options.title, init);
  } catch {
    // Some platforms (notably Chrome on Android) only allow service-worker notifications.
    return;
  }
  handle.addEventListener("click", () => {
    window.focus();
    options.onClick?.();
    handle.close();
  });
}

/** Turns a feed event into a notification, if the user asked to be told about that kind. */
export function notifyForEvent(
  event: FeedEvent,
  enabledKinds: readonly string[],
  onClick?: () => void,
): void {
  if (!enabledKinds.includes(event.kind)) return;
  const who = subjectName(event.payload);
  const options: NotifyOptions = {
    title: who === null ? eventLabel(event.kind) : `${who} — ${eventLabel(event.kind)}`,
    tag: `vrcz:${event.kind}:${event.subjectId ?? event.id}`,
    ...(who === null ? {} : { body: eventLabel(event.kind) }),
    ...(onClick === undefined ? {} : { onClick }),
  };
  notify(options);
}
