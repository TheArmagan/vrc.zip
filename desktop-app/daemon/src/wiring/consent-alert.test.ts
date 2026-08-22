import { beforeEach, expect, test } from "bun:test";
import { EventBus } from "../bus/event-bus.ts";
import type { NotifyResult } from "../os/desktop-notification.ts";
import { ConsentRegistry } from "../proxy/consent.ts";
import { hashProxyToken } from "../security/proxy-tokens.ts";
import { MEMORY, Store } from "../store/store.ts";
import { attachConsentAlerts } from "./consent-alert.ts";

/**
 * Reaching a user who is not looking at the app. PLAN.md §Phase 2 "Pending consent" assumes exactly
 * that — the flow exists because the person may be somewhere else — so the interesting assertions
 * here are about *which* channel fires, not about the text.
 */

let store: Store;
let bus: EventBus;
let consent: ConsentRegistry;
let notified: Array<{ title: string; body: string }>;
let opened: string[];
let notifyResult: NotifyResult;

const APP = { name: "MyApp", version: "1.0.0", contact: "me@somewhere.dev" };

beforeEach(() => {
  store = Store.open(MEMORY);
  store.upsertAccount({
    id: "usr_alice",
    display_name: "Alice",
    added_at: 1,
    enabled: 1,
    last_seen_at: null,
  });
  bus = new EventBus();
  consent = new ConsentRegistry({
    store,
    bus,
    mintCode: () => ({ token: "424242", hash: hashProxyToken("424242") }),
  });
  notified = [];
  opened = [];
  notifyResult = { shown: true };
});

function attach(overrides: { uiConnected?: boolean; openBrowser?: boolean } = {}): () => void {
  return attachConsentAlerts({
    bus,
    consent,
    uiConnected: () => overrides.uiConnected ?? false,
    consentUrl: (id) => `http://127.0.0.1:7773/?token=t#/consent/${id}`,
    notify: async (notification) => {
      notified.push({ title: notification.title, body: notification.body });
      return notifyResult;
    },
    open: async (url) => {
      opened.push(url);
      return true;
    },
    ...(overrides.openBrowser === undefined
      ? {}
      : { openBrowser: (): boolean => overrides.openBrowser === true }),
  });
}

function open(scopes: readonly string[] = ["friends:read"], newScopes = scopes) {
  return consent.open({
    accountId: "usr_alice",
    requestedUsername: "alice@somewhere.dev",
    app: APP,
    scopes: scopes as never,
    newScopes: newScopes as never,
  });
}

/** The alert path is async off a synchronous `emit`; let its microtasks run. */
async function settle(): Promise<void> {
  await Bun.sleep(5);
}

test("with nobody watching, it notifies and opens the consent tab", async () => {
  // A Windows toast cannot carry a click handler without a registered AppUserModelID, so the tab is
  // what actually delivers the user and the toast is what explains why one just opened.
  const detach = attach({ uiConnected: false });
  const { pending } = open();
  await settle();

  expect(notified).toHaveLength(1);
  expect(notified[0]?.title).toBe("MyApp wants to use your VRChat account");
  // The code is the point of the notification — it is what the user types into the app.
  expect(notified[0]?.body).toContain("424242");
  expect(opened).toEqual([`http://127.0.0.1:7773/?token=t#/consent/${pending.id}`]);
  detach();
});

test("with the UI connected, it still notifies but does not open a tab", async () => {
  // The regression this encodes: a connected UI client only means a browser tab holds the socket,
  // not that anyone is looking at it. Someone logging into a VRChat app is usually in a headset,
  // and the UI's own Web Notification needs a browser permission most people never grant. Staying
  // silent left a login waiting for a code nobody was ever shown.
  const detach = attach({ uiConnected: true });
  open();
  await settle();

  expect(notified).toHaveLength(1);
  expect(notified[0]?.body).toContain("424242");
  // The tab is the intrusive half, and the app already has its own sheet up.
  expect(opened).toEqual([]);
  detach();
});

test("the browser half can be switched off without losing the notification", async () => {
  const detach = attach({ uiConnected: false, openBrowser: false });
  open();
  await settle();

  expect(notified).toHaveLength(1);
  expect(opened).toEqual([]);
  detach();
});

test("a failed toast still opens the tab, and says so once", async () => {
  // Headless boxes, containers, and desktops with notifications off are all normal. None of them
  // is a reason to leave the user with no way to reach the sheet.
  notifyResult = { shown: false, reason: "notify-send not found" };
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    const detach = attach({ uiConnected: false });
    open();
    await settle();

    expect(opened).toHaveLength(1);
    expect(warnings.some((line) => line.includes("consent notification not shown"))).toBe(true);
    detach();
  } finally {
    console.warn = realWarn;
  }
});

test("the notification counts the new permissions, not the whole ask", async () => {
  // On an escalation the sheet leads with the delta, and the toast should agree with it — telling
  // the user an app wants "four permissions" when three are ones they already granted is a way to
  // make a small ask look alarming, and a big one look routine.
  const detach = attach({ uiConnected: false });
  open(["friends:read", "users:read", "invite:send"], ["invite:send"]);
  await settle();

  expect(notified[0]?.body).toContain("one new permission");
  detach();
});

test("detaching stops the alerts", async () => {
  const detach = attach({ uiConnected: false });
  detach();
  open();
  await settle();

  expect(notified).toEqual([]);
  expect(opened).toEqual([]);
});

test("the code is read synchronously with the emit, so nothing can race it away", async () => {
  // The registry is the source of the code, not the bus payload — the payload deliberately carries
  // none. That read happens before the first `await`, so a request answered a moment later has
  // still already produced its alert rather than a notification with a blank where the code goes.
  const detach = attach({ uiConnected: false });
  const { pending } = open();
  consent.deny(pending.id);
  await settle();

  expect(notified[0]?.body).toContain("424242");
  detach();
});

test("an event for a request the registry never had is skipped, not guessed at", async () => {
  const detach = attach({ uiConnected: false });
  bus.emit({
    kind: "consent.pending",
    accountId: null,
    ts: Date.now(),
    subjectId: "no-such-request",
    payload: {},
  });
  await settle();

  expect(notified).toEqual([]);
  expect(opened).toEqual([]);
  detach();
});

test("the bus payload never carries the pairing code", async () => {
  // The stream goes to every UI client and, later, to plugins. The code belongs to the one screen
  // that is behind the session token, which reads it from the control API instead.
  const seen: unknown[] = [];
  bus.subscribe(
    (event) => {
      seen.push(event.payload);
    },
    { kinds: ["consent.pending"] },
  );
  open();
  await settle();

  expect(JSON.stringify(seen)).not.toContain("424242");
});
