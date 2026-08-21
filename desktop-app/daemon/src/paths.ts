import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the daemon keeps its state. See PLAN.md §1.2.
 *
 * Everything is derived from one function so that tests can redirect the whole tree with a single
 * environment override, and so there is exactly one place to look when a platform gets a new path.
 */

/**
 * Overrides the state directory entirely. Set by tests, and available to users who want their state
 * somewhere other than the platform default.
 */
const OVERRIDE_ENV = "VRCZIP_STATE_DIR";

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OVERRIDE_ENV];
  if (override) return override;

  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) return join(localAppData, "vrc.zip");
    // LOCALAPPDATA is set on every supported Windows install; if it somehow isn't, derive it rather
    // than writing state next to the executable.
    return join(homedir(), "AppData", "Local", "vrc.zip");
  }

  if (process.platform === "darwin") {
    // Not a supported platform in v1 — present so the daemon writes somewhere sane rather than
    // falling into the Linux branch and littering ~/.local/state on a Mac.
    return join(homedir(), "Library", "Application Support", "vrc.zip");
  }

  const xdgState = env.XDG_STATE_HOME;
  if (xdgState) return join(xdgState, "vrc.zip");
  return join(homedir(), ".local", "state", "vrc.zip");
}

/**
 * Creates the state directory if it is not there.
 *
 * Must run before anything opens a file under it. `bun:sqlite`'s `create: true` creates the
 * *database*, not the directory holding it, so a genuinely fresh machine gets `SQLITE_CANTOPEN` and
 * the daemon dies before it can show anyone why. Synchronous because every caller needs it done
 * before its next line, and it happens exactly once at boot.
 */
export function ensureStateDir(env?: NodeJS.ProcessEnv): string {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The encrypted credential store. */
export function secretsPath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "secrets.enc");
}

/** The master key, only when no OS keychain is available. See `security/keychain.ts`. */
export function fallbackKeyPath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "master.key");
}

/** The single SQLite database. One schema, `account_id` as a column. */
export function databasePath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "vrczip.sqlite");
}

/** Written at startup with the bound URLs and the UI session token. Tight permissions. */
export function stateFilePath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "state.json");
}

/** User settings, in the clear — nothing secret goes here. */
export function settingsPath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "settings.json");
}
