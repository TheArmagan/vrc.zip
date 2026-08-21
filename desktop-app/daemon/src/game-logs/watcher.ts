/**
 * The log watcher: discovery + tailing + sessions, tied together.
 *
 * Every live log file is tailed concurrently, one offset and one poll slot each, with dormant files
 * backing off to a slow poll so cost stays flat as historical logs pile up.
 *
 * It emits exclusively through an injected `LogSink`. It does not import the store, a database, or
 * the event bus — that decoupling is the design, not a workaround: the watcher is a pure
 * file-to-events transform, which is also what makes it testable against tmp files.
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { listLogFiles } from "./discovery.ts";
import { parseLine } from "./parser.ts";
import type { ExitKind, LogSink, SessionSnapshot } from "./sessions.ts";
import { SessionTracker } from "./sessions.ts";
import {
  FileTail,
  nextPollDelay,
  type PollScheduleOptions,
  type ResolvedPollSchedule,
  resolvePollSchedule,
} from "./tail.ts";

export interface LogWatcherOptions extends PollScheduleOptions {
  /** Directories to watch, from `discoverLogDirectories()` or a settings override. */
  directories: readonly string[];
  sink: LogSink;
  /** How often the directories are re-scanned for new log files. */
  scanIntervalMs?: number;
  /**
   * A live session whose file has not grown for this long, with no quit marker, is declared
   * crashed. Only the log can make this distinction, and it is what drives auto-rejoin.
   */
  staleAfterMs?: number;
  /**
   * Read pre-existing files from the top (backfill) rather than from their current end. Default
   * true: a file's account is only knowable from its `User Authenticated:` line, which sits near
   * the top, so starting at EOF would leave every already-running client permanently unattributed.
   */
  backfill?: boolean;
  resolveAccountId?: (userId: string) => string | null;
  /** Injectable clock; tests drive it directly. */
  now?: () => number;
}

interface WatchedFile {
  path: string;
  key: string;
  tail: FileTail;
  tracker: SessionTracker;
  /** Unix ms of the last observed growth, for staleness and poll backoff. */
  lastGrowthAt: number;
  /** Unix ms this file is next due to be polled. */
  nextDueAt: number;
  /** True once the tracker has been ended; the file is no longer read. */
  finished: boolean;
  /**
   * False until this file has been read once. The first read drains whatever was already on disk,
   * which is history rather than live growth — see the staleness note in `poll`.
   */
  primed: boolean;
}

const DEFAULT_SCAN_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 300_000;
/**
 * How much of an already-running client's log to scan for its auth line. VRChat writes it within
 * the first few hundred lines; 256KB is generous cover for that without reading a 200MB log.
 */
const ATTRIBUTION_HEAD_BYTES = 256 * 1024;

/**
 * Filesystem identity of a log file. `dev:ino` where the platform provides it; Windows commonly
 * reports `ino === 0`, so there the birth time stands in — enough to notice that the path now
 * points at a different file.
 */
async function fileKey(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (info.ino !== 0) return `${info.dev}:${info.ino}`;
    return `${path}:${Math.trunc(info.birthtimeMs)}`;
  } catch {
    return null;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * When this log file's client started, as a stable value.
 *
 * **Birth time, not mtime.** A live log is appended to constantly, so its mtime is "a moment ago"
 * for as long as the client runs — meaning every daemon restart computed a *different* start time
 * for the same still-running session. The store keys sessions on `(log_path, started_at)`, so each
 * restart inserted a second row for one client and orphaned the first with `ended_at` never set:
 * one ghost "live" session per restart, which under `bun --watch` is one per code edit.
 *
 * Birth time is not universally available — some Linux filesystems report 0 — so the old
 * computation stays as the fallback. It is wrong in the same way it always was, but only where
 * there is nothing better.
 *
 * Note it is **not** clamped to `now`, unlike the mtime fallback. Clamping is what makes a value
 * unstable: `Math.min(birth, now)` returns a moving `now` whenever the two disagree, which is the
 * exact failure being fixed. A birth time in the future means a broken filesystem clock, and
 * honouring it is better than substituting a number that changes on every restart.
 */
async function fileStartedAt(path: string, modifiedAt: number, now: number): Promise<number> {
  try {
    const birth = Math.trunc((await stat(path)).birthtimeMs);
    if (birth > 0) return birth;
  } catch {
    // Fall through: a file we cannot stat is one the tail will fail on anyway.
  }
  return Math.min(modifiedAt, now);
}

export class LogWatcher {
  private readonly directories: readonly string[];
  private readonly sink: LogSink;
  private readonly schedule: ResolvedPollSchedule;
  private readonly scanIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly backfill: boolean;
  private readonly resolveAccountId: ((userId: string) => string | null) | null;
  private readonly now: () => number;

  private readonly files = new Map<string, WatchedFile>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;
  private nextScanAt = 0;

  constructor(options: LogWatcherOptions) {
    this.directories = options.directories;
    this.sink = options.sink;
    this.schedule = resolvePollSchedule(options);
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.backfill = options.backfill ?? true;
    this.resolveAccountId = options.resolveAccountId ?? null;
    this.now = options.now ?? Date.now;
  }

  /** Snapshots of every session the watcher currently knows about. */
  sessions(): SessionSnapshot[] {
    return [...this.files.values()].map((file) => file.tracker.snapshot());
  }

  /** Starts the poll loop. Runs the first tick immediately so a caller can `await` a warm state. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.tick();
    this.scheduleNextTick();
  }

  /**
   * Stops polling. Live sessions are left open on purpose — the game is still running, and the
   * daemon restarting is not a session boundary. Pass `endLiveSessions` to close them out as
   * `unknown` instead, for a shutdown path that needs a consistent store.
   */
  async stop(options: { endLiveSessions?: boolean } = {}): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (options.endLiveSessions === true) {
      for (const file of this.files.values()) {
        if (!file.finished) this.finish(file, null, "unknown");
      }
    }
    await Promise.resolve();
  }

  private scheduleNextTick(): void {
    if (!this.running) return;
    const delay = nextPollDelay(this.schedule, 0, false);
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNextTick());
    }, delay);
    // The loop must never hold the process open by itself.
    this.timer.unref?.();
  }

  /**
   * One pass: rescan the directories when due, read every file that is due, then age out stale
   * sessions. Public so tests can drive the watcher deterministically without timers.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (now >= this.nextScanAt) {
        this.nextScanAt = now + this.scanIntervalMs;
        await this.scan();
      }
      for (const file of [...this.files.values()]) {
        if (file.finished) continue;
        if (this.now() < file.nextDueAt) continue;
        await this.poll(file);
      }
      this.reapStale();
    } finally {
      this.ticking = false;
    }
  }

  private async scan(): Promise<void> {
    for (const directory of this.directories) {
      for (const entry of await listLogFiles(directory)) {
        const key = await fileKey(entry.path);
        if (key === null) continue;
        const existing = this.files.get(entry.path);

        if (existing === undefined) {
          // A new path is a new session — and NOT necessarily a rotation: a second VRChat client
          // starting up looks exactly like this, and both sessions must then run side by side.
          this.files.set(entry.path, await this.adopt(entry.path, key, entry.modifiedAt));
          continue;
        }

        if (existing.key !== key) {
          // Same path, different file: a true rotation. The old session ends here — a session is
          // never continued across files.
          if (!existing.finished) this.finish(existing, null, "crash");
          this.files.set(entry.path, await this.adopt(entry.path, key, entry.modifiedAt));
        }
      }
    }
  }

  /** Builds the watched-file record for a newly seen file, including its fresh session. */
  private async adopt(path: string, key: string, modifiedAt: number): Promise<WatchedFile> {
    const startOffset = this.backfill ? 0 : await fileSize(path);
    const startedAt = await fileStartedAt(path, modifiedAt, this.now());
    const file = this.makeFile(path, key, startedAt, new FileTail({ path, startOffset }));

    // Staleness is measured from the file's last write, not from when we happened to adopt it.
    // Seeding `lastGrowthAt` with `now` gives every long-dead log a fresh lease: the daemon
    // restarts, re-adopts a log whose client exited hours ago, and presents it as a live session
    // for a further `staleAfterMs` before deciding it crashed. Under `bun --watch` that is a dead
    // client showing as live, permanently, because the timer resets faster than it expires.
    file.lastGrowthAt = Math.min(modifiedAt, this.now());

    // Tailing from EOF skips the whole head of the file — including the `User Authenticated:`
    // line, which sits a couple of hundred lines in and is the *only* link between a log file and
    // an account. A client already running when the daemon starts would otherwise stay unlinked
    // for its entire remaining life. Reading just the head for that one line costs one small read
    // and does not replay any history as events.
    if (startOffset > 0) await this.attributeFromHead(file);
    return file;
  }

  /**
   * Reads the head of an already-running client's log looking for its `User Authenticated:` line,
   * and feeds only that line to the tracker.
   *
   * Deliberately narrow: it ingests the auth event and nothing else. The rest of the head is
   * history that was already live before we started watching, and replaying it as events would
   * duplicate every world join and player join the previous run already recorded.
   */
  private async attributeFromHead(file: WatchedFile): Promise<void> {
    let head: string;
    try {
      const handle = Bun.file(file.path);
      head = await handle.slice(0, ATTRIBUTION_HEAD_BYTES).text();
    } catch {
      return;
    }

    for (const line of head.split("\n")) {
      // Substring-gate before parsing, the same way the parser does: this runs over a few thousand
      // lines and all but one of them are irrelevant.
      if (!line.includes("User Authenticated: ")) continue;
      const event = parseLine(line);
      if (event?.kind === "authenticated") {
        file.tracker.ingest(event);
        return;
      }
    }
  }

  private makeFile(path: string, key: string, startedAt: number, tail: FileTail): WatchedFile {
    const now = this.now();
    const tracker = new SessionTracker({
      id: randomUUID(),
      logPath: path,
      logKey: key,
      startedAt,
      sink: this.sink,
      ...(this.resolveAccountId === null ? {} : { resolveAccountId: this.resolveAccountId }),
    });
    tracker.start();
    return {
      path,
      key,
      tail,
      tracker,
      lastGrowthAt: now,
      nextDueAt: 0,
      finished: false,
      primed: false,
    };
  }

  private async poll(watched: WatchedFile): Promise<void> {
    const result = await watched.tail.read();
    let file = watched;

    if (result.truncated) {
      // The file was rewritten in place. That is a new run of the client, so the old session ends
      // and a fresh one begins; the lines just re-read belong to the new one. The tail object is
      // carried over because it has already reset itself to offset 0.
      this.finish(watched, null, "crash");
      file = this.makeFile(watched.path, watched.key, this.now(), watched.tail);
      this.files.set(file.path, file);
    }

    for (const line of result.lines) {
      file.tracker.ingest(parseLine(line));
      if (!file.tracker.isLive) {
        // A quit marker ended the session mid-chunk. Anything after it is shutdown noise.
        file.finished = true;
        break;
      }
    }

    const now = this.now();
    // The **first** read of a newly adopted file is catch-up on history that predates us, not the
    // client writing. Counting it as growth restarts the staleness clock, which is what let a log
    // whose client exited hours ago look live for another `staleAfterMs` after every daemon
    // restart. The seeded value — the file's own mtime — is the truth about when it last grew.
    if (result.grew && file.primed) file.lastGrowthAt = now;
    file.primed = true;
    file.nextDueAt = now + nextPollDelay(this.schedule, now - file.lastGrowthAt, result.hasMore);
  }

  /** A live session whose file stopped growing with no quit marker crashed. */
  private reapStale(): void {
    const now = this.now();
    for (const file of this.files.values()) {
      if (file.finished) continue;
      if (now - file.lastGrowthAt < this.staleAfterMs) continue;
      this.finish(file, null, "crash");
    }
  }

  private finish(file: WatchedFile, endedAt: number | null, exitKind: ExitKind): void {
    file.finished = true;
    // A hard crash can leave the last line unterminated; it is still a real line now that the file
    // is known to be done.
    const pending = file.tail.flushPending();
    if (pending !== null && file.tracker.isLive) file.tracker.ingest(parseLine(pending));
    file.tracker.end(endedAt, exitKind);
  }
}
