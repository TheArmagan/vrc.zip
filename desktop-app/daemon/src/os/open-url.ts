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
 * Opens a public https URL, for the handful of links that are deliberately *not* ours.
 *
 * Separate from {@link openUrl} rather than a flag on it, and the split is the point. `openUrl`
 * carries a session token, so its loopback check is a security guard and must not grow an escape
 * hatch — the first caller who passes `allowExternal: true` by mistake is leaking the token to
 * whatever host the string names. This function can never see the token: it takes a hard-coded
 * link (the repository, and whatever joins it later), and it refuses anything that is not https,
 * so `file://` and every other scheme stay out of reach.
 *
 * Best-effort in the same way, and for the same reasons.
 */
export async function openExternalUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (!isPublicHttpsUrl(url)) return false;

  const argv = openerArgv(url, platform);
  if (argv === null) return false;

  try {
    const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
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

/**
 * True for an https URL with a hostname, which is all {@link openExternalUrl} will open.
 *
 * https only: the links this opens are ours and are all https, and permitting `http:` would buy
 * nothing except a scheme that can be intercepted.
 */
export function isPublicHttpsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname !== "";
}

/* -------------------------------------------------------------------------------------------- */
/* VRChat's own scheme                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * The `vrchat://` deep link for an instance, or null if the location is not one.
 *
 * **`attach=1` is why this is worth having.** Without it the handler starts a *second* client, and
 * two clients on one account fight over it — which is why the UI has always preferred a self-invite
 * whenever a client was already running. With it, the running client brings the instance page up
 * instead, and the user presses join. That makes the deep link safe in the case it was previously
 * wrong in, so it is the default everywhere.
 *
 * The location is validated rather than interpolated: `wrld_…:12345~region(eu)` and nothing else.
 * This string reaches a shell-less spawn as one argument, but it also reaches the *operating
 * system's* protocol handler, which is somebody else's parser, and handing that a caller-chosen
 * string is how a URL becomes an argument injection.
 */
export function vrchatLaunchUrl(location: string, attach = true): string | null {
  const colon = location.indexOf(":");
  if (colon <= 0 || colon === location.length - 1) return null;
  const worldId = location.slice(0, colon);
  const instanceId = location.slice(colon + 1);
  // `wrld_` plus a UUID, and an instance id whose tags VRChat writes with `~()-_` and letters. A
  // location with anything else in it did not come from VRChat.
  if (!/^wrld_[0-9a-fA-F-]{36}$/.test(worldId)) return null;
  if (!/^[0-9A-Za-z~()._-]+$/.test(instanceId)) return null;
  return `vrchat://launch?ref=vrc.zip&id=${encodeURIComponent(location)}${attach ? "&attach=1" : ""}`;
}

/**
 * Opens an instance in the VRChat client on this machine.
 *
 * The third opener rather than a flag on either of the others, and the reason is the same one that
 * split those two: `openUrl` carries a session token and its loopback check is a security guard,
 * `openExternalUrl` takes hard-coded https links. This one takes a *location* — never a URL — and
 * builds the link itself, so there is no caller-chosen string reaching the protocol handler.
 *
 * Best-effort like the others: a machine with no VRChat installed, or a Linux box with no handler
 * registered for the scheme, are both normal, and neither is a reason to fail a graph run. The
 * boolean says the opener was launched, never that VRChat did anything with it.
 */
export async function openVrchatLaunch(
  location: string,
  attach = true,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const url = vrchatLaunchUrl(location, attach);
  if (url === null) return false;

  const argv = openerArgv(url, platform);
  if (argv === null) return false;

  try {
    const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
