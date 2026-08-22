/**
 * `vrc.zip dev <dir>` — install a plugin folder into a running daemon, and reinstall it on change.
 *
 * ## It talks to a running daemon rather than starting one
 *
 * The alternative — a dev mode that boots its own daemon — would mean an author testing against a
 * vrc.zip with none of their accounts, none of their friends and none of their game logs, which is
 * to say against nothing their plugin is for. So this reads `state.json` for the control URL and the
 * session token, exactly as the UI does, and drives the ordinary install route.
 *
 * ## Polling, not `fs.watch`
 *
 * The same invariant as the log watcher, and for a related reason: `fs.watch` on Windows is
 * unreliable for files another process holds open, and an editor writing a file is exactly that.
 * A poll over mtimes is boring, portable, and cannot miss a change it can see — the cost is up to
 * one interval of latency on a save, which is not a cost anyone notices at 400ms.
 *
 * ## The first install asks; later ones do not
 *
 * The grant is keyed by `(plugin, version, grantHash)`, so a save that changes only code produces
 * the same hash and reuses the answer already given. A save that changes what the plugin *asks for*
 * changes the hash and asks again — which is the behaviour an author wants and the one a user needs.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readStateFile } from "../security/state-file.ts";

/** How often to look. Fast enough to feel immediate, slow enough to be free. */
const POLL_MS = 400;

/** Directories that are never a plugin's source, and are expensive to walk. */
const SKIP = new Set(["node_modules", ".git", "dist", ".vrcz"]);

/**
 * A fingerprint of every file under `root`: path, size and mtime.
 *
 * Size *and* mtime because a save that keeps the same length is common (a one-character edit) and a
 * save that keeps the same mtime is possible on a coarse filesystem clock. Neither alone is enough;
 * together they miss nothing an editor does.
 */
function fingerprint(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        const stat = statSync(full);
        parts.push(`${full}:${String(stat.size)}:${String(stat.mtimeMs)}`);
      } catch {
        // Raced with the editor's own write. The next poll sees it.
      }
    }
  };
  walk(root);
  return parts.sort().join("|");
}

export interface DevOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam. Defaults to the real thing. */
  readonly fetchImpl?: typeof fetch;
  /** Stops after this many installs. Tests pass a number; the CLI does not. */
  readonly maxInstalls?: number;
  readonly log?: (message: string) => void;
}

async function install(
  controlUrl: string,
  token: string,
  dir: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; message: string }> {
  let response: Response;
  try {
    response = await fetchImpl(`${controlUrl}/api/plugins`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
  } catch (error) {
    return { ok: false, message: `could not reach vrc.zip: ${String(error)}` };
  }

  const body = (await response.json().catch(() => null)) as {
    name?: string;
    version?: string;
    state?: string;
    message?: string;
    error?: string;
  } | null;

  if (!response.ok) {
    // The daemon's sentences are written to be read — a manifest issue, a compile diagnostic with a
    // line and column, a deny-scan finding naming the construct. Printed unchanged.
    return {
      ok: false,
      message: body?.message ?? body?.error ?? `install failed (${String(response.status)})`,
    };
  }
  return {
    ok: true,
    message: `installed ${body?.name ?? "plugin"} ${body?.version ?? ""} (${body?.state ?? "?"})`,
  };
}

/**
 * Runs the dev loop. Resolves when `maxInstalls` is reached; otherwise runs until killed.
 */
export async function runDev(dir: string, options: DevOptions = {}): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(message));
  const fetchImpl = options.fetchImpl ?? fetch;
  const root = resolve(dir);

  const state = await readStateFile(options.env);
  if (state === null) {
    log("vrc.zip does not appear to be running. Start it first — dev installs into a live daemon,");
    log("so that your plugin sees your accounts and your game logs rather than an empty one.");
    return 1;
  }

  log(`watching ${root}`);
  log(`installing into ${state.controlUrl}`);
  log("");
  log("The first install waits for you to approve it on the Plugins screen.");
  log("");

  let last = "";
  let installs = 0;

  for (;;) {
    const current = fingerprint(root);
    if (current !== last) {
      last = current;
      const result = await install(state.controlUrl, state.sessionToken, root, fetchImpl);
      installs += 1;
      log(result.ok ? `  ✓ ${result.message}` : `  ✗ ${result.message}`);
      if (options.maxInstalls !== undefined && installs >= options.maxInstalls) return 0;
    }
    await Bun.sleep(POLL_MS);
  }
}
