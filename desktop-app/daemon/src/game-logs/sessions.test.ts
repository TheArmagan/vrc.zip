import { expect, test } from "bun:test";
import { LogScanner, parseLine } from "./parser.ts";
import type { ExitKind, LogSink, SessionEvent, SessionPatch, SessionSnapshot } from "./sessions.ts";
import { SessionTracker } from "./sessions.ts";

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

const USER = "usr_0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";

function makeTracker(
  sink: LogSink,
  resolveAccountId?: (userId: string) => string | null,
): SessionTracker {
  return new SessionTracker({
    id: "session-1",
    logPath: "C:\\tmp\\output_log_00-00-00.txt",
    logKey: "1:2",
    startedAt: 1_700_000_000_000,
    sink,
    ...(resolveAccountId === undefined ? {} : { resolveAccountId }),
  });
}

function feed(tracker: SessionTracker, lines: readonly string[]): void {
  for (const line of lines) tracker.ingest(parseLine(line));
}

const PRE_AUTH = [
  "2024.03.09 14:22:03 Log        -  Initializing VRSDK.",
  "2024.03.09 14:22:05 Log        -  [Behaviour] Entering Room: The Great Pug",
];
const AUTH = `2024.03.09 14:22:07 Log        -  User Authenticated: Kira Test (${USER})`;

test("pre-auth events are buffered, then attributed retroactively", () => {
  const { sink, log } = recorder();
  const tracker = makeTracker(sink, (userId) => (userId === USER ? "acct_1" : null));

  feed(tracker, PRE_AUTH);
  // Nothing may be emitted yet: the account is not known, and guessing is not an option.
  expect(log.events).toHaveLength(0);
  expect(tracker.bufferedCount).toBe(2);

  feed(tracker, [AUTH]);

  expect(log.events.map((event) => [event.kind, event.accountId])).toEqual([
    ["vr-mode", "acct_1"],
    ["world-enter", "acct_1"],
    ["authenticated", "acct_1"],
  ]);
  // Order is preserved: the buffered events keep their original timestamps and sequence.
  expect(log.events[0]?.at).toBeLessThan(log.events[2]?.at ?? 0);
});

test("a client on an account vrc.zip does not manage stays unlinked, not dropped", () => {
  const { sink, log } = recorder();
  const tracker = makeTracker(sink, () => null);

  feed(tracker, [...PRE_AUTH, AUTH]);

  expect(log.events).toHaveLength(3);
  expect(log.events.every((event) => event.accountId === null)).toBe(true);
  expect(tracker.snapshot().displayName).toBe("Kira Test");
  expect(tracker.snapshot().userId).toBe(USER);
});

test("the buffer is flushed unattributed if the session ends before authenticating", () => {
  const { sink, log } = recorder();
  const tracker = makeTracker(sink);

  feed(tracker, PRE_AUTH);
  expect(log.events).toHaveLength(0);

  tracker.end(null, "crash");
  expect(log.events).toHaveLength(2);
  expect(log.events.every((event) => event.accountId === null)).toBe(true);
});

test("the buffer is capped so a never-authenticating file cannot grow without bound", () => {
  const { sink, log } = recorder();
  const tracker = new SessionTracker({
    id: "session-1",
    logPath: "p",
    logKey: "k",
    startedAt: 0,
    sink,
    maxBufferedEvents: 2,
  });

  feed(tracker, PRE_AUTH);
  expect(log.events).toHaveLength(2);
  expect(tracker.bufferedCount).toBe(0);
});

test("a quit marker ends the session as a clean exit", () => {
  const { sink, log } = recorder();
  const tracker = makeTracker(sink, () => "acct_1");

  feed(tracker, [AUTH, "2024.03.09 14:23:40 Log        -  VRCApplication: OnApplicationQuit at 1"]);

  expect(log.ends).toHaveLength(1);
  expect(log.ends[0]?.exitKind).toBe("clean");
  expect(log.ends[0]?.endedAt).toBe(new Date(2024, 2, 9, 14, 23, 40).getTime());
  expect(tracker.isLive).toBe(false);
});

test("a session with no quit marker ends as a crash, stamped at the last line seen", () => {
  const { sink, log } = recorder();
  const tracker = makeTracker(sink, () => "acct_1");

  feed(tracker, [AUTH, "2024.03.09 14:30:00 Log        -  [Behaviour] OnLeftRoom"]);
  // The daemon notices much later; the session ended when the log stopped, not when we looked.
  tracker.end(null, "crash");

  expect(log.ends[0]?.exitKind).toBe("crash");
  expect(log.ends[0]?.endedAt).toBe(new Date(2024, 2, 9, 14, 30, 0).getTime());
});

test("lines after the quit marker are ignored and end is idempotent", () => {
  const { sink, log } = recorder();
  const tracker = makeTracker(sink, () => "acct_1");

  feed(tracker, [
    AUTH,
    "2024.03.09 14:23:40 Log        -  VRCApplication: OnApplicationQuit at 1",
    "2024.03.09 14:23:41 Log        -  [Behaviour] OnPlayerLeft Ghost (usr_x)",
  ]);
  tracker.end(null, "crash");

  expect(log.ends).toHaveLength(1);
  expect(log.ends[0]?.exitKind).toBe("clean");
  expect(log.events.some((event) => event.kind === "player-leave")).toBe(false);
});

test("world and VR mode land on the session, and unknown lines are dropped silently", () => {
  const { sink, log } = recorder();
  const tracker = makeTracker(sink, () => "acct_1");

  feed(tracker, [
    AUTH,
    "2024.03.09 14:22:08 Log        -  VR Disabled",
    "2024.03.09 14:22:15 Log        -  [Behaviour] Joining wrld_abc:12345~region(us)",
    "  at VRC.Something.Method ()",
  ]);

  const snapshot = tracker.snapshot();
  expect(snapshot.vrMode).toBe("desktop");
  expect(snapshot.currentWorldId).toBe("wrld_abc");
  expect(snapshot.currentLocation).toBe("wrld_abc:12345~region(us)");
  // The unparseable stack-trace line produced no event at all.
  expect(log.events.map((event) => event.kind)).toEqual([
    "authenticated",
    "vr-mode",
    "location-join",
  ]);

  feed(tracker, ["2024.03.09 14:25:00 Log        -  [Behaviour] OnLeftRoom"]);
  expect(tracker.snapshot().currentLocation).toBeNull();
});

test("sessionStart fires once, before any event", () => {
  const { sink, log } = recorder();
  const tracker = makeTracker(sink, () => "acct_1");
  tracker.start();
  tracker.start();
  feed(tracker, [AUTH]);

  expect(log.starts).toHaveLength(1);
  expect(log.starts[0]?.accountId).toBeNull();
  // The account arrives as an update, so a store can patch the row it already wrote.
  expect(log.updates[0]?.patch).toEqual({
    userId: USER,
    displayName: "Kira Test",
    accountId: "acct_1",
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Environment, OSC and device de-duplication                                                     */
/* -------------------------------------------------------------------------------------------- */

test("the environment block lands on the session, merged rather than replaced", () => {
  const { sink } = recorder();
  const tracker = makeTracker(sink);
  feed(tracker, [AUTH]);

  const scanner = new LogScanner();
  const lines = [
    "2024.03.09 14:22:08 Log        -  [UserInfoLogger] Environment Info",
    "VRChat Build: Build 1500",
    "XR Device: Index",
    "2024.03.09 14:22:09 Log        -  [UserInfoLogger] Environment Info",
    "Unity Version: 2022.3.22f1",
    "2024.03.09 14:22:10 Log        -  [Behaviour] OnLeftRoom",
  ];
  for (const line of lines) for (const event of scanner.push(line)) tracker.ingest(event);

  // A second, partial block must not blank what the first one established.
  expect(tracker.snapshot().environment).toEqual({
    "VRChat Build": "Build 1500",
    "XR Device": "Index",
    "Unity Version": "2022.3.22f1",
  });
});

test("only the first OSC port is kept", () => {
  const { sink, log } = recorder();
  const tracker = makeTracker(sink);
  feed(tracker, [
    AUTH,
    "2024.03.09 14:22:08 Log        -  Advertising Service VRChat-Client of type OSC on 9000",
    // OSCQuery lands on a random high port. Taking the newest value recorded that one instead.
    "2024.03.09 14:22:09 Log        -  OSC::Bound receiver to 127.0.0.1:54123",
  ]);

  expect(tracker.snapshot().oscPort).toBe(9000);
  expect(log.updates.filter((entry) => entry.patch.oscPort !== undefined)).toHaveLength(1);
});

test("a re-logged device is dropped; a real change is not", () => {
  const { sink, log } = recorder();
  const tracker = makeTracker(sink);
  feed(tracker, [
    AUTH,
    "2024.03.09 14:22:08 Log        -  [Behaviour] Microphone device changing to Yeti",
    "2024.03.09 14:22:09 Log        -  [Behaviour] Microphone device changing to Yeti",
    "2024.03.09 14:22:10 Log        -  [Behaviour] Microphone device changing to Index HMD",
    // A different kind with the same name is still its own change.
    "2024.03.09 14:22:11 Log        -  [Behaviour] Audio device changing to Index HMD",
  ]);

  const devices = log.events.filter((event) => event.kind === "device-change");
  expect(devices).toHaveLength(3);
});
