/**
 * Offset-based file tailing.
 *
 * `fs.watch` is not used and must not be: on Windows VRChat keeps `output_log_*.txt` open with a
 * share mode that makes change notifications unreliable, and the watch handle itself can block
 * rotation. Instead each file carries a byte offset, and the tail is re-read on a jittered timer.
 *
 * Two details that are easy to get wrong and are handled here:
 *
 * - **Partial trailing line.** A read almost always lands mid-line. The remainder after the last
 *   newline is carried to the next read and never emitted as a line of its own.
 * - **Partial multi-byte character.** The carry is kept at the *byte* level too, via a streaming
 *   `TextDecoder`, so a UTF-8 sequence split across a read boundary is not turned into U+FFFD.
 */

import { open, stat } from "node:fs/promises";

/** Read at most this many bytes per poll, so a huge backfill is streamed rather than slurped. */
const DEFAULT_MAX_CHUNK_BYTES = 1 << 20;

export interface FileTailOptions {
  path: string;
  /** Byte offset to resume from. Defaults to 0 — i.e. read the file from the top. */
  startOffset?: number;
  maxChunkBytes?: number;
}

export interface TailRead {
  /** Complete lines, in order, with any trailing `\r` stripped. Never includes a partial line. */
  lines: string[];
  /** The file shrank below the offset: it was replaced or emptied, and the read restarted at 0. */
  truncated: boolean;
  /** The file could not be opened or stat'd on this poll (deleted, locked, replaced mid-read). */
  missing: boolean;
  /** Byte offset after this read. */
  offset: number;
  /** File size observed at the start of this read. */
  size: number;
  /** True when the file had grown since the previous read. */
  grew: boolean;
  /** More bytes remain past `maxChunkBytes`; poll again immediately rather than waiting. */
  hasMore: boolean;
}

/**
 * The offset + carry state for a single file. Stateful and single-threaded: call `read()` from one
 * scheduler only.
 */
export class FileTail {
  readonly path: string;
  private readonly maxChunkBytes: number;
  private offset: number;
  private carry = "";
  private decoder = new TextDecoder("utf-8");

  constructor(options: FileTailOptions) {
    this.path = options.path;
    this.offset = options.startOffset ?? 0;
    this.maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  }

  /** Current byte offset — persist it to resume a file across daemon restarts. */
  get byteOffset(): number {
    return this.offset;
  }

  /** Text read but not yet terminated by a newline. Exposed for tests and diagnostics. */
  get pending(): string {
    return this.carry;
  }

  private reset(): void {
    this.offset = 0;
    this.carry = "";
    this.decoder = new TextDecoder("utf-8");
  }

  async read(): Promise<TailRead> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return {
        lines: [],
        truncated: false,
        missing: true,
        offset: this.offset,
        size: 0,
        grew: false,
        hasMore: false,
      };
    }

    let truncated = false;
    if (size < this.offset) {
      // The file was replaced in place or emptied. Anything buffered belongs to the old contents.
      truncated = true;
      this.reset();
    }

    if (size === this.offset) {
      return {
        lines: [],
        truncated,
        missing: false,
        offset: this.offset,
        size,
        grew: false,
        hasMore: false,
      };
    }

    const wanted = Math.min(size - this.offset, this.maxChunkBytes);
    const buffer = Buffer.allocUnsafe(wanted);
    let bytesRead: number;
    try {
      const handle = await open(this.path, "r");
      try {
        ({ bytesRead } = await handle.read(buffer, 0, wanted, this.offset));
      } finally {
        await handle.close();
      }
    } catch {
      return {
        lines: [],
        truncated,
        missing: true,
        offset: this.offset,
        size,
        grew: false,
        hasMore: false,
      };
    }

    this.offset += bytesRead;
    const text = this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    const lines = this.split(text);

    return {
      lines,
      truncated,
      missing: false,
      offset: this.offset,
      size,
      grew: bytesRead > 0,
      hasMore: this.offset < size,
    };
  }

  private split(text: string): string[] {
    const combined = this.carry + text;
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = combined.indexOf("\n", start);
      if (newline === -1) break;
      const end = newline > start && combined[newline - 1] === "\r" ? newline - 1 : newline;
      lines.push(combined.slice(start, end));
      start = newline + 1;
    }
    // Whatever follows the last newline is a partial line: hold it until its newline arrives.
    this.carry = combined.slice(start);
    return lines;
  }

  /**
   * Flushes a held partial line as a complete one. Only correct once the file is known to be
   * finished (session ended, file rotated away) — VRChat does not newline-terminate its last line
   * on a hard crash.
   */
  flushPending(): string | null {
    if (this.carry.length === 0) return null;
    const line = this.carry;
    this.carry = "";
    return line;
  }
}

export interface PollScheduleOptions {
  /** Interval for a file that is actively growing. */
  activeIntervalMs?: number;
  /** Interval for a file that has not grown for `idleAfterMs`. */
  idleIntervalMs?: number;
  idleAfterMs?: number;
  /** Fraction of the interval to randomise by, so N files do not all wake on the same tick. */
  jitterRatio?: number;
  random?: () => number;
}

export interface ResolvedPollSchedule {
  activeIntervalMs: number;
  idleIntervalMs: number;
  idleAfterMs: number;
  jitterRatio: number;
  random: () => number;
}

export const DEFAULT_POLL_SCHEDULE: Omit<ResolvedPollSchedule, "random"> = {
  activeIntervalMs: 1_000,
  idleIntervalMs: 10_000,
  idleAfterMs: 30_000,
  jitterRatio: 0.2,
};

export function resolvePollSchedule(options: PollScheduleOptions = {}): ResolvedPollSchedule {
  return {
    activeIntervalMs: options.activeIntervalMs ?? DEFAULT_POLL_SCHEDULE.activeIntervalMs,
    idleIntervalMs: options.idleIntervalMs ?? DEFAULT_POLL_SCHEDULE.idleIntervalMs,
    idleAfterMs: options.idleAfterMs ?? DEFAULT_POLL_SCHEDULE.idleAfterMs,
    jitterRatio: options.jitterRatio ?? DEFAULT_POLL_SCHEDULE.jitterRatio,
    random: options.random ?? Math.random,
  };
}

/**
 * Picks the next delay for one file: the active interval while it is growing, backing off to the
 * idle interval once it has been quiet, always jittered. Keeps watcher cost flat in the number of
 * dormant historical log files, which on a long-lived install vastly outnumber the live ones.
 */
export function nextPollDelay(
  schedule: ResolvedPollSchedule,
  msSinceLastGrowth: number,
  hasMore: boolean,
): number {
  if (hasMore) return 0;
  const base =
    msSinceLastGrowth >= schedule.idleAfterMs ? schedule.idleIntervalMs : schedule.activeIntervalMs;
  const jitter = base * schedule.jitterRatio * (schedule.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}
