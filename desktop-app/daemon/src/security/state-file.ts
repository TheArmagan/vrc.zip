import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stateFilePath } from "../paths.ts";

/**
 * `state.json` — how anything outside this process finds the running daemon. See PLAN.md §1.8.
 *
 * It holds the three bound URLs and the UI session token, which makes it a credential file: mode
 * `0600`, and never anywhere but the state directory.
 *
 * Written atomically (temp file in the same directory, then `rename`) so that a CLI reading it
 * while the daemon starts sees either the previous run's file or this one's, never half of either.
 * The explicit `chmod` after the write is not redundant: `writeFile`'s `mode` applies only when the
 * file is created, so a leftover temp file from a crashed run would otherwise keep its old, laxer
 * permissions.
 */

export interface DaemonState {
  /** Where the browser goes. Carries `?token=` when the daemon opens it. */
  uiUrl: string;
  /** The VRChat API mirror. Phase 2. */
  proxyUrl: string;
  /** The control API the UI and CLI talk to. */
  controlUrl: string;
  /** The UI session token for this run. See `session-token.ts`. */
  sessionToken: string;
  pid: number;
  /** Unix milliseconds, integer. */
  startedAt: number;
}

const FILE_MODE = 0o600;

export async function writeStateFile(state: DaemonState, env?: NodeJS.ProcessEnv): Promise<string> {
  const path = stateFilePath(env);
  await mkdir(dirname(path), { recursive: true });

  const tmp = `${path}.${process.pid}.tmp`;
  const body = `${JSON.stringify(state, null, 2)}\n`;
  try {
    await writeFile(tmp, body, { mode: FILE_MODE, encoding: "utf8" });
    // No-op on win32, where the POSIX bits are not honoured; harmless there and load-bearing
    // everywhere else.
    await chmod(tmp, FILE_MODE).catch(() => {});
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  await chmod(path, FILE_MODE).catch(() => {});
  return path;
}

/** Reads `state.json`, or `null` when no daemon has written one. */
export async function readStateFile(env?: NodeJS.ProcessEnv): Promise<DaemonState | null> {
  const path = stateFilePath(env);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return isDaemonState(parsed) ? parsed : null;
}

/** Removes `state.json` on a clean shutdown. Missing is success. */
export async function removeStateFile(env?: NodeJS.ProcessEnv): Promise<void> {
  await unlink(stateFilePath(env)).catch(() => {});
}

function isDaemonState(value: unknown): value is DaemonState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.uiUrl === "string" &&
    typeof v.proxyUrl === "string" &&
    typeof v.controlUrl === "string" &&
    typeof v.sessionToken === "string" &&
    typeof v.pid === "number" &&
    typeof v.startedAt === "number"
  );
}
