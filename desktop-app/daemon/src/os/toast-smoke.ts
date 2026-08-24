/**
 * `bun run notify:smoke` — raises one real toast and waits for you to press something.
 *
 * The FFI in `toast.ts` cannot be unit tested in any way that would tell you the truth. A test can
 * assert that the document is right (`os.test.ts` does) and that a vtable index is the number it was
 * written as, and none of that is the question. The question is whether Windows draws the toast,
 * whether the buttons appear on it, and whether pressing one comes back into this process — and the
 * only instrument for that is a person looking at their own desktop.
 *
 * So this is the instrument. It suppresses nothing, writes the Start menu shortcut if there is not
 * one, holds the message pump open for a minute, and prints every activation it receives.
 *
 * Run it after touching anything in `toast.ts`, `com.ts`, `shortcut.ts` or `message-pump.ts`.
 * Nothing else in this repository will notice if that layer breaks.
 */

import { DesktopNotifier } from "./desktop-notification.ts";
import { acquireMessagePump } from "./message-pump.ts";

const WAIT_MS = 60_000;

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    console.log("Not Windows. There is nothing here to smoke test.");
    return;
  }

  /*
   * The daemon holds this open for its tray icon. This script has no tray, and without a pump the
   * toast still appears and the activation never arrives — which is exactly the failure this is here
   * to catch, so it must not be the failure this is here to *cause*.
   */
  const pump = acquireMessagePump();
  if (pump === null) {
    console.log("No message pump. Activations cannot be delivered, so this would prove nothing.");
    return;
  }

  const notifier = new DesktopNotifier({
    // The one place suppression is deliberately stepped around: this script exists to put a toast on
    // a desktop, and `NODE_ENV` in a shell that has run tests would otherwise silence it.
    env: { ...process.env, NODE_ENV: "development", VRCZIP_NO_DESKTOP_NOTIFICATIONS: "" },
    openUrl: (url) => {
      console.log(`  would open externally: ${url}`);
    },
    openScreen: (path) => {
      console.log(`  would open vrc.zip at: ${path}`);
    },
  });

  notifier.onActivation((activation) => {
    console.log(
      `activated: button=${activation.button ?? "(body)"} action=${activation.action} argument=${activation.argument || "(none)"}`,
    );
  });

  const result = await notifier.notify({
    title: "vrc.zip smoke test",
    body: "Press a button, or click the toast itself.",
    tag: "smoke",
    silent: true,
    buttons: [
      { id: "yes", label: "Signal", action: "signal" },
      { id: "site", label: "Open GitHub", action: "url", argument: "https://github.com" },
      { id: "no", label: "Not now", action: "dismiss" },
    ],
  });

  console.log(result);
  if (!result.shown) {
    notifier.stop();
    pump.release();
    return;
  }

  console.log(`waiting ${String(WAIT_MS / 1000)}s for a press. Ctrl+C to stop.`);
  await Bun.sleep(WAIT_MS);
  notifier.stop();
  pump.release();
}

await main();
