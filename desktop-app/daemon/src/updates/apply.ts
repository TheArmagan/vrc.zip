/**
 * Downloading a release and putting it where the running executable is.
 *
 * ## The rename trick, and why there is no way around it
 *
 * Windows will not let a running image be overwritten. It *will* let one be renamed, which is the
 * whole basis of every self-updater on the platform: move the file you are executing out of the
 * way, write the new one into the name it just vacated, start that, and go away. The process keeps
 * running out of the renamed file until it exits, and the file it left behind is deleted by the
 * next start rather than by the process that is still using it.
 *
 * So the order below is not a preference:
 *
 *  1. Download beside the target, never into `%TEMP%`. A rename across volumes is a copy, and a
 *     copy is a thing that can half-happen; a rename within one directory either did or did not.
 *  2. Check what arrived before touching anything that works.
 *  3. Rename the running executable to `<name>.old-<pid>`.
 *  4. Rename the download into its place. If that fails, put the original back — a failed update
 *     that leaves no vrc.zip on disk is the one outcome worth writing rollback code for.
 *  5. Start the new file, and let the caller decide when to stop.
 *
 * ## What this does not do
 *
 * It does not verify a signature, because there is nothing to verify against: the release workflow
 * publishes an unsigned executable, and a checksum fetched from the same host as the file it
 * describes proves only that GitHub served two consistent things. The trust here is TLS to
 * `github.com` and the fact that the URL came out of that repository's own release list. Saying so
 * plainly is better than a hash that reads like a guarantee and is not one.
 */

import { readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { noteInstalledVersion, startExecutable } from "../os/install.ts";
import type { FetchLike, ReleaseAsset } from "./releases.ts";
import { updateUserAgent } from "./releases.ts";

/**
 * A download that came back this much smaller than the release said it was is a redirect page, an
 * error document or a truncated body, not an executable. The packaged binary is tens of megabytes,
 * so any sane floor catches all three.
 */
const MIN_PLAUSIBLE_BYTES = 1_000_000;

/** `vrc.zip.exe.old-1234` and `vrc.zip.exe.new-1234`: the two names this file ever creates. */
function sidecar(execPath: string, kind: "old" | "new", pid: number): string {
  return `${execPath}.${kind}-${String(pid)}`;
}

/** Matches any sidecar, whichever process left it. Anchored, so it can only match our own leavings. */
const SIDECAR_PATTERN = /\.exe\.(old|new)-\d+$/i;

/**
 * Deletes the files a previous update left behind, best effort.
 *
 * Called on startup rather than at the end of an update, because the file that most needs deleting
 * is the image the updating process was executing from — which it cannot delete while it is still
 * the one executing it. The successor can, and by the time it runs the predecessor is gone.
 *
 * Every failure is ignored, including "still in use". A leftover 80MB file is untidy; a start that
 * failed because it could not tidy up is broken.
 */
export async function sweepSidecars(execPath: string = process.execPath): Promise<number> {
  const directory = dirname(execPath);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!SIDECAR_PATTERN.test(entry)) continue;
    try {
      await unlink(join(directory, entry));
      removed += 1;
    } catch {
      // Usually the predecessor is still exiting. The next start gets it.
    }
  }
  return removed;
}

export interface ApplyResult {
  readonly ok: boolean;
  /** Where the new executable now is, which is where the old one was. Null when nothing changed. */
  readonly path: string | null;
  /** Why not, in a sentence fit to show a user. Null on success. */
  readonly reason: string | null;
}

/**
 * Downloads the asset and swaps it in for the running executable.
 *
 * Nothing is started and nothing exits — this only puts the file in place, so the caller can shut a
 * daemon down tidily before handing over. Splitting those is what makes an update able to flush
 * SQLite on the way out, which the kill-and-replace path on startup cannot.
 */
export async function applyUpdate(
  asset: ReleaseAsset,
  version: string,
  execPath: string = process.execPath,
  fetchImpl: FetchLike = fetch,
): Promise<ApplyResult> {
  const download = sidecar(execPath, "new", process.pid);
  const retired = sidecar(execPath, "old", process.pid);

  let response: Response;
  try {
    response = await fetchImpl(asset.url, {
      headers: { accept: "application/octet-stream", "user-agent": updateUserAgent() },
      redirect: "follow",
    });
  } catch {
    return { ok: false, path: null, reason: "Could not reach GitHub to download the update." };
  }
  if (!response.ok) {
    return {
      ok: false,
      path: null,
      reason: `GitHub answered ${String(response.status)} when asked for ${asset.name}.`,
    };
  }

  let written = 0;
  try {
    // Streamed by `Bun.write`, which takes the `Response` itself: an 80MB executable read into a
    // string first is 80MB of memory for no reason, in a daemon whose whole pitch is 50-80MB idle.
    written = await Bun.write(download, response);
  } catch {
    await unlink(download).catch(() => undefined);
    return {
      ok: false,
      path: null,
      reason: `Could not write the download to ${dirname(execPath)}.`,
    };
  }

  // Both floors, and they catch different things: the absolute one catches an error page served
  // with a 200, the relative one catches a body that stopped early.
  const short = asset.size > 0 && written < asset.size;
  if (written < MIN_PLAUSIBLE_BYTES || short) {
    await unlink(download).catch(() => undefined);
    return {
      ok: false,
      path: null,
      reason: "The download did not arrive in one piece. Nothing was changed.",
    };
  }

  try {
    await rename(execPath, retired);
  } catch {
    await unlink(download).catch(() => undefined);
    return {
      ok: false,
      path: null,
      reason: `Could not move ${basename(execPath)} aside to replace it.`,
    };
  }

  try {
    await rename(download, execPath);
  } catch {
    // The rollback. Without it there is no vrc.zip at the path every shortcut, the autostart entry
    // and the Installed apps entry point at, and the user's next double-click does nothing at all.
    await rename(retired, execPath).catch(() => undefined);
    await unlink(download).catch(() => undefined);
    return {
      ok: false,
      path: null,
      reason: `Could not put the new ${basename(execPath)} in place.`,
    };
  }

  // Only when the file that was just replaced is the installed one, which `noteInstalledVersion`
  // decides for itself. Settings would otherwise keep showing the version that is no longer there,
  // and `installedVersion()` would read that number back and act on it.
  noteInstalledVersion(version);

  return { ok: true, path: execPath, reason: null };
}

/**
 * Starts the executable at `execPath` and hands this run's arguments to it.
 *
 * The arguments carry over for the reason they do everywhere else in this app: the run being
 * replaced is the run the user asked for, and an update that turned `--hidden` into a window on
 * screen has broken something even though it updated successfully.
 */
export function restartInto(
  execPath: string = process.execPath,
  args: readonly string[] = [],
): boolean {
  return startExecutable(execPath, args, dirname(execPath));
}
