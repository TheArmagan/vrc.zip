import { APP_NAME, APP_VERSION } from "@vrcz/shared";
import { attention, banner, helpText, note, startupSummary, versionText } from "./cli/banner.ts";
import { enableAnsiColour, setConsoleTitle } from "./os/console.ts";
import { startDaemon } from "./app.ts";
import { openUrl, shouldOpenBrowser } from "./os/open-url.ts";
import { isPackaged } from "./servers/embedded-ui.ts";
import { needsFirstRun } from "./settings.ts";

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
  enableAnsiColour();
  setConsoleTitle(`${APP_NAME} ${APP_VERSION}`);

  const code = await runSubcommand(process.argv.slice(2));
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

  if (shouldOpenBrowser(process.argv.slice(2), isPackaged())) {
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
    console.log(note("VRChat requires it in the User-Agent, and a placeholder is worse than none."));
  }

  for (const line of daemon.startupNotes) console.log(note(line));

  let stopping = false;
  const shutdown = (signal: string): void => {
    // A second Ctrl-C during shutdown should not start a second one; the flush is not reentrant.
    if (stopping) return;
    stopping = true;

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
