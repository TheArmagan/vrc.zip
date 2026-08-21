import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  buildPipelineUrl,
  computeBackoffDelay,
  DEFAULT_BACKOFF,
  PipelineClient,
  type PipelineClientOptions,
  type PipelineStateChange,
} from "./client.ts";
import type { DecodedPipelineEvent, PipelineReauthRequired } from "./decode.ts";
import { DEAD_SESSION_ERROR } from "./decode.ts";

/**
 * Every socket test runs against a local `Bun.serve` fixture. The live VRChat pipeline is never
 * contacted: it would make the suite non-deterministic, rate-limited, and dependent on a real
 * account's credentials.
 */

const USER_AGENT = "vrc.zip/0.1.0 test@example.com";

interface Handshake {
  readonly authToken: string | null;
  readonly userAgent: string | null;
}

type Behavior = (ws: ServerWebSocket<undefined>, index: number) => void;

interface Fixture {
  readonly url: string;
  readonly handshakes: Handshake[];
  readonly sockets: ServerWebSocket<undefined>[];
  /** Ping frames the fixture has received from the client's heartbeat. */
  readonly pings: { count: number };
  stop(): void;
}

function startFixture(behavior?: Behavior): Fixture {
  const handshakes: Handshake[] = [];
  const sockets: ServerWebSocket<undefined>[] = [];
  const pings = { count: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, self) {
      const url = new URL(request.url);
      handshakes.push({
        authToken: url.searchParams.get("authToken"),
        userAgent: request.headers.get("user-agent"),
      });
      if (self.upgrade(request)) {
        return undefined;
      }
      return new Response("expected a websocket upgrade", { status: 400 });
    },
    websocket: {
      open(ws: ServerWebSocket<undefined>) {
        sockets.push(ws);
        behavior?.(ws, sockets.length - 1);
      },
      message() {
        // The pipeline is server-to-client only; anything the client sends is ignored.
      },
      ping() {
        pings.count += 1;
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/`,
    handshakes,
    sockets,
    pings,
    stop: () => {
      server.stop(true);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(2);
  }
}

const openClients: PipelineClient[] = [];
const openFixtures: Fixture[] = [];

function makeClient(overrides: Partial<PipelineClientOptions> & { url: string }): PipelineClient {
  const options: PipelineClientOptions = {
    getAuthToken: () => Promise.resolve("auth-token"),
    userAgent: USER_AGENT,
    onEvent: () => {},
    onReauthRequired: () => {},
    // Fast, deterministic-ish timings so the suite stays in the tens of milliseconds.
    backoff: { initialDelayMs: 10, maxDelayMs: 200, factor: 2, jitterRatio: 0 },
    heartbeatIntervalMs: 0,
    idleTimeoutMs: 0,
    ...overrides,
  };
  const client = new PipelineClient(options);
  openClients.push(client);
  return client;
}

function track(fixture: Fixture): Fixture {
  openFixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const client of openClients.splice(0)) {
    client.dispose();
  }
  for (const fixture of openFixtures.splice(0)) {
    fixture.stop();
  }
});

describe("handshake", () => {
  test("sends the User-Agent header and the auth token in the query string", async () => {
    const fixture = track(startFixture());
    const client = makeClient({ url: fixture.url, getAuthToken: () => Promise.resolve("tok_abc") });
    client.start();

    await waitFor(() => fixture.handshakes.length === 1);
    // A missing UA is a hard 403 + waf_code 13799 on the upgrade, so this assertion is load-bearing.
    expect(fixture.handshakes[0]?.userAgent).toBe(USER_AGENT);
    expect(fixture.handshakes[0]?.authToken).toBe("tok_abc");
    await waitFor(() => client.state === "connected");
  });

  test("refuses to construct without a User-Agent", () => {
    expect(
      () =>
        new PipelineClient({
          getAuthToken: () => Promise.resolve("t"),
          userAgent: "   ",
          onEvent: () => {},
          onReauthRequired: () => {},
        }),
    ).toThrow(/User-Agent/);
  });

  test("buildPipelineUrl encodes the token into the query string", () => {
    expect(buildPipelineUrl("wss://pipeline.vrchat.cloud/", "a b+c")).toBe(
      "wss://pipeline.vrchat.cloud/?authToken=a+b%2Bc",
    );
  });
});

describe("event delivery", () => {
  test("decodes frames from the socket into typed events", async () => {
    const fixture = track(
      startFixture((ws) => {
        ws.send(JSON.stringify({ type: "see-notification", content: "not_1" }));
        ws.send(
          JSON.stringify({
            type: "friend-active",
            content: JSON.stringify({ userid: "usr_typo" }),
          }),
        );
      }),
    );
    const events: DecodedPipelineEvent[] = [];
    const client = makeClient({ url: fixture.url, onEvent: (event) => events.push(event) });
    client.start();

    await waitFor(() => events.length === 2);
    const [see, active] = events;
    expect(see?.type).toBe("see-notification");
    expect(active?.type).toBe("friend-active");
    if (active?.type !== "friend-active") {
      throw new Error("expected friend-active");
    }
    expect(active.data.userId).toBe("usr_typo");
    expect(client.lastFrameAt).toBeGreaterThan(0);
  });

  test("unknown and malformed frames are reported without dropping the socket", async () => {
    const fixture = track(
      startFixture((ws) => {
        ws.send(JSON.stringify({ type: "invented-tomorrow", content: "{}" }));
        ws.send("{not json");
        ws.send(JSON.stringify({ type: "group-joined", content: '{"groupId":"grp_1"}' }));
      }),
    );
    const undecodable: string[] = [];
    const events: DecodedPipelineEvent[] = [];
    const client = makeClient({
      url: fixture.url,
      onEvent: (event) => events.push(event),
      onUndecodable: (result) => undecodable.push(result.kind),
    });
    client.start();

    await waitFor(() => events.length === 1 && undecodable.length === 2);
    expect(undecodable).toEqual(["unknown-event", "malformed"]);
    expect(client.state).toBe("connected");
    expect(fixture.handshakes).toHaveLength(1);
  });
});

describe("re-auth", () => {
  test("the authToken error frame stops the client instead of retrying", async () => {
    const fixture = track(
      startFixture((ws) => {
        ws.send(JSON.stringify({ err: DEAD_SESSION_ERROR }));
      }),
    );
    const reasons: PipelineReauthRequired[] = [];
    let serverErrors = 0;
    const client = makeClient({
      url: fixture.url,
      onReauthRequired: (reason) => reasons.push(reason),
      onServerError: () => {
        serverErrors += 1;
      },
    });
    client.start();

    await waitFor(() => reasons.length === 1);
    expect(reasons[0]?.message).toBe(DEAD_SESSION_ERROR);
    expect(serverErrors).toBe(0);
    expect(client.state).toBe("reauth-required");

    // The reconnect would have fired several times over by now had it been scheduled at all.
    await Bun.sleep(120);
    expect(fixture.handshakes).toHaveLength(1);
    expect(client.state).toBe("reauth-required");
  });

  test("restart() resumes after the caller has re-authenticated", async () => {
    const fixture = track(
      startFixture((ws, index) => {
        if (index === 0) {
          ws.send(JSON.stringify({ err: DEAD_SESSION_ERROR }));
        }
      }),
    );
    const tokens = ["stale", "fresh"];
    let call = 0;
    const client = makeClient({
      url: fixture.url,
      getAuthToken: () => Promise.resolve(tokens[Math.min(call++, tokens.length - 1)] ?? ""),
    });
    client.start();
    await waitFor(() => client.state === "reauth-required");

    client.restart();
    await waitFor(() => client.state === "connected");
    expect(fixture.handshakes.map((h) => h.authToken)).toEqual(["stale", "fresh"]);
  });

  test("an empty token is treated as re-auth, not as a retryable failure", async () => {
    const fixture = track(startFixture());
    let reauths = 0;
    const client = makeClient({
      url: fixture.url,
      getAuthToken: () => Promise.resolve(""),
      onReauthRequired: () => {
        reauths += 1;
      },
    });
    client.start();

    await waitFor(() => reauths === 1);
    await Bun.sleep(80);
    // Never even attempted the handshake: there is nothing to authenticate with.
    expect(fixture.handshakes).toHaveLength(0);
    expect(reauths).toBe(1);
  });
});

describe("reconnect", () => {
  test("re-reads the auth token on every attempt", async () => {
    // The server drops each connection immediately, forcing attempt after attempt.
    const fixture = track(
      startFixture((ws) => {
        ws.close(1011, "go away");
      }),
    );
    let issued = 0;
    const client = makeClient({
      url: fixture.url,
      // Emulates a token that is rotated by some other part of the daemon between attempts. A client
      // that captured the token once would show "token-0" three times here.
      getAuthToken: () => Promise.resolve(`token-${issued++}`),
    });
    client.start();

    await waitFor(() => fixture.handshakes.length >= 3, 4_000);
    expect(fixture.handshakes.slice(0, 3).map((h) => h.authToken)).toEqual([
      "token-0",
      "token-1",
      "token-2",
    ]);
  });

  test("backs off exponentially with jitter across repeated failures", async () => {
    const fixture = track(
      startFixture((ws, index) => {
        // Fail the first three connections, then stay up.
        if (index < 3) {
          ws.close(1011, "nope");
        }
      }),
    );
    const changes: PipelineStateChange[] = [];
    const client = makeClient({
      url: fixture.url,
      backoff: { initialDelayMs: 20, maxDelayMs: 10_000, factor: 2, jitterRatio: 0.25 },
      // Deterministic "randomness" at the extremes of the jitter window, so the assertion below is
      // about the bounds rather than about one lucky draw.
      random: (() => {
        const draws = [0, 1, 0.5];
        let i = 0;
        return () => draws[i++ % draws.length] ?? 0.5;
      })(),
      onStateChange: (change) => changes.push(change),
    });
    client.start();

    await waitFor(() => client.state === "connected" && fixture.handshakes.length === 4, 4_000);

    const delays = changes
      .filter((change) => change.state === "backoff")
      .map((change) => change.retryInMs ?? -1);
    expect(delays).toHaveLength(3);
    // Jittered, so exact equality is wrong; the exponential base and the ±25% window are the contract.
    expect(delays[0]).toBe(15); // 20 · (1 − 0.25)
    expect(delays[1]).toBe(50); // 40 · (1 + 0.25)
    expect(delays[2]).toBe(80); // 80 · (1 ± 0)
    // Strictly growing despite jitter pulling the first sample down.
    expect(delays[0]).toBeLessThan(delays[1] ?? 0);
    expect(delays[1]).toBeLessThan(delays[2] ?? 0);
    // The streak is *not* cleared merely by the socket opening: these three all opened and died
    // instantly, and treating that as success would flatten the backoff into a tight loop.
    expect(client.attempt).toBe(3);
  });

  test("a connection that stays up long enough clears the failure streak", async () => {
    const fixture = track(
      startFixture((ws, index) => {
        if (index === 0) {
          ws.close(1011, "instant");
        } else if (index === 1) {
          // Open long enough to count as a real session, then die.
          setTimeout(() => {
            ws.close(1011, "later");
          }, 60);
        }
      }),
    );
    const delays: number[] = [];
    const client = makeClient({
      url: fixture.url,
      backoff: { initialDelayMs: 20, maxDelayMs: 10_000, factor: 2, jitterRatio: 0 },
      stableConnectionMs: 25,
      onStateChange: (change) => {
        if (change.state === "backoff") {
          delays.push(change.retryInMs ?? -1);
        }
      },
    });
    client.start();

    await waitFor(() => fixture.handshakes.length >= 3 && delays.length >= 2, 4_000);
    // Second delay is back at the initial value rather than doubled, because the connection that
    // preceded it was healthy for longer than stableConnectionMs.
    expect(delays.slice(0, 2)).toEqual([20, 20]);
  });

  test("a token supplier that throws is retried rather than treated as re-auth", async () => {
    const fixture = track(startFixture());
    let calls = 0;
    let reauths = 0;
    const client = makeClient({
      url: fixture.url,
      getAuthToken: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("keychain locked")) : Promise.resolve("tok");
      },
      onReauthRequired: () => {
        reauths += 1;
      },
    });
    client.start();

    await waitFor(() => client.state === "connected");
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(reauths).toBe(0);
  });

  test("a stale socket that sends nothing is dropped and reconnected", async () => {
    // The server accepts and then goes silent — indistinguishable, from the socket API, from a
    // half-open connection that will never deliver another frame.
    const fixture = track(startFixture());
    const details: string[] = [];
    const client = makeClient({
      url: fixture.url,
      idleTimeoutMs: 40,
      onStateChange: (change) => {
        if (change.state === "backoff" && change.detail !== undefined) {
          details.push(change.detail);
        }
      },
    });
    client.start();

    await waitFor(() => fixture.handshakes.length >= 2, 4_000);
    expect(details[0]).toContain("stale");
  });

  test("the heartbeat pings a quiet socket without resetting stale detection", async () => {
    const fixture = track(startFixture());
    const client = makeClient({ url: fixture.url, heartbeatIntervalMs: 15, idleTimeoutMs: 0 });
    client.start();

    await waitFor(() => fixture.pings.count >= 2, 4_000);
    expect(client.state).toBe("connected");
    // Pings keep the path warm; only real inbound frames count as liveness, so lastFrameAt is still
    // the open timestamp and the idle timer (disabled here) would still have fired.
    expect(client.lastFrameAt).toBeGreaterThan(0);
  });

  test("dispose() stops everything and never reconnects", async () => {
    const fixture = track(
      startFixture((ws) => {
        ws.close(1011, "bye");
      }),
    );
    const client = makeClient({ url: fixture.url, backoff: { initialDelayMs: 5, jitterRatio: 0 } });
    client.start();
    await waitFor(() => fixture.handshakes.length >= 1);

    client.dispose();
    const seen = fixture.handshakes.length;
    expect(client.state).toBe("closed");

    await Bun.sleep(120);
    expect(fixture.handshakes).toHaveLength(seen);
    expect(() => {
      client.start();
    }).toThrow(/disposed/);
  });

  test("dispose() during a backoff wait cancels the pending attempt", async () => {
    const fixture = track(
      startFixture((ws) => {
        ws.close(1011, "bye");
      }),
    );
    const client = makeClient({
      url: fixture.url,
      backoff: { initialDelayMs: 60, jitterRatio: 0 },
    });
    client.start();
    await waitFor(() => client.state === "backoff", 4_000);

    client.dispose();
    const seen = fixture.handshakes.length;
    await Bun.sleep(150);
    expect(fixture.handshakes).toHaveLength(seen);
  });
});

describe("computeBackoffDelay", () => {
  test("is exponential at the midpoint of the jitter window", () => {
    const options = { initialDelayMs: 1_000, maxDelayMs: 60_000, factor: 2, jitterRatio: 0.3 };
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4].map((n) => computeBackoffDelay(n, options, mid))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  test("clamps the exponential term at maxDelayMs", () => {
    const options = { initialDelayMs: 1_000, maxDelayMs: 60_000, factor: 2, jitterRatio: 0 };
    expect(computeBackoffDelay(20, options, () => 0.5)).toBe(60_000);
  });

  test("jitter spans exactly ±jitterRatio around the exponential term", () => {
    const options = { initialDelayMs: 1_000, maxDelayMs: 60_000, factor: 2, jitterRatio: 0.3 };
    expect(computeBackoffDelay(1, options, () => 0)).toBe(1_400); // 2000 · 0.7
    expect(computeBackoffDelay(1, options, () => 1)).toBe(2_600); // 2000 · 1.3
  });

  test("real randomness stays inside the window and actually varies", () => {
    const samples = Array.from({ length: 200 }, () => computeBackoffDelay(3, DEFAULT_BACKOFF));
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(5_600); // 8000 · 0.7
      expect(sample).toBeLessThanOrEqual(10_400); // 8000 · 1.3
    }
    // Without jitter every account on the machine would retry on the same tick.
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  test("never returns a negative delay", () => {
    const options = { initialDelayMs: 100, maxDelayMs: 1_000, factor: 2, jitterRatio: 4 };
    expect(computeBackoffDelay(0, options, () => 0)).toBe(0);
  });
});
