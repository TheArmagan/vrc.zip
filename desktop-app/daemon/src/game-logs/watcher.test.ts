import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExitKind, LogSink, SessionEvent, SessionPatch, SessionSnapshot } from "./sessions.ts";
import { LogWatcher } from "./watcher.ts";

/** Every test watches a throwaway tmp dir — never a real VRChat log directory. */
const temporary: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vrcz-watch-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Recorded {
  starts: SessionSnapshot[];
  updates: Array<{ sessionId: string; patch: SessionPatch }>;
  ends: Array<{ sessionId: string; endedAt: number; exitKind: ExitKind }>;
  events: SessionEvent[];
}

function recorder(): { sink: LogSink; log: Recorded } {
  const log: Recorded = { starts: [], updates: [], ends: [], events: [] };
  const sink: LogSink = {
    sessionStart: (session) => log.starts.push(session),
    sessionUpdate: (sessionId, patch) => log.updates.push({ sessionId, patch }),
    sessionEnd: (sessionId, endedAt, exitKind) => log.ends.push({ sessionId, endedAt, exitKind }),
    event: (event) => log.events.push(event),
  };
  return { sink, log };
}

const ALICE = "usr_aaaaaaaa-0000-0000-0000-000000000001";
const BOB = "usr_bbbbbbbb-0000-0000-0000-000000000002";

function authLine(time: string, name: string, userId: string): string {
  return `2024.03.09 ${time} Log        -  User Authenticated: ${name} (${userId})`;
}

function joinLine(time: string, name: string, userId: string): string {
  return `2024.03.09 ${time} Log        -  [Behaviour] OnPlayerJoined ${name} (${userId})`;
}

const QUIT = "2024.03.09 15:00:00 Log        -  VRCApplication: OnApplicationQuit at 4290.113";

/** A clock the tests advance by hand, so no test ever waits on a real timer. */
function clock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

function makeWatcher(directory: string, sink: LogSink, now: () => number, staleAfterMs = 60_000) {
  return new LogWatcher({
    directories: [directory],
    sink,
    now,
    staleAfterMs,
    scanIntervalMs: 0,
    activeIntervalMs: 0,
    idleIntervalMs: 0,
    jitterRatio: 0,
    resolveAccountId: (userId) =>
      userId === ALICE ? "acct_alice" : userId === BOB ? "acct_bob" : null,
  });
}

test("tails two concurrent clients on different accounts as separate sessions", async () => {
  const dir = tempDir();
  const { sink, log } = recorder();
  const time = clock();
  const watcher = makeWatcher(dir, sink, time.now);

  writeFileSync(
    join(dir, "output_log_14-22-01.txt"),
    `${authLine("14:22:07", "Alice", ALICE)}\n${joinLine("14:22:18", "Alice", ALICE)}\n`,
  );
  writeFileSync(
    join(dir, "output_log_14-30-00.txt"),
    `${authLine("14:30:07", "Bob", BOB)}\n${joinLine("14:30:18", "Bob", BOB)}\n`,
  );

  await watcher.tick();

  expect(log.starts).toHaveLength(2);
  const accounts = new Set(log.events.map((event) => event.accountId));
  expect(accounts).toEqual(new Set(["acct_alice", "acct_bob"]));
  // Two files, two sessions — the player lists must not be interleaved.
  expect(new Set(log.events.map((event) => event.sessionId)).size).toBe(2);
  await watcher.stop();
});

test("a client already running when the daemon starts is still attributed", async () => {
  // The daemon restarts while VRChat keeps running. Tailing from EOF is right for events — the
  // previous run already recorded that history — but it skips the `User Authenticated:` line,
  // which sits near the top and is the *only* link between a log file and an account. Without a
  // head scan the session stays unlinked for the rest of the client's life, which is exactly what
  // a `bun --watch` session looks like from the UI: an unlinked client whose account is signed in.
  const dir = tempDir();
  const path = join(dir, "output_log_14-22-01.txt");
  const { sink, log } = recorder();
  const time = clock();
  const watcher = new LogWatcher({
    directories: [dir],
    sink,
    now: time.now,
    staleAfterMs: 60_000,
    scanIntervalMs: 0,
    activeIntervalMs: 0,
    idleIntervalMs: 0,
    jitterRatio: 0,
    // The daemon's real posture for a file that already exists at startup.
    backfill: false,
    resolveAccountId: (userId) => (userId === ALICE ? "acct_alice" : null),
  });

  // History from before the daemon started, auth line included.
  writeFileSync(
    path,
    `${authLine("14:22:07", "Alice", ALICE)}
${joinLine("14:22:18", "Alice", ALICE)}
`,
  );

  await watcher.tick();

  // The account is known from the head scan...
  expect(log.updates.at(-1)?.patch.accountId).toBe("acct_alice");
  expect(log.updates.at(-1)?.patch.displayName).toBe("Alice");
  // ...without replaying the history as events. Re-emitting that join would double every row the
  // previous run already wrote.
  expect(log.events.filter((event) => event.kind === "player-join")).toHaveLength(0);

  // And a line written after we started watching is attributed, not buffered as unlinked.
  appendFileSync(
    path,
    `${joinLine("14:25:00", "Carol", BOB)}
`,
  );
  await watcher.tick();

  const joins = log.events.filter((event) => event.kind === "player-join");
  expect(joins).toHaveLength(1);
  expect(joins[0]?.accountId).toBe("acct_alice");
  await watcher.stop();
});

test("a log whose client exited long ago is not resurrected as a live session", async () => {
  // Restarting the daemon must not give a dead client a fresh lease on life. Staleness runs from
  // the file's last write; seeding it with "now" made every restart show hours-old logs as live
  // for another staleAfterMs, which under `bun --watch` never expires.
  const dir = tempDir();
  const path = join(dir, "output_log_14-22-01.txt");
  writeFileSync(
    path,
    `${authLine("14:22:07", "Alice", ALICE)}
`,
  );

  // The file was last written well beyond the stale window, as a log from a previous run is.
  const past = 1_700_000_000_000;
  utimesSync(path, new Date(past), new Date(past));

  const { sink, log } = recorder();
  const time = clock(past + 3_600_000);
  const watcher = makeWatcher(dir, sink, time.now);

  await watcher.tick();

  // Adopted (so its history is still attributed), then immediately aged out — not left live.
  expect(log.starts).toHaveLength(1);
  expect(log.ends).toHaveLength(1);
  expect(log.ends[0]?.exitKind).toBe("crash");
  await watcher.stop();
});

test("a live file keeps one stable start time across re-adoption", async () => {
  // `startedAt` used to come from the file's mtime, which for a growing log is "a moment ago" —
  // so every daemon restart computed a different start for the same running client. The store
  // keys sessions on (log_path, started_at), so each restart forked a second row and orphaned the
  // first with `ended_at` never set: one ghost live session per restart.
  const dir = tempDir();
  const path = join(dir, "output_log_14-22-01.txt");
  writeFileSync(
    path,
    `${authLine("14:22:07", "Alice", ALICE)}
`,
  );

  const first = recorder();
  const timeA = clock();
  const watcherA = makeWatcher(dir, first.sink, timeA.now);
  await watcherA.tick();
  await watcherA.stop();

  // The client keeps writing, so the mtime moves on. A second daemon adopts the same file.
  appendFileSync(
    path,
    `${joinLine("14:25:00", "Carol", BOB)}
`,
  );
  const second = recorder();
  const timeB = clock(1_700_000_600_000);
  const watcherB = makeWatcher(dir, second.sink, timeB.now);
  await watcherB.tick();
  await watcherB.stop();

  expect(second.log.starts[0]?.startedAt).toBe(first.log.starts[0]?.startedAt);
});

test("attributes pre-auth events retroactively once the auth line arrives", async () => {
  const dir = tempDir();
  const path = join(dir, "output_log_14-22-01.txt");
  const { sink, log } = recorder();
  const time = clock();
  const watcher = makeWatcher(dir, sink, time.now);

  writeFileSync(path, "2024.03.09 14:22:03 Log        -  Initializing VRSDK.\n");
  await watcher.tick();
  expect(log.events).toHaveLength(0);

  appendFileSync(path, `${authLine("14:22:07", "Alice", ALICE)}\n`);
  await watcher.tick();

  expect(log.events.map((event) => [event.kind, event.accountId])).toEqual([
    ["vr-mode", "acct_alice"],
    ["authenticated", "acct_alice"],
  ]);
  await watcher.stop();
});

test("a partial trailing line is not emitted until its newline lands", async () => {
  const dir = tempDir();
  const path = join(dir, "output_log_14-22-01.txt");
  const { sink, log } = recorder();
  const time = clock();
  const watcher = makeWatcher(dir, sink, time.now);

  writeFileSync(path, `${authLine("14:22:07", "Alice", ALICE)}\n`);
  await watcher.tick();

  // VRChat is mid-write: half a line is on disk.
  appendFileSync(path, "2024.03.09 14:22:18 Log        -  [Behaviour] OnPlayerJoined Ali");
  await watcher.tick();
  expect(log.events.some((event) => event.kind === "player-join")).toBe(false);

  appendFileSync(path, `ce (${ALICE})\n`);
  await watcher.tick();
  const join_ = log.events.find((event) => event.kind === "player-join");
  expect(join_?.kind === "player-join" ? join_.displayName : null).toBe("Alice");
  await watcher.stop();
});

test("a quit marker ends the session cleanly", async () => {
  const dir = tempDir();
  const { sink, log } = recorder();
  const time = clock();
  const watcher = makeWatcher(dir, sink, time.now);

  writeFileSync(
    join(dir, "output_log_14-22-01.txt"),
    `${authLine("14:22:07", "Alice", ALICE)}\n${QUIT}\n`,
  );
  await watcher.tick();

  expect(log.ends).toHaveLength(1);
  expect(log.ends[0]?.exitKind).toBe("clean");
  await watcher.stop();
});

test("a file that stops growing with no quit marker is a crash", async () => {
  const dir = tempDir();
  const { sink, log } = recorder();
  const time = clock();
  const watcher = makeWatcher(dir, sink, time.now, 60_000);

  writeFileSync(
    join(dir, "output_log_14-22-01.txt"),
    `${authLine("14:22:07", "Alice", ALICE)}\n${joinLine("14:22:18", "Alice", ALICE)}\n`,
  );
  await watcher.tick();
  expect(log.ends).toHaveLength(0);

  time.advance(120_000);
  await watcher.tick();

  expect(log.ends).toHaveLength(1);
  expect(log.ends[0]?.exitKind).toBe("crash");
  // Stamped where the log stopped, not where the daemon noticed.
  expect(log.ends[0]?.endedAt).toBe(new Date(2024, 2, 9, 14, 22, 18).getTime());
  await watcher.stop();
});

test("one client crashing leaves the other session live", async () => {
  // §1.10's actual wording: kill one client without a clean quit and the *other* session stays
  // live. Crash detection is per-file, and a single-session test cannot tell a correct
  // implementation from one that ends every session the moment any file goes quiet.
  const dir = tempDir();
  const { sink, log } = recorder();
  const time = clock();
  const watcher = makeWatcher(dir, sink, time.now, 60_000);

  const doomed = join(dir, "output_log_14-22-01.txt");
  const survivor = join(dir, "output_log_14-30-00.txt");
  writeFileSync(
    doomed,
    `${authLine("14:22:07", "Alice", ALICE)}
${joinLine("14:22:18", "Alice", ALICE)}
`,
  );
  writeFileSync(
    survivor,
    `${authLine("14:30:07", "Bob", BOB)}
${joinLine("14:30:18", "Bob", BOB)}
`,
  );

  await watcher.tick();
  expect(log.starts).toHaveLength(2);
  const doomedSession = log.starts.find((session) => session.logPath === doomed);
  const survivorSession = log.starts.find((session) => session.logPath === survivor);
  expect(doomedSession).toBeDefined();
  expect(survivorSession).toBeDefined();

  // Alice's client dies: no quit marker, no further growth. Bob's keeps writing.
  time.advance(120_000);
  appendFileSync(
    survivor,
    `${joinLine("14:32:00", "Someone", "usr_someone")}
`,
  );
  await watcher.tick();

  expect(log.ends).toHaveLength(1);
  expect(log.ends[0]?.sessionId).toBe(doomedSession?.id as string);
  expect(log.ends[0]?.exitKind).toBe("crash");

  // And the survivor is still being read, not merely un-ended.
  time.advance(1_000);
  appendFileSync(
    survivor,
    `${joinLine("14:33:00", "Another", "usr_another")}
`,
  );
  await watcher.tick();

  expect(log.ends).toHaveLength(1);
  expect(
    log.events.filter((event) => event.sessionId === survivorSession?.id).length,
  ).toBeGreaterThan(1);
  await watcher.stop();
});

test("rotation starts a new session and never continues the old one", async () => {
  const dir = tempDir();
  const { sink, log } = recorder();
  const time = clock();
  const watcher = makeWatcher(dir, sink, time.now, 60_000);

  writeFileSync(
    join(dir, "output_log_14-22-01.txt"),
    `${authLine("14:22:07", "Alice", ALICE)}\n${joinLine("14:22:18", "Alice", ALICE)}\n`,
  );
  await watcher.tick();
  const first = log.starts[0]?.id;

  // The client restarted: a fresh file, same account, and the old file goes quiet.
  time.advance(120_000);
  writeFileSync(
    join(dir, "output_log_16-00-00.txt"),
    `${authLine("16:00:07", "Alice", ALICE)}\n${joinLine("16:00:18", "Alice", ALICE)}\n`,
  );
  await watcher.tick();

  expect(log.starts).toHaveLength(2);
  const second = log.starts[1]?.id;
  expect(second).not.toBe(first);
  expect(log.ends.map((end) => [end.sessionId, end.exitKind])).toEqual([[first ?? "", "crash"]]);
  // Every event belongs to exactly one of the two sessions.
  const bySession = new Map<string, number>();
  for (const event of log.events)
    bySession.set(event.sessionId, (bySession.get(event.sessionId) ?? 0) + 1);
  expect(bySession.size).toBe(2);
  await watcher.stop();
});

test("truncation ends the old session and reparses the file as a new one", async () => {
  const dir = tempDir();
  const path = join(dir, "output_log_14-22-01.txt");
  const { sink, log } = recorder();
  const time = clock();
  const watcher = makeWatcher(dir, sink, time.now);

  writeFileSync(
    path,
    `${authLine("14:22:07", "Alice", ALICE)}\n${joinLine("14:22:18", "Alice", ALICE)}\n${joinLine("14:22:19", "Someone", BOB)}\n`,
  );
  await watcher.tick();
  const first = log.starts[0]?.id;
  expect(log.events.filter((event) => event.kind === "player-join")).toHaveLength(2);

  // Rewritten in place, shorter: a new run of the client behind the same path.
  writeFileSync(path, `${authLine("16:00:07", "Bob", BOB)}\n`);
  await watcher.tick();

  expect(log.starts).toHaveLength(2);
  expect(log.starts[1]?.id).not.toBe(first);
  expect(log.ends[0]?.sessionId).toBe(first ?? "");
  const last = log.events.at(-1);
  expect(last?.accountId).toBe("acct_bob");
  expect(last?.sessionId).toBe(log.starts[1]?.id ?? "");
  await watcher.stop();
});

test("a client on an unmanaged account is watched with a null accountId", async () => {
  const dir = tempDir();
  const { sink, log } = recorder();
  const time = clock();
  const watcher = makeWatcher(dir, sink, time.now);

  const stranger = "usr_cccccccc-0000-0000-0000-000000000003";
  writeFileSync(
    join(dir, "output_log_14-22-01.txt"),
    `${authLine("14:22:07", "Stranger", stranger)}\n${joinLine("14:22:18", "Stranger", stranger)}\n`,
  );
  await watcher.tick();

  expect(log.events).toHaveLength(2);
  expect(log.events.every((event) => event.accountId === null)).toBe(true);
  expect(log.events[0]?.accountDisplayName).toBe("Stranger");
  await watcher.stop();
});

test("start/stop drives the timer loop without leaving one running", async () => {
  const dir = tempDir();
  const { sink, log } = recorder();
  writeFileSync(join(dir, "output_log_14-22-01.txt"), `${authLine("14:22:07", "Alice", ALICE)}\n`);

  const watcher = new LogWatcher({ directories: [dir], sink, activeIntervalMs: 5, jitterRatio: 0 });
  await watcher.start();
  expect(log.starts).toHaveLength(1);

  await watcher.stop({ endLiveSessions: true });
  expect(log.ends[0]?.exitKind).toBe("unknown");
});
