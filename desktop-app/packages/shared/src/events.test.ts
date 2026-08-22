import { describe, expect, test } from "bun:test";
import {
  BUS_EVENT_KINDS,
  type BusEventKind,
  EVENT_FAMILIES,
  type EventFamily,
  familyOf,
  isBusEventKind,
} from "./events.ts";

describe("the kind taxonomy", () => {
  test("every known kind is dotted and lands in a real family", () => {
    // `other` is the fallback for a namespace this build has never heard of, so a *known* kind
    // resolving to it means the union and the family list have drifted apart.
    for (const kind of BUS_EVENT_KINDS) {
      expect(kind).toContain(".");
      expect(familyOf(kind)).not.toBe("other");
    }
  });

  test("no kind is listed twice", () => {
    expect(new Set(BUS_EVENT_KINDS).size).toBe(BUS_EVENT_KINDS.length);
  });

  test("every family except `other` is actually used by a kind", () => {
    // A family nobody emits is a filter chip that can never match anything.
    const used = new Set<EventFamily>(BUS_EVENT_KINDS.map((kind) => familyOf(kind)));
    for (const family of EVENT_FAMILIES) {
      if (family === "other") continue;
      expect(used.has(family)).toBe(true);
    }
  });

  test("EVENT_FAMILIES has no duplicates", () => {
    expect(new Set(EVENT_FAMILIES).size).toBe(EVENT_FAMILIES.length);
  });
});

describe("familyOf", () => {
  test("reads the namespace off a dotted kind", () => {
    expect(familyOf("gamelog.player_join")).toBe("gamelog");
    expect(familyOf("friend.online")).toBe("friend");
    expect(familyOf("notification.received_v2")).toBe("notification");
  });

  test("a kind from a newer daemon gets a home rather than an exception", () => {
    // This runs on every feed row, including rows written by a build this one has never seen.
    expect(familyOf("quest.completed")).toBe("other");
    expect(familyOf("")).toBe("other");
    expect(familyOf("nodots")).toBe("other");
  });

  test("only the first segment counts", () => {
    expect(familyOf("gamelog.a.b.c")).toBe("gamelog");
  });
});

describe("isBusEventKind", () => {
  test("accepts the known ones and narrows", () => {
    const kind = "friend.online";
    expect(isBusEventKind(kind)).toBe(true);
    if (!isBusEventKind(kind)) throw new Error("unreachable");
    const narrowed: BusEventKind = kind;
    expect(narrowed).toBe("friend.online");
  });

  test("rejects a near-miss", () => {
    // `friend.update` (no `d`) is the exact typo that sat in presence.test.ts, passing because the
    // handler matched `friend.*` generically. Nothing emits it.
    expect(isBusEventKind("friend.update")).toBe(false);
    expect(isBusEventKind("gamelog.player_joined")).toBe(false);
    expect(isBusEventKind("")).toBe(false);
  });

  test("knows the kinds the UI's hand-copied union used to miss", () => {
    // These ten are emitted by the pipeline bridge and were absent from `KnownEventKind`, which is
    // the drift that motivated hoisting this list in the first place.
    const wereMissing = [
      "user.badge_assigned",
      "user.badge_unassigned",
      "content.refresh",
      "content.image_updated",
      "instance.queue_joined",
      "instance.queue_ready",
      "group.joined",
      "group.left",
      "group.member_updated",
      "group.role_updated",
    ];
    for (const kind of wereMissing) expect(isBusEventKind(kind)).toBe(true);
  });
});
