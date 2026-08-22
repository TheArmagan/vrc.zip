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

/**
 * The forward proxy's TLS material: the local CA and the leaf it signs. See `forward-proxy/ca.ts`.
 *
 * Its own directory rather than loose files in the state root, because `ca.key` is the single most
 * dangerous file vrc.zip writes — anyone holding it can impersonate any site the user trusts — and
 * keeping it beside its siblings makes "what do I delete to revoke this" a one-line answer.
 */
export function tlsDir(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "tls");
}

/** User settings, in the clear — nothing secret goes here. */
export function settingsPath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "settings.json");
}

/**
 * Where installed plugins live: `plugins/<id>/`.
 *
 * Content-addressed inside — `plugins/<id>/<sha256>.js` — so the artifact that actually runs is
 * named by its own hash and is verified on every load (PLAN.md §"Install-time compilation"). Two
 * consequences worth stating: an update leaves the old artifact on disk under its own name until
 * something prunes it, which is what makes a rollback a rename rather than a rebuild; and a
 * tampered file cannot be loaded under the name it was installed as, because the name *is* the
 * hash.
 */
export function pluginsDir(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "plugins");
}

/** One plugin's installed artifacts. `id` has already been validated by the manifest schema. */
export function pluginDir(id: string, env?: NodeJS.ProcessEnv): string {
  return join(pluginsDir(env), id);
}

/**
 * One plugin's own data directory, holding its own SQLite file and nothing of ours.
 *
 * Separate from {@link pluginDir} rather than a subdirectory of it, and that separation is the
 * point: uninstall is `rm -rf` on the code, and *keeping* the data across an uninstall-reinstall is
 * then a decision someone makes rather than an accident of layout. It is also what lets the quota
 * be a `stat` on one directory (PLAN.md §"Manifest, lifecycle, storage").
 */
export function pluginDataDir(id: string, env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "plugin-data", id);
}

/** One plugin's SQLite file. Its own database — a plugin cannot lock or corrupt the daemon's WAL. */
export function pluginDatabasePath(id: string, env?: NodeJS.ProcessEnv): string {
  return join(pluginDataDir(id, env), "plugin.sqlite");
}
