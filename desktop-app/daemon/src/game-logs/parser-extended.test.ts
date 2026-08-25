/**
 * The lines added from PARSER-PATTERNS.md — media, spawns, devices, OSC, API failures, the access
 * model on an instance id, and the multi-line `Environment Info` block.
 *
 * Written as hand-built lines rather than a golden fixture, on purpose. Each test names the *shape*
 * it is pinning and, where the shape is subtle, the failure that shape prevents: sticker lines
 * putting the id before the name, `' resolved to '` consuming the source URL's closing quote,
 * OSCQuery being advertised first on a random port. A golden file would pin all of it as one blob
 * and say why for none of it.
 */

import { describe, expect, test } from "bun:test";
import {
  desanitizeName,
  LogScanner,
  normalizeEndpoint,
  parseLine,
  parseLocation,
  stripRichText,
} from "./parser.ts";

const WORLD = "wrld_1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809";
const USER = "usr_0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";

/** Builds a line with the header VRChat writes, so every test states only the body it cares about. */
function line(body: string, level = "Log"): string {
  return `2024.03.09 14:22:03 ${level.padEnd(10)} -  ${body}`;
}

describe("instance access model", () => {
  test("a bare instance with no owner tag is public", () => {
    expect(parseLocation(`${WORLD}:12345~region(us)`)?.access).toBe("public");
  });

  test("hidden, friends and private map onto the three friend-family access types", () => {
    expect(parseLocation(`${WORLD}:1~hidden(${USER})`)?.access).toBe("friends-plus");
    expect(parseLocation(`${WORLD}:1~friends(${USER})`)?.access).toBe("friends");
    expect(parseLocation(`${WORLD}:1~private(${USER})`)?.access).toBe("invite");
  });

  test("the owner id comes off whichever owner tag was present", () => {
    expect(parseLocation(`${WORLD}:1~private(${USER})`)?.ownerId).toBe(USER);
    expect(parseLocation(`${WORLD}:1~group(grp_abc)`)?.ownerId).toBe("grp_abc");
    expect(parseLocation(`${WORLD}:1~region(us)`)?.ownerId).toBeNull();
  });

  test("canRequestInvite upgrades invite to invite+, and only invite", () => {
    expect(parseLocation(`${WORLD}:1~private(${USER})~canRequestInvite`)?.access).toBe(
      "invite-plus",
    );
    // The flag appears on nothing else, and reading it as a general upgrade would silently relabel
    // a group instance.
    expect(parseLocation(`${WORLD}:1~group(grp_abc)~canRequestInvite`)?.access).toBe(
      "group-public",
    );
  });

  test("groupAccessType is applied after the owner tag, so tag order does not matter", () => {
    const after = parseLocation(`${WORLD}:1~group(grp_abc)~groupAccessType(members)`);
    const before = parseLocation(`${WORLD}:1~groupAccessType(members)~group(grp_abc)`);
    expect(after?.access).toBe("group-members");
    expect(before?.access).toBe("group-members");
  });

  test("ageGate is read as a bare flag", () => {
    expect(parseLocation(`${WORLD}:1~group(grp_abc)~ageGate`)?.ageGated).toBe(true);
    expect(parseLocation(`${WORLD}:1~group(grp_abc)`)?.ageGated).toBe(false);
  });

  test("the offline Error World parses as a real visit with no access model", () => {
    const parsed = parseLocation("local:error_1234");
    // Refusing this reported every failed-join session as having visited nowhere at all.
    expect(parsed).not.toBeNull();
    expect(parsed?.offline).toBe(true);
    expect(parsed?.access).toBe("unknown");
    expect(parsed?.worldId).toBe("local:error_1234");
  });
});

describe("name handling", () => {
  test("lookalike substitutions map back to keyboard characters", () => {
    expect(desanitizeName("A․B ＆ C")).toBe("A.B & C");
    expect(desanitizeName("plain name")).toBe("plain name");
  });

  test("a join line carries both the logged name and the clean one", () => {
    const event = parseLine(line(`[Behaviour] OnPlayerJoined A․B (${USER})`));
    expect(event).toMatchObject({
      kind: "player-join",
      displayName: "A․B",
      displayNameClean: "A.B",
      userId: USER,
    });
  });

  test("rich text is stripped depth-counted, and untouched strings come back as they are", () => {
    expect(stripRichText("[<color=#B5438F>Billiards</color>]")).toBe("[Billiards]");
    expect(stripRichText("[Billiards]")).toBe("[Billiards]");
  });
});

describe("leaving an instance", () => {
  test("OnLeftRoom is a deliberate leave and carries no reason", () => {
    expect(parseLine(line("[Behaviour] OnLeftRoom"))).toMatchObject({
      kind: "left-room",
      reason: null,
    });
  });

  test("OnDisconnected is the same kind, with VRChat's reason kept", () => {
    expect(parseLine(line("[Behaviour] OnDisconnected: ClientTimeout"))).toMatchObject({
      kind: "left-room",
      reason: "ClientTimeout",
    });
  });

  test("OnPlayerLeftRoom is an instance leave, not a player leave", () => {
    // The trailing space on the `OnPlayerLeft ` prefix is what keeps these apart. Without it this
    // line parses as a departure by a player called "Room" and corrupts per-player pairing.
    expect(parseLine(line("[Behaviour] OnPlayerLeftRoom")).kind).toBe("left-room");
  });

  test("Finished entering world is instance-ready, not a join", () => {
    expect(parseLine(line("[Behaviour] Finished entering world.")).kind).toBe("instance-ready");
  });
});

describe("avatars", () => {
  test("Switching names both the wearer and the avatar", () => {
    expect(parseLine(line("[Behaviour] Switching Kira Test to avatar Robot Girl"))).toMatchObject({
      kind: "avatar-change",
      displayName: "Kira Test",
      avatarName: "Robot Girl",
    });
  });

  test("Loading avatar for names the wearer only, and leaves the avatar unset", () => {
    expect(parseLine(line("[Behaviour] Loading avatar for Kira Test"))).toMatchObject({
      kind: "avatar-change",
      displayName: "Kira Test",
      avatarName: null,
    });
  });
});

describe("media", () => {
  test("a resolved video URL is split on the whole separator", () => {
    // Pair-scanning for quotes here silently dropped every resolved URL: the separator consumes the
    // source URL's closing quote, so the "pair" spanned from the source into the resolved one.
    const event = parseLine(
      line("[Video Playback] URL 'https://youtu.be/abc' resolved to 'https://cdn/xyz.m3u8'"),
    );
    expect(event).toMatchObject({
      kind: "video-play",
      url: "https://youtu.be/abc",
      resolvedUrl: "https://cdn/xyz.m3u8",
    });
  });

  test("a video line with only a source URL still parses, with nothing resolved", () => {
    expect(parseLine(line("[AVProVideo] Attempting to play 'https://a/b.mp4'"))).toMatchObject({
      kind: "video-play",
      url: "https://a/b.mp4",
      resolvedUrl: null,
    });
  });

  test("download kind comes from the component tag", () => {
    expect(parseLine(line("[String Download] Attempting to load 'https://a/b.txt'"))).toMatchObject(
      { kind: "download", downloadKind: "string", url: "https://a/b.txt", failed: false },
    );
    expect(parseLine(line("[Image Download] Starting download 'https://a/b.png'"))).toMatchObject({
      kind: "download",
      downloadKind: "image",
    });
  });

  test("a failed download is flagged", () => {
    expect(
      parseLine(line("[String Download] Error loading 'https://a/b.txt'", "Error")),
    ).toMatchObject({ kind: "download", failed: true });
  });

  test("queue noise under a download tag is dropped rather than emitted", () => {
    expect(parseLine(line("[AssetBundleDownloadManager] Queued 3 items")).kind).toBe("unknown");
  });
});

describe("spawns", () => {
  test("a sticker line puts the id before the name", () => {
    // The inverse of a join line. Reusing the join parser here swapped the two fields.
    expect(
      parseLine(line(`[StickersManager] User ${USER} (Kira Test) spawned file_abc`)),
    ).toMatchObject({
      kind: "sticker-spawn",
      userId: USER,
      displayName: "Kira Test",
      contentId: "file_abc",
    });
  });

  test("the content id is the id alone, never the kind word in front of it", () => {
    // A real line reads `spawned sticker inv_…`. Slicing everything after the separator produced
    // `"sticker inv_…"`, which is a phrase: it matched no real id a graph compared it against.
    expect(
      parseLine(line(`[StickersManager] User ${USER} (Kira Test) spawned sticker inv_abc`)),
    ).toMatchObject({ kind: "sticker-spawn", contentId: "inv_abc" });

    expect(
      parseLine(line(`[VRCItems] Item spawned prop prop_abc spawned by ${USER} (Kira Test)`)),
    ).toMatchObject({ kind: "prop-spawn", contentId: "prop_abc", spawnKind: "prop" });
  });

  test("an unrecognised prefix falls back to the last token rather than the whole phrase", () => {
    // A prefix VRChat has not shipped yet still yields something id-shaped, without a code change.
    expect(
      parseLine(line(`[StickersManager] User ${USER} (Kira Test) spawned sticker xyz_abc`)),
    ).toMatchObject({ kind: "sticker-spawn", contentId: "xyz_abc" });
  });

  test("props and items are one kind, told apart by the id and not the wording", () => {
    const prop = parseLine(line(`[VRCProps] Prop prop_abc spawned by ${USER} (Kira Test)`));
    const item = parseLine(line(`[VRCItems] Item prop_abc spawned by ${USER} (Kira Test)`));
    expect(prop).toMatchObject({ kind: "prop-spawn", spawnKind: "prop", contentId: "prop_abc" });
    // Same id, newer wording: still a prop, so a real archive does not tally one feature twice.
    expect(item).toMatchObject({ kind: "prop-spawn", spawnKind: "prop", contentId: "prop_abc" });
  });
});

describe("devices and OSC", () => {
  test("a microphone change names the device", () => {
    expect(parseLine(line("[Behaviour] Microphone device changing to Yeti"))).toMatchObject({
      kind: "device-change",
      deviceKind: "microphone",
      device: "Yeti",
    });
  });

  test("the OSC port is read only off a line whose type is exactly OSC", () => {
    expect(parseLine(line("Advertising Service VRChat-Client of type OSC on 9000"))).toMatchObject({
      kind: "osc-ready",
      port: 9000,
    });
    // OSCQuery is advertised first, on a random high port. Matching it recorded the wrong port.
    expect(
      parseLine(line("Advertising Service VRChat-Client of type OSCQuery on 54123")).kind,
    ).toBe("unknown");
  });

  test("the OSC:: fallback takes the first 4-5 digit run", () => {
    expect(parseLine(line("OSC::Bound receiver to 127.0.0.1:9000"))).toMatchObject({
      kind: "osc-ready",
      port: 9000,
    });
  });
});

describe("API failures", () => {
  test("endpoints are normalized so two calls to one route group together", () => {
    expect(normalizeEndpoint(`https://api.vrchat.cloud/api/1/users/${USER}/friends?offset=0`)).toBe(
      "users/:id/friends",
    );
  });

  test("a 4xx in the bracketed form is a failure, with method and endpoint", () => {
    const event = parseLine(
      line(
        `[API] [12, 404, GET, https://api.vrchat.cloud/api/1/users/${USER}] - not found`,
        "Error",
      ),
    );
    expect(event).toMatchObject({
      kind: "api-failure",
      status: 404,
      method: "GET",
      endpoint: "users/:id",
      reason: "not found",
    });
  });

  test("a failure by wording is caught even with no status", () => {
    expect(parseLine(line("[API] Abandoning request after 3 attempts", "Warning"))).toMatchObject({
      kind: "api-failure",
      status: null,
    });
  });

  test("a successful call is not a failure", () => {
    expect(
      parseLine(line("[API] [12, 200, GET, https://api.vrchat.cloud/api/1/auth/user]")).kind,
    ).toBe("unknown");
  });

  test("a model-decode complaint is not a failure", () => {
    // The request succeeded and the client could not map part of the reply. Noisy, repetitive, and
    // filing it under failures made the failure list useless.
    expect(parseLine(line("[API] TryWriteConvert: no converter for Foo", "Warning")).kind).toBe(
      "unknown",
    );
  });
});

describe("notifications from the log", () => {
  test("type, sender and message are read off the comma-delimited body", () => {
    const event = parseLine(
      line(
        `Received Notification: <Notification from username:A․B, sender user id:${USER} of type:friendRequest, message: "hi there">`,
      ),
    );
    expect(event).toMatchObject({
      kind: "notification",
      notificationType: "friendRequest",
      fromUserId: USER,
      fromDisplayName: "A․B",
      // Messages embed display names, which carry the same substitutions the names do.
      fromDisplayNameClean: "A.B",
      message: "hi there",
    });
  });

  test("a friend update carries the user id when the line has one", () => {
    expect(parseLine(line(`FriendUpdated: ${USER}`))).toMatchObject({
      kind: "friend-updated",
      userId: USER,
    });
  });
});

describe("LogScanner", () => {
  test("an ordinary line is emitted on its own header line, not delayed", () => {
    const scanner = new LogScanner();
    // Buffering every entry until the next line arrived would hold a join unemitted for as long as
    // a quiet instance stays quiet.
    const events = scanner.push(line(`[Behaviour] OnPlayerJoined Kira (${USER})`));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("player-join");
  });

  test("the environment block is collected from continuation lines and closed by the next entry", () => {
    const scanner = new LogScanner();
    expect(scanner.push(line("[UserInfoLogger] Environment Info"))).toEqual([]);
    expect(scanner.push("VRChat Build: Build 1500")).toEqual([]);
    expect(scanner.push("Graphics Device Name: NVIDIA GeForce RTX 4090")).toEqual([]);
    expect(scanner.push("Some Internal Counter: 12")).toEqual([]);

    const closed = scanner.push(line("[Behaviour] OnLeftRoom"));
    expect(closed).toHaveLength(2);
    expect(closed[0]).toMatchObject({
      kind: "environment",
      info: {
        "VRChat Build": "Build 1500",
        "Graphics Device Name": "NVIDIA GeForce RTX 4090",
      },
    });
    // Keys outside the allow-list are dropped rather than stored.
    expect(closed[0]).toMatchObject({ kind: "environment" });
    if (closed[0]?.kind === "environment") {
      expect(closed[0].info["Some Internal Counter"]).toBeUndefined();
    }
    expect(closed[1]?.kind).toBe("left-room");
  });

  test("flush closes a block the file ended inside", () => {
    const scanner = new LogScanner();
    scanner.push(line("[UserInfoLogger] Environment Info"));
    scanner.push("Unity Version: 2022.3.22f1");
    expect(scanner.flush()).toMatchObject([{ kind: "environment" }]);
    // And there is nothing left to close afterwards.
    expect(scanner.flush()).toEqual([]);
  });

  test("a BOM on the first line does not make the file unparseable", () => {
    const scanner = new LogScanner();
    const events = scanner.push(`﻿${line("[Behaviour] OnLeftRoom")}`);
    expect(events[0]?.kind).toBe("left-room");
  });

  test("a stack trace's frames extend nothing and emit nothing", () => {
    const scanner = new LogScanner();
    scanner.push(line("[Behaviour] OnLeftRoom"));
    expect(scanner.push("  at Foo.Bar () [0x00000]")).toEqual([]);
  });
});
