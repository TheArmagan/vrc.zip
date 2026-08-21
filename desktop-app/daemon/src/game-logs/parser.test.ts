/**
 * Golden-file tests for the line parser.
 *
 * The fixtures under `__fixtures__/` (`.txt`, as VRChat itself names them) were written by hand from the marker table in PLAN.md §1.7 —
 * they are not captures from a real client, and nothing here should be read as evidence that a
 * shipped VRChat build emits these exact bytes. They exist to pin the parser's behaviour so a
 * refactor cannot quietly change it.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParsedEvent, parseHeader, parseLine, parseLocation } from "./parser.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__");

function readFixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), "utf8").split("\n");
}

function parseFixture(name: string): ParsedEvent[] {
  return readFixture(name).map(parseLine);
}

/** VRChat timestamps are local wall time; the expectations must be built the same way. */
function at(stamp: string): number {
  const [date, time] = stamp.split(" ");
  const [y, mo, d] = (date ?? "").split(".").map(Number);
  const [h, mi, s] = (time ?? "").split(":").map(Number);
  return new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0).getTime();
}

const WORLD = "wrld_1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809";
const USER = "usr_0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
const OTHER_USER = "usr_99887766-5544-3322-1100-aabbccddeeff";

test("golden: markers.txt parses to the v1 marker table", () => {
  const known = parseFixture("markers.txt").filter((event) => event.kind !== "unknown");

  expect(known).toEqual([
    { kind: "vr-mode", at: at("2024.03.09 14:22:03"), level: "Log", component: null, vrMode: "vr" },
    {
      kind: "vr-mode",
      at: at("2024.03.09 14:22:05"),
      level: "Log",
      component: null,
      vrMode: "desktop",
    },
    {
      kind: "authenticated",
      at: at("2024.03.09 14:22:07"),
      level: "Log",
      component: null,
      displayName: "Kira Test",
      userId: USER,
    },
    {
      kind: "destination-set",
      at: at("2024.03.09 14:22:12"),
      level: "Log",
      component: "Behaviour",
      location: {
        location: `${WORLD}:12345~region(us)`,
        worldId: WORLD,
        instanceId: "12345",
        region: "us",
        groupId: null,
      },
    },
    {
      kind: "world-enter",
      at: at("2024.03.09 14:22:14"),
      level: "Log",
      component: "Behaviour",
      worldName: "The Great Pug",
    },
    {
      kind: "location-join",
      at: at("2024.03.09 14:22:15"),
      level: "Log",
      component: "Behaviour",
      location: {
        location: `${WORLD}:12345~region(us)~group(grp_11112222-3333-4444-5555-666677778888)`,
        worldId: WORLD,
        instanceId: "12345",
        region: "us",
        groupId: "grp_11112222-3333-4444-5555-666677778888",
      },
    },
    {
      kind: "player-join",
      at: at("2024.03.09 14:22:18"),
      level: "Log",
      component: "Behaviour",
      displayName: "Kira Test",
      userId: USER,
    },
    {
      kind: "player-join",
      at: at("2024.03.09 14:22:19"),
      level: "Log",
      component: "Behaviour",
      displayName: "Someone (Else)",
      userId: OTHER_USER,
    },
    {
      kind: "portal-spawn",
      at: at("2024.03.09 14:22:30"),
      level: "Log",
      component: "Behaviour",
      spawnerDisplayName: null,
      target: null,
      objectPath: "Portals/PortalInternalDynamic",
    },
    {
      kind: "screenshot",
      at: at("2024.03.09 14:22:41"),
      level: "Log",
      component: "VRC Camera",
      path: "C:\\Users\\test\\Pictures\\VRChat\\2024-03\\VRChat_2024-03-09_14-22-41.png",
    },
    {
      kind: "player-leave",
      at: at("2024.03.09 14:23:02"),
      level: "Log",
      component: "Behaviour",
      displayName: "Someone (Else)",
      userId: OTHER_USER,
    },
    { kind: "left-room", at: at("2024.03.09 14:23:10"), level: "Log", component: "Behaviour" },
    {
      kind: "join-failed",
      at: at("2024.03.09 14:23:12"),
      level: "Warning",
      component: "Behaviour",
      reason: `'${WORLD}:99999' due to reason 'instance is full'`,
    },
    { kind: "app-quit", at: at("2024.03.09 14:23:40"), level: "Log", component: null },
  ]);
});

test("golden: OnPlayerJoined parses with and without the user id", () => {
  const events = parseFixture("player-join-legacy.txt").filter(
    (event) => event.kind === "player-join" || event.kind === "player-leave",
  );

  expect(
    events.map((event) =>
      event.kind === "player-join" || event.kind === "player-leave"
        ? [event.kind, event.displayName, event.userId]
        : null,
    ),
  ).toEqual([
    // VRChat has shipped both shapes; both must parse, and a name containing parentheses must not
    // be mistaken for a user id suffix.
    ["player-join", "Kira Test", null],
    ["player-join", "Someone (Else)", null],
    ["player-leave", "Someone (Else)", null],
    ["player-join", "Kira Test", USER],
  ]);
});

test("golden: malformed.txt degrades to unknown and never throws", () => {
  const events = parseFixture("malformed.txt");
  expect(events.every((event) => event.kind === "unknown")).toBe(true);

  const reasons = events.map((event) => (event.kind === "unknown" ? event.reason : "known"));
  // Lines with no valid header at all vs. headed lines whose body matched no marker.
  expect(reasons).toContain("no-header");
  expect(reasons).toContain("unmatched");
});

test("`Joining or Creating Room:` is not read as a location", () => {
  const event = parseLine(
    "2024.03.09 14:22:07 Log        -  [Behaviour] Joining or Creating Room: The Great Pug",
  );
  expect(event.kind).toBe("unknown");
});

test("HandleApplicationQuit is a quit marker in both shapes", () => {
  for (const body of [
    "VRCApplication: OnApplicationQuit at 4290.113",
    "VRCApplication: HandleApplicationQuit at 4290.113",
    "HandleApplicationQuit at 4290.113",
  ]) {
    expect(parseLine(`2024.03.09 14:23:40 Log        -  ${body}`).kind).toBe("app-quit");
  }
});

test("header validation rejects continuation lines cheaply", () => {
  expect(parseHeader("  at VRC.Something.Method ()")).toBeNull();
  expect(parseHeader("")).toBeNull();
  expect(parseHeader("2024.03.09 14:23:40 12345      -  body")).toBeNull();
  expect(parseHeader("2024.03.09 14:23:40 Log        -  body")).toEqual({
    at: at("2024.03.09 14:23:40"),
    level: "Log",
    body: "body",
  });
});

test("timestamps are local time, as integer unix ms", () => {
  const event = parseLine("2024.03.09 14:23:40 Log        -  [Behaviour] OnLeftRoom");
  expect(event.at).toBe(new Date(2024, 2, 9, 14, 23, 40).getTime());
  expect(Number.isInteger(event.at)).toBe(true);
});

test("locations decompose into world, instance, region and group", () => {
  expect(parseLocation(`${WORLD}:12345~region(eu)~group(grp_abc)`)).toEqual({
    location: `${WORLD}:12345~region(eu)~group(grp_abc)`,
    worldId: WORLD,
    instanceId: "12345",
    region: "eu",
    groupId: "grp_abc",
  });
  expect(parseLocation(WORLD)).toEqual({
    location: WORLD,
    worldId: WORLD,
    instanceId: null,
    region: null,
    groupId: null,
  });
  expect(parseLocation("private")).toBeNull();
});
