/**
 * OS-level desktop notifications, with no native dependency.
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
 * **Click-to-open is not available everywhere, so nothing depends on it.** A Windows toast can only
 * carry an activation handler if the app is registered with an AppUserModelID and a COM activator,
 * which means an installer and a shortcut — a Phase 5 concern, not something to half-build now.
 * Callers that need the user to *arrive* somewhere open the browser themselves; see
 * `wiring/consent-alert.ts`, where the notification explains and the browser tab delivers.
 */

/** What to show. Deliberately minimal: three platforms have to agree on it. */
export interface DesktopNotification {
  readonly title: string;
  readonly body: string;
}

export interface NotifyResult {
  readonly shown: boolean;
  /** Why not, for the log. Never surfaced to a user — a failed toast is not their problem. */
  readonly reason?: string;
}

/**
 * Raises a notification. Resolves to whether it was shown; never rejects.
 *
 * Spawned with an argv array so the text is an argument rather than part of a shell string. Both
 * halves are attacker-influenced — an app's name and contact come off its `User-Agent` — and a
 * toast is not worth a command injection.
 */
export async function notifyDesktop(
  notification: DesktopNotification,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NotifyResult> {
  if (suppressed(env)) return { shown: false, reason: "suppressed" };

  const title = sanitise(notification.title);
  const body = sanitise(notification.body);

  try {
    switch (platform) {
      case "win32":
        return await run(powershellToast(), { title, body });
      case "darwin":
        return await run([
          "osascript",
          "-e",
          `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`,
        ]);
      case "linux":
        // libnotify. Absent on a minimal install, which `run` reports as not-shown rather than
        // throwing — there is nothing useful to do about it, and a daemon that crashed because
        // `notify-send` was missing would be a much worse bug than a missing toast.
        return await run(["notify-send", "--app-name=vrc.zip", "--urgency=normal", title, body]);
      default:
        return { shown: false, reason: `unsupported platform: ${platform}` };
    }
  } catch (error) {
    return { shown: false, reason: String(error) };
  }
}

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
 * Checked here rather than at the callers for the same reason redaction lives in the logger: one
 * choke point covers every path, including ones written later by someone who never read this.
 * `bun test` sets `NODE_ENV=test` itself, so nothing has to be configured for it to work.
 */
function suppressed(env: NodeJS.ProcessEnv): boolean {
  if ((env[SUPPRESS_ENV] ?? "") !== "") return true;
  return env.NODE_ENV === "test";
}

/**
 * A Windows toast through PowerShell's WinRT bridge.
 *
 * Uses PowerShell's own AppUserModelID because we do not have one of our own until there is an
 * installed shortcut (Phase 5). The visible cost is that the toast is attributed to Windows
 * PowerShell rather than to vrc.zip — worth taking, because the alternative is no notification at
 * all on the platform most users are on.
 *
 * The text is passed through `$env:` rather than interpolated into the script. PowerShell has its
 * own quoting rules on top of the argv boundary, and a display name containing a quote would
 * otherwise break the script — or worse, extend it.
 */
export function powershellToast(): string[] {
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] > $null",
    "$template=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$nodes=$template.GetElementsByTagName('text')",
    "$nodes.Item(0).AppendChild($template.CreateTextNode($env:VRCZ_TOAST_TITLE)) > $null",
    "$nodes.Item(1).AppendChild($template.CreateTextNode($env:VRCZ_TOAST_BODY)) > $null",
    "$toast=[Windows.UI.Notifications.ToastNotification]::new($template)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.PowerShell').Show($toast)",
  ].join("; ");

  return [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-Command",
    script,
  ];
}

/** Runs an argv, with the toast text supplied out of band. Never throws. */
async function run(argv: string[], text?: { title: string; body: string }): Promise<NotifyResult> {
  const [command, ...args] = argv;
  if (command === undefined) return { shown: false, reason: "empty argv" };

  try {
    const child = Bun.spawn([command, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: {
        ...process.env,
        ...(text === undefined ? {} : { VRCZ_TOAST_TITLE: text.title, VRCZ_TOAST_BODY: text.body }),
      },
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
  return collapsed.length > 200 ? collapsed.slice(0, 197) + "..." : collapsed;
}

/** Written as a named constant so the loop above reads as the interesting half. */
const WHITESPACE_RUN = / +/g;

/** Escapes a string for embedding in AppleScript source, which only understands `"` and `\`. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
