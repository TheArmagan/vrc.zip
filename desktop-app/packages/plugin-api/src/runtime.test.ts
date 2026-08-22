/**
 * The plugin-side runtime, driven through a fake host seam.
 *
 * A fake rather than a spawned process on purpose: what is being tested is the correlation, the
 * credit accounting and the lifecycle answers, all of which are pure frame handling. The real
 * process path is covered by the supervisor's own tests and by the hostile suite.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { __resetRuntimeForTests, definePlugin, getContext, PluginCallError } from "./runtime.ts";

interface FakeHost {
  readonly pluginId: string;
  readonly protocol: number;
  send(frame: unknown): boolean;
  onFrame(handler: (frame: Record<string, unknown>) => void): void;
  log(message: unknown): void;
}

let sent: Record<string, unknown>[] = [];
let deliver: (frame: Record<string, unknown>) => void = () => {};
let logs: unknown[] = [];

function installHost(options: { refuseSend?: boolean } = {}): void {
  sent = [];
  logs = [];
  const host: FakeHost = {
    pluginId: "acme.notes",
    protocol: 1,
    send(frame) {
      if (options.refuseSend === true) return false;
      sent.push(frame as Record<string, unknown>);
      return true;
    },
    onFrame(handler) {
      deliver = handler;
    },
    log(message) {
      logs.push(message);
    },
  };
  (globalThis as { __vrczHost?: FakeHost }).__vrczHost = host;
}

/** Answers the most recent request frame the way the host would. */
function answer(result: unknown): void {
  const last = sent.at(-1);
  deliver({ t: "res", id: String(last?.id), result });
}

afterEach(() => {
  __resetRuntimeForTests();
  delete (globalThis as { __vrczHost?: FakeHost }).__vrczHost;
});

describe("definePlugin", () => {
  test("an activate frame calls the hook and is answered on the same id", async () => {
    installHost();
    const seen: string[] = [];
    definePlugin({
      activate(ctx) {
        seen.push(ctx.pluginId);
        return { ready: true };
      },
    });

    deliver({ t: "lifecycle", id: "L1", deadline: Date.now() + 1000, phase: "activate" });
    await Bun.sleep(1);

    expect(seen).toEqual(["acme.notes"]);
    expect(sent.at(-1)).toEqual({ t: "res", id: "L1", result: { ready: true } });
  });

  /**
   * The distinction the supervisor cannot make for itself: a hook that throws must come back as an
   * error on that id. Swallowed, it is a plugin that never answers, and "threw during activate" and
   * "spin loop" become the same observation.
   */
  test("a hook that throws answers err, not silence", async () => {
    installHost();
    definePlugin({
      activate() {
        throw new Error("no database");
      },
    });

    deliver({ t: "lifecycle", id: "L1", deadline: Date.now() + 1000, phase: "activate" });
    await Bun.sleep(1);

    expect(sent.at(-1)).toMatchObject({ t: "err", id: "L1", error: { code: "E_INTERNAL" } });
  });

  test("a plugin with no hook for a phase still answers it", async () => {
    installHost();
    definePlugin({});
    deliver({ t: "lifecycle", id: "L9", deadline: Date.now() + 1000, phase: "deactivate" });
    await Bun.sleep(1);
    expect(sent.at(-1)).toEqual({ t: "res", id: "L9", result: null });
  });

  test("calling it twice is an error, because there is one frame handler", () => {
    installHost();
    definePlugin({});
    expect(() => definePlugin({})).toThrow(/twice/);
  });

  test("without a host seam it says where it is meant to run", () => {
    delete (globalThis as { __vrczHost?: FakeHost }).__vrczHost;
    expect(() => definePlugin({})).toThrow(/inside a vrc.zip plugin process/);
  });
});

describe("calls", () => {
  test("a response resolves the matching promise", async () => {
    installHost();
    definePlugin({});
    const pending = getContext().storage.kv.get("a");
    expect(sent.at(-1)).toMatchObject({ t: "req", method: "storage.kv.get", params: { key: "a" } });
    answer({ n: 1 });
    expect(await pending).toEqual({ n: 1 });
  });

  test("an error frame rejects with the host's own code", async () => {
    installHost();
    definePlugin({});
    const pending = getContext().vrchat.friends.list();
    const last = sent.at(-1);
    deliver({
      t: "err",
      id: String(last?.id),
      error: { code: "E_SCOPE_DENIED", message: "needs friends:read" },
    });

    await expect(pending).rejects.toBeInstanceOf(PluginCallError);
    await expect(pending).rejects.toMatchObject({ code: "E_SCOPE_DENIED" });
  });

  test("two calls in flight settle independently, and a late answer is ignored", async () => {
    installHost();
    definePlugin({});
    const ctx = getContext();
    const first = ctx.storage.kv.get("a");
    const firstId = String(sent.at(-1)?.id);
    const second = ctx.storage.kv.get("b");
    const secondId = String(sent.at(-1)?.id);
    expect(firstId).not.toBe(secondId);

    deliver({ t: "res", id: secondId, result: "second" });
    deliver({ t: "res", id: firstId, result: "first" });
    expect(await first).toBe("first");
    expect(await second).toBe("second");

    // A duplicate answer to a settled id must not throw or resolve anything a second time.
    expect(() => {
      deliver({ t: "res", id: firstId, result: "again" });
    }).not.toThrow();
  });

  test("a send the host refuses rejects rather than hanging", async () => {
    installHost({ refuseSend: true });
    definePlugin({});
    await expect(getContext().storage.kv.get("a")).rejects.toThrow(/refused/);
  });
});

describe("events", () => {
  test("subscribe registers, and a batch reaches the handler", async () => {
    installHost();
    definePlugin({});
    const seen: string[] = [];
    const pending = getContext().events.subscribe((event) => seen.push(event.kind), {
      filter: { kinds: ["friend.online"] },
    });
    const frame = sent.at(-1);
    expect(frame).toMatchObject({ t: "subscribe", filter: { kinds: ["friend.online"] } });
    answer(null);
    const subscription = await pending;

    deliver({
      t: "event",
      sub: subscription.id,
      seq: 1,
      events: [
        { kind: "friend.online", accountId: null, ts: 1 },
        { kind: "friend.offline", accountId: null, ts: 2 },
      ],
    });
    expect(seen).toEqual(["friend.online", "friend.offline"]);
  });

  /**
   * Credit is returned for what was *processed*, after the handlers ran. Returning it on arrival
   * would make the host's credit window a receipt counter rather than backpressure.
   */
  test("credit is returned after delivery, for exactly the batch size", async () => {
    installHost();
    definePlugin({});
    const pending = getContext().events.subscribe(() => {});
    answer(null);
    const subscription = await pending;

    sent.length = 0;
    deliver({
      t: "event",
      sub: subscription.id,
      seq: 1,
      events: [
        { kind: "a", accountId: null, ts: 1 },
        { kind: "b", accountId: null, ts: 2 },
        { kind: "c", accountId: null, ts: 3 },
      ],
    });
    expect(sent).toEqual([{ t: "credit", sub: subscription.id, credits: 3 }]);
  });

  test("a handler that throws does not cost the rest of the batch or the credit", async () => {
    installHost();
    definePlugin({});
    const seen: string[] = [];
    const pending = getContext().events.subscribe((event) => {
      if (event.kind === "b") throw new Error("bad handler");
      seen.push(event.kind);
    });
    answer(null);
    const subscription = await pending;

    sent.length = 0;
    deliver({
      t: "event",
      sub: subscription.id,
      seq: 1,
      events: [
        { kind: "a", accountId: null, ts: 1 },
        { kind: "b", accountId: null, ts: 2 },
        { kind: "c", accountId: null, ts: 3 },
      ],
    });
    expect(seen).toEqual(["a", "c"]);
    expect(sent).toEqual([{ t: "credit", sub: subscription.id, credits: 3 }]);
    expect(logs.some((line) => String(line).includes("threw"))).toBe(true);
  });

  test("a dropped frame reaches onDropped, so a gap is never silent", async () => {
    installHost();
    definePlugin({});
    const drops: { count: number; reason: string }[] = [];
    const pending = getContext().events.subscribe(() => {}, {
      onDropped: (info) => drops.push({ count: info.count, reason: info.reason }),
    });
    answer(null);
    const subscription = await pending;

    deliver({ t: "dropped", sub: subscription.id, count: 897, reason: "coalesced", seq: 4 });
    expect(drops).toEqual([{ count: 897, reason: "coalesced" }]);
  });

  test("a refused subscribe leaves no handler behind", async () => {
    installHost();
    definePlugin({});
    const pending = getContext().events.subscribe(() => {
      throw new Error("must never run");
    });
    const subscribeFrame = sent.at(-1);
    deliver({
      t: "err",
      id: String(subscribeFrame?.id),
      error: { code: "E_SCOPE_DENIED", message: "no" },
    });
    await expect(pending).rejects.toMatchObject({ code: "E_SCOPE_DENIED" });

    sent.length = 0;
    // The sub id the failed subscribe used. An event for it must find nothing.
    deliver({
      t: "event",
      sub: String(subscribeFrame?.sub),
      seq: 1,
      events: [{ kind: "a", accountId: null, ts: 1 }],
    });
    expect(sent).toEqual([]);
  });

  test("close unsubscribes and stops delivery immediately", async () => {
    installHost();
    definePlugin({});
    let count = 0;
    const pending = getContext().events.subscribe(() => {
      count += 1;
    });
    answer(null);
    const subscription = await pending;

    const closing = subscription.close();
    expect(sent.at(-1)).toMatchObject({ t: "unsubscribe", sub: subscription.id });
    answer(null);
    await closing;

    deliver({
      t: "event",
      sub: subscription.id,
      seq: 2,
      events: [{ kind: "a", accountId: null, ts: 1 }],
    });
    expect(count).toBe(0);
  });
});

describe("unknown frames", () => {
  test("a tag this protocol major does not know is ignored, not fatal", () => {
    installHost();
    definePlugin({});
    expect(() => {
      deliver({ t: "something-new-in-protocol-2", id: "x" });
    }).not.toThrow();
  });
});
