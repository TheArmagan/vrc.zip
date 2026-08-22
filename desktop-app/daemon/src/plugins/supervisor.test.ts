import { describe, expect, test } from "bun:test";
import { type Envelope, PLUGIN_API_PROTOCOL_MAJOR } from "@vrcz/plugin-api";
import {
  type CancelTimer,
  type DisableRecord,
  MemoryDisableStore,
  type PluginDisableStore,
  PluginSupervisor,
  type SupervisorClock,
  type SupervisorNotification,
  type SupervisorOptions,
} from "./supervisor.ts";
import type {
  ExitInfo,
  PluginTransport,
  TransportHandlers,
  TransportSpawnOptions,
} from "./transport.ts";

/**
 * The supervisor's unit of testing is a **fake transport and a fake clock**, never a real process.
 * Every mechanism under test — three missed beats, a doubling backoff, five crashes in five minutes
 * — is defined in terms of elapsed time, and the only way to assert on those in milliseconds rather
 * than minutes is to own the clock.
 */

const PLUGIN_ID = "test.plugin";
const START_MS = 1_700_000_000_000;

class FakeClock implements SupervisorClock {
  #now = START_MS;
  #seq = 0;
  readonly #tasks = new Map<number, { at: number; fn: () => void }>();

  readonly now = (): number => this.#now;

  readonly schedule = (delayMs: number, fn: () => void): CancelTimer => {
    const id = ++this.#seq;
    this.#tasks.set(id, { at: this.#now + delayMs, fn });
    return () => {
      this.#tasks.delete(id);
    };
  };

  get pending(): number {
    return this.#tasks.size;
  }

  /** Runs every task due within `ms`, in due order, moving `now` to each task's own instant. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let bestId: number | null = null;
      let bestAt = Number.POSITIVE_INFINITY;
      for (const [id, task] of this.#tasks) {
        if (task.at <= target && (task.at < bestAt || (task.at === bestAt && id < (bestId ?? 0)))) {
          bestId = id;
          bestAt = task.at;
        }
      }
      if (bestId === null) break;
      const task = this.#tasks.get(bestId);
      this.#tasks.delete(bestId);
      if (task === undefined) break;
      this.#now = task.at;
      task.fn();
    }
    this.#now = target;
  }
}

class FakeTransport implements PluginTransport {
  running = true;
  readonly sent: Envelope[] = [];
  killCalls = 0;
  stopCalls = 0;
  /** When true, a `ping` is answered inline — a plugin whose event loop is turning. */
  autoPong = false;
  /** RSS the auto-pong reports, when it reports one. */
  pongRss: number | undefined;

  constructor(
    readonly pluginId: string,
    readonly handlers: TransportHandlers,
    readonly pid: number | null,
  ) {}

  send(frame: Envelope): boolean {
    if (!this.running) return false;
    this.sent.push(frame);
    if (frame.t === "ping" && this.autoPong) {
      this.handlers.onFrame({
        t: "pong",
        nonce: frame.nonce,
        ...(this.pongRss === undefined ? {} : { rss: this.pongRss }),
      });
    }
    return true;
  }

  async stop(_graceMs: number): Promise<ExitInfo> {
    this.stopCalls++;
    const info: ExitInfo = {
      reason: "shutdown",
      code: 0,
      signal: null,
      detail: "Stopped on request",
    };
    this.#exit(info);
    return info;
  }

  kill(): void {
    this.killCalls++;
    this.#exit({ reason: "killed", code: null, signal: "SIGKILL", detail: "Killed by the host" });
  }

  /** A plugin process that died on its own. */
  crash(detail = "Exited with code 1"): void {
    this.#exit({ reason: "crashed", code: 1, signal: null, detail });
  }

  hello(protocol = PLUGIN_API_PROTOCOL_MAJOR, pluginId = this.pluginId): void {
    this.handlers.onFrame({ t: "hello", protocol, pluginId });
  }

  /** The id of the `activate` lifecycle frame, or null if one was never sent. */
  activateId(): string | null {
    for (const frame of this.sent) {
      if (frame.t === "lifecycle" && frame.phase === "activate") return frame.id;
    }
    return null;
  }

  pings(): number {
    return this.sent.filter((frame) => frame.t === "ping").length;
  }

  #exit(info: ExitInfo): void {
    if (!this.running) return;
    this.running = false;
    this.handlers.onExit(info);
  }
}

interface Harness {
  readonly clock: FakeClock;
  readonly supervisor: PluginSupervisor;
  readonly transports: FakeTransport[];
  readonly store: PluginDisableStore;
  readonly notifications: SupervisorNotification[];
  latest(): FakeTransport;
  /** Fails the spawn from now on. */
  breakSpawn(message: string | null): void;
}

const SPAWN: Omit<TransportSpawnOptions, "pluginId" | "helloTimeoutMs"> = {
  bundlePath: "/plugins/test.plugin/abc.js",
  smol: true,
  memoryLimitBytes: 256 * 1024 * 1024,
};

function makeHarness(
  overrides: Partial<SupervisorOptions> = {},
  options: { readonly pid?: number | null; readonly store?: PluginDisableStore } = {},
): Harness {
  const clock = new FakeClock();
  const transports: FakeTransport[] = [];
  const notifications: SupervisorNotification[] = [];
  const store = options.store ?? new MemoryDisableStore();
  let spawnError: string | null = null;

  const supervisor = new PluginSupervisor({
    pluginId: PLUGIN_ID,
    spawn: SPAWN,
    factory: async (spawnOptions, handlers) => {
      if (spawnError !== null) throw new Error(spawnError);
      const transport = new FakeTransport(spawnOptions.pluginId, handlers, options.pid ?? null);
      transports.push(transport);
      return transport;
    },
    clock,
    // Fixed at 0 so `jitter` is the identity and a backoff ladder is exactly 1s, 2s, 4s.
    random: () => 0,
    disableStore: store,
    onNotify: (notification) => notifications.push(notification),
    ...overrides,
  });

  return {
    clock,
    supervisor,
    transports,
    store,
    notifications,
    latest: () => {
      const transport = transports.at(-1);
      if (transport === undefined) throw new Error("no transport was created");
      return transport;
    },
    breakSpawn: (message) => {
      spawnError = message;
    },
  };
}

/** Lets the `void this.start()` inside a restart timer settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Drives one transport from spawn to `running`. */
async function boot(harness: Harness, autoPong = true): Promise<FakeTransport> {
  await harness.supervisor.start();
  const transport = harness.latest();
  transport.autoPong = autoPong;
  transport.hello();
  const id = transport.activateId();
  expect(id).not.toBeNull();
  if (id !== null) transport.handlers.onFrame({ t: "res", id });
  expect(harness.supervisor.state).toBe("running");
  return transport;
}

/** Crashes the current transport and waits out its backoff, returning the fresh transport. */
async function crashAndRestart(harness: Harness, backoffMs: number): Promise<FakeTransport> {
  harness.latest().crash();
  expect(harness.supervisor.state).toBe("backoff");
  harness.clock.advance(backoffMs);
  await flush();
  return harness.latest();
}

describe("PluginSupervisor heartbeat", () => {
  test("a plugin that answers every ping stays running", async () => {
    const harness = makeHarness();
    const transport = await boot(harness);

    harness.clock.advance(100_000);

    expect(harness.supervisor.state).toBe("running");
    expect(harness.supervisor.status.missedBeats).toBe(0);
    expect(transport.pings()).toBeGreaterThanOrEqual(9);
    expect(transport.killCalls).toBe(0);
  });

  test("three missed beats kill the plugin", async () => {
    const harness = makeHarness();
    const transport = await boot(harness, false);

    // Beat 1 sends a ping; beats 2-4 each judge the previous unanswered one.
    harness.clock.advance(10_000);
    expect(harness.supervisor.status.missedBeats).toBe(0);
    harness.clock.advance(10_000);
    expect(harness.supervisor.status.missedBeats).toBe(1);
    harness.clock.advance(10_000);
    expect(harness.supervisor.status.missedBeats).toBe(2);
    expect(harness.supervisor.state).toBe("running");

    harness.clock.advance(10_000);
    expect(transport.killCalls).toBe(1);
    expect(transport.stopCalls).toBe(0);
    expect(harness.supervisor.status.lastFailure?.kind).toBe("heartbeat-lost");
    expect(harness.supervisor.state).toBe("backoff");
  });

  test("a pong for a nonce that was never sent does not count as liveness", async () => {
    const harness = makeHarness();
    const transport = await boot(harness, false);

    transport.handlers.onFrame({ t: "pong", nonce: "forged-nonce" });
    harness.clock.advance(20_000);

    expect(harness.supervisor.status.missedBeats).toBe(1);
  });
});

describe("PluginSupervisor RSS watchdog", () => {
  test("an OS reading over the cap kills rather than stops", async () => {
    const harness = makeHarness({ rssLimitBytes: 100, readRssBytes: () => 4_096 }, { pid: 4242 });
    const transport = await boot(harness);

    harness.clock.advance(10_000);

    expect(transport.killCalls).toBe(1);
    expect(transport.stopCalls).toBe(0);
    expect(harness.supervisor.status.lastFailure?.kind).toBe("rss-exceeded");
    expect(harness.supervisor.status.rssBytes).toBe(4_096);
  });

  test("the self-reported figure is used when no pid-backed reading is available", async () => {
    const harness = makeHarness({ rssLimitBytes: 1_000 });
    const transport = await boot(harness);
    transport.pongRss = 5_000;

    // First beat pings and gets a pong carrying the oversized figure; the next beat acts on it.
    harness.clock.advance(10_000);
    expect(harness.supervisor.status.rssBytes).toBe(5_000);
    expect(harness.supervisor.state).toBe("running");

    harness.clock.advance(10_000);
    expect(transport.killCalls).toBe(1);
    expect(harness.supervisor.status.lastFailure?.kind).toBe("rss-exceeded");
  });

  test("the OS reading wins over the number the plugin reports about itself", async () => {
    const harness = makeHarness({ rssLimitBytes: 10_000, readRssBytes: () => 2_000 }, { pid: 99 });
    const transport = await boot(harness);
    transport.pongRss = 9_999_999;

    harness.clock.advance(10_000);

    expect(harness.supervisor.status.rssBytes).toBe(2_000);
    expect(harness.supervisor.state).toBe("running");
  });
});

describe("PluginSupervisor activation", () => {
  test("an activate that is never answered is reported as hung, not failed", async () => {
    const harness = makeHarness();
    await harness.supervisor.start();
    const transport = harness.latest();
    transport.hello();
    expect(harness.supervisor.state).toBe("activating");

    harness.clock.advance(15_000);

    expect(harness.supervisor.status.lastFailure?.kind).toBe("activate-hung");
    expect(harness.supervisor.status.lastFailure?.detail).toContain("not responding");
    expect(transport.killCalls).toBe(1);
    expect(harness.supervisor.state).toBe("backoff");
  });

  test("an activate answered with an error is reported as failed, not hung", async () => {
    const harness = makeHarness();
    await harness.supervisor.start();
    const transport = harness.latest();
    transport.hello();
    const id = transport.activateId();
    expect(id).not.toBeNull();
    if (id === null) return;

    transport.handlers.onFrame({
      t: "err",
      id,
      error: { code: "E_INTERNAL", message: "settings.json is corrupt" },
    });

    expect(harness.supervisor.status.lastFailure?.kind).toBe("activate-failed");
    expect(harness.supervisor.status.lastFailure?.detail).toContain("settings.json is corrupt");
    expect(harness.supervisor.state).toBe("backoff");
  });

  test("a plugin that never says hello is dead on arrival rather than unresponsive", async () => {
    const harness = makeHarness();
    await harness.supervisor.start();

    harness.clock.advance(10_000);

    expect(harness.supervisor.status.lastFailure?.kind).toBe("hello-timeout");
    expect(harness.supervisor.state).toBe("backoff");
  });
});

describe("PluginSupervisor protocol version", () => {
  test("a hello with the wrong major is a hard stop naming the version needed", async () => {
    const harness = makeHarness();
    await harness.supervisor.start();
    const transport = harness.latest();

    transport.hello(PLUGIN_API_PROTOCOL_MAJOR + 1);

    expect(harness.supervisor.state).toBe("disabled");
    expect(harness.supervisor.disabled?.reason).toBe("protocol-mismatch");
    expect(harness.supervisor.disabled?.detail).toContain(
      `plugin API ${PLUGIN_API_PROTOCOL_MAJOR}`,
    );
    expect(transport.killCalls).toBe(1);

    // The point of the hard stop: no restart loop, however long we wait.
    harness.clock.advance(600_000);
    await flush();
    expect(harness.transports.length).toBe(1);
  });

  test("the mismatch is sticky across a daemon restart", async () => {
    const store = new MemoryDisableStore();
    const first = makeHarness({}, { store });
    await first.supervisor.start();
    first.latest().hello(PLUGIN_API_PROTOCOL_MAJOR + 1);

    const second = makeHarness({}, { store });
    expect(second.supervisor.state).toBe("disabled");
    await second.supervisor.start();
    expect(second.transports.length).toBe(0);
  });
});

describe("PluginSupervisor restart backoff", () => {
  test("a killed plugin restarts with a doubling backoff", async () => {
    const harness = makeHarness();
    await boot(harness);

    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = harness.clock.now();
      harness.latest().crash();
      const restartAt = harness.supervisor.status.restartAt;
      expect(restartAt).not.toBeNull();
      delays.push((restartAt ?? 0) - before);
      harness.clock.advance(restartAt === null ? 0 : restartAt - before);
      await flush();
      expect(harness.supervisor.state).toBe("starting");
    }

    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(harness.transports.length).toBe(4);
  });

  test("the backoff is capped", async () => {
    const harness = makeHarness({ maxBackoffMs: 3_000 });
    await boot(harness);

    let transport = await crashAndRestart(harness, 1_000);
    transport = await crashAndRestart(harness, 2_000);
    transport.crash();

    const restartAt = harness.supervisor.status.restartAt;
    expect((restartAt ?? 0) - harness.clock.now()).toBe(3_000);
  });

  test("a stable period resets the ladder", async () => {
    const harness = makeHarness();
    await boot(harness);

    harness.latest().crash();
    expect((harness.supervisor.status.restartAt ?? 0) - harness.clock.now()).toBe(1_000);
    harness.clock.advance(1_000);
    await flush();
    await boot(harness);

    // 60s of answered heartbeats: past startup, which is where crash loops live.
    harness.clock.advance(60_000);
    expect(harness.supervisor.status.restarts).toBe(0);

    harness.latest().crash();
    expect((harness.supervisor.status.restartAt ?? 0) - harness.clock.now()).toBe(1_000);
  });
});

describe("PluginSupervisor crash loop", () => {
  test("five crashes inside the window auto-disable with the reason surfaced", async () => {
    const harness = makeHarness();
    await boot(harness);

    for (const backoff of [1_000, 2_000, 4_000, 8_000]) {
      await crashAndRestart(harness, backoff);
    }
    harness.latest().crash();

    expect(harness.supervisor.state).toBe("disabled");
    const record = harness.supervisor.disabled;
    expect(record?.reason).toBe("crash-loop");
    expect(record?.detail).toContain("failed 5 times");
    expect(harness.notifications.length).toBe(1);
    expect(harness.notifications[0]?.body).toBe(record?.detail);

    // Sticky, or it is not auto-disable.
    const persisted: DisableRecord | null = harness.store.load(PLUGIN_ID);
    expect(persisted?.reason).toBe("crash-loop");
  });

  test("a disabled plugin does not restart", async () => {
    const harness = makeHarness({ crashLoopThreshold: 2 });
    await boot(harness);
    await crashAndRestart(harness, 1_000);
    harness.latest().crash();
    expect(harness.supervisor.state).toBe("disabled");

    const spawned = harness.transports.length;
    harness.clock.advance(600_000);
    await flush();
    await harness.supervisor.start();

    expect(harness.transports.length).toBe(spawned);
    expect(harness.supervisor.state).toBe("disabled");
  });

  test("crashes spread beyond the window do not accumulate", async () => {
    const harness = makeHarness({ crashWindowMs: 5_000, crashLoopThreshold: 2 });
    await boot(harness);

    harness.latest().crash();
    harness.clock.advance(1_000);
    await flush();
    // Well past the window, so the first crash has aged out before the second is counted.
    harness.clock.advance(30_000);
    harness.latest().crash();

    expect(harness.supervisor.state).toBe("backoff");
    expect(harness.supervisor.disabled).toBeNull();
  });
});

describe("PluginSupervisor disable", () => {
  test("cancels a pending restart", async () => {
    const harness = makeHarness();
    await boot(harness);
    harness.latest().crash();
    expect(harness.supervisor.state).toBe("backoff");

    harness.supervisor.disable();

    harness.clock.advance(600_000);
    await flush();
    expect(harness.supervisor.state).toBe("disabled");
    expect(harness.transports.length).toBe(1);
  });

  test("kills rather than stops, and never awaits the plugin", async () => {
    const harness = makeHarness();
    const transport = await boot(harness);

    harness.supervisor.disable();

    expect(transport.killCalls).toBe(1);
    expect(transport.stopCalls).toBe(0);
    expect(harness.supervisor.state).toBe("disabled");
    expect(harness.clock.pending).toBe(0);
  });

  test("is idempotent and works after the process has already exited", async () => {
    const harness = makeHarness();
    const transport = await boot(harness);
    transport.crash();

    harness.supervisor.disable("user", "off");
    harness.supervisor.disable("user", "off again");
    harness.supervisor.disable("crash-loop", "and again");

    expect(harness.supervisor.state).toBe("disabled");
    expect(harness.supervisor.disabled?.detail).toBe("off");
    expect(transport.killCalls).toBe(0);
  });

  test("lands safely while a spawn is still in flight", async () => {
    const harness = makeHarness();
    const starting = harness.supervisor.start();
    harness.supervisor.disable();
    await starting;

    expect(harness.supervisor.state).toBe("disabled");
    // The transport that arrived after the decision is killed, not adopted.
    expect(harness.latest().killCalls).toBe(1);
    expect(harness.clock.pending).toBe(0);
  });

  test("enable clears the record and allows a fresh start", async () => {
    const harness = makeHarness();
    await boot(harness);
    harness.supervisor.disable();

    harness.supervisor.enable();
    expect(harness.supervisor.state).toBe("idle");
    expect(harness.store.load(PLUGIN_ID)).toBeNull();

    await boot(harness);
    expect(harness.supervisor.state).toBe("running");
  });
});

describe("PluginSupervisor bundle resolution", () => {
  /*
   * "Verify the hash on every load" is only true if something re-asks on every load, and the load
   * that is easiest to forget is the one nobody triggers: a crash loop respawns every few seconds,
   * indefinitely, and a path captured at construction would mean the file is never looked at again
   * after the daemon booted.
   */
  test("the bundle is re-resolved on every start, not captured once", async () => {
    let resolutions = 0;
    const harness = makeHarness({
      spawn: () => {
        resolutions += 1;
        return SPAWN;
      },
    });

    await boot(harness);
    expect(resolutions).toBe(1);

    await crashAndRestart(harness, 1_000);
    expect(resolutions).toBe(2);
  });

  test("a refused bundle halts rather than respawning it", async () => {
    let allow = true;
    const harness = makeHarness({
      spawn: () => (allow ? SPAWN : null),
    });

    await boot(harness);
    allow = false;

    // The artifact was swapped out under a running plugin; the restart is where that is caught.
    harness.latest().crash();
    harness.clock.advance(1_000);
    await flush();

    expect(harness.supervisor.state).toBe("disabled");
    expect(harness.supervisor.disabled?.reason).toBe("spawn-failed");
    // Not sticky: a locked file is a condition of the moment, and the halt still holds this session.
    expect(harness.store.load(PLUGIN_ID)).toBeNull();
    // And nothing was spawned from the file it refused.
    expect(harness.transports.length).toBe(1);
  });
});

describe("PluginSupervisor spawn failure", () => {
  test("halts without a restart loop and without persisting the halt", async () => {
    const harness = makeHarness();
    harness.breakSpawn("EPERM");

    await harness.supervisor.start();

    expect(harness.supervisor.state).toBe("disabled");
    expect(harness.supervisor.disabled?.reason).toBe("spawn-failed");
    expect(harness.supervisor.status.lastFailure?.kind).toBe("spawn-failed");
    // Not sticky: a locked file is a condition of the moment, not a verdict on the plugin.
    expect(harness.store.load(PLUGIN_ID)).toBeNull();

    harness.clock.advance(600_000);
    await flush();
    expect(harness.transports.length).toBe(0);
  });
});

describe("PluginSupervisor graceful stop", () => {
  test("does not restart, whatever the exit says", async () => {
    const harness = makeHarness();
    const transport = await boot(harness);

    await harness.supervisor.stop();

    expect(transport.stopCalls).toBe(1);
    expect(harness.supervisor.state).toBe("idle");
    harness.clock.advance(600_000);
    await flush();
    expect(harness.transports.length).toBe(1);
  });
});

describe("PluginSupervisor frame routing", () => {
  test("frames the supervisor does not own reach the dispatcher", async () => {
    const seen: Envelope[] = [];
    const harness = makeHarness({ onPluginFrame: (frame) => seen.push(frame) });
    const transport = await boot(harness);

    transport.handlers.onFrame({ t: "credit", sub: "s1", credits: 4 });

    expect(seen.length).toBe(1);
    expect(seen[0]?.t).toBe("credit");
  });

  /*
   * The other half of the routing seam. `onPluginFrame` carries frames outward; `send` is what
   * carries a reply back, and without it a `PluginChannel` — and therefore the whole dispatcher —
   * cannot be built over a supervisor at all.
   */
  test("send reaches the running plugin", async () => {
    const harness = makeHarness();
    const transport = await boot(harness);

    expect(harness.supervisor.send({ t: "res", id: "h1", result: null })).toBe(true);
    expect(transport.sent.at(-1)).toEqual({ t: "res", id: "h1", result: null });
  });

  test("send answers false rather than throwing when nothing is running", async () => {
    const harness = makeHarness();
    // Before a start there is no transport at all.
    expect(harness.supervisor.send({ t: "res", id: "h1" })).toBe(false);

    await boot(harness);
    harness.supervisor.disable();

    // And after a disable the supervisor has dropped it, so a channel held across the disable
    // writes into nothing rather than into a process that is on its way out.
    expect(harness.supervisor.send({ t: "res", id: "h1" })).toBe(false);
  });
});
