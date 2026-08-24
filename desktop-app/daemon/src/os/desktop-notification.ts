/**
 * OS-level desktop notifications: a title, a body, buttons, and somewhere for a press to go.
 *
 * This is **not** the Web Notifications path in `ui/`. That one only fires while a browser tab is
 * loaded, which is exactly the case a consent prompt cannot rely on: the whole reason the pairing
 * flow exists is that the user may be somewhere else entirely, with no vrc.zip tab open at all.
 * When there is no UI client connected, this is the only thing that can reach them.
 *
 * Every platform is best-effort and every failure is silent. A daemon on a headless box, in a
 * container, or on a desktop with notifications switched off is a normal environment, and none of
 * them is a reason to fail the thing that wanted to notify.
 *
 * ## Windows is a real toast now, and the other two are not
 *
 * Windows goes through `os/toast.ts`: WinRT over `bun:ffi`, which means buttons, an image, a
 * scenario, an expiry, and an `Activated` callback that arrives in this process. The header of this
 * file used to say click-to-open was unavailable and that nothing should depend on it. That was true
 * of a toast raised by a PowerShell process which then exited, and it is not true any more.
 *
 * macOS and Linux still spawn `osascript` and `notify-send`. Neither can do buttons —
 * `display notification` has no such thing, and `notify-send`'s actions need a process to stay alive
 * holding the D-Bus connection — so on those platforms the extra fields are **dropped rather than
 * refused**: the toast still appears with its title and body, and {@link NotifyResult.ignored} names
 * what did not survive. A cross-platform graph that asked for a button gets a notification without
 * one, which is better than getting nothing and better than being lied to.
 *
 * ## The activation contract
 *
 * A press does not resolve `notify()`. It arrives later, on {@link DesktopNotifier.onActivation},
 * because that is what it actually is: the user may press a button ten minutes after the toast
 * appeared, from the Action Center, or never. `wiring/notification-activation.ts` puts those on the
 * EventBus, where the graph runtime's trigger picks them up like any other event.
 */

import { randomUUID } from "node:crypto";
import { APP_USER_MODEL_ID, ensureToastShortcut } from "./shortcut.ts";
import { closeAllToasts, type LiveToast, showToast, toastSupported } from "./toast.ts";

/* -------------------------------------------------------------------------------------------- */
/* What a notification is                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * What a button does when it is pressed, beyond telling whoever is listening that it was.
 *
 * Every one of these also raises an activation, `dismiss` excepted — that one is handed to Windows
 * as a system action, so the toast closes without this process being involved at all, which is the
 * whole point of having an explicit "no" button.
 */
export type ButtonAction = "signal" | "url" | "screen" | "dismiss" | "snooze";

export interface NotificationButton {
  /** Reported back on activation. A graph filters on this, so it is an id and not a label. */
  readonly id: string;
  readonly label: string;
  /** Defaults to `signal`: the press means whatever the graph wires it to mean. */
  readonly action?: ButtonAction;
  /** A URL for `url`, a route for `screen`, minutes for `snooze`. Ignored by the others. */
  readonly argument?: string;
}

/** Windows' own vocabulary. `reminder` and `alarm` stay on screen until they are answered. */
export type NotificationScenario = "default" | "reminder" | "alarm" | "incomingCall";

export interface DesktopNotification {
  /**
   * A name for *this one*, chosen by the caller.
   *
   * The difference from {@link DesktopNotification.tag} is the difference between a kind and an
   * instance: a tag says "this is the friend-online notification" and replaces the last one like it,
   * an id says "this is the one about Ada, tonight". A trigger can filter on either.
   *
   * Left off, a fresh one is minted per notification. Reusing an id lets go of whatever was on
   * screen under it first — two live toasts answering to one name is a press that cannot be
   * attributed, which is the one thing an id is for.
   */
  readonly id?: string;
  readonly title: string;
  readonly body: string;
  /** No sound. The toast still appears. */
  readonly silent?: boolean;
  /**
   * A name for *this kind* of notification.
   *
   * Two purposes, and they are the same purpose: Windows replaces a toast that shares a tag rather
   * than stacking a second one, and the activation trigger filters on it. So a graph that says
   * "friend-online" gets one toast that updates instead of eleven, and can react to only its own.
   */
  readonly tag?: string;
  readonly buttons?: readonly NotificationButton[];
  /** A local path, or something {@link DesktopNotifierOptions.resolveImage} can turn into one. */
  readonly image?: string;
  readonly scenario?: NotificationScenario;
  readonly duration?: "short" | "long";
  /** How long Windows keeps it in the Action Center. Relative, because absolute times drift. */
  readonly expiresInMs?: number;
  /** What clicking the body itself means. Defaults to a plain signal. */
  readonly click?: { readonly action: ButtonAction; readonly argument?: string };
  /**
   * Anything the caller wants handed back when this one is pressed.
   *
   * Never shown, never sent to the platform, and deliberately not part of
   * {@link activationArgument}: it is held here, in this process, beside the toast it belongs to, and
   * copied onto the activation. That is what lets it be arbitrary JSON rather than something short
   * enough to survive an `arguments` string that Windows round-trips through the shell.
   *
   * It is the answer to a press arriving minutes later with no idea what it was about. The toast said
   * "Ada wants in"; the press says "yes" — and this is where the whole invite lives in between.
   */
  readonly data?: unknown;
}

export interface NotifyResult {
  readonly shown: boolean;
  /** Why not, for the log. Never surfaced to a user — a failed toast is not their problem. */
  readonly reason?: string;
  /** Correlates this toast with the activations it later produces. Absent when nothing was shown. */
  readonly id?: string;
  /**
   * What this platform could not do. Empty on Windows.
   *
   * Reported rather than refused: see the note at the top about dropping fields instead of failing.
   */
  readonly ignored?: readonly string[];
}

export interface NotificationActivation {
  /** The {@link NotifyResult.id} of the toast this came from. */
  readonly id: string;
  readonly tag: string;
  /** The button's id, or null when the body itself was clicked. */
  readonly button: string | null;
  readonly label: string | null;
  readonly action: ButtonAction;
  readonly argument: string;
  /** Whatever {@link DesktopNotification.data} was set to. Absent when it was set to nothing. */
  readonly data?: unknown;
  readonly at: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Limits                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** Windows shows at most five, and drops the whole `<actions>` block if there are more. */
export const MAX_BUTTONS = 5;
/** Windows rejects a longer one, and takes the entire `Show` down with it. */
const MAX_TAG_LENGTH = 64;
/**
 * The longest a snooze may be.
 *
 * A snooze is a `setTimeout` and nothing more: it does not survive a restart, and it was not going
 * to. Capping it at an hour makes that a bounded surprise rather than an open-ended one — an hour of
 * uptime is an ordinary thing to expect and a day of it is not. The node says so in as many words.
 */
export const MAX_SNOOZE_MS = 60 * 60 * 1000;

/** Set this to stop the daemon raising OS notifications. Any non-empty value counts. */
export const SUPPRESS_ENV = "VRCZIP_NO_DESKTOP_NOTIFICATIONS";

/**
 * Whether to stay silent.
 *
 * **The test-runner case is not a nicety.** The consent flow raises a toast the moment a login
 * arrives, and the daemon's integration tests log apps in — so a full `bun test` fired a real
 * Windows toast per test that touched the handshake, on the developer's actual desktop. That is
 * both maddening and a genuine correctness signal: a unit test is not a user, and anything that
 * escapes the process during one is a side effect nobody asked for.
 *
 * Checked in one place rather than at the callers for the same reason redaction lives in the logger:
 * one choke point covers every path, including ones written later by someone who never read this.
 * `bun test` sets `NODE_ENV=test` itself, so nothing has to be configured for it to work.
 */
export function suppressed(env: NodeJS.ProcessEnv): boolean {
  if ((env[SUPPRESS_ENV] ?? "") !== "") return true;
  return env.NODE_ENV === "test";
}

/* -------------------------------------------------------------------------------------------- */
/* The toast document                                                                             */
/* -------------------------------------------------------------------------------------------- */

/** Escapes text for XML. Everything in a toast comes from somewhere a user or an app controls. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The `arguments` string a press comes back with.
 *
 * Deliberately not JSON. It travels through the shell and back, it is visible in the notification
 * platform's own logs, and it has to survive being compared as a string — so it is two encoded
 * fields and nothing that needs parsing to be understood.
 */
export function activationArgument(id: string, buttonId: string | null): string {
  const base = `n=${encodeURIComponent(id)}`;
  return buttonId === null ? base : `${base}&b=${encodeURIComponent(buttonId)}`;
}

/** The other direction, written to answer null for anything that is not ours. */
export function parseActivationArgument(
  text: string,
): { id: string; button: string | null } | null {
  const parts = new URLSearchParams(text);
  const id = parts.get("n");
  if (id === null || id === "") return null;
  const button = parts.get("b");
  return { id, button: button === null || button === "" ? null : button };
}

/**
 * Builds the whole `<toast>` document.
 *
 * Pure, exported, and tested on its own, because it is the half of the Windows path that can be
 * wrong in a way a test can see. The FFI underneath it either works on a machine or does not.
 *
 * `ToastGeneric` rather than one of the numbered templates: the templates cap out at two lines of
 * text and cannot carry actions at all, which is the entire feature.
 */
export function toastXml(
  id: string,
  notification: DesktopNotification,
  imagePath: string | null,
): string {
  const attributes = [`launch="${escapeXml(activationArgument(id, null))}"`];
  if (notification.duration === "long") attributes.push('duration="long"');
  if (notification.scenario !== undefined && notification.scenario !== "default") {
    attributes.push(`scenario="${notification.scenario}"`);
  }

  const visual: string[] = [
    `<text>${escapeXml(notification.title)}</text>`,
    `<text>${escapeXml(notification.body)}</text>`,
  ];
  if (imagePath !== null) {
    // `appLogoOverride` is the small round slot beside the text, which is where a person's avatar
    // belongs. A `hero` image would push the text down and is the wrong shape for a face.
    visual.push(
      `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXml(fileUrl(imagePath))}"/>`,
    );
  }

  const actions = (notification.buttons ?? []).slice(0, MAX_BUTTONS).map((button) => {
    /*
     * `activationType="system"` with `arguments="dismiss"` is Windows closing its own toast. It
     * never reaches this process, which is exactly what a Dismiss button should do — routing "no"
     * through an IPC callback so the daemon can do nothing with it would be ceremony.
     */
    if (button.action === "dismiss") {
      return `<action content="${escapeXml(button.label)}" arguments="dismiss" activationType="system"/>`;
    }
    const args = escapeXml(activationArgument(id, button.id));
    return `<action content="${escapeXml(button.label)}" arguments="${args}" activationType="foreground"/>`;
  });

  return [
    `<toast ${attributes.join(" ")}>`,
    `<visual><binding template="ToastGeneric">${visual.join("")}</binding></visual>`,
    notification.silent === true ? '<audio silent="true"/>' : "",
    actions.length > 0 ? `<actions>${actions.join("")}</actions>` : "",
    "</toast>",
  ].join("");
}

/**
 * A `file:///` URL for a local path.
 *
 * Windows accepts a bare path here too, right up until the path has a space or a `#` in it — and
 * `%LOCALAPPDATA%` has a space on any machine whose user name does. The image then silently does not
 * draw, with the rest of the toast looking perfect.
 */
export function fileUrl(path: string): string {
  const normalised = path.replace(/\\/g, "/");
  const encoded = normalised
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    // A drive letter's colon is not something to encode; nothing else in a segment is a colon.
    .join("/")
    .replace(/^([A-Za-z])%3A/, "$1:");
  return `file:///${encoded.replace(/^\/+/, "")}`;
}

/* -------------------------------------------------------------------------------------------- */
/* The notifier                                                                                   */
/* -------------------------------------------------------------------------------------------- */

export interface DesktopNotifierOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * How a `url` button opens something on the public internet.
   *
   * Injected for the reason the tray's is: `os/open-url.ts` has two openers and picking the wrong
   * one is a button that silently does nothing. It is also what keeps a test from launching a
   * browser.
   */
  readonly openUrl?: (url: string) => void;
  /** How a `screen` button opens vrc.zip itself. The caller owns the token in that URL. */
  readonly openScreen?: (path: string) => void;
  /**
   * Turns whatever the caller called an image into a local file path.
   *
   * An unpackaged app's toast cannot load an image over the network — Windows simply does not draw
   * it — so a URL has to become a file before it is any use. `app.ts` wires this to the daemon's own
   * image cache, which is also the only thing that can fetch a VRChat CDN image at all, since those
   * need the auth cookie and the User-Agent.
   */
  readonly resolveImage?: (source: string) => Promise<string | null>;
  readonly now?: () => number;
}

interface LiveRecord {
  readonly notification: DesktopNotification;
  readonly toast: LiveToast | null;
}

/**
 * Raises notifications and reports what is done with them.
 *
 * Constructed in `app.ts` and passed to whoever needs it, like every other subsystem — it holds live
 * COM handlers, a table of what is on screen, and any pending snoozes, none of which should exist
 * twice in one process.
 */
export class DesktopNotifier {
  readonly #platform: NodeJS.Platform;
  readonly #env: NodeJS.ProcessEnv;
  readonly #options: DesktopNotifierOptions;
  readonly #live = new Map<string, LiveRecord>();
  readonly #listeners = new Set<(activation: NotificationActivation) => void>();
  readonly #snoozes = new Set<ReturnType<typeof setTimeout>>();
  #stopped = false;

  constructor(options: DesktopNotifierOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#env = options.env ?? process.env;
    this.#options = options;
  }

  /** Subscribes to presses. Returns the function that unsubscribes. */
  onActivation(handler: (activation: NotificationActivation) => void): () => void {
    this.#listeners.add(handler);
    return () => {
      this.#listeners.delete(handler);
    };
  }

  /** Raises one. Resolves to whether it was shown; never rejects. */
  async notify(notification: DesktopNotification): Promise<NotifyResult> {
    if (this.#stopped) return { shown: false, reason: "stopped" };
    if (suppressed(this.#env)) return { shown: false, reason: "suppressed" };

    const cleaned = this.#clean(notification);
    try {
      if (this.#platform === "win32") return await this.#showWindows(cleaned);
      return await this.#showElsewhere(cleaned);
    } catch (error) {
      return { shown: false, reason: String(error) };
    }
  }

  /** Lets go of everything on screen and cancels any pending snooze. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const timer of this.#snoozes) clearTimeout(timer);
    this.#snoozes.clear();
    for (const record of this.#live.values()) record.toast?.close();
    this.#live.clear();
    this.#listeners.clear();
    closeAllToasts();
  }

  /** Sanitising and clamping, in one place, before any platform sees the values. */
  #clean(notification: DesktopNotification): DesktopNotification {
    const buttons = (notification.buttons ?? []).slice(0, MAX_BUTTONS).map((button) => ({
      ...button,
      label: sanitise(button.label),
    }));
    return {
      ...notification,
      title: sanitise(notification.title),
      body: sanitise(notification.body),
      ...(notification.tag === undefined
        ? {}
        : { tag: sanitise(notification.tag).slice(0, MAX_TAG_LENGTH) }),
      ...(buttons.length > 0 ? { buttons } : {}),
    };
  }

  async #showWindows(notification: DesktopNotification): Promise<NotifyResult> {
    if (!toastSupported()) {
      return { shown: false, reason: "this machine has no WinRT notification platform" };
    }
    const shortcut = await ensureToastShortcut(this.#env);
    if (shortcut === null) {
      // Worth a sentence rather than a bare false: this is the one failure with a cause somebody
      // could act on, and "install vrc.zip" is the action.
      return { shown: false, reason: "no Start menu shortcut to raise a notification from" };
    }

    const image = await this.#resolveImage(notification.image);
    const id =
      notification.id === undefined || notification.id === "" ? randomUUID() : notification.id;
    // A reused id replaces rather than doubles. See the note on `DesktopNotification.id`.
    this.#live.get(id)?.toast?.close();
    const now = this.#options.now?.() ?? Date.now();

    const live = showToast(
      APP_USER_MODEL_ID,
      {
        xml: toastXml(id, notification, image),
        ...(notification.tag === undefined ? {} : { tag: notification.tag }),
        ...(notification.expiresInMs === undefined
          ? {}
          : { expiresAt: now + notification.expiresInMs }),
      },
      {
        onActivated: (argumentsText) => {
          this.#activated(argumentsText);
        },
        onDismissed: () => {
          this.#live.delete(id);
        },
      },
    );
    if (live === null) return { shown: false, reason: "the notification platform refused it" };

    this.#live.set(id, { notification, toast: live });
    return { shown: true, id, ignored: [] };
  }

  /** macOS and Linux, where the text is all that survives. */
  async #showElsewhere(notification: DesktopNotification): Promise<NotifyResult> {
    const ignored: string[] = [];
    if ((notification.buttons ?? []).length > 0) ignored.push("buttons");
    if (notification.image !== undefined) ignored.push("image");
    if (notification.scenario !== undefined && notification.scenario !== "default") {
      ignored.push("scenario");
    }
    if (notification.duration !== undefined) ignored.push("duration");
    if (notification.expiresInMs !== undefined) ignored.push("expiry");

    switch (this.#platform) {
      case "darwin": {
        // `display notification` has no sound switch worth the name, no buttons, and no image.
        if (notification.silent === true) ignored.push("silent");
        const result = await run([
          "osascript",
          "-e",
          `display notification ${appleScriptString(notification.body)} with title ${appleScriptString(notification.title)}`,
        ]);
        return { ...result, ignored };
      }
      case "linux": {
        // libnotify. Absent on a minimal install, which `run` reports as not-shown rather than
        // throwing — there is nothing useful to do about it, and a daemon that crashed because
        // `notify-send` was missing would be a much worse bug than a missing toast.
        const argv = [
          "notify-send",
          "--app-name=vrc.zip",
          `--urgency=${notification.scenario === "alarm" ? "critical" : "normal"}`,
        ];
        // The one extra field that survives: a hint every notification daemon understands.
        if (notification.silent === true) argv.push("--hint=int:suppress-sound:1");
        argv.push(notification.title, notification.body);
        const result = await run(argv);
        return { ...result, ignored };
      }
      default:
        return { shown: false, reason: `unsupported platform: ${this.#platform}`, ignored };
    }
  }

  async #resolveImage(source: string | undefined): Promise<string | null> {
    if (source === undefined || source.trim() === "") return null;
    // A path, not a URL: anything with a scheme has to go through the resolver, and everything else
    // is already a file. `C:\…` is not a scheme, which is why the test is for two or more letters.
    if (!/^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(source)) return source;
    const resolve = this.#options.resolveImage;
    if (resolve === undefined) return null;
    try {
      return await resolve(source);
    } catch {
      return null;
    }
  }

  /** A press, arriving from `os/toast.ts` on our own stack. */
  #activated(argumentsText: string): void {
    const parsed = parseActivationArgument(argumentsText);
    if (parsed === null) return;
    const record = this.#live.get(parsed.id);
    if (record === undefined) return;

    const button =
      parsed.button === null
        ? null
        : ((record.notification.buttons ?? []).find((entry) => entry.id === parsed.button) ?? null);
    const click = record.notification.click;
    const action: ButtonAction =
      button?.action ?? (parsed.button === null ? (click?.action ?? "signal") : "signal");
    const argument =
      button?.argument ?? (parsed.button === null ? click?.argument || "" : "") ?? "";

    this.#perform(action, argument, record.notification);

    const activation: NotificationActivation = {
      id: parsed.id,
      tag: record.notification.tag ?? "",
      button: parsed.button,
      label: button?.label ?? null,
      action,
      argument,
      // Straight off the record this process kept. Absent rather than null when there was none, so
      // "carried nothing" and "carried a null" stay different answers.
      ...(record.notification.data === undefined ? {} : { data: record.notification.data }),
      at: this.#options.now?.() ?? Date.now(),
    };
    for (const listener of [...this.#listeners]) {
      try {
        listener(activation);
      } catch {
        // One subscriber's mistake is not another's missed event.
      }
    }
  }

  /** The built-in half of a press. `signal` deliberately does nothing here. */
  #perform(action: ButtonAction, argument: string, notification: DesktopNotification): void {
    switch (action) {
      case "url":
        if (argument !== "") this.#options.openUrl?.(argument);
        break;
      case "screen":
        this.#options.openScreen?.(argument);
        break;
      case "snooze": {
        const minutes = Number.parseFloat(argument);
        const delay = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : MAX_SNOOZE_MS;
        const timer = setTimeout(
          () => {
            this.#snoozes.delete(timer);
            void this.notify(notification);
          },
          Math.min(delay, MAX_SNOOZE_MS),
        );
        timer.unref?.();
        this.#snoozes.add(timer);
        break;
      }
      default:
        // `signal` and `dismiss`. The first means whatever the canvas says it means, and the second
        // never reaches this process — Windows closes the toast itself. See `toastXml`.
        break;
    }
  }
}

/* -------------------------------------------------------------------------------------------- */
/* The helper processes, and the text they carry                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * Runs an argv. Never throws.
 *
 * Spawned with an argv array so the text is an argument rather than part of a shell string. Both
 * halves are attacker-influenced — an app's name and contact come off its `User-Agent` — and a
 * toast is not worth a command injection.
 */
async function run(argv: string[]): Promise<NotifyResult> {
  const [command, ...args] = argv;
  if (command === undefined) return { shown: false, reason: "empty argv" };

  try {
    const child = Bun.spawn([command, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      // `CREATE_NO_WINDOW`: no console of its own when we have none to lend it.
      windowsHide: true,
    });
    const code = await child.exited;
    return code === 0 ? { shown: true } : { shown: false, reason: `exit ${String(code)}` };
  } catch (error) {
    // ENOENT for a missing `notify-send` or `osascript` lands here.
    return { shown: false, reason: String(error) };
  }
}

/**
 * One line, bounded length, no control characters.
 *
 * The strings come from an app's `User-Agent`, so they are arbitrary text from a third party. A
 * newline in a toast body is at best ugly and at worst a way to fake a second notification's worth
 * of text inside one.
 */
export function sanitise(text: string): string {
  let flat = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    flat += code < 0x20 || code === 0x7f ? " " : character;
  }
  const collapsed = flat.replace(WHITESPACE_RUN, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}

/** Written as a named constant so the loop above reads as the interesting half. */
const WHITESPACE_RUN = / +/g;

/** Escapes a string for embedding in AppleScript source, which only understands `"` and `\`. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
