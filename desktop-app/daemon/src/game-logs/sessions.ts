/**
 * Session lifecycle for one log file.
 *
 * A session is (log file, account, run) — never just an account. VRChat can run several clients on
 * one machine at once, each signed into a different account, each writing its own
 * `output_log_*.txt`, and the same account may legally have two clients open. Attributing both to
 * one account would interleave two instances' player lists into nonsense, so the session is the
 * identity and `accountId` is a nullable attribute of it.
 *
 * `accountId` stays `null` for a client signed into an account vrc.zip does not manage. That is a
 * normal state, not an error: the session is kept, shown as unlinked with its display name, and
 * never silently bound to the wrong account.
 */

import type { KnownEvent, ParsedEvent, VrMode } from "./parser.ts";

/** How a session ended. `unknown` is for a session torn down by daemon shutdown, not by the game. */
export type ExitKind = "clean" | "crash" | "unknown";

export interface SessionSnapshot {
  id: string;
  /** `null` until the auth line lands, and permanently `null` for an unmanaged account. */
  accountId: string | null;
  /** VRChat user id from the auth line; `null` until it lands. */
  userId: string | null;
  displayName: string | null;
  logPath: string;
  /** Filesystem identity of the log file (`dev:ino`, or a path+birthtime fallback on Windows). */
  logKey: string;
  /** Unix ms. */
  startedAt: number;
  /** Unix ms, `null` while the session is live. */
  endedAt: number | null;
  exitKind: ExitKind | null;
  vrMode: VrMode | null;
  currentLocation: string | null;
  currentWorldId: string | null;
}

/** Fields that can change over a live session's lifetime. Only the changed keys are present. */
export interface SessionPatch {
  accountId?: string | null;
  userId?: string | null;
  displayName?: string | null;
  vrMode?: VrMode | null;
  currentLocation?: string | null;
  currentWorldId?: string | null;
}

/**
 * A parsed event stamped with the session that produced it.
 *
 * The session's display name is carried as `accountDisplayName`, not `displayName`: several event
 * kinds (`player-join`, `player-leave`) already have a `displayName` of their own meaning "the
 * player this line is about", and an intersection cannot give one key two meanings. Whatever maps
 * this onto the wire is free to rename it there.
 */
export type SessionEvent = KnownEvent & {
  sessionId: string;
  /** Resolved at emit time, so retroactively attributed events carry the right account. */
  accountId: string | null;
  accountDisplayName: string | null;
  logPath: string;
};

/**
 * The watcher's only outbound edge. Everything downstream — the store, the event stream, webhooks —
 * plugs in here. The watcher deliberately knows nothing about persistence.
 */
export interface LogSink {
  sessionStart(session: SessionSnapshot): void;
  /** Emitted whenever a live session's mutable fields change, including retroactive attribution. */
  sessionUpdate(sessionId: string, patch: SessionPatch): void;
  sessionEnd(sessionId: string, endedAt: number, exitKind: ExitKind): void;
  event(event: SessionEvent): void;
}

export interface SessionTrackerOptions {
  id: string;
  logPath: string;
  logKey: string;
  /** Unix ms the session is considered to have started at. */
  startedAt: number;
  sink: LogSink;
  /**
   * Maps a VRChat user id to a vrc.zip account id, or `null` when vrc.zip does not manage that
   * account. Absent means "no accounts configured" — every session stays unlinked.
   */
  resolveAccountId?: (userId: string) => string | null;
  /**
   * Safety valve for the pre-auth buffer. A log file that never authenticates (a truncated
   * historical file, a client that failed to log in) would otherwise buffer forever; past this many
   * events the buffer is flushed unattributed. Not a guess — the events go out with
   * `accountId: null`, exactly as an unmanaged account's would.
   */
  maxBufferedEvents?: number;
}

const DEFAULT_MAX_BUFFERED_EVENTS = 5_000;

/**
 * Consumes parsed lines from one log file and drives one session through its lifecycle.
 *
 * Events seen before the `User Authenticated:` line are buffered and attributed RETROACTIVELY when
 * it lands. VRChat writes several parseable lines before authenticating, so dropping them would
 * lose the start of every session, and guessing the account would be worse than losing them.
 */
export class SessionTracker {
  readonly id: string;
  private readonly sink: LogSink;
  private readonly resolveAccountId: ((userId: string) => string | null) | null;
  private readonly maxBufferedEvents: number;

  private readonly state: SessionSnapshot;
  private buffered: KnownEvent[] = [];
  private authenticated = false;
  private started = false;
  private ended = false;
  /** Unix ms of the newest line seen, used as the fallback `ended_at` for a crashed session. */
  private lastEventAt: number;

  constructor(options: SessionTrackerOptions) {
    this.id = options.id;
    this.sink = options.sink;
    this.resolveAccountId = options.resolveAccountId ?? null;
    this.maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.lastEventAt = options.startedAt;
    this.state = {
      id: options.id,
      accountId: null,
      userId: null,
      displayName: null,
      logPath: options.logPath,
      logKey: options.logKey,
      startedAt: options.startedAt,
      endedAt: null,
      exitKind: null,
      vrMode: null,
      currentLocation: null,
      currentWorldId: null,
    };
  }

  get isLive(): boolean {
    return !this.ended;
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Number of events held pending attribution. */
  get bufferedCount(): number {
    return this.buffered.length;
  }

  snapshot(): SessionSnapshot {
    return { ...this.state };
  }

  /** Announces the session. Idempotent; the watcher calls it as soon as the file is picked up. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.sink.sessionStart(this.snapshot());
  }

  /** Feeds one parsed line. `unknown` results are dropped here — the parser never throws. */
  ingest(event: ParsedEvent): void {
    if (event.kind === "unknown") return;
    if (this.ended) return;
    this.start();
    this.lastEventAt = event.at;

    if (event.kind === "authenticated") {
      this.applyAuthentication(event.displayName, event.userId);
      this.emit(event);
      return;
    }

    this.applySideEffects(event);
    this.emit(event);

    if (event.kind === "app-quit") {
      // The marker itself is the end of the session, and the only source of "clean" there is.
      this.end(event.at, "clean");
    }
  }

  /**
   * Attributes the session from an auth line **without** emitting it as an event.
   *
   * For the head scan: a resumed or EOF-adopted file has its `User Authenticated:` line thousands
   * of lines behind the read position, and the account is only recoverable from it. Feeding that
   * line through `ingest` would work, but it would also re-emit a `gamelog.authenticated` event
   * for a line a previous run already recorded — one more copy of exactly the duplication the
   * offset store exists to stop.
   */
  attribute(displayName: string, userId: string): void {
    if (this.authenticated || this.ended) return;
    this.start();
    this.applyAuthentication(displayName, userId);
  }

  private applyAuthentication(displayName: string, userId: string): void {
    this.authenticated = true;
    const accountId = this.resolveAccountId === null ? null : this.resolveAccountId(userId);
    this.state.userId = userId;
    this.state.displayName = displayName;
    this.state.accountId = accountId;
    this.sink.sessionUpdate(this.id, { userId, displayName, accountId });
    // Everything buffered before this line belongs to this account. Flush it now, in order, so it
    // reaches the sink attributed rather than being dropped.
    this.flushBuffer();
  }

  private applySideEffects(event: KnownEvent): void {
    switch (event.kind) {
      case "vr-mode": {
        if (this.state.vrMode === event.vrMode) return;
        this.state.vrMode = event.vrMode;
        this.sink.sessionUpdate(this.id, { vrMode: event.vrMode });
        return;
      }
      case "location-join": {
        this.state.currentLocation = event.location.location;
        this.state.currentWorldId = event.location.worldId;
        this.sink.sessionUpdate(this.id, {
          currentLocation: event.location.location,
          currentWorldId: event.location.worldId,
        });
        return;
      }
      case "left-room": {
        if (this.state.currentLocation === null && this.state.currentWorldId === null) return;
        this.state.currentLocation = null;
        this.state.currentWorldId = null;
        this.sink.sessionUpdate(this.id, { currentLocation: null, currentWorldId: null });
        return;
      }
      default:
        return;
    }
  }

  private emit(event: KnownEvent): void {
    if (!this.authenticated) {
      this.buffered.push(event);
      if (this.buffered.length >= this.maxBufferedEvents) this.flushBuffer();
      return;
    }
    this.sink.event(this.stamp(event));
  }

  private stamp(event: KnownEvent): SessionEvent {
    return {
      ...event,
      sessionId: this.id,
      accountId: this.state.accountId,
      accountDisplayName: this.state.displayName,
      logPath: this.state.logPath,
    };
  }

  private flushBuffer(): void {
    if (this.buffered.length === 0) return;
    const pending = this.buffered;
    this.buffered = [];
    for (const event of pending) this.sink.event(this.stamp(event));
  }

  /**
   * Ends the session. `endedAt` defaults to the newest line seen, which is the right answer for a
   * crash: the log stops at the moment the process died, not when the daemon noticed.
   */
  end(endedAt: number | null, exitKind: ExitKind): void {
    if (this.ended) return;
    this.ended = true;
    // Anything still buffered never got an auth line; it goes out unlinked rather than dropped.
    this.flushBuffer();
    const at = endedAt ?? this.lastEventAt;
    this.state.endedAt = at;
    this.state.exitKind = exitKind;
    this.start();
    this.sink.sessionEnd(this.id, at, exitKind);
  }
}
