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
import { LogScanner, parseLine } from "./parser.ts";
import type { ExitKind, LogSink, SessionSnapshot } from "./sessions.ts";
import { SessionTracker } from "./sessions.ts";
import {
  FileTail,
  nextPollDelay,
  type PollScheduleOptions,
  type ResolvedPollSchedule,
  resolvePollSchedule,
} from "./tail.ts";

/**
 * Where the watcher's read positions are kept between runs.
 *
 * Injected rather than imported, like the sink: the watcher is a pure file-to-events transform and
 * must not know that a database exists. `app.ts` wires this to the `log_offsets` table.
 *
 * Without one, the watcher re-reads every log file from the top on every start and re-emits every
 * line in it — which is how a single VRChat shutdown ended up in the feed six times, once per
 * daemon restart. See migration 007.
 */
export interface LogOffsetStore {
  /** Byte offset already consumed from this file, or `null` for a file never seen before. */
  get(logKey: string): number | null;
  /** Records progress. Called after every read that advanced the offset. */
  set(logKey: string, logPath: string, byteOffset: number): void;
  /** Forgets a file's position, for a file rewritten in place — its bytes are new bytes now. */
  reset(logKey: string): void;
}

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
  /**
   * Persistent read positions. Absent means every run starts from `backfill`'s answer, which is
   * the old — and duplicating — behaviour; tests that do not care about resumption omit it.
   */
  offsets?: LogOffsetStore;
  /** Injectable clock; tests drive it directly. */
  now?: () => number;
}

interface WatchedFile {
  path: string;
  key: string;
  tail: FileTail;
  /**
   * `null` for a **dormant** file: one already read to its end on a previous run, whose client may
   * or may not still be alive. It gets a tracker — and therefore a session, and therefore a place
   * in the UI — the moment it writes another line, and not before.
   *
   * That laziness is the point. Adopting a finished log eagerly re-opens its session row on every
   * daemon start, and with the file already consumed there is no quit marker left to close it
   * again, so a client that exited cleanly last week reappears as live and is then reaped as a
   * crash five minutes later.
   */
  tracker: SessionTracker | null;
  /**
   * Per-file scanning state, so a multi-line entry that straddles two polled chunks still stitches
   * back together. One per file and never shared: two clients writing at once would otherwise
   * interleave their continuation lines into one another's blocks.
   */
  scanner: LogScanner;
  /** When this file's client started, for the tracker a dormant file may still grow into. */
  startedAt: number;
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
  private readonly offsets: LogOffsetStore | null;
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
    this.offsets = options.offsets ?? null;
    this.now = options.now ?? Date.now;
  }

  /** Snapshots of every session the watcher currently knows about. */
  sessions(): SessionSnapshot[] {
    return [...this.files.values()]
      .map((file) => file.tracker?.snapshot() ?? null)
      .filter((snapshot): snapshot is SessionSnapshot => snapshot !== null);
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
        if (!file.finished && file.tracker !== null) this.finish(file, null, "unknown");
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

  /**
   * Builds the watched-file record for a newly seen file.
   *
   * Where it starts reading is the whole question, and there are three answers:
   *
   *  - **A file with a stored offset** resumes there. This is what stops the daemon replaying
   *    months of logs on every start (migration 007). If the offset already covers the file it
   *    starts *dormant* — no tracker, no session — until the file writes something new.
   *  - **A file we have never seen** backfills from 0, so a client that started before the daemon
   *    did still gets its history and, more importantly, its `User Authenticated:` line.
   *  - **A stored offset past the end of the file** is stale: the file was replaced under a key
   *    the filesystem reused. Read it from the top; skipping to a byte that no longer exists would
   *    silently swallow a whole run.
   */
  private async adopt(path: string, key: string, modifiedAt: number): Promise<WatchedFile> {
    const size = await fileSize(path);
    const stored = this.offsets?.get(key) ?? null;
    const resumable = stored !== null && stored <= size;
    const startOffset = resumable ? stored : this.backfill ? 0 : size;
    const startedAt = await fileStartedAt(path, modifiedAt, this.now());

    const file: WatchedFile = {
      path,
      key,
      tail: new FileTail({ path, startOffset }),
      tracker: null,
      scanner: new LogScanner(),
      startedAt,
      // Staleness is measured from the file's last write, not from when we happened to adopt it.
      // Seeding `lastGrowthAt` with `now` gives every long-dead log a fresh lease: the daemon
      // restarts, re-adopts a log whose client exited hours ago, and presents it as a live session
      // for a further `staleAfterMs` before deciding it crashed. Under `bun --watch` that is a dead
      // client showing as live, permanently, because the timer resets faster than it expires.
      lastGrowthAt: Math.min(modifiedAt, this.now()),
      nextDueAt: 0,
      finished: false,
      primed: false,
    };

    // Nothing left to read and we have read it before: stay dormant. `poll` wakes it if the file
    // grows again, which is exactly the case of a client that was already running when the daemon
    // restarted.
    if (resumable && startOffset >= size) return file;

    this.wake(file);
    // Tailing from anywhere but the top skips the head of the file — including the
    // `User Authenticated:` line, which sits a couple of hundred lines in and is the *only* link
    // between a log file and an account. Without this a resumed or EOF-adopted client would stay
    // unlinked for its entire remaining life, and its events would buffer unattributed. Reading
    // just the head for that one line costs one small read and replays no history.
    if (startOffset > 0) await this.attributeFromHead(file);
    return file;
  }

  /**
   * Gives a file a session tracker, announcing the session. Idempotent.
   *
   * Separated from adoption because a dormant file earns its session later, on its first new line,
   * rather than at the moment it is discovered.
   */
  private wake(file: WatchedFile): void {
    if (file.tracker !== null) return;
    file.tracker = new SessionTracker({
      id: randomUUID(),
      logPath: file.path,
      logKey: file.key,
      startedAt: file.startedAt,
      sink: this.sink,
      ...(this.resolveAccountId === null ? {} : { resolveAccountId: this.resolveAccountId }),
    });
    file.tracker.start();
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
        file.tracker?.attribute(event.displayName, event.userId);
        return;
      }
    }
  }

  private async poll(watched: WatchedFile): Promise<void> {
    // Read before the read: whether this poll started mid-file is what decides if the tracker
    // needs the head fetched separately for its `User Authenticated:` line.
    const resumedMidFile = watched.tail.byteOffset > 0;
    const result = await watched.tail.read();
    let file = watched;

    if (result.truncated) {
      // The file was rewritten in place. That is a new run of the client, so the old session ends
      // and a fresh one begins; the lines just re-read belong to the new one. The tail object is
      // carried over because it has already reset itself to offset 0.
      //
      // The stored offset has to go with it. It describes bytes that no longer exist, and the
      // "never rewind" rule that protects it from a stale writer would otherwise pin it past the
      // whole new run — the daemon would skip everything the restarted client writes.
      this.offsets?.reset(watched.key);
      if (watched.tracker !== null) this.finish(watched, null, "crash");
      file = {
        ...watched,
        tracker: null,
        scanner: new LogScanner(),
        startedAt: this.now(),
        finished: false,
        primed: false,
      };
      this.files.set(file.path, file);
    }

    // A dormant file has just proved its client is still writing, so now it gets a session. The
    // head read re-attributes it: the tracker is new and has not seen the `User Authenticated:`
    // line, which by now is thousands of lines behind the resume point.
    if (result.lines.length > 0 && file.tracker === null) {
      this.wake(file);
      // Not after a truncation: those lines *are* the head, and the tracker is about to read the
      // auth line itself. Fetching it as well would authenticate the session twice.
      if (resumedMidFile && !result.truncated) await this.attributeFromHead(file);
    }

    const tracker = file.tracker;
    if (tracker !== null) {
      for (const line of result.lines) {
        // Through the scanner, not `parseLine` directly: a line with no header is a continuation of
        // the entry above it, and the `Environment Info` block only exists as one.
        for (const event of file.scanner.push(line)) tracker.ingest(event);
        if (!tracker.isLive) {
          // A quit marker ended the session mid-chunk. Anything after it is shutdown noise.
          file.finished = true;
          break;
        }
      }
    }

    // Persisted **after** the lines are ingested, and only when the file was actually readable.
    // The ordering is the durability rule: a crash between the two replays a chunk, which the
    // dedupe index absorbs, where the other order would lose it outright.
    if (!result.missing) this.offsets?.set(file.key, file.path, file.tail.byteOffset);

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
      if (file.finished || file.tracker === null) continue;
      if (now - file.lastGrowthAt < this.staleAfterMs) continue;
      this.finish(file, null, "crash");
    }
  }

  /** Ends a file's session. Only ever called for a file that has one — a dormant file has none. */
  private finish(file: WatchedFile, endedAt: number | null, exitKind: ExitKind): void {
    file.finished = true;
    const tracker = file.tracker;
    if (tracker === null) return;
    // A hard crash can leave the last line unterminated; it is still a real line now that the file
    // is known to be done.
    const pending = file.tail.flushPending();
    if (pending !== null && tracker.isLive) {
      for (const event of file.scanner.push(pending)) tracker.ingest(event);
    }
    // Closes whatever block the file ended inside. A log that stops mid-`Environment Info` still
    // has a usable block, and dropping it would lose the whole thing for a session that never quit.
    if (tracker.isLive) for (const event of file.scanner.flush()) tracker.ingest(event);
    tracker.end(endedAt, exitKind);
  }
}
