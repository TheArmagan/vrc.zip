import { afterAll, describe, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import type { NodeConfigValues, PortValues } from "@vrcz/plugin-api/nodes";
import { DESKTOP_ACTIVATION_KIND } from "@vrcz/shared";
import type { BusEvent } from "../../bus/event-bus.ts";
import { EventBus } from "../../bus/event-bus.ts";
import type { ExecuteContext } from "../types.ts";
import type { GraphNotification } from "./actions.ts";
import { splitInstance } from "./actions.ts";
import { createBuiltinNodes } from "./index.ts";
import { encodeOscMessage } from "./osc.ts";

const T0 = 1_700_000_000_000;

/**
 * A real `Bun.serve`, not a fetch stub.
 *
 * The same reason the VRChat fixture is a real server: the bugs in this layer are HTTP-level —
 * headers, methods, what a 4xx body does to an error message — and a stub agrees with whatever the
 * code already believes.
 */
const received: { path: string; body: string; headers: Record<string, string> }[] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    received.push({
      path: url.pathname,
      body: await request.text(),
      headers: Object.fromEntries(request.headers.entries()),
    });
    if (url.pathname === "/refuse") return new Response("no thanks", { status: 403 });
    return new Response("ok");
  },
});
const base = `http://127.0.0.1:${String(server.port)}`;

afterAll(() => {
  server.stop(true);
});

interface Harness {
  readonly events: BusEvent[];
  readonly sent: { user: string; kind: string }[];
  /** Every desktop notification the run raised. Never a real toast — see the seam. */
  readonly toasts: GraphNotification[];
  readonly bus: EventBus;
  run(
    type: string,
    inputs: PortValues,
    config?: NodeConfigValues,
    context?: Partial<ExecuteContext>,
  ): Promise<PortValues>;
  /** Arms one trigger and hands back the teardown the engine would hold. */
  arm(
    type: string,
    config: NodeConfigValues,
    fire: (values: PortValues) => void,
  ): Promise<() => Promise<void>>;
}

function harness(options: { canNotify?: boolean } = {}): Harness {
  const bus = new EventBus();
  const events: BusEvent[] = [];
  const sent: { user: string; kind: string }[] = [];
  const toasts: GraphNotification[] = [];
  let instances = 0;
  bus.subscribe((event) => {
    events.push(event);
  });
  const nodes = createBuiltinNodes({
    bus,
    now: () => T0,
    social: {
      invite: async (_accountId, user) => {
        sent.push({ user, kind: "invite" });
        await Promise.resolve();
      },
      requestInvite: async (_accountId, user) => {
        sent.push({ user, kind: "request-invite" });
        await Promise.resolve();
      },
      boop: async (_accountId, user) => {
        sent.push({ user, kind: "boop" });
        await Promise.resolve();
      },
      selectAvatar: async (_accountId, avatar) => {
        sent.push({ user: avatar, kind: "wear-avatar" });
        await Promise.resolve();
      },
    },
    // The local server is http and `validateWebhookUrl` refuses that for a good reason, so the
    // fetch seam is where the test server is reached instead of by weakening the check.
    fetch: async (url, init) => await fetch(url.replace("https://vrc.zip.test", base), init),
    /*
     * Injected rather than letting the real notifier through, and not only for assertions: a `bun
     * test` that reached `os/desktop-notification.ts` would spawn PowerShell per test on Windows.
     * (That path suppresses itself under NODE_ENV=test for exactly this reason — this seam means the
     * node's own test does not have to rely on it.)
     */
    ...(options.canNotify === false
      ? {}
      : {
          notify: async (notification) => {
            toasts.push(notification);
            // `shown: false` for a blank body, standing in for an OS that refused it — the case the
            // node's `Shown` port exists to make visible.
            return await Promise.resolve({
              shown: notification.body !== "",
              id: "toast-1",
              // What a machine that cannot draw a button reports. Named rather than empty so the
              // node's `Dropped` port has something to be tested against.
              ignored: notification.buttons === undefined ? [] : ["buttons"],
            });
          },
        }),
  });

  return {
    events,
    sent,
    toasts,
    bus,
    arm: async (type, config, fire) => {
      instances += 1;
      const instanceId = `inst-${String(instances)}`;
      await nodes.arm(`vrcz/${type}`, { instanceId, graphId: "g1", nodeId: "n1", config, fire });
      return async () => {
        await nodes.disarm(`vrcz/${type}`, instanceId);
      };
    },
    run: (type, inputs, config = {}, context = {}) =>
      nodes.execute(`vrcz/${type}`, inputs, config, {
        graphId: "g1",
        runId: "r1",
        nodeId: "n1",
        dryRun: false,
        accountId: "usr_me",
        ...context,
      }),
  };
}

function notes(events: readonly BusEvent[]): string[] {
  return events
    .filter((event) => event.kind === "graph.note")
    .map((event) => String((event.payload as { note?: unknown }).note));
}

describe("http actions", () => {
  test("a webhook posts the wired body as JSON and answers with the status", async () => {
    const h = harness();
    const before = received.length;
    const result = await h.run("webhook", { body: { a: 1 } }, { url: "https://vrc.zip.test/hook" });

    expect(result).toEqual({ status: 200 });
    const call = received[before];
    expect(call?.path).toBe("/hook");
    expect(call?.body).toBe('{"a":1}');
    expect(call?.headers["user-agent"]).toContain("vrc.zip/");
  });

  test("a webhook with only text wraps it, rather than sending a bare string", async () => {
    const h = harness();
    const before = received.length;
    await h.run("webhook", { text: "hello" }, { url: "https://vrc.zip.test/hook" });
    expect(received[before]?.body).toBe('{"text":"hello"}');
  });

  test("a refusal becomes an error naming the status, which the error port can catch", async () => {
    const h = harness();
    await expect(
      h.run("webhook", { text: "x" }, { url: "https://vrc.zip.test/refuse" }),
    ).rejects.toThrow(/403/);
  });

  test("a private address is refused before anything is sent", async () => {
    // The same SSRF check registered webhooks get. A graph is a place a URL gets typed, so it is a
    // place SSRF starts.
    const h = harness();
    await expect(
      h.run("webhook", { text: "x" }, { url: "http://127.0.0.1:9999/hook" }),
    ).rejects.toThrow();
  });

  test("discord sends a content field and clamps an over-long message", async () => {
    const h = harness();
    const before = received.length;
    await h.run(
      "discord",
      { text: "x".repeat(2500) },
      { url: "https://vrc.zip.test/api/webhooks/1/2", username: "vrc.zip" },
    );
    const body = JSON.parse(received[before]?.body ?? "{}") as {
      content: string;
      username: string;
    };
    expect(body.content).toHaveLength(2000);
    expect(body.username).toBe("vrc.zip");
  });

  test("ntfy posts plain text to the topic with its title and priority", async () => {
    const h = harness();
    const before = received.length;
    await h.run(
      "ntfy",
      { text: "Ada is online" },
      { server: "https://vrc.zip.test/", topic: "vrc", title: "Friend", priority: "4" },
    );
    const call = received[before];
    expect(call?.path).toBe("/vrc");
    expect(call?.body).toBe("Ada is online");
    expect(call?.headers.title).toBe("Friend");
    expect(call?.headers.priority).toBe("4");
  });
});

describe("osc", () => {
  test("encodes an address, a type tag and padded arguments", () => {
    const packet = encodeOscMessage("/test", ["hi", 1, 1.5, true]);
    const decoded = new TextDecoder().decode(packet);
    // Every OSC part is padded to four bytes, so the length is a multiple of four by construction.
    expect(packet.length % 4).toBe(0);
    expect(decoded.startsWith("/test")).toBe(true);
    expect(decoded).toContain(",sifT");
  });

  test("an integral number is an int and a fractional one is a float", () => {
    expect(new TextDecoder().decode(encodeOscMessage("/a", [1]))).toContain(",i");
    expect(new TextDecoder().decode(encodeOscMessage("/a", [1.5]))).toContain(",f");
  });

  test("a message actually reaches a UDP socket", async () => {
    // A real socket rather than a stub: this is a wire format, and the whole risk is in the bytes.
    const socket: Socket = createSocket("udp4");
    const arrived = new Promise<Buffer>((resolve) => {
      socket.on("message", (message) => {
        resolve(message);
      });
    });
    await new Promise<void>((resolve) => {
      socket.bind(0, "127.0.0.1", resolve);
    });
    const port = socket.address().port;

    const h = harness();
    const result = await h.run(
      "osc",
      { value: 1.5 },
      { host: "127.0.0.1", port, address: "/avatar/parameters/Test" },
    );
    expect(result).toEqual({ sent: true });

    const message = new TextDecoder().decode(await arrived);
    expect(message).toContain("/avatar/parameters/Test");
    socket.close();
  });

  test("an XSOverlay notification is JSON on its own port", async () => {
    const socket: Socket = createSocket("udp4");
    const arrived = new Promise<Buffer>((resolve) => {
      socket.on("message", (message) => {
        resolve(message);
      });
    });
    await new Promise<void>((resolve) => {
      socket.bind(0, "127.0.0.1", resolve);
    });

    const h = harness();
    await h.run(
      "xsoverlay",
      { text: "Ada joined" },
      { host: "127.0.0.1", port: socket.address().port, title: "vrc.zip", seconds: 3 },
    );

    const payload = JSON.parse(new TextDecoder().decode(await arrived)) as {
      content: string;
      title: string;
      timeout: number;
    };
    expect(payload).toMatchObject({ content: "Ada joined", title: "vrc.zip", timeout: 3 });
    socket.close();
  });
});

describe("the desktop notification", () => {
  test("raises a toast and reports that it appeared", async () => {
    const h = harness();
    const result = await h.run("desktop-notification", { text: "Ada is online" }, { title: "Ada" });
    expect(result).toEqual({ shown: true, id: "toast-1", dropped: [] });
    expect(h.toasts).toEqual([{ title: "Ada", body: "Ada is online" }]);
  });

  test("`Shown` is a real answer, not decoration", async () => {
    // A notification can be refused by the OS, switched off in settings, or unavailable entirely.
    // The daemon's notifier reports all three as not-shown rather than throwing, so a graph that
    // genuinely has to reach somebody can wire this into a condition and fall through to Discord.
    const h = harness();
    expect(await h.run("desktop-notification", { text: "" })).toMatchObject({ shown: false });
  });

  test("falls back to a title when none is configured", async () => {
    const h = harness();
    await h.run("desktop-notification", { text: "hello" });
    expect(h.toasts[0]?.title).toBe("vrc.zip");
  });

  test("a wired title beats the configured one", async () => {
    // Which is the point of the port: "vrc.zip" names the app, and "Ada is online" names what
    // happened. Only the graph knows the second one.
    const h = harness();
    await h.run("desktop-notification", { text: "hello", title: "Ada" }, { title: "vrc.zip" });
    expect(h.toasts[0]?.title).toBe("Ada");
  });

  test("buttons come off the config, and a wired label overrides one", async () => {
    const h = harness();
    await h.run(
      "desktop-notification",
      { text: "Ada wants in", button1: "Accept from Ada" },
      {
        buttons: JSON.stringify([
          { id: "yes", label: "Accept", action: "signal" },
          { id: "site", label: "Profile", action: "url", argument: "https://vrchat.com" },
        ]),
      },
    );
    expect(h.toasts[0]?.buttons).toEqual([
      { id: "yes", label: "Accept from Ada", action: "signal" },
      { id: "site", label: "Profile", action: "url", argument: "https://vrchat.com" },
    ]);
  });

  test("an empty wired label leaves the authored one alone", async () => {
    // A `Compose text` that produced nothing must not blank a button: a button with no text is a
    // button nobody can press.
    const h = harness();
    await h.run(
      "desktop-notification",
      { text: "hi", button1: "   " },
      { buttons: JSON.stringify([{ id: "yes", label: "Accept" }]) },
    );
    expect(h.toasts[0]?.buttons?.[0]?.label).toBe("Accept");
  });

  test("nonsense in the buttons field is no buttons, not a failed run", async () => {
    // The value is round-tripped through export, hand-editing and import like any other config.
    const h = harness();
    await h.run("desktop-notification", { text: "hi" }, { buttons: "not json" });
    expect(h.toasts[0]?.buttons).toBeUndefined();
  });

  test("`Dropped` names what this computer could not do", async () => {
    // Dropped rather than refused: a cross-platform graph that asked for a button gets a
    // notification without one, and is told which part did not survive.
    const h = harness();
    const result = await h.run(
      "desktop-notification",
      { text: "hi" },
      { buttons: JSON.stringify([{ id: "yes", label: "Accept" }]) },
    );
    expect(result.dropped).toEqual(["buttons"]);
  });

  test("an expiry of zero is left off rather than sent", async () => {
    // Zero means "leave it in the Action Center". Sending it would remove the notification the
    // instant it was raised, which is the same bug spelled the other way round.
    const h = harness();
    await h.run("desktop-notification", { text: "hi" }, { expires: 0 });
    expect(h.toasts[0]?.expiresInMs).toBeUndefined();
    await h.run("desktop-notification", { text: "hi" }, { expires: 60_000 });
    expect(h.toasts[1]?.expiresInMs).toBe(60_000);
  });

  test("a rehearsal writes a note and raises nothing", async () => {
    const h = harness();
    expect(
      await h.run("desktop-notification", { text: "Ada is online" }, {}, { dryRun: true }),
    ).toMatchObject({ shown: false });
    expect(h.toasts).toEqual([]);
    expect(notes(h.events)).toEqual(["desktop notification: Ada is online"]);
  });

  test("a daemon built without the seam fails with a sentence rather than a silent false", async () => {
    // "Nothing appeared" and "this build cannot notify at all" are different problems, and only one
    // of them is the user's machine.
    const h = harness({ canNotify: false });
    await expect(h.run("desktop-notification", { text: "hello" })).rejects.toThrow(
      /cannot raise desktop notifications/,
    );
  });
});

describe("the notification press trigger", () => {
  const press = (payload: Record<string, unknown>): BusEvent => ({
    kind: DESKTOP_ACTIVATION_KIND,
    accountId: null,
    ts: T0,
    subjectId: "friend-online",
    payload,
  });

  test("fires with what was pressed", async () => {
    const h = harness();
    const fired: PortValues[] = [];
    const disarm = await h.arm("on-notification-press", {}, (values) => fired.push(values));
    h.bus.emit(
      press({
        notificationId: "toast-1",
        tag: "friend-online",
        button: "yes",
        label: "Accept",
        action: "signal",
        argument: "",
      }),
    );
    expect(fired).toEqual([
      {
        button: "yes",
        label: "Accept",
        tag: "friend-online",
        notification: "toast-1",
        argument: "",
        at: T0,
      },
    ]);
    await disarm();
  });

  test("a blank tag hears everything and a set one hears only itself", async () => {
    const h = harness();
    const all: PortValues[] = [];
    const mine: PortValues[] = [];
    const a = await h.arm("on-notification-press", {}, (values) => all.push(values));
    const b = await h.arm("on-notification-press", { tag: "friend-online" }, (values) =>
      mine.push(values),
    );
    h.bus.emit(press({ notificationId: "t1", tag: "friend-online", button: "yes" }));
    h.bus.emit(press({ notificationId: "t2", tag: "something-else", button: "yes" }));
    expect(all).toHaveLength(2);
    expect(mine).toHaveLength(1);
    await a();
    await b();
  });

  test("a named button hears only itself, and a blank one hears the body click too", async () => {
    const h = harness();
    const named: PortValues[] = [];
    const any: PortValues[] = [];
    const a = await h.arm("on-notification-press", { button: "yes" }, (values) =>
      named.push(values),
    );
    const b = await h.arm("on-notification-press", {}, (values) => any.push(values));
    // `button: null` is the notification itself being clicked rather than a button on it.
    h.bus.emit(press({ notificationId: "t1", tag: "", button: null }));
    h.bus.emit(press({ notificationId: "t1", tag: "", button: "no" }));
    h.bus.emit(press({ notificationId: "t1", tag: "", button: "yes" }));
    expect(named).toHaveLength(1);
    expect(any).toHaveLength(3);
    // The body click reads as "" on a string port, which is what "no button" looks like downstream.
    expect(any[0]?.button).toBe("");
    await a();
    await b();
  });

  test("a payload missing its notification id fires nothing", async () => {
    // It crosses the bus like anything else, so it is read defensively rather than trusted.
    const h = harness();
    const fired: PortValues[] = [];
    const disarm = await h.arm("on-notification-press", {}, (values) => fired.push(values));
    h.bus.emit(press({ tag: "friend-online", button: "yes" }));
    expect(fired).toEqual([]);
    await disarm();
  });
});

describe("vrchat actions", () => {
  test("an invite splits the instance and sends as the run's account", async () => {
    const h = harness();
    const result = await h.run("invite", {
      user: "usr_a",
      instance: "wrld_x:12345~region(eu)",
    });
    expect(result).toEqual({ sent: true });
    expect(h.sent).toEqual([{ user: "usr_a", kind: "invite" }]);
  });

  test("an instance string that cannot be split is an error, not a guess", () => {
    // Sending an invite to the wrong place is worse than not sending one.
    expect(splitInstance("wrld_x:1")).toEqual({ worldId: "wrld_x", instanceId: "1" });
    expect(splitInstance("wrld_x")).toBeNull();
    expect(splitInstance(":1")).toBeNull();
    expect(splitInstance("wrld_x:")).toBeNull();
  });

  test("a graph with no account says so rather than sending as somebody", async () => {
    const h = harness();
    await expect(h.run("boop", { user: "usr_a" }, {}, { accountId: null })).rejects.toThrow(
      /No account is set/,
    );
  });

  test("request invite, boop and wear-avatar reach the same social actions", async () => {
    const h = harness();
    await h.run("request-invite", { user: "usr_a" });
    await h.run("boop", { user: "usr_b" });
    await h.run("wear-avatar", { avatar: "avtr_1" });
    expect(h.sent).toEqual([
      { user: "usr_a", kind: "request-invite" },
      { user: "usr_b", kind: "boop" },
      { user: "avtr_1", kind: "wear-avatar" },
    ]);
  });
});

describe("dry run", () => {
  test("every outbound action writes a note and does nothing else", async () => {
    const h = harness();
    const before = received.length;
    const context = { dryRun: true };

    await h.run("webhook", { text: "x" }, { url: "https://vrc.zip.test/hook" }, context);
    await h.run("discord", { text: "x" }, { url: "https://vrc.zip.test/hook" }, context);
    await h.run("ntfy", { text: "x" }, { server: base, topic: "t" }, context);
    await h.run("invite", { user: "usr_a", instance: "wrld_x:1" }, {}, context);
    await h.run("boop", { user: "usr_a" }, {}, context);
    await h.run("osc", { value: 1 }, { address: "/a", port: 1 }, context);

    // Nothing left the process: no request reached the server, and no social action was performed.
    expect(received.length).toBe(before);
    expect(h.sent).toEqual([]);
    // And the evidence the arming gesture needs is in the feed, as ordinary events.
    expect(notes(h.events)).toHaveLength(6);
    expect(notes(h.events)[3]).toBe("invite usr_a to wrld_x:1");
    expect(h.events.every((event) => event.kind === "graph.note")).toBe(true);
  });

  test("the feed note is written for real even in a rehearsal", async () => {
    // The one action with no dry-run branch: suppressing it would make the dry-run log emptier than
    // the real run it is evidence for, and writing a line in the user's own feed harms nobody.
    const h = harness();
    const result = await h.run("note", { text: "hello" }, {}, { dryRun: true });
    expect(result).toEqual({ written: true });
    expect(notes(h.events)).toEqual(["hello"]);
    expect(h.events[0]?.payload).toMatchObject({ dryRun: true, note: "hello" });
  });
});
