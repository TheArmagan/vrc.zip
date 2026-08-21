import { describe, expect, test } from "bun:test";
import {
  DEAD_SESSION_ERROR,
  decodePipelineMessage,
  isReauthError,
  type PipelineDecodeResult,
} from "./decode.ts";
import { PIPELINE_CONTENT_KIND, PIPELINE_EVENT_TYPES } from "./events.ts";

/** Fixed clock so every assertion on `receivedAt` is exact. */
const AT = 1_700_000_000_000;

function frame(type: string, content?: unknown): string {
  return content === undefined
    ? JSON.stringify({ type })
    : JSON.stringify({
        type,
        content: typeof content === "string" ? content : JSON.stringify(content),
      });
}

function decode(raw: string): PipelineDecodeResult {
  return decodePipelineMessage(raw, AT);
}

describe("content that is not a JSON object", () => {
  // These three are the whole reason this module exists. An unconditional JSON.parse(content)
  // throws on all of them, and the usual swallow-everything catch makes the loss invisible.

  test("see-notification carries a bare, unquoted notification id", () => {
    const result = decode(frame("see-notification", "not_00000000-0000-0000-0000-000000000000"));
    expect(result.kind).toBe("event");
    if (result.kind !== "event" || result.type !== "see-notification") {
      throw new Error(`expected see-notification, got ${result.kind}`);
    }
    expect(result.data.notificationId).toBe("not_00000000-0000-0000-0000-000000000000");
    expect(result.receivedAt).toBe(AT);
  });

  test("hide-notification carries a bare, unquoted notification id", () => {
    const result = decode(frame("hide-notification", "not_deadbeef"));
    if (result.kind !== "event" || result.type !== "hide-notification") {
      throw new Error(`expected hide-notification, got ${result.kind}`);
    }
    expect(result.data.notificationId).toBe("not_deadbeef");
  });

  test("clear-notification has no content key at all", () => {
    const raw = JSON.stringify({ type: "clear-notification" });
    expect(raw).not.toContain("content");
    const result = decode(raw);
    if (result.kind !== "event" || result.type !== "clear-notification") {
      throw new Error(`expected clear-notification, got ${result.kind}`);
    }
    expect(result.data).toEqual({});
  });

  test("clear-notification tolerates a stray content field rather than rejecting it", () => {
    const result = decode(JSON.stringify({ type: "clear-notification", content: "" }));
    expect(result.kind).toBe("event");
  });

  test("a JSON-quoted id is unwrapped, since both spellings have been observed", () => {
    const result = decode(JSON.stringify({ type: "see-notification", content: '"not_quoted"' }));
    if (result.kind !== "event" || result.type !== "see-notification") {
      throw new Error("expected see-notification");
    }
    expect(result.data.notificationId).toBe("not_quoted");
  });

  test("an empty see-notification id is malformed, not an event with an empty id", () => {
    const result = decode(JSON.stringify({ type: "see-notification", content: "   " }));
    expect(result.kind).toBe("malformed");
    if (result.kind !== "malformed") {
      throw new Error("expected malformed");
    }
    expect(result.reason).toBe("content-not-id-string");
  });
});

describe("upstream quirks", () => {
  test('friend-location keeps worldId as the literal string "private"', () => {
    const result = decode(
      frame("friend-location", {
        userId: "usr_1",
        location: "private",
        travelingToLocation: "",
        worldId: "private",
        canRequestInvite: false,
        user: { id: "usr_1", displayName: "Someone", status: "join me" },
      }),
    );
    if (result.kind !== "event" || result.type !== "friend-location") {
      throw new Error(`expected friend-location, got ${result.kind}`);
    }
    // Not rewritten to null, not dropped: consumers must be able to see that it was withheld.
    expect(result.data.worldId).toBe("private");
    expect(result.data.location).toBe("private");
    expect(result.data.user?.id).toBe("usr_1");
    expect(result.raw).toMatchObject({ worldId: "private" });
  });

  test("friend-active uses the lowercase-i `userid` typo and gains a userId alias", () => {
    const wire = { userid: "usr_typo", platform: "standalonewindows" };
    expect(Object.keys(wire)).toContain("userid");
    expect(Object.keys(wire)).not.toContain("userId");

    const result = decode(frame("friend-active", wire));
    if (result.kind !== "event" || result.type !== "friend-active") {
      throw new Error(`expected friend-active, got ${result.kind}`);
    }
    expect(result.data.userid).toBe("usr_typo");
    expect(result.data.userId).toBe("usr_typo");
    // The alias is ours; the raw content still shows exactly what VRChat sent.
    expect(result.raw).toEqual({ userid: "usr_typo", platform: "standalonewindows" });
  });

  test("friend-active with only the corrected spelling is malformed", () => {
    // Guards against someone "fixing" the typo in the spec table and breaking live decoding.
    const result = decode(frame("friend-active", { userId: "usr_1" }));
    expect(result.kind).toBe("malformed");
  });

  test("friend-online accepts world: {} for ask-me/DND friends", () => {
    const result = decode(
      frame("friend-online", {
        userId: "usr_1",
        location: "private",
        worldId: "private",
        world: {},
      }),
    );
    if (result.kind !== "event" || result.type !== "friend-online") {
      throw new Error("expected friend-online");
    }
    expect(result.data.world).toEqual({});
  });

  test.each(["", "offline", "traveling", "traveling:traveling", "private", "wrld_a:1~region(use)"])(
    "location %p decodes",
    (location) => {
      const result = decode(frame("friend-location", { userId: "usr_1", location }));
      expect(result.kind).toBe("event");
    },
  );

  test("notification.details stays an unparsed JSON string", () => {
    const result = decode(
      frame("notification", {
        id: "not_1",
        type: "friendRequest",
        senderUserId: "usr_1",
        details: "{}",
        created_at: "2026-08-21T00:00:00.000Z",
      }),
    );
    if (result.kind !== "event" || result.type !== "notification") {
      throw new Error("expected notification");
    }
    expect(result.data.details).toBe("{}");
  });
});

describe("error frames", () => {
  test("the dead-session error is re-auth, and is not reported as a retryable error", () => {
    const result = decode(JSON.stringify({ err: DEAD_SESSION_ERROR }));
    expect(result.kind).toBe("reauth-required");
    if (result.kind !== "reauth-required") {
      throw new Error("expected reauth-required");
    }
    expect(result.message).toBe(DEAD_SESSION_ERROR);
    // Explicitly not the retryable outcome: the caller branches on this to stop reconnecting.
    expect(result.kind).not.toBe("server-error");
  });

  test.each(["missing authToken", "invalid authToken", "authToken expired"])(
    "%p also means re-auth",
    (message) => {
      expect(isReauthError(message)).toBe(true);
      expect(decode(JSON.stringify({ err: message })).kind).toBe("reauth-required");
    },
  );

  test("an unrelated err frame is a retryable server error", () => {
    const result = decode(JSON.stringify({ err: "internal server error" }));
    expect(result.kind).toBe("server-error");
    expect(isReauthError("internal server error")).toBe(false);
  });
});

describe("hostile input", () => {
  test("an unknown event type does not throw and is reported as unknown", () => {
    const result = decode(frame("brand-new-event-2027", { anything: true }));
    expect(result.kind).toBe("unknown-event");
    if (result.kind !== "unknown-event") {
      throw new Error("expected unknown-event");
    }
    expect(result.type).toBe("brand-new-event-2027");
    // Content is handed back untouched: we do not know its contract, so we do not guess.
    expect(result.content).toBe('{"anything":true}');
  });

  test.each([
    ["truncated json", '{"type":"friend-add","content":'],
    ["empty string", ""],
    ["json array", "[1,2,3]"],
    ["bare number", "42"],
    ["frame without type or err", '{"content":"{}"}'],
    ["content string that is not json", '{"type":"friend-add","content":"not json"}'],
    ["content that is a json array", '{"type":"friend-add","content":"[1]"}'],
    ["missing required field", '{"type":"group-joined","content":"{}"}'],
    ["field of the wrong type", '{"type":"group-joined","content":"{\\"groupId\\":7}"}'],
    ["null content for a json event", '{"type":"friend-add","content":null}'],
  ])("%s is malformed, never thrown", (_name, raw) => {
    let result: PipelineDecodeResult | undefined;
    expect(() => {
      result = decode(raw);
    }).not.toThrow();
    expect(result?.kind).toBe("malformed");
    expect(result?.receivedAt).toBe(AT);
  });

  test("a huge frame is truncated in the malformed report", () => {
    const result = decode(`{"oops":"${"x".repeat(5_000)}`);
    if (result?.kind !== "malformed") {
      throw new Error("expected malformed");
    }
    expect(result.raw.length).toBeLessThan(600);
  });

  test("optional fields may be null without discarding the event", () => {
    const result = decode(
      frame("friend-location", { userId: "usr_1", world: null, location: null }),
    );
    expect(result.kind).toBe("event");
  });

  test("content already given as an object, not a JSON string, is accepted", () => {
    const raw = JSON.stringify({ type: "group-joined", content: { groupId: "grp_1" } });
    const result = decode(raw);
    if (result.kind !== "event" || result.type !== "group-joined") {
      throw new Error("expected group-joined");
    }
    expect(result.data.groupId).toBe("grp_1");
  });
});

describe("event coverage", () => {
  test("all 28 documented event types are modelled with a content kind", () => {
    expect(PIPELINE_EVENT_TYPES).toHaveLength(28);
    for (const type of PIPELINE_EVENT_TYPES) {
      expect(PIPELINE_CONTENT_KIND[type]).toBeDefined();
    }
  });

  test("exactly the three known offenders have non-JSON content", () => {
    const odd = PIPELINE_EVENT_TYPES.filter((t) => PIPELINE_CONTENT_KIND[t] !== "json-object");
    expect([...odd].sort()).toEqual([
      "clear-notification",
      "hide-notification",
      "see-notification",
    ]);
  });

  test("a minimal payload for every JSON-object event decodes", () => {
    const minimal: Record<string, unknown> = {
      notification: { id: "not_1", type: "friendRequest" },
      "notification-v2": { id: "not_1" },
      "notification-v2-update": { id: "not_1", updates: { isRead: true } },
      "notification-v2-delete": { ids: ["not_1"], version: 1 },
      "response-notification": { notificationId: "not_1", responseId: "resp_1" },
      "friend-add": { userId: "usr_1", user: { id: "usr_1" } },
      "friend-delete": { userId: "usr_1" },
      "friend-online": { userId: "usr_1", world: {} },
      "friend-active": { userid: "usr_1" },
      "friend-offline": { userId: "usr_1" },
      "friend-update": { userId: "usr_1", user: { id: "usr_1" } },
      "friend-location": { userId: "usr_1", worldId: "private" },
      "user-update": { userId: "usr_1", user: { id: "usr_1" } },
      "user-location": { userId: "usr_1", location: "" },
      "user-badge-assigned": { badge: { badgeId: "bdg_1" } },
      "user-badge-unassigned": { badgeId: "bdg_1" },
      "content-refresh": { contentType: "avatar", actionType: "created" },
      "economy-update": { balance: 10 },
      "modified-image-update": { fileId: "file_1" },
      "instance-queue-joined": { instanceLocation: "wrld_a:1", position: 3 },
      "instance-queue-ready": { instanceLocation: "wrld_a:1", expiryTime: "2026-08-21T00:00:00Z" },
      "group-joined": { groupId: "grp_1" },
      "group-left": { groupId: "grp_1" },
      "group-member-updated": { member: { id: "gmem_1" } },
      "group-role-updated": { role: { id: "grol_1" } },
    };
    for (const type of PIPELINE_EVENT_TYPES) {
      if (PIPELINE_CONTENT_KIND[type] !== "json-object") {
        continue;
      }
      const payload = minimal[type];
      expect(payload, `no fixture for ${type}`).toBeDefined();
      const result = decode(frame(type, payload));
      expect(result.kind, `${type} did not decode: ${JSON.stringify(result)}`).toBe("event");
    }
  });
});
