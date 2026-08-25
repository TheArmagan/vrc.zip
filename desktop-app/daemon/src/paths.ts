import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

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

/**
 * Rewrites a path into the host's own spelling: absolute, `.` and `..` collapsed, no trailing
 * separator, and the platform's separator throughout — `\` on Windows, `/` everywhere else.
 *
 * Every path that leaves the daemon goes through this. Paths reach us in whatever shape their
 * source produced: a user pastes `C:/Users/you/AppData/LocalLow/VRChat/VRChat` into settings, an
 * argv-derived `process.execPath` can arrive with forward slashes, and `settings.json` keeps
 * whatever was written into it a version ago. `join()` and `resolve()` fix the separators of the
 * segments they are *given* but not of the string handed in, so a mixed root survives all the way
 * to `sessions.log_path`, to the settings list, and to the console, where it reads as a bug even
 * though every file it names opens fine.
 *
 * Empty in, empty out — an unset override or a blank input is not a path, and resolving it would
 * silently return the working directory instead. Relative input resolves against the working
 * directory, which is what a user typing one into settings means by it.
 */
export function nativePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  return resolve(trimmed);
}

/** A drive letter or a UNC prefix — the two ways a string announces itself as a Windows path. */
const WINDOWS_ROOTED = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/;

/**
 * Tidies a path that came out of VRChat's own log, without pretending it is a path on this host.
 *
 * Separate from {@link nativePath}, and the difference is the whole point. `nativePath` resolves
 * against the working directory, which is right for a path a user typed at us and wrong for one
 * the game wrote: on Linux, VRChat runs in a Proton bottle and logs
 * `C:\Users\you\Pictures\VRChat\2026-08\VRChat_1920x1080_….png`, a path inside the bottle. Resolving
 * that would produce `/home/you/vrc.zip/C:\Users\you\…`, which is not a file anywhere.
 *
 * So the flavour is chosen by the string, not by the host: a Windows-rooted path is normalised as
 * Windows (every separator becomes `\`, `.` and `..` collapse), anything else as POSIX. On Windows
 * that lands on the host's own spelling, which is the case that matters — VRChat writes
 * `C:\Users\…` with backslashes but `[VRC Camera] Took screenshot to:` has been seen with mixed
 * separators, and that string is what the screenshot feed row shows and what the "When I take a
 * screenshot" graph node hands to whatever moves or posts the file.
 */
export function gamePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  // Never resolved, only normalised: resolving would give a rootless string the daemon's own drive
  // or working directory, which is an invented answer rather than a tidied one.
  const windows = WINDOWS_ROOTED.test(trimmed) || process.platform === "win32";
  return windows ? win32.normalize(trimmed) : posix.normalize(trimmed);
}

/**
 * The running executable, in the host's own path spelling.
 *
 * Use this rather than `process.execPath` directly wherever the value is shown to someone, written
 * to the registry, or compared against a path we composed ourselves. `process.execPath` is derived
 * from how the process was launched, so a shell that spells the path with forward slashes hands
 * one straight through — and this is the string the installer copies from, the updater renames, and
 * the console prints back at the user.
 */
export function executablePath(): string {
  return nativePath(process.execPath);
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OVERRIDE_ENV];
  // Normalised like every other path we hand out: the override is typed by a human into `.env`, and
  // the whole state tree hangs off it, so a forward slash here would spread to every path derived
  // from it.
  if (override) return nativePath(override);

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
