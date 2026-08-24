/**
 * "Is there a newer vrc.zip", asked four times a day and answered in one place.
 *
 * One object owns the whole question: the timer, the last answer, whether a check or an install is
 * in flight, and the install itself. The alternative — a poller here, a status field there, a route
 * that does its own fetch — is three things that can disagree about which version is newest, and
 * the banner in the UI would be reading one of them while the console had logged another.
 *
 * ## Six hours
 *
 * Long enough that GitHub's unauthenticated allowance (60 requests an hour, per IP) is never in
 * sight; short enough that somebody who leaves vrc.zip running for a week is told about a release
 * within a working day of it landing. The first check runs shortly after start rather than during
 * it, so a slow or absent network cannot hold up a daemon that has nothing to do with the network
 * to start with.
 *
 * ## What it never does
 *
 * It never installs on its own. Finding an update is passive — a line in the console and a bar at
 * the top of the UI — and the swap happens when somebody presses the button, because it ends with
 * the app restarting under them. That is the difference between this and the update-on-run path in
 * `index.ts`: there, the user *ran* the new version, which is as clear a request as pressing a
 * button. Here they ran the old one and are being told something.
 */

import { APP_VERSION } from "@vrcz/shared";
import { applyUpdate } from "./apply.ts";
import { type FetchLike, fetchReleases, newestRelease, type ReleaseInfo } from "./releases.ts";

/** Four checks a day. See the note above on why this number and not a shorter one. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Not during startup, and not so late that a short run never checks at all. */
const FIRST_CHECK_DELAY_MS = 20_000;

/** What the UI banner, the console line and `GET /api/update` all read. */
export interface UpdateStatus {
  /** The version that is running. */
  readonly current: string;
  /** The newest release found, or null when none is newer than {@link current}. */
  readonly latest: string | null;
  readonly available: boolean;
  /** The release page, so "what changed" has somewhere to go. */
  readonly url: string | null;
  /**
   * Whether the update button can do anything.
   *
   * False on a build that cannot replace itself — running from source, or a platform whose packaged
   * executable this release does not carry — and the banner then says "download it" instead of
   * offering to do it. An enabled button that cannot work is worse than an absent one.
   */
  readonly canInstall: boolean;
  readonly checkedAt: number | null;
  readonly checking: boolean;
  readonly installing: boolean;
  /** The last check's failure, in a sentence fit to show a user. Null when the last check worked. */
  readonly error: string | null;
}

export interface UpdateInstallResult {
  readonly ok: boolean;
  /** True when the swap is done and the app is about to restart into the new build. */
  readonly restarting: boolean;
  readonly reason: string | null;
}

export interface UpdateCheckerOptions {
  /**
   * Whether this build can replace itself: a packaged executable on a platform the release carries.
   * Everything still checks and reports on an unsupported build — knowing an update exists is
   * useful even where the button cannot be offered.
   */
  readonly canInstall: boolean;
  /** Announced once, the first time a given version is seen. Wired to the console in `app.ts`. */
  readonly onAvailable?: (release: ReleaseInfo) => void;
  readonly intervalMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

export interface UpdateChecker {
  status(): UpdateStatus;
  /** Checks now. Never rejects: a failure lands in `status().error`. */
  check(): Promise<UpdateStatus>;
  /**
   * Downloads the release and swaps it in, then asks {@link onRestart} to hand over.
   *
   * The two halves are separate because only the caller knows how to stop a daemon tidily, and an
   * update that skipped the flush would cost the user whatever was queued for the feed.
   */
  install(): Promise<UpdateInstallResult>;
  start(): void;
  stop(): void;
  /**
   * Called once the new executable is in place. Whoever sets it owns the shutdown and the handover.
   * Set by `index.ts`, which is the only place that has both `daemon.stop()` and the argv.
   */
  onRestart: (() => void | Promise<void>) | null;
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const interval = options.intervalMs ?? CHECK_INTERVAL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let release: ReleaseInfo | null = null;
  let checkedAt: number | null = null;
  let checking = false;
  let installing = false;
  let error: string | null = null;
  /** The version already announced, so a six-hourly timer does not say the same thing four times a day. */
  let announced: string | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let repeat: ReturnType<typeof setInterval> | null = null;

  const status = (): UpdateStatus => ({
    current: APP_VERSION,
    latest: release?.version ?? null,
    available: release !== null,
    url: release?.url ?? null,
    // Both halves: this build has to be able to replace itself, *and* the release has to carry an
    // executable to replace it with. A release published without its asset is not installable.
    canInstall: options.canInstall && (release?.asset ?? null) !== null,
    checkedAt,
    checking,
    installing,
    error,
  });

  const check = async (): Promise<UpdateStatus> => {
    if (checking) return status();
    checking = true;
    try {
      const releases = await fetchReleases(fetchImpl);
      release = newestRelease(releases);
      error = null;
      checkedAt = now();
      if (release !== null && release.version !== announced) {
        announced = release.version;
        options.onAvailable?.(release);
      }
    } catch (failure) {
      // The message is written for a person by `releases.ts`; anything else is a bug leaking out,
      // and `String(failure)` is still better than a silent check that never explains itself.
      error = failure instanceof Error ? failure.message : String(failure);
      checkedAt = now();
    } finally {
      checking = false;
    }
    return status();
  };

  const checker: UpdateChecker = {
    status,
    check,

    async install(): Promise<UpdateInstallResult> {
      if (installing) {
        return { ok: false, restarting: false, reason: "An update is already being installed." };
      }
      const asset = release?.asset ?? null;
      if (release === null || asset === null || !options.canInstall) {
        return {
          ok: false,
          restarting: false,
          reason: "There is no update this copy of vrc.zip can install itself.",
        };
      }

      installing = true;
      const applied = await applyUpdate(asset, release.version, process.execPath, fetchImpl);
      if (!applied.ok) {
        // Cleared only on the failure path. A swap that worked leaves this set for the seconds
        // between the reply and the restart, so a second press cannot start a download into a
        // process that is on its way out.
        installing = false;
        return { ok: false, restarting: false, reason: applied.reason };
      }

      /*
       * The handover, deliberately after this call returns.
       *
       * The response has to reach the browser before the daemon it came from stops answering, and
       * a shutdown started inline would race the socket it is replying on. A macrotask is enough:
       * Bun has flushed the response by the time the timer fires.
       */
      setTimeout(() => {
        void checker.onRestart?.();
      }, 250);

      return { ok: true, restarting: true, reason: null };
    },

    start(): void {
      if (first !== null || repeat !== null) return;
      first = setTimeout(() => {
        first = null;
        void check();
      }, FIRST_CHECK_DELAY_MS);
      repeat = setInterval(() => {
        void check();
      }, interval);
    },

    stop(): void {
      if (first !== null) clearTimeout(first);
      if (repeat !== null) clearInterval(repeat);
      first = null;
      repeat = null;
    },

    onRestart: null,
  };

  return checker;
}
