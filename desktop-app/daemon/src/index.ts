import { APP_NAME, APP_VERSION } from "@vrcz/shared";
import { startDaemon } from "./app.ts";
import { needsFirstRun } from "./settings.ts";

/**
 * Daemon entry point.
 *
 * Binds `127.0.0.1` only, prints the launch URL, and shuts down cleanly on a signal. The clean
 * shutdown matters more than usual here: it flushes queued feed rows and closes the SQLite handle,
 * and it deliberately does **not** log accounts out, so the next start resumes from cookies instead
 * of minting a fresh session against an undisclosed cap.
 */

async function main(): Promise<void> {
  console.log(`${APP_NAME} ${APP_VERSION} — starting (UNOFFICIAL, not affiliated with VRChat)`);

  const daemon = await startDaemon();

  console.log(`  UI       ${daemon.servers.urls.uiUrl}`);
  console.log(`  proxy    ${daemon.servers.urls.proxyUrl}  (VRChat API mirror)`);
  console.log(`  control  ${daemon.servers.urls.controlUrl}`);
  console.log("");
  console.log(`  Open: ${daemon.launchUrl}`);

  if (needsFirstRun(daemon.settings)) {
    console.log("");
    console.log("  First run: set a contact address in settings before signing in.");
    console.log("  VRChat requires it in the User-Agent, and a placeholder is worse than none.");
  }

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
