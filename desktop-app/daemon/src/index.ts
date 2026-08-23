import { dirname } from "node:path";
import { APP_NAME, APP_VERSION, REPOSITORY_URL } from "@vrcz/shared";
import { startDaemon } from "./app.ts";
import {
  attention,
  banner,
  forceColour,
  helpText,
  note,
  startupSummary,
  versionText,
} from "./cli/banner.ts";
import {
  applyWindowIcon,
  askConsoleYesNo,
  claimConsole,
  enableAnsiColour,
  onConsoleKey,
  setConsoleTitle,
  setConsoleVisible,
  shouldStartHidden,
} from "./os/console.ts";
import {
  compareVersions,
  installExists,
  installedVersion,
  installLocally,
  installTarget,
  isInstalled,
  updateInstalledCopy,
} from "./os/install.ts";
import { openExternalUrl, openUrl, shouldOpenBrowser } from "./os/open-url.ts";
import {
  createStartupControl,
  repairStartupEntry,
  setStartupEnabled,
  startupLocation,
} from "./os/startup.ts";
import { shouldShowTray, startTray } from "./os/tray.ts";
import { isPackaged } from "./servers/embedded-ui.ts";
import { needsFirstRun, saveSettings } from "./settings.ts";

/**
 * Daemon entry point.
 *
 * Binds `127.0.0.1` only, prints the launch URL, and shuts down cleanly on a signal. The clean
 * shutdown matters more than usual here: it flushes queued feed rows and closes the SQLite handle,
 * and it deliberately does **not** log accounts out, so the next start resumes from cookies instead
 * of minting a fresh session against an undisclosed cap.
 *
 * The packaged build opens the browser for you. Someone who double-clicked `vrc.zip.exe` is not
 * reading a terminal, and a URL with a session token in it is not something to retype — but from
 * source that would fight `bun --watch`, which restarts constantly and would open a tab each time.
 * `--open` and `--no-open` override the default in either direction.
 */

/**
 * The executable's sub-commands.
 *
 * Modes of this binary rather than separate tools (decision 182): an author needs the app before
 * they can run a plugin against it, and a separate CLI would be a third artifact to keep versioned
 * against the protocol major. Anything that is not a known sub-command starts the daemon, so the
 * ordinary double-click path is untouched.
 */
async function runSubcommand(argv: readonly string[]): Promise<number | null> {
  const [command, ...rest] = argv;

  // Answered before the daemon starts, and before anything touches disk: someone asking what this
  // is should not have a state directory created as a side effect of asking.
  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    console.log(helpText());
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v") || command === "version") {
    console.log(versionText());
    return 0;
  }

  /*
   * `--uninstall`, answered here rather than by starting a daemon.
   *
   * This is what the `UninstallString` in Installed apps runs, so Windows invokes it directly and
   * expects a process that does the work and exits. Answered alongside `--help` and `--version`, and
   * for the same reason those are: it must not create a state directory, bind a port or touch the
   * credential store on its way to removing the app.
   */
  if (argv.includes("--uninstall") || command === "uninstall") {
    const { uninstallLocally } = await import("./os/install.ts");
    const result = await uninstallLocally();
    if (result.reason !== null) console.log(result.reason);
    else if (result.path !== null) {
      console.log(`Removed vrc.zip. ${result.path} goes when this process exits.`);
      console.log("Your accounts, settings and feed are untouched in %APPDATA%\vrc.zip.");
    }
    return result.ok ? 0 : 1;
  }

  if (command === "create-plugin") {
    const target = rest.find((arg) => !arg.startsWith("-"));
    if (target === undefined) {
      console.error("usage: vrc.zip create-plugin <folder> [--publisher <name>]");
      return 2;
    }
    const publisherIndex = rest.indexOf("--publisher");
    const publisher = publisherIndex === -1 ? undefined : rest[publisherIndex + 1];
    const { scaffoldPlugin } = await import("./cli/scaffold.ts");
    const result = scaffoldPlugin(target, publisher === undefined ? {} : { publisher });
    console.log(result.message);
    return result.ok ? 0 : 1;
  }

  if (command === "dev") {
    const target = rest.find((arg) => !arg.startsWith("-")) ?? ".";
    const { runDev } = await import("./cli/dev.ts");
    return await runDev(target);
  }

  return null;
}

/**
 * Whether to make the first-run install offer at all.
 *
 * Five conditions, and each one is a way this could otherwise be obnoxious.
 *
 * `--hidden` is the important one: that is the flag the autostart entry passes, so a machine
 * signing in would otherwise stop and wait for a keypress nobody is there to give. The prompt would
 * also be invisible, because that run has just hidden its own console.
 *
 * `installOffered` means the question has been asked once and answered. Declining is an answer, and
 * an offer that comes back every start is nagware — the settings screen keeps the same actions
 * available for whenever somebody changes their mind.
 *
 * The location check is what makes this an offer rather than an advert. A build already sitting in
 * a sensible folder does not need a copy of itself somewhere else, so the only runs that get asked
 * are the ones with a real problem: Downloads, and the temp folder Explorer extracts a zip into.
 */
export function shouldOfferInstall(
  argv: readonly string[],
  alreadyOffered: boolean,
  packaged: boolean = isPackaged(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32" || !packaged) return false;
  if (argv.includes("--hidden")) return false;
  if (alreadyOffered) return false;
  if (isInstalled()) return false;
  // An existing installation is the update offer's business, not this one's. Without this, running
  // a newer build out of Downloads would be told to install a copy of itself over the top of one
  // that is already there, described as a first-time setup. `installExists` rather than the
  // registry alone: an entry left behind by a folder somebody deleted is not an installation.
  if (installExists() && installedVersion() !== null) return false;
  return !startupLocation().ok;
}

/**
 * Whether to offer to update the installed copy with the one that is running.
 *
 * The question this answers is narrow: somebody downloaded a newer vrc.zip, extracted it, and ran
 * it, while an older one sits installed. Nothing about that is automatic — vrc.zip does not update
 * itself, does not phone home, and does not check for releases — so the only moment it can know a
 * newer build exists is the moment one is executing.
 *
 * `isInstalled()` excluding: if this *is* the installed copy, there is nothing to copy over itself.
 * `--hidden` excluding for the same reason the install offer does: that is the autostart flag, and
 * a machine signing in must not stop for a keypress nobody is there to give.
 *
 * `declined` is the version whose offer was already refused, so saying no to 0.2.0 is remembered
 * for 0.2.0 and forgotten the moment 0.3.0 turns up.
 */
export function shouldOfferUpdate(
  argv: readonly string[],
  declined: string,
  running: string = APP_VERSION,
  packaged: boolean = isPackaged(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32" || !packaged) return false;
  if (argv.includes("--hidden")) return false;
  if (isInstalled()) return false;
  if (declined === running) return false;

  if (!installExists()) return false;
  const installed = installedVersion();
  if (installed === null) return false;
  // Strictly newer. Running an older build than the installed one is a normal thing to do on
  // purpose — checking whether a regression is new — and silently offering to downgrade over it is
  // not a favour.
  return compareVersions(running, installed) > 0;
}

/**
 * Records that the offer was made, in the settings object *and* on disk.
 *
 * Mutated in place rather than replaced, and that is load-bearing rather than lazy: `startDaemon`
 * hands the very same object to the control API, which keeps its own reference to it. Writing a new
 * object here would leave that copy still saying `installOffered: false`, and the first settings
 * save from the UI would write that stale `false` back over this — so the offer would come round
 * again on the next start, having been answered.
 */
async function rememberOffered(daemon: Awaited<ReturnType<typeof startDaemon>>): Promise<void> {
  daemon.settings.installOffered = true;
  await saveSettings(daemon.settings);
}

/**
 * Offers to replace the installed copy with the running one.
 *
 * Only the executable and the Installed apps version change. "Start with Windows" and the shortcuts
 * are left exactly as the user left them, which is `updateInstalledCopy`'s whole reason for existing
 * separately from `installLocally`: an update that silently re-enabled autostart, or put back a
 * desktop shortcut somebody deleted, would be undoing their decisions on the way past.
 *
 * A null answer means there was no console to ask in, and nothing is recorded — the offer has not
 * been made, so it is still owed.
 */
async function offerUpdate(daemon: Awaited<ReturnType<typeof startDaemon>>): Promise<void> {
  const installed = installedVersion();
  console.log("");
  console.log(
    attention(
      `This is vrc.zip ${APP_VERSION}. The installed copy is ${installed ?? "an older version"}.`,
    ),
  );
  console.log(note(`Installed at ${String(installTarget())}`));

  const update = await askConsoleYesNo("Update the installed copy to this version?");
  if (update === null) return;

  if (!update) {
    daemon.settings.updateDeclinedVersion = APP_VERSION;
    await saveSettings(daemon.settings);
    console.log(note("Left it alone. You will be asked again when a newer version turns up."));
    return;
  }

  const result = await updateInstalledCopy();
  if (!result.ok) {
    // Not recorded as declined: they said yes and it failed, so the offer is still owed.
    console.log(attention(result.reason ?? "Could not update the installed copy."));
    return;
  }

  console.log(note(`Updated ${String(result.path)} to ${result.to}.`));
  if (result.reason !== null) console.log(note(result.reason));
  console.log(
    note(
      "Your shortcuts and startup setting are unchanged. This window is still the copy you ran.",
    ),
  );
}

/**
 * Offers to install, and asks the two follow-up questions only if the first is answered yes.
 *
 * The Start menu shortcut is not one of the questions. It is what makes vrc.zip come up when
 * somebody types its name, which is most of what "install it properly" means to the person being
 * asked — offering to skip it would be offering to do the job badly. The desktop shortcut is a
 * matter of taste, so that one is asked.
 *
 * A null answer means there was no console to ask in, and nothing is recorded: the offer has not
 * been made, so it is still owed. Only a real answer sets `installOffered`.
 */
async function offerInstall(daemon: Awaited<ReturnType<typeof startDaemon>>): Promise<void> {
  const target = installTarget();
  console.log("");
  console.log(
    attention(`vrc.zip is running from a folder Windows cleans up: ${dirname(process.execPath)}`),
  );
  console.log(
    note(
      target === null
        ? "Move it somewhere permanent to keep it."
        : `It can copy itself to ${dirname(target)}, add a Start menu entry so you can search for it, and keep working from there.`,
    ),
  );

  const install = await askConsoleYesNo("Install vrc.zip there now?");
  if (install === null) return;

  if (!install) {
    await rememberOffered(daemon);
    console.log(note("Not installing. You can do it later from Settings."));
    return;
  }

  const desktop = (await askConsoleYesNo("Add a desktop shortcut?", false)) ?? false;

  const result = await installLocally({ desktopShortcut: desktop, startMenuShortcut: true });
  if (!result.ok) {
    // Not recorded as offered: the question was answered yes and we failed to act on it, so the
    // user is owed the offer again rather than being told to go find it in settings.
    console.log(attention(result.reason ?? "Could not install vrc.zip."));
    return;
  }

  console.log(note(`Installed to ${String(result.path)}.`));
  if (result.desktopShortcut) console.log(note("Added a desktop shortcut."));
  if (result.startMenuShortcut) {
    console.log(note("Added it to the Start menu, so Windows search can find it."));
  }

  /*
   * The last question, and it is asked *after* the copy rather than before.
   *
   * Before the copy the honest answer would have to be "no, and here is why not" — an autostart
   * from Downloads is exactly what `os/startup.ts` refuses. Afterwards there is somewhere for the
   * entry to point, so the question is a real one.
   */
  const autostart = await askConsoleYesNo("Start vrc.zip when Windows starts?");
  if (autostart === false && result.startWithWindows) {
    // `installLocally` registers it, so declining here is an undo rather than a no-op.
    setStartupEnabled(false);
    console.log(note("Left it out of startup."));
  } else if (autostart === true) {
    if (result.startWithWindows) console.log(note("It will start with Windows."));
    // The reason from the install carries the *specific* refusal, which is worth more than a
    // generic failure line: it is the difference between "could not" and "could not, because".
    else console.log(attention(result.reason ?? "Could not register it to start with Windows."));
  }

  await rememberOffered(daemon);
  console.log(note("Next time, start vrc.zip from the Start menu rather than this copy."));
}

async function main(): Promise<void> {
  /*
   * The console window, before anything is printed into it.
   *
   * `enableAnsiColour` asks an older Windows console to interpret escapes at all — chalk decides
   * whether to *use* them, but on `conhost` without this flag the escapes arrive as visible
   * characters, which reads as a broken program rather than a plain one.
   *
   * The title matters for the double-click case: without it the window is named with the full path
   * to the executable, which is both ugly and a way to put somebody's home directory in a
   * screenshot.
   */
  /*
   * A console of our own, before anything is printed into it.
   *
   * The executable is built GUI-subsystem (`--windows-hide-console`), so Windows gives it no console
   * and the one it would have given belonged to the user's default terminal — Windows Terminal,
   * wearing PowerShell's icon and title. `claimConsole` asks for a `conhost` window instead, which
   * takes its icon from this executable, and reroutes `console.*` into it because Bun's streams were
   * bound before that window existed. It does nothing at all when output already goes somewhere.
   */
  const console_ = claimConsole();
  const colour = enableAnsiColour();
  setConsoleTitle(`${APP_NAME} ${APP_VERSION}`);
  // Asks for the icon at the exact sizes this display's scaling wants, so Windows picks a matching
  // entry out of the directory rather than scaling whichever one it was handed.
  applyWindowIcon();
  /*
   * Colour has to be switched on by hand for a console we allocated.
   *
   * Chalk reads `process.stdout.isTTY`, which is `undefined` here because Bun bound stdout before
   * the window existed — it settles on level 0 and every style becomes a no-op. The window itself
   * handles truecolor perfectly well, which is why this is a correction rather than a workaround.
   */
  if (console_ !== null && colour) forceColour();

  // One copy, read by four flags now: `--open`/`--no-open`, `--tray`/`--no-tray` and `--hidden`.
  const argv = process.argv.slice(2);

  const code = await runSubcommand(argv);
  if (code !== null) {
    process.exit(code);
  }

  console.log(banner());

  const daemon = await startDaemon();

  // Every address in one place, including the forward proxy's — which used to announce itself from
  // inside its own startup path, several lines earlier and in a different format.
  console.log(
    startupSummary({
      uiUrl: daemon.servers.urls.uiUrl,
      proxyUrl: daemon.servers.urls.proxyUrl,
      controlUrl: daemon.servers.urls.controlUrl,
      forwardProxyUrl: daemon.forwardProxy?.url,
      launchUrl: daemon.launchUrl,
    }),
  );

  if (shouldOpenBrowser(argv, isPackaged())) {
    // Best-effort by contract: a machine with no default browser still has a running daemon and a
    // URL on screen, which is a working app, not a failure to report.
    const opened = await openUrl(daemon.launchUrl);
    console.log(note(opened ? "opening it in your browser…" : "open that link to get started"));
  }

  if (needsFirstRun(daemon.settings)) {
    console.log("");
    // Accented, because it is a thing to *do* rather than a thing to know: signing in before it is
    // set fails at VRChat rather than here, which is the least useful place to find out.
    console.log(attention("First run: set a contact address in settings before signing in."));
    console.log(
      note("VRChat requires it in the User-Agent, and a placeholder is worse than none."),
    );
  }

  for (const line of daemon.startupNotes) console.log(note(line));

  /*
   * The first-run install offer.
   *
   * Before the `O`/`F` key listener, and that ordering is not cosmetic: `onConsoleKey` is one reader
   * over one console handle, and two of them running at once would race for the same keypresses.
   * The prompt attaches its own listener and takes it down before this returns.
   *
   * Two offers, and at most one of them is made. Updating comes first because it is the more
   * specific situation: an older copy is already installed and the executable in the user's hand is
   * newer than it, which is a different problem from having no installation at all. `shouldOfferInstall`
   * stands down whenever an installation exists, so these cannot both fire.
   *
   * Everything about when *not* to ask is in the two predicates. The short version: only a packaged
   * build, only when this executable is not itself the installed one, only where there is something
   * worth doing about it, and never on a run that nobody is watching.
   */
  if (shouldOfferUpdate(argv, daemon.settings.updateDeclinedVersion)) {
    await offerUpdate(daemon);
  } else if (shouldOfferInstall(argv, daemon.settings.installOffered)) {
    await offerInstall(daemon);
  }

  /*
   * Keys, for the window nobody can type a URL into.
   *
   * Somebody who double-clicked has a console holding two long `http://127.0.0.1:…` links and no
   * shell to paste them into — and the UI one carries a session token, so retyping it is not an
   * option either. `O` and `F` are what that window is for.
   *
   * Only offered when there is something to read keys from: with output redirected there is no
   * console and no keyboard, and a hint about keys that do nothing is worse than no hint.
   */
  const stopKeys = onConsoleKey((key) => {
    const pressed = key.toLowerCase();
    if (pressed === "o") {
      console.log(note("opening the app…"));
      void openUrl(daemon.launchUrl);
      return;
    }
    if (pressed === "f" && daemon.forwardProxy !== null) {
      console.log(note("opening the forward proxy setup page…"));
      void openUrl(`${daemon.forwardProxy.url}/`);
    }
  });

  if (stopKeys !== null) {
    console.log("");
    console.log(
      note(
        daemon.forwardProxy === null
          ? "Press O to open the app."
          : "Press O to open the app, F for the forward proxy setup page.",
      ),
    );
  }

  // Re-applied after the startup output: Bun sets the console title from the script name on some
  // paths, and whichever of us runs last is what the user reads on the title bar.
  setConsoleTitle(`${APP_NAME} ${APP_VERSION}`);

  /*
   * The notification-area icon.
   *
   * It exists for the same person the `O` and `F` keys exist for: somebody who double-clicked the
   * executable and has one console window standing between them and a running daemon. From the tray
   * they can open the app, put that window away, and get it back — which is what makes hiding it
   * safe to offer at all.
   *
   * `ownsConsole` is the whole reason `claimConsole`'s answer is threaded down here. A daemon that
   * inherited a developer's terminal must not offer to hide it, and the tray builds no Hide item
   * when the window is not ours.
   */
  const startup = createStartupControl(process.platform, isPackaged());

  /*
   * An entry that has drifted is repaired before anything reads it.
   *
   * vrc.zip is a single file people move around, and a `Run` value still naming last month's folder
   * is an autostart that silently does nothing at every sign-in. Only an entry that already exists
   * is touched, so this can never turn the feature on by itself.
   */
  if (startup.supported && repairStartupEntry()) {
    console.log(note("repaired the Windows startup entry, which pointed at an old location"));
  }

  const tray = shouldShowTray(argv)
    ? startTray({
        title: `${APP_NAME} ${APP_VERSION}`,
        launchUrl: daemon.launchUrl,
        githubUrl: REPOSITORY_URL,
        ownsConsole: console_ !== null,
        startup: startup.supported ? startup : null,
        open: (url) => {
          void openUrl(url);
        },
        // A second opener, not the same one: `openUrl` refuses anything off loopback because the URL
        // it is normally handed carries a session token, and "Open on GitHub" going through it is a
        // menu item that quietly does nothing.
        openExternal: (url) => {
          void openExternalUrl(url);
        },
        // Routed through the same shutdown path a signal takes, rather than `process.exit`: the exit
        // has to flush queued feed rows and close SQLite, and "quit from the tray" is not a reason
        // to skip that.
        onExit: () => {
          shutdown("tray exit");
        },
      })
    : null;

  /*
   * `--hidden`, last, once there is an icon to get the window back from.
   *
   * The order is the safety property rather than tidiness: `shouldStartHidden` refuses the flag
   * outright when the tray did not start, and the refusal is said out loud while there is still a
   * console to say it in. This is the flag the startup entry passes, so the failure mode it guards
   * against is a machine that boots into a vrc.zip with no window, no icon and no way back.
   */
  if (argv.includes("--hidden") && tray === null) {
    console.log(
      note("--hidden needs the tray icon to put the window back, and there is none. Ignoring it."),
    );
  } else if (shouldStartHidden(argv, tray !== null)) {
    setConsoleVisible(false);
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    // A second Ctrl-C during shutdown should not start a second one; the flush is not reentrant.
    if (stopping) return;
    stopping = true;

    stopKeys?.();
    tray?.stop();
    console.log(`\n${APP_NAME}: ${signal} received, shutting down...`);
    daemon
      .stop()
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error("shutdown failed:", error);
        process.exit(1);
      });
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

await main();
