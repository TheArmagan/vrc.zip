import { describe, expect, test } from "bun:test";
import type { Envelope, ErrorFrame, PluginGrant, RequestFrame } from "@vrcz/plugin-api";
import type { JsonValue } from "@vrcz/shared";
import { PluginBudget } from "./budget.ts";
import {
  DispatchError,
  type PluginCallRecord,
  type PluginChannel,
  PluginDispatcher,
} from "./dispatcher.ts";
import { defineGatedMethod, type GatedMethodTable } from "./scope-gate.ts";

const GRANT: PluginGrant = {
  pluginId: "p",
  scopes: ["friends:read", "invite:send"],
  accountIds: ["usr_a"],
  capabilities: [],
};

function channel(): PluginChannel & { sent: Envelope[] } {
  const sent: Envelope[] = [];
  return {
    pluginId: "p",
    sent,
    send(frame) {
      sent.push(frame);
      return true;
    },
  };
}

interface Harness {
  readonly dispatcher: PluginDispatcher;
  readonly peer: PluginChannel & { sent: Envelope[] };
  readonly calls: PluginCallRecord[];
  readonly seen: { params: JsonValue | undefined; accountId: string | undefined }[];
}

function harness(
  options: {
    handle?: (params: JsonValue | undefined) => Promise<JsonValue | undefined>;
    grant?: PluginGrant | null;
    budget?: PluginBudget;
    maxInFlight?: number;
  } = {},
): Harness {
  const seen: Harness["seen"] = [];
  const calls: PluginCallRecord[] = [];
  const table: GatedMethodTable = {
    "test.read": defineGatedMethod("required", {
      scope: "friends:read",
      capability: null,
      cost: 1,
      parse: (raw) => {
        if (raw !== undefined && typeof raw !== "object") {
          return { ok: false, code: "E_BAD_REQUEST", message: "params must be an object" };
        }
        return { ok: true, value: raw };
      },
      handle: async (params, ctx) => {
        seen.push({ params, accountId: ctx.accountId });
        return options.handle ? await options.handle(params) : "ok";
      },
    }),
    "test.invite": defineGatedMethod("required", {
      scope: "invite:send",
      capability: null,
      cost: 1,
      parse: (raw) => ({ ok: true, value: raw }),
      handle: () => Promise.resolve("sent"),
    }),
  };

  const peer = channel();
  const dispatcher = new PluginDispatcher({
    table,
    grants: () => (options.grant === undefined ? GRANT : options.grant),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
    onCall: (record) => calls.push(record),
  });
  dispatcher.attach(peer);
  return { dispatcher, peer, calls, seen };
}

function req(method: string, params?: JsonValue, id = "1", timeoutMs = 5_000): RequestFrame {
  return {
    t: "req",
    id,
    method,
    deadline: Date.now() + timeoutMs,
    ...(params === undefined ? {} : { params }),
  };
}

function errorOf(frame: Envelope | undefined): ErrorFrame["error"] {
  if (frame === undefined || frame.t !== "err")
    throw new Error(`expected an err frame, got ${frame?.t}`);
  return frame.error;
}

/** Lets the dispatched promise chain settle without leaning on a timer. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("inbound calls", () => {
  test("answers a granted call with a res frame, and the handler sees parsed params only", async () => {
    const h = harness();
    h.dispatcher.handleFrame("p", req("test.read", { n: 5 }));
    await settle();

    expect(h.peer.sent).toEqual([{ t: "res", id: "1", result: "ok" }]);
    expect(h.seen).toEqual([{ params: { n: 5 }, accountId: "usr_a" }]);
    expect(h.calls[0]?.code).toBeNull();
    expect(h.calls[0]?.scope).toBe("friends:read");
    expect(h.calls[0]?.accountId).toBe("usr_a");
  });

  test("a plugin with no live grant is refused before anything else runs", async () => {
    const h = harness({ grant: null });
    h.dispatcher.handleFrame("p", req("test.read"));
    await settle();
    expect(errorOf(h.peer.sent[0]).code).toBe("E_SCOPE_DENIED");
    expect(h.seen).toHaveLength(0);
  });

  test("an unknown method is a refusal, never a silent pass", async () => {
    const h = harness();
    h.dispatcher.handleFrame("p", req("test.nope"));
    await settle();
    expect(errorOf(h.peer.sent[0]).code).toBe("E_UNKNOWN_METHOD");
  });

  test("a scope the grant does not hold never reaches the handler", async () => {
    const h = harness({
      grant: { pluginId: "p", scopes: [], accountIds: ["usr_a"], capabilities: [] },
    });
    h.dispatcher.handleFrame("p", req("test.read"));
    await settle();
    expect(errorOf(h.peer.sent[0]).code).toBe("E_SCOPE_DENIED");
    expect(h.seen).toHaveLength(0);
  });

  test("a parse failure is the method's own error and costs the plugin only that call", async () => {
    const h = harness();
    h.dispatcher.handleFrame("p", req("test.read", "not an object"));
    await settle();
    expect(errorOf(h.peer.sent[0]).code).toBe("E_BAD_REQUEST");
  });

  test("a handler's DispatchError reaches the plugin; anything else becomes E_INTERNAL", async () => {
    const declared = harness({
      handle: () =>
        Promise.reject(new DispatchError("E_UPSTREAM", "VRChat answered 503.", { data: 503 })),
    });
    declared.dispatcher.handleFrame("p", req("test.read"));
    await settle();
    expect(errorOf(declared.peer.sent[0])).toEqual({
      code: "E_UPSTREAM",
      message: "VRChat answered 503.",
      data: 503,
    });

    const leaky = harness({
      handle: () => Promise.reject(new Error("ENOENT /home/user/.vrczip/secrets.json")),
    });
    leaky.dispatcher.handleFrame("p", req("test.read"));
    await settle();
    const error = errorOf(leaky.peer.sent[0]);
    expect(error.code).toBe("E_INTERNAL");
    expect(error.message).not.toContain("secrets.json");
  });
});

describe("the rate budget", () => {
  test("refuses past the allowance with a retryAfterMs, and never reaches the handler", async () => {
    const budget = new PluginBudget({ limits: { "invite:send": 1 } });
    const h = harness({ budget });
    h.dispatcher.handleFrame("p", req("test.invite", undefined, "1"));
    await settle();
    h.dispatcher.handleFrame("p", req("test.invite", undefined, "2"));
    await settle();

    expect(h.peer.sent[0]?.t).toBe("res");
    const error = errorOf(h.peer.sent[1]);
    expect(error.code).toBe("E_RATE_LIMIT");
    expect(error.retryAfterMs).toBeGreaterThan(0);
    expect(h.calls[1]?.code).toBe("E_RATE_LIMIT");
  });

  test("an unbudgeted scope is not metered by it at all", async () => {
    const budget = new PluginBudget({ limits: { "invite:send": 1 } });
    const h = harness({ budget });
    for (let i = 0; i < 5; i++) {
      h.dispatcher.handleFrame("p", req("test.read", undefined, String(i)));
      await settle();
    }
    expect(h.peer.sent.every((frame) => frame.t === "res")).toBe(true);
  });
});

describe("deadlines", () => {
  test("answers E_TIMEOUT at the deadline and drops the handler's late result", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      handle: () =>
        new Promise<JsonValue>((resolve) => {
          release = () => resolve("late");
        }),
    });

    h.dispatcher.handleFrame("p", req("test.read", undefined, "1", 5));
    await Bun.sleep(30);
    expect(errorOf(h.peer.sent[0]).code).toBe("E_TIMEOUT");

    release?.();
    await settle();
    // One reply per id, ever. The handler finishing afterwards must not produce a second frame.
    expect(h.peer.sent).toHaveLength(1);
  });

  test("the handler's signal is aborted when the deadline passes", async () => {
    let aborted = false;
    const table: GatedMethodTable = {
      "test.slow": defineGatedMethod("none", {
        scope: null,
        capability: null,
        cost: 0,
        parse: (raw) => ({ ok: true, value: raw }),
        handle: (_params, ctx) =>
          new Promise<JsonValue>((resolve) => {
            ctx.signal.addEventListener("abort", () => {
              aborted = true;
              resolve(null);
            });
          }),
      }),
    };
    const peer = channel();
    const dispatcher = new PluginDispatcher({ table, grants: () => GRANT });
    dispatcher.attach(peer);
    dispatcher.handleFrame("p", req("test.slow", undefined, "1", 5));
    await Bun.sleep(30);
    expect(aborted).toBe(true);
  });
});

describe("the in-flight cap", () => {
  test("answers the excess with E_RATE_LIMIT rather than queueing it", async () => {
    const gates: (() => void)[] = [];
    const h = harness({
      maxInFlight: 2,
      handle: () =>
        new Promise<JsonValue>((resolve) => {
          gates.push(() => resolve("ok"));
        }),
    });

    for (const id of ["1", "2", "3"])
      h.dispatcher.handleFrame("p", req("test.read", undefined, id));
    await settle();

    expect(h.dispatcher.inFlight("p")).toBe(2);
    const error = errorOf(h.peer.sent[0]);
    expect(error.code).toBe("E_RATE_LIMIT");
    expect(error.retryAfterMs).toBeGreaterThan(0);
    for (const open of gates) open();
    await settle();
  });
});

describe("outbound calls", () => {
  test("resolves on the plugin's res frame", async () => {
    const h = harness();
    const pending = h.dispatcher.call("p", "ui.intent", { name: "refresh" });
    const sent = h.peer.sent[0];
    if (sent?.t !== "req") throw new Error("expected a req frame");
    expect(sent.method).toBe("ui.intent");
    // The deadline rides the wire as an absolute instant, never as a duration.
    expect(sent.deadline).toBeGreaterThan(Date.now());

    h.dispatcher.handleFrame("p", { t: "res", id: sent.id, result: "done" });
    expect(await pending).toBe("done");
  });

  test("rejects at the deadline, and a reply that arrives afterwards is dropped", async () => {
    const h = harness();
    const pending = h.dispatcher.call("p", "ui.intent", undefined, 5);
    const sent = h.peer.sent[0];
    if (sent?.t !== "req") throw new Error("expected a req frame");

    await expect(pending).rejects.toThrow(/deadline/);
    // Nothing to settle: the entry is gone, so a late reply cannot resurrect a finished call.
    expect(h.dispatcher.handleFrame("p", { t: "res", id: sent.id, result: "late" })).toBe(true);
  });

  test("an err frame rejects with the plugin's own code", async () => {
    const h = harness();
    const pending = h.dispatcher.call("p", "ui.intent");
    const sent = h.peer.sent[0];
    if (sent?.t !== "req") throw new Error("expected a req frame");
    h.dispatcher.handleFrame("p", {
      t: "err",
      id: sent.id,
      error: { code: "E_QUOTA", message: "full" },
    });
    await expect(pending).rejects.toMatchObject({ code: "E_QUOTA" });
  });

  test("detaching aborts in-flight work and fails outstanding calls", async () => {
    const h = harness({ handle: () => new Promise<JsonValue>(() => undefined) });
    const pending = h.dispatcher.call("p", "ui.intent");
    h.dispatcher.handleFrame("p", req("test.read"));
    await settle();

    h.dispatcher.detach("p");
    await expect(pending).rejects.toMatchObject({ code: "E_CANCELLED" });
    expect(h.dispatcher.inFlight("p")).toBe(0);
  });

  test("calling a plugin that is not attached fails rather than hanging", async () => {
    const h = harness();
    await expect(h.dispatcher.call("gone", "ui.intent")).rejects.toMatchObject({
      code: "E_UNAVAILABLE",
    });
  });
});
