/**
 * Opening a URL in the user's default browser.
 *
 * Three platforms, three commands, and no dependency. Every call is best-effort: a machine with no
 * default browser, a headless Linux box, or a locked-down desktop are all normal environments for a
 * daemon, and none of them is a reason to fail whatever the caller was actually doing.
 *
 * **The URL carries a session token**, so it is passed as an argument to a spawned process and
 * never through a shell string that could word-split or expand it. `Bun.spawn` takes an argv array
 * and does no shell interpretation, which is what makes that true.
 */

/** Best-effort. Resolves to whether the opener was launched, never rejects. */
export async function openUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  // Only ever open something we would serve ourselves. Without this the function is a general
  // "launch whatever this string says" primitive, one bug away from opening a `file://` or a
  // remote page with the session token attached.
  if (!isLoopbackHttpUrl(url)) return false;

  const argv = openerArgv(url, platform);
  if (argv === null) return false;

  try {
    const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    // Deliberately not awaited beyond the spawn: `xdg-open` can stay alive for as long as the
    // browser it launched, and blocking on that would hang the caller for the session.
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether to open a browser at startup: `--open` / `--no-open` if either is given, otherwise only a
 * packaged build does.
 *
 * The default splits that way because the two builds are used differently. Someone who
 * double-clicked `vrc.zip.exe` is not reading a terminal, and a URL with a session token in it is
 * not something to retype. From source the daemon usually runs under `bun --watch`, which restarts
 * on every keystroke-sized edit and would open a tab each time.
 */
export function shouldOpenBrowser(argv: readonly string[], packaged: boolean): boolean {
  // `--no-open` wins over `--open`: a flag that turns something off should not depend on the order
  // a script happened to append them in.
  if (argv.includes("--no-open")) return false;
  if (argv.includes("--open")) return true;
  return packaged;
}

/** The argv for this platform, or null if we do not know how to open a URL here. */
export function openerArgv(url: string, platform: NodeJS.Platform): string[] | null {
  switch (platform) {
    case "win32":
      // `start` is a cmd builtin, not an executable. The empty string is the window *title*
      // argument: without it `start "http://…"` treats the URL as the title and opens nothing.
      return ["cmd", "/c", "start", "", url];
    case "darwin":
      return ["open", url];
    case "linux":
      return ["xdg-open", url];
    default:
      return null;
  }
}

/**
 * True for a URL on loopback over plain HTTP — the only thing this module will open.
 *
 * An allowlist rather than a "does it resolve" check: a DNS lookup that has to succeed before a
 * browser can be opened is a new way for the launch to fail.
 */
export function isLoopbackHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
}
