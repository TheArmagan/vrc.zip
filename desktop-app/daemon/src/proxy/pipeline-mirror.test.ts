import { describe, expect, test } from "bun:test";
import { DEFAULT_SCOPES, expandSuperWildcard, type Scope } from "@vrcz/shared";
import { type DecodedPipelineEvent, decodePipelineMessage } from "../pipeline/index.ts";
import {
  deadSessionFrame,
  PIPELINE_EVENT_SCOPES,
  PipelineMirror,
  type PipelineSink,
  pipelineToken,
} from "./pipeline-mirror.ts";

/**
 * The mirror is fed from `decodePipelineMessage` rather than from hand-built objects, because the
 * property that matters most — that a client receives the bytes VRChat sent, not a re-serialisation
 * of them — is only meaningful if the frame really did come off a decoder.
 */

const REAL = "authcookie_2e0a5f9c-1b3d-4a77-9f0e-6c1d2b3a4e5f";

/** A frame as VRChat writes it: `content` is a JSON *string* inside the JSON. */
function frameOf(type: string, content: unknown): string {
  return JSON.stringify({ type, content: JSON.stringify(content) });
}

function decoded(wire: string): DecodedPipelineEvent {
  const result = decodePipelineMessage(wire, 1_700_000_000_000);
  if (result.kind !== "event") throw new Error(`fixture did not decode: ${result.kind}`);
  return result;
}

function sink(): PipelineSink & { sent: string[]; closed: boolean } {
  const sent: string[] = [];
  return {
    sent,
    closed: false,
    send(frame) {
      sent.push(frame);
    },
    close() {
      this.closed = true;
    },
  };
}

const FRIEND_ONLINE = frameOf("friend-online", {
  userId: "usr_x",
  user: {},
  platform: "standalone",
});

describe("fan-out", () => {
  test("delivers the frame exactly as it arrived", () => {
    const mirror = new PipelineMirror();
    const client = sink();
    mirror.subscribe("usr_a", ["friends:read"], client);

    mirror.publish("usr_a", decoded(FRIEND_ONLINE));
    // Byte-identical, not merely equivalent. A rebuild would reorder keys and re-encode the nested
    // content string, and "almost identical" is the wrong standard for a byte-faithful mirror.
    expect(client.sent).toEqual([FRIEND_ONLINE]);
  });

  test("one real socket feeds every connected app", () => {
    // The ratio the mirror exists for: N apps, one VRChat session.
    const mirror = new PipelineMirror();
    const a = sink();
    const b = sink();
    mirror.subscribe("usr_a", ["friends:read"], a);
    mirror.subscribe("usr_a", ["friends:read"], b);

    mirror.publish("usr_a", decoded(FRIEND_ONLINE));
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(mirror.subscriberCount).toBe(2);
  });

  test("an app bound to one account never sees another's events", () => {
    const mirror = new PipelineMirror();
    const client = sink();
    mirror.subscribe("usr_a", ["friends:read"], client);

    mirror.publish("usr_b", decoded(FRIEND_ONLINE));
    expect(client.sent).toEqual([]);
  });

  test("unsubscribing stops delivery and releases the account", () => {
    const mirror = new PipelineMirror();
    const client = sink();
    const detach = mirror.subscribe("usr_a", ["friends:read"], client);

    detach();
    mirror.publish("usr_a", decoded(FRIEND_ONLINE));
    expect(client.sent).toEqual([]);
    // Dropped rather than left as an empty set, so a long run does not accumulate one entry per
    // account any app ever connected for.
    expect(mirror.subscriberCount).toBe(0);
  });

  test("a socket that throws mid-fan-out does not stop the others", () => {
    const mirror = new PipelineMirror();
    const dead: PipelineSink = {
      send() {
        throw new Error("socket closed");
      },
      close() {},
    };
    const alive = sink();
    mirror.subscribe("usr_a", ["friends:read"], dead);
    mirror.subscribe("usr_a", ["friends:read"], alive);

    mirror.publish("usr_a", decoded(FRIEND_ONLINE));
    expect(alive.sent).toHaveLength(1);
  });

  test("disconnectAccount closes every client of that account", () => {
    const mirror = new PipelineMirror();
    const client = sink();
    mirror.subscribe("usr_a", ["friends:read"], client);

    mirror.disconnectAccount("usr_a");
    expect(client.closed).toBe(true);
    expect(mirror.subscriberCount).toBe(0);
  });
});

describe("scope filtering", () => {
  test("withholds an event the grant has no scope for", () => {
    const mirror = new PipelineMirror();
    const client = sink();
    mirror.subscribe("usr_a", ["friends:read"], client);

    // Not merely unreadable: an app without `notifications:read` is not told one happened.
    mirror.publish(
      "usr_a",
      decoded(frameOf("notification", { id: "not_1", type: "friendRequest" })),
    );
    expect(client.sent).toEqual([]);
  });

  test("delivers what the grant does cover", () => {
    const mirror = new PipelineMirror();
    const client = sink();
    mirror.subscribe("usr_a", ["notifications:read"], client);

    const wire = frameOf("notification", { id: "not_1", type: "friendRequest" });
    mirror.publish("usr_a", decoded(wire));
    expect(client.sent).toEqual([wire]);
  });

  test("the three malformed-content event types are mirrored too", () => {
    // `see-notification` carries a bare id string and `clear-notification` carries nothing. These
    // are the frames an unconditional JSON.parse swallows, so they are the ones worth proving.
    const mirror = new PipelineMirror();
    const client = sink();
    mirror.subscribe("usr_a", ["notifications:read"], client);

    const bare = JSON.stringify({ type: "see-notification", content: "not_1" });
    const absent = JSON.stringify({ type: "clear-notification" });
    mirror.publish("usr_a", decoded(bare));
    mirror.publish("usr_a", decoded(absent));

    expect(client.sent).toEqual([bare, absent]);
  });

  test("every event type maps to a scope, so a new one cannot arrive unguarded", () => {
    // The map is `Record<PipelineEventType, Scope>`, so this is really a compile-time property —
    // asserted at runtime as well because the consequence of getting it wrong is a silent leak.
    for (const [type, scope] of Object.entries(PIPELINE_EVENT_SCOPES)) {
      expect(typeof scope).toBe("string");
      expect(scope).toContain(":");
      expect(type.length).toBeGreaterThan(0);
    }
  });
});

describe("credential sanitisation", () => {
  test("withholds a frame carrying a real VRChat credential, from everyone", () => {
    // PLAN.md's leak table names the pipeline explicitly. A frame that should never contain a
    // credential and does is withheld rather than filtered, because we do not know what else is in it.
    const violations: unknown[] = [];
    const mirror = new PipelineMirror({ onViolation: (context) => violations.push(context) });
    const client = sink();
    mirror.subscribe("usr_a", ["friends:read"], client);

    mirror.publish("usr_a", decoded(frameOf("friend-online", { userId: "usr_x", note: REAL })));

    expect(client.sent).toEqual([]);
    expect(violations).toEqual([{ accountId: "usr_a", type: "friend-online" }]);
  });

  test("our own tokens are not credentials and pass through", () => {
    const mirror = new PipelineMirror();
    const client = sink();
    mirror.subscribe("usr_a", ["friends:read"], client);

    const ours = `${REAL}_vrczip`;
    mirror.publish("usr_a", decoded(frameOf("friend-online", { userId: "usr_x", note: ours })));
    expect(client.sent).toHaveLength(1);
  });
});

describe("deadSessionFrame", () => {
  test("says why without echoing the token or the IP", () => {
    const frame = JSON.parse(deadSessionFrame()) as Record<string, unknown>;
    // VRChat's real frame is `{"err":…,"authToken":"…","ip":"…"}`. Both extras are on the leak
    // table: one is the credential itself, the other is the user's address.
    expect(frame.err).toContain("authToken");
    expect(frame).not.toHaveProperty("authToken");
    expect(frame).not.toHaveProperty("ip");
  });
});

describe("pipelineToken", () => {
  const base = "wss://pipeline.vrchat.cloud/";

  test("reads VRChat's documented authToken", () => {
    expect(pipelineToken(`${base}?authToken=abc`, null)).toBe("abc");
  });

  test("reads the auth spelling VRCX actually sends", () => {
    // The regression: VRCX opens `wss://pipeline.vrchat.cloud/?auth=<token>`.
    expect(pipelineToken(`${base}?auth=abc`, null)).toBe("abc");
  });

  test("falls back to the cookie, for a client that cannot set a query string", () => {
    expect(pipelineToken(base, "twoFactorAuth=x; auth=abc")).toBe("abc");
  });

  test("prefers the query string over the cookie", () => {
    expect(pipelineToken(`${base}?authToken=fromQuery`, "auth=fromCookie")).toBe("fromQuery");
  });

  test("null when there is nothing usable", () => {
    expect(pipelineToken(base, null)).toBeNull();
    expect(pipelineToken(`${base}?auth=`, null)).toBeNull();
    expect(pipelineToken("not a url", null)).toBeNull();
    expect(pipelineToken(base, "theme=dark")).toBeNull();
  });
});

describe("what a default grant actually sees", () => {
  test("friend and own-user events, which is what DEFAULT_SCOPES covers", () => {
    const granted = new Set<Scope>(DEFAULT_SCOPES);
    for (const type of [
      "friend-online",
      "friend-location",
      "friend-update",
      "user-update",
    ] as const) {
      expect(granted.has(PIPELINE_EVENT_SCOPES[type])).toBe(true);
    }
  });

  test("not notifications or groups, which have to be asked for", () => {
    // Worth stating rather than discovering: an app that cannot request scopes — one sending a real
    // password, which is most of them — gets DEFAULT_SCOPES and a socket with no notifications on
    // it. `**` in the password field is how such an app asks for everything.
    const granted = new Set<Scope>(DEFAULT_SCOPES);
    expect(granted.has(PIPELINE_EVENT_SCOPES.notification)).toBe(false);
    expect(granted.has(PIPELINE_EVENT_SCOPES["group-joined"])).toBe(false);

    const everything = new Set<Scope>(expandSuperWildcard());
    expect(everything.has(PIPELINE_EVENT_SCOPES.notification)).toBe(true);
    expect(everything.has(PIPELINE_EVENT_SCOPES["group-joined"])).toBe(true);
  });
});

describe("revocation is per grant", () => {
  test("closes one app's sockets and leaves the others alone", () => {
    // PLAN.md is specific: revoking an app's access to one account must not touch the others, and
    // one account can legitimately have several apps attached at once.
    const mirror = new PipelineMirror();
    const revoked = sink();
    const kept = sink();
    mirror.subscribe("usr_a", ["friends:read"], revoked, "grant_1");
    mirror.subscribe("usr_a", ["friends:read"], kept, "grant_2");

    expect(mirror.disconnectGrant("grant_1")).toBe(1);
    expect(revoked.closed).toBe(true);
    expect(kept.closed).toBe(false);
    expect(mirror.subscriberCount).toBe(1);
  });

  test("a revoked socket stops receiving, not merely stops being counted", () => {
    // The reason closing matters at all: a grant is checked once at the handshake, so a socket left
    // open would keep streaming a revoked app events until it happened to reconnect.
    const mirror = new PipelineMirror();
    const client = sink();
    mirror.subscribe("usr_a", ["friends:read"], client, "grant_1");

    mirror.disconnectGrant("grant_1");
    mirror.publish("usr_a", decoded(FRIEND_ONLINE));
    expect(client.sent).toEqual([]);
  });

  test("socketsForGrant counts only that grant's sockets", () => {
    const mirror = new PipelineMirror();
    mirror.subscribe("usr_a", ["friends:read"], sink(), "grant_1");
    mirror.subscribe("usr_a", ["friends:read"], sink(), "grant_1");
    mirror.subscribe("usr_b", ["friends:read"], sink(), "grant_2");

    expect(mirror.socketsForGrant("grant_1")).toBe(2);
    expect(mirror.socketsForGrant("grant_2")).toBe(1);
    expect(mirror.socketsForGrant("grant_nope")).toBe(0);
  });

  test("revoking a grant with no live socket is not an error", () => {
    expect(new PipelineMirror().disconnectGrant("grant_1")).toBe(0);
  });
});
