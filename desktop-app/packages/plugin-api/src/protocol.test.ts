import { describe, expect, test } from "bun:test";
import {
  applyOverflow,
  authorizeCall,
  coalesceByKey,
  compileFilter,
  type DeliveryPolicy,
  deadlineIn,
  decodeEnvelope,
  defineMethod,
  type Envelope,
  encodeEnvelope,
  exceedsFrameCap,
  FRAME_TAGS,
  isExpired,
  isFrameAllowedFrom,
  MAX_BATCH_EVENTS,
  MAX_DEADLINE_HORIZON_MS,
  MAX_FRAME_BYTES,
  MAX_JSON_DEPTH,
  type MethodTable,
  OVERFLOW_POLICIES,
  type PluginEvent,
  type PluginGrant,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_ERRORS,
  parseEnvelope,
  type RequestFrame,
  readKeyPath,
} from "./protocol.ts";

const NOW = 1_700_000_000_000;

function event(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return { kind: "friend.location", accountId: "usr_a", ts: NOW, ...overrides };
}

/** One legal instance of every frame kind, so the round-trip test is exhaustive by construction. */
const SAMPLES: Record<Envelope["t"], Envelope> = {
  req: {
    t: "req",
    id: "1",
    method: "vrchat.friends.list",
    deadline: NOW + 5_000,
    params: { n: 1 },
  },
  res: { t: "res", id: "1", result: { ok: true } },
  err: {
    t: "err",
    id: "1",
    error: { code: "E_RATE_LIMIT", message: "budget spent", retryAfterMs: 1_500 },
  },
  subscribe: {
    t: "subscribe",
    id: "2",
    deadline: NOW + 5_000,
    sub: "s1",
    filter: { kinds: ["friend.*", "gamelog.player_join"], accountIds: ["usr_a"] },
    delivery: { credits: 100, maxBatch: 32, overflow: "coalesce", keyPath: "userId" },
  },
  unsubscribe: { t: "unsubscribe", id: "3", deadline: NOW + 5_000, sub: "s1" },
  event: { t: "event", sub: "s1", seq: 7, events: [event({ payload: { userId: "usr_b" } })] },
  dropped: { t: "dropped", sub: "s1", count: 800, reason: "coalesced", seq: 907 },
  credit: { t: "credit", sub: "s1", credits: 32 },
  hello: { t: "hello", protocol: 0, pluginId: "com.example.plugin" },
  lifecycle: { t: "lifecycle", id: "4", deadline: NOW + 5_000, phase: "activate" },
  ping: { t: "ping", nonce: "n1", deadline: NOW + 2_000 },
  pong: { t: "pong", nonce: "n1", rss: 41_000_000 },
};

describe("envelope round-trip", () => {
  test("every frame tag has a sample", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...FRAME_TAGS].sort());
  });

  for (const tag of FRAME_TAGS) {
    test(`${tag} survives encode and decode unchanged`, () => {
      const frame = SAMPLES[tag];
      const encoded = encodeEnvelope(frame);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;

      const decoded = decodeEnvelope(encoded.value, { now: NOW });
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.value).toEqual(frame);
    });
  }
});

describe("malformed frames are rejected, never thrown on", () => {
  test("an unknown tag is rejected", () => {
    const result = parseEnvelope({ t: "evaluate", code: "1+1" }, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_PROTOCOL");
    expect(result.message).toContain("Unknown frame tag");
  });

  test.each([
    ["not an object", 42],
    ["null", null],
    ["an array", []],
    ["no tag at all", { id: "1" }],
    ["a non-string tag", { t: 7 }],
    ["a request with no method", { t: "req", id: "1", deadline: NOW }],
    ["a request with no deadline", { t: "req", id: "1", method: "a.b" }],
    ["a request with a fractional deadline", { t: "req", id: "1", method: "a.b", deadline: 1.5 }],
    ["a request with an empty id", { t: "req", id: "", method: "a.b", deadline: NOW }],
    [
      "an error frame with an invented code",
      { t: "err", id: "1", error: { code: "E_NOPE", message: "" } },
    ],
    ["an event frame whose events are not an array", { t: "event", sub: "s", seq: 0, events: {} }],
    [
      "an event with an ISO timestamp",
      {
        t: "event",
        sub: "s",
        seq: 0,
        events: [{ kind: "a.b", accountId: null, ts: "2026-01-01T00:00:00Z" }],
      },
    ],
    ["a credit frame granting zero", { t: "credit", sub: "s", credits: 0 }],
    ["a pong with a negative rss", { t: "pong", nonce: "n", rss: -1 }],
  ])("%s", (_label, value) => {
    let result: ReturnType<typeof parseEnvelope> | undefined;
    expect(() => {
      result = parseEnvelope(value, { now: NOW });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
  });

  test("invalid JSON is a result, not an exception", () => {
    const result = decodeEnvelope("{not json", { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_PROTOCOL");
  });

  test("a deep nest is refused rather than walked", () => {
    let params = "1";
    for (let i = 0; i < MAX_JSON_DEPTH + 10; i++) params = `[${params}]`;
    const result = decodeEnvelope(
      `{"t":"req","id":"1","method":"a.b","deadline":${NOW},"params":${params}}`,
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_TOO_LARGE");
  });

  test("NaN cannot reach a handler as a number", () => {
    const result = parseEnvelope(
      { t: "req", id: "1", method: "a.b", deadline: NOW, params: { n: Number.NaN } },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
  });
});

describe("direction", () => {
  test("a plugin may not forge an event frame", () => {
    expect(isFrameAllowedFrom("event", "plugin")).toBe(false);
    const result = parseEnvelope(SAMPLES.event, { from: "plugin", now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("may not send");
  });

  test("the same frame from the host is accepted", () => {
    expect(parseEnvelope(SAMPLES.event, { from: "host", now: NOW }).ok).toBe(true);
  });

  test("requests flow both ways", () => {
    expect(parseEnvelope(SAMPLES.req, { from: "plugin", now: NOW }).ok).toBe(true);
    expect(parseEnvelope(SAMPLES.req, { from: "host", now: NOW }).ok).toBe(true);
  });
});

describe("size caps", () => {
  test("an oversized frame is refused before it is parsed", () => {
    const huge = `{"t":"res","id":"1","result":"${"x".repeat(MAX_FRAME_BYTES)}"}`;
    const result = decodeEnvelope(huge, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_TOO_LARGE");
  });

  test("the sender refuses to encode an oversized frame", () => {
    const result = encodeEnvelope({ t: "res", id: "1", result: "x".repeat(MAX_FRAME_BYTES) });
    expect(result.ok).toBe(false);
  });

  test("multi-byte characters count as bytes, not code units", () => {
    // Three bytes each, so a string of a third the cap in code units is at the cap in bytes.
    expect(exceedsFrameCap("あ".repeat(Math.floor(MAX_FRAME_BYTES / 3) + 10))).toBe(true);
    expect(exceedsFrameCap("あ".repeat(10))).toBe(false);
  });

  test("an over-long event batch is refused", () => {
    const result = parseEnvelope(
      {
        t: "event",
        sub: "s1",
        seq: 0,
        events: Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => event()),
      },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_TOO_LARGE");
  });
});

describe("deadlines", () => {
  test("a deadline in the past is recognised as expired", () => {
    expect(isExpired(NOW - 1, NOW)).toBe(true);
    expect(isExpired(NOW, NOW)).toBe(true);
    expect(isExpired(NOW + 1, NOW)).toBe(false);
  });

  test("an expired deadline still parses - expiry is the caller's business", () => {
    const result = parseEnvelope(
      { t: "req", id: "1", method: "a.b", deadline: NOW - 60_000 },
      { now: NOW },
    );
    expect(result.ok).toBe(true);
  });

  test("a deadline beyond the horizon is rejected", () => {
    const result = parseEnvelope(
      { t: "req", id: "1", method: "a.b", deadline: NOW + MAX_DEADLINE_HORIZON_MS + 1 },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
  });

  test("deadlineIn produces an absolute instant clamped to the horizon", () => {
    expect(deadlineIn(5_000, NOW)).toBe(NOW + 5_000);
    expect(deadlineIn(Number.MAX_SAFE_INTEGER, NOW)).toBe(NOW + MAX_DEADLINE_HORIZON_MS);
    expect(deadlineIn(-1, NOW)).toBe(NOW);
  });
});

describe("filters", () => {
  test("a wildcard kind matches its family and nothing else", () => {
    const match = compileFilter({ kinds: ["gamelog.*"] });
    expect(match(event({ kind: "gamelog.player_join" }))).toBe(true);
    expect(match(event({ kind: "gamelog.world_enter" }))).toBe(true);
    expect(match(event({ kind: "friend.online" }))).toBe(false);
  });

  test("a literal kind matches exactly", () => {
    const match = compileFilter({ kinds: ["friend.online"] });
    expect(match(event({ kind: "friend.online" }))).toBe(true);
    expect(match(event({ kind: "friend.offline" }))).toBe(false);
  });

  test("an empty filter matches everything, including a kind this build never heard of", () => {
    const match = compileFilter({});
    expect(match(event({ kind: "future.invented_by_a_newer_daemon" }))).toBe(true);
  });

  test("fields are ANDed and values ORed", () => {
    const match = compileFilter({ kinds: ["friend.online"], accountIds: ["usr_a", "usr_b"] });
    expect(match(event({ kind: "friend.online", accountId: "usr_b" }))).toBe(true);
    expect(match(event({ kind: "friend.online", accountId: "usr_c" }))).toBe(false);
    expect(match(event({ kind: "friend.offline", accountId: "usr_a" }))).toBe(false);
  });

  test("an account-scoped filter never matches an unlinked session event", () => {
    const match = compileFilter({ accountIds: ["usr_a"] });
    expect(match(event({ accountId: null }))).toBe(false);
  });

  test("a subject filter needs a subject", () => {
    const match = compileFilter({ subjectIds: ["usr_b"] });
    expect(match(event({ subjectId: "usr_b" }))).toBe(true);
    expect(match(event({ subjectId: null }))).toBe(false);
    expect(match(event())).toBe(false);
  });

  test("a filter is data, so an invented operator does not parse", () => {
    const result = parseEnvelope(
      {
        ...SAMPLES.subscribe,
        filter: { kinds: ["friend.online || true"] },
      },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
  });
});

describe("delivery policy validation", () => {
  test("coalesce without a keyPath is refused", () => {
    const result = parseEnvelope(
      { ...SAMPLES.subscribe, delivery: { credits: 10, maxBatch: 4, overflow: "coalesce" } },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
  });

  test("a keyPath without coalesce is refused rather than ignored", () => {
    const result = parseEnvelope(
      {
        ...SAMPLES.subscribe,
        delivery: { credits: 10, maxBatch: 4, overflow: "drop-oldest", keyPath: "userId" },
      },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
  });

  test("an unknown overflow policy is refused", () => {
    const result = parseEnvelope(
      { ...SAMPLES.subscribe, delivery: { credits: 10, maxBatch: 4, overflow: "block" } },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
  });
});

describe("key paths", () => {
  test("a bare segment that is not an event field resolves against the payload", () => {
    expect(readKeyPath(event({ payload: { userId: "usr_b" } }), "userId")).toBe("usr_b");
  });

  test("an event field is addressable directly", () => {
    expect(readKeyPath(event({ subjectId: "usr_c" }), "subjectId")).toBe("usr_c");
  });

  test("the explicit payload path works too", () => {
    expect(readKeyPath(event({ payload: { userId: "usr_b" } }), "payload.userId")).toBe("usr_b");
  });

  test("a path resolving to a non-primitive makes the event uncoalescable", () => {
    expect(readKeyPath(event({ payload: { userId: { id: "x" } } }), "userId")).toBeUndefined();
    expect(readKeyPath(event(), "nothing.here")).toBeUndefined();
  });
});

describe("overflow policies", () => {
  const base: DeliveryPolicy = { credits: 3, maxBatch: 3, overflow: "drop-newest" };
  const located = (userId: string, ts: number): PluginEvent =>
    event({ ts, payload: { userId, location: `wrld_${ts}` } });

  test("every policy is exercised by name", () => {
    expect([...OVERFLOW_POLICIES].sort()).toEqual([
      "coalesce",
      "disconnect",
      "drop-newest",
      "drop-oldest",
    ]);
  });

  test("drop-newest keeps the head of the burst", () => {
    let queue: PluginEvent[] = [located("a", 1), located("b", 2), located("c", 3)];
    const result = applyOverflow(queue, located("d", 4), base);
    queue = result.queue;
    expect(result.dropped).toBe(1);
    expect(result.close).toBe(false);
    expect(queue.map((e) => e.ts)).toEqual([1, 2, 3]);
  });

  test("drop-oldest keeps the tail of the burst", () => {
    const policy: DeliveryPolicy = { ...base, overflow: "drop-oldest" };
    const result = applyOverflow(
      [located("a", 1), located("b", 2), located("c", 3)],
      located("d", 4),
      policy,
    );
    expect(result.dropped).toBe(1);
    expect(result.queue.map((e) => e.ts)).toEqual([2, 3, 4]);
  });

  test("disconnect closes the subscription rather than guessing", () => {
    const policy: DeliveryPolicy = { ...base, overflow: "disconnect" };
    const result = applyOverflow(
      [located("a", 1), located("b", 2), located("c", 3)],
      located("d", 4),
      policy,
    );
    expect(result.close).toBe(true);
  });

  test("coalesce keeps the newest per key and drops the rest", () => {
    const policy: DeliveryPolicy = {
      credits: 100,
      maxBatch: 32,
      overflow: "coalesce",
      keyPath: "userId",
    };
    // Three friends moving repeatedly: the 900-event backlog PLAN.md is worried about, in miniature.
    let queue: PluginEvent[] = [];
    let dropped = 0;
    for (let i = 0; i < 30; i++) {
      const result = applyOverflow(queue, located(["a", "b", "c"][i % 3] ?? "a", i), policy);
      queue = result.queue;
      dropped += result.dropped;
    }
    expect(queue).toHaveLength(3);
    expect(dropped).toBe(27);
    // Each friend's *current* location, not a path they have already left.
    expect(queue.map((e) => e.ts)).toEqual([27, 28, 29]);
  });

  test("coalesce keeps the first slot for a key, so a chatty key cannot starve a quiet one", () => {
    const policy: DeliveryPolicy = {
      credits: 100,
      maxBatch: 32,
      overflow: "coalesce",
      keyPath: "userId",
    };
    const { kept, dropped } = coalesceByKey(
      [located("a", 1), located("b", 2), located("a", 3), located("a", 4)],
      "userId",
    );
    expect(dropped).toBe(2);
    expect(kept.map((e) => e.ts)).toEqual([4, 2]);
    expect(policy.keyPath).toBe("userId");
  });

  test("uncoalescable events queue normally", () => {
    const policy: DeliveryPolicy = {
      credits: 100,
      maxBatch: 32,
      overflow: "coalesce",
      keyPath: "userId",
    };
    const { kept, dropped } = coalesceByKey([event({ ts: 1 }), event({ ts: 2 })], "userId");
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(2);
    expect(policy.overflow).toBe("coalesce");
  });

  test("a coalesce subscription with all-distinct keys degrades to a ring buffer", () => {
    const policy: DeliveryPolicy = {
      credits: 2,
      maxBatch: 2,
      overflow: "coalesce",
      keyPath: "userId",
    };
    const result = applyOverflow([located("a", 1), located("b", 2)], located("c", 3), policy);
    expect(result.dropped).toBe(1);
    expect(result.queue.map((e) => e.ts)).toEqual([2, 3]);
  });
});

describe("error taxonomy", () => {
  test("E_RATE_LIMIT carries retryAfterMs through the wire", () => {
    const encoded = encodeEnvelope(SAMPLES.err);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeEnvelope(encoded.value, { now: NOW });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.value.t !== "err") return;
    expect(decoded.value.error.code).toBe("E_RATE_LIMIT");
    expect(decoded.value.error.retryAfterMs).toBe(1_500);
    expect(PROTOCOL_ERRORS.E_RATE_LIMIT.retryable).toBe(true);
  });

  test("a retryAfterMs beyond the horizon is refused", () => {
    const result = parseEnvelope(
      {
        t: "err",
        id: "1",
        error: { code: "E_RATE_LIMIT", message: "x", retryAfterMs: MAX_DEADLINE_HORIZON_MS + 1 },
      },
      { now: NOW },
    );
    expect(result.ok).toBe(false);
  });

  test("every code has a description", () => {
    for (const code of PROTOCOL_ERROR_CODES) {
      expect(PROTOCOL_ERRORS[code].description.length).toBeGreaterThan(0);
    }
  });
});

describe("dispatcher contract", () => {
  const grant: PluginGrant = {
    pluginId: "com.example.plugin",
    scopes: ["friends:read"],
    accountIds: ["usr_a"],
    capabilities: [],
    events: ["*"],
  };

  const table: MethodTable = {
    "vrchat.friends.list": defineMethod<{ n: number }, { count: number }>({
      scope: "friends:read",
      capability: null,
      cost: 1,
      parse: (raw) =>
        typeof raw === "object" && raw !== null && !Array.isArray(raw) && typeof raw.n === "number"
          ? { ok: true, value: { n: raw.n } }
          : { ok: false, code: "E_BAD_REQUEST", message: "n must be a number" },
      handle: async (params) => ({ count: params.n }),
    }),
    "moderation.block": defineMethod<null, undefined>({
      scope: "moderation:write",
      capability: null,
      cost: 1,
      parse: () => ({ ok: true, value: null }),
      handle: async () => undefined,
    }),
    "ui.setPanel": defineMethod<null, undefined>({
      scope: null,
      capability: null,
      cost: 0,
      parse: () => ({ ok: true, value: null }),
      handle: async () => undefined,
    }),
  };

  const request = (method: string, deadline = NOW + 1_000): RequestFrame => ({
    t: "req",
    id: "1",
    method,
    deadline,
  });

  test("a granted method authorizes", () => {
    const result = authorizeCall(table, request("vrchat.friends.list"), grant, NOW);
    expect(result.ok).toBe(true);
  });

  test("an ungranted scope is refused before the handler runs", () => {
    const result = authorizeCall(table, request("moderation.block"), grant, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_SCOPE_DENIED");
  });

  test("a method needing no scope is reachable", () => {
    expect(authorizeCall(table, request("ui.setPanel"), grant, NOW).ok).toBe(true);
  });

  test("an unknown method is refused", () => {
    const result = authorizeCall(table, request("node:fs.readFile"), grant, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_UNKNOWN_METHOD");
  });

  test("an already-expired call never reaches the handler", () => {
    const result = authorizeCall(table, request("vrchat.friends.list", NOW - 1), grant, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_TIMEOUT");
  });

  test("parse failure is reported as a result, and the handler is not called", async () => {
    const method = table["vrchat.friends.list"];
    expect(method).toBeDefined();
    if (!method) return;
    const ctx = {
      grant,
      deadline: NOW + 1_000,
      signal: AbortSignal.abort(),
    };
    const bad = await method.invoke({ n: "one" }, ctx);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("E_BAD_REQUEST");

    const good = await method.invoke({ n: 3 }, ctx);
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.value).toEqual({ count: 3 });
  });
});
