import { APP_NAME, APP_VERSION } from "@vrcz/shared";

/**
 * Daemon bootstrap. Phase 1.8 replaces this body with port binding, the three Hono apps, and the
 * `state.json` write; until then it exists so the workspace has a runnable entry point.
 */
function main(): void {
  console.log(`${APP_NAME} ${APP_VERSION} — daemon not implemented yet (Phase 1.8).`);
}

main();
