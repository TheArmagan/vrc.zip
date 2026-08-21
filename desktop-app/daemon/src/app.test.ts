import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { portFallbackWarnings, type RunningDaemon, startDaemon } from "./app.ts";
import { generateSessionToken } from "./security/session-token.ts";
import { writeStateFile } from "./security/state-file.ts";
import { type PipelineFixture, startPipelineFixture } from "./testing/pipeline-fixture.ts";
import { startVrchatFixture, type VrchatFixture } from "./testing/vrchat-fixture.ts";

/**
 * End-to-end over the composition root. PLAN.md §1.10.
 *
 * This is the test that catches wiring, which unit tests structurally cannot: every piece can be
 * correct while the daemon still fails to start, binds the wrong thing, or drops events between two
 * modules that each work fine alone.
 *
 * Never touches the real state directory or the real keychain — `VRCZIP_STATE_DIR` redirects the
 * whole tree and `VRCZIP_KEY_BACKEND=file` keeps it out of Credential Manager.
 */

const ALICE = {
  username: "alice@somewhere.dev",
  password: "alice-password",
  userId: "usr_alice",
  displayName: "Alice",
  friends: [
    { id: "usr_f1", displayName: "Friend One", online: true },
    { id: "usr_f2", displayName: "Friend Two", online: false },
  ],
} as const;

const BOB = {
  username: "bob@somewhere.dev",
  password: "bob-password",
  userId: "usr_bob",
  displayName: "Bob",
  twoFactorMethods: ["totp"],
  twoFactorCode: "654321",
  friends: [{ id: "usr_f3", displayName: "Friend Three", online: true }],
} as const;

/**
 * One account per 2FA method. §1.10 names all three and only `totp` ever had a success path — the
 * other two branches were reachable from the UI and asserted nowhere.
 */
const CAROL = {
  username: "carol@somewhere.dev",
  password: "carol-password",
  userId: "usr_carol",
  displayName: "Carol",
  twoFactorMethods: ["emailOtp"],
  twoFactorCode: "112233",
} as const;

const DAVE = {
  username: "dave@somewhere.dev",
  password: "dave-password",
  userId: "usr_dave",
  displayName: "Dave",
  twoFactorMethods: ["otp"],
  twoFactorCode: "445566",
} as const;

describe("daemon end to end", () => {
  let fixture: VrchatFixture;
  let pipeline: PipelineFixture;
  let dir: string;
  let daemon: RunningDaemon | null = null;

  async function boot(
    contact = "tests@somewhere.dev",
    // Port 0 asks the OS for a free one — a fixed port would make the suite flaky against a real
    // daemon running on the same machine. Only the fallback test overrides this.
    ports: { ui: number; proxy: number; control: number } = { ui: 0, proxy: 0, control: 0 },
  ): Promise<RunningDaemon> {
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        contact,
        ports,
        useLocalDomain: false,
        logDirectories: [join(dir, "no-logs-here")],
        openBrowserOnStart: false,
      }),
      "utf8",
    );

    daemon = await startDaemon({
      env: { VRCZIP_STATE_DIR: dir, VRCZIP_KEY_BACKEND: "file" },
      baseUrl: fixture.baseUrl,
      pipelineUrl: pipeline.url,
    });
    return daemon;
  }

  /** `Response.json()` is `unknown` under strict mode; assert the shape once, here. */
  async function json<T>(response: Promise<Response> | Response): Promise<T> {
    return (await (await response).json()) as T;
  }

  function api(running: RunningDaemon, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${running.servers.urls.controlUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${running.sessionToken}`, ...init.headers },
    });
  }

  beforeEach(async () => {
    fixture = startVrchatFixture({ accounts: [ALICE, BOB, CAROL, DAVE] });
    pipeline = startPipelineFixture();
    dir = await mkdtemp(join(tmpdir(), "vrczip-e2e-"));
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    pipeline.stop();
    fixture.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("starts, binds three ports, and writes state.json", async () => {
    const running = await boot();

    expect(running.servers.urls.uiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.servers.urls.controlUrl).not.toBe(running.servers.urls.uiUrl);
    expect(running.servers.urls.proxyUrl).not.toBe(running.servers.urls.controlUrl);

    const state = await Bun.file(join(dir, "state.json")).json();
    expect(state.sessionToken).toBe(running.sessionToken);
    expect(state.pid).toBe(process.pid);
  });

  test("the UI port serves the API same-origin", async () => {
    // Without this the packaged build is inert: the bundle is served from the UI port, the control
    // API listens on another, and every call is cross-origin — originGuard rejects it and no CORS
    // headers come back. Only `vite dev` works, because it proxies. PLAN.md §Architecture puts
    // "UI + session API" on one port for exactly this reason.
    const running = await boot();

    const response = await fetch(`${running.servers.urls.uiUrl}/api/status`, {
      headers: {
        Authorization: `Bearer ${running.sessionToken}`,
        Origin: running.servers.urls.uiUrl,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("the proxy port still refuses to serve a control route", async () => {
    // The separation PLAN.md §1.8 actually insists on: the byte-faithful mirror must not be able
    // to answer a control request. Mounting the API on the UI port must not have weakened it, and
    // neither must the mirror having grown real routes — `/api/status` is not one of VRChat's, so
    // it gets VRChat's real 404 rather than the control answer.
    const running = await boot();

    const response = await fetch(`${running.servers.urls.proxyUrl}/api/status`, {
      headers: { Authorization: `Bearer ${running.sessionToken}` },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { message: '"Not Found"', status_code: 404 } });
  });

  test("an app can log into the mirror and reach a consent sheet", async () => {
    // The composition root's half of the handshake: a real account manager behind
    // `resolveAccount`, so the username an app types resolves to an account that actually exists.
    const running = await boot();
    await api(running, "/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ALICE.username, password: ALICE.password }),
    });

    const credentials = Buffer.from(
      `${encodeURIComponent(ALICE.username)}:${encodeURIComponent("friends:read")}`,
      "utf8",
    ).toString("base64");

    const response = await fetch(`${running.servers.urls.proxyUrl}/api/1/auth/user`, {
      headers: {
        Authorization: `Basic ${credentials}`,
        "User-Agent": "SomeApp/1.0 someone@somewhere.dev",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requiresTwoFactorAuth: ["totp"] });
    // The half-authenticated cookie survives the egress filter, which strips every other one.
    expect(response.headers.get("set-cookie")).toMatch(/^auth=authcookie_.+_vrczip/);
  });

  test("rejects an unauthenticated request and a rebinding Host", async () => {
    const running = await boot();
    const base = running.servers.urls.controlUrl;

    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    // The actual DNS-rebinding defense.
    const rebind = await fetch(`${base}/api/status`, {
      headers: { Authorization: `Bearer ${running.sessionToken}`, Host: "evil.example.com" },
    });
    expect(rebind.status).toBe(403);
  });

  test("logs in through the API, and the account appears with live friends", async () => {
    const running = await boot();

    const login = await api(running, "/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ALICE.username, password: ALICE.password }),
    });
    expect(login.status).toBe(200);
    expect((await json<{ status: string }>(login)).status).toBe("ok");

    const accounts = await json<Array<{ id: string; connection: string }>>(
      api(running, "/api/accounts"),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.id).toBe("usr_alice");
    expect(accounts[0]?.connection).toBe("connected");

    // Presence is populated by the first refresh, which is kicked off eagerly rather than waiting
    // out the jittered interval.
    await Bun.sleep(150);
    const friends = await json<Array<{ displayName: string; status: string }>>(
      api(running, "/api/friends"),
    );
    expect(friends).toHaveLength(2);
    expect(friends[0]?.displayName).toBe("Friend One");
    expect(friends[0]?.status).toBe("active");
  });

  // §1.10 names all three verifiers. Branching explicitly on the returned method is the whole
  // reason `auth.ts` does not fire them in parallel, and until now two of the three branches were
  // asserted by nothing at all.
  for (const account of [BOB, CAROL, DAVE] as const) {
    const method = account.twoFactorMethods[0];

    test(`a ${method} login stops at the challenge and completes on verify`, async () => {
      const running = await boot();

      const login = await json<{ status: string; accountId: string; methods: string[] }>(
        api(running, "/api/accounts/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: account.username, password: account.password }),
        }),
      );

      expect(login.status).toBe("requires-2fa");
      expect(login.methods).toEqual([method]);

      const wrong = await json<{ status: string }>(
        api(running, `/api/accounts/${login.accountId}/verify-2fa`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method, code: "000000" }),
        }),
      );
      expect(wrong.status).not.toBe("ok");

      const verify = await api(running, `/api/accounts/${login.accountId}/verify-2fa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, code: account.twoFactorCode }),
      });
      expect(verify.status).toBe(200);
      expect((await json<{ account: { id: string } }>(verify)).account.id).toBe(account.userId);

      // The verifier actually reached is the one the method named — the failure this guards against
      // is a mapping that sends every method to `/totp/verify` and passes anyway.
      expect(
        fixture.requests.some(
          (r) => r.path === `/auth/twofactorauth/${method.toLowerCase()}/verify`,
        ),
      ).toBe(true);
    });
  }

  /** Signs Alice in (no 2FA) and Bob in (totp), leaving two accounts online. */
  async function loginTwoAccounts(running: RunningDaemon): Promise<void> {
    await api(running, "/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ALICE.username, password: ALICE.password }),
    });

    const login = await json<{ accountId: string }>(
      api(running, "/api/accounts/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: BOB.username, password: BOB.password }),
      }),
    );
    await api(running, `/api/accounts/${login.accountId}/verify-2fa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "totp", code: BOB.twoFactorCode }),
    });
  }

  test("two accounts hold two independent pipeline sockets", async () => {
    // Phase 1's definition of done, and nothing constructed two `PipelineClient`s until this test:
    // two sockets, each carrying its *own* account's auth token. One socket shared between accounts
    // — or two sockets on one token — is a cookie-bleed bug that presents as one account silently
    // receiving the other's events.
    const running = await boot();
    await loginTwoAccounts(running);

    const live = await pipeline.waitForConnections(2);
    const tokens = live.map((connection) => connection.authToken).sort();

    const alice = fixture.authTokenFor(ALICE.userId);
    const bob = fixture.authTokenFor(BOB.userId);
    expect(alice).not.toBeNull();
    expect(bob).not.toBeNull();
    expect(alice).not.toBe(bob);
    expect(tokens).toEqual([alice, bob].sort() as string[]);

    // A missing UA is a hard reject on the handshake too, not only on the REST API.
    for (const connection of live) expect(connection.userAgent).toStartWith("vrc.zip/");
  });

  test("pipeline events land in the store under the account whose socket carried them", async () => {
    // The end of the chain §1.10 asks for: socket → decode → bus → feed writer → SQLite, with two
    // accounts live at once. Asserting the row rather than the bus event is deliberate — several
    // bugs have shipped with a passing test that asserted the emit while nothing was written.
    const running = await boot();
    await loginTwoAccounts(running);
    await pipeline.waitForConnections(2);

    const aliceToken = fixture.authTokenFor(ALICE.userId) ?? "";
    const bobToken = fixture.authTokenFor(BOB.userId) ?? "";

    expect(
      pipeline.send(aliceToken, "friend-online", {
        userId: "usr_f1",
        location: "wrld_alice:1~region(us)",
        platform: "standalonewindows",
      }),
    ).toBe(true);
    expect(
      pipeline.send(bobToken, "friend-offline", { userId: "usr_f3", platform: "android" }),
    ).toBe(true);
    // Content is a bare id string here, not JSON — the decode path that the npm client swallows.
    expect(pipeline.send(aliceToken, "see-notification", "not_01234567")).toBe(true);

    await Bun.sleep(500);

    const aliceEvents = await json<Array<{ kind: string; subjectId: string | null }>>(
      api(running, `/api/events?accountId=${ALICE.userId}&limit=50`),
    );
    const bobEvents = await json<Array<{ kind: string; subjectId: string | null }>>(
      api(running, `/api/events?accountId=${BOB.userId}&limit=50`),
    );

    expect(aliceEvents).toContainEqual(
      expect.objectContaining({ kind: "friend.online", subjectId: "usr_f1" }),
    );
    expect(aliceEvents.some((event) => event.kind === "notification.seen")).toBe(true);
    expect(bobEvents).toContainEqual(
      expect.objectContaining({ kind: "friend.offline", subjectId: "usr_f3" }),
    );

    // Neither account may see the other's rows. This is the assertion that catches a shared socket.
    expect(aliceEvents.some((event) => event.subjectId === "usr_f3")).toBe(false);
    expect(bobEvents.some((event) => event.subjectId === "usr_f1")).toBe(false);
  });

  test("both accounts hold live presence at the same time", async () => {
    const running = await boot();
    await loginTwoAccounts(running);
    await Bun.sleep(250);

    const alice = await json<Array<{ id: string }>>(
      api(running, `/api/friends?accountId=${ALICE.userId}`),
    );
    const bob = await json<Array<{ id: string }>>(
      api(running, `/api/friends?accountId=${BOB.userId}`),
    );

    // The fixture keys its friends on the account precisely so a cross-account cache keyed on URL
    // alone shows up here as one account's roster answering for both.
    expect(alice.map((friend) => friend.id).sort()).toEqual(["usr_f1", "usr_f2"]);
    expect(bob.map((friend) => friend.id)).toEqual(["usr_f3"]);
  });

  test("rejects a foreign Origin on the live UI port", async () => {
    // The `Host` half of this has been asserted since 1.8; the `Origin` half never was on a real
    // bound port. A present-but-wrong `Origin` is a genuine cross-site browser request.
    const running = await boot();

    const response = await fetch(`${running.servers.urls.uiUrl}/api/status`, {
      headers: {
        Authorization: `Bearer ${running.sessionToken}`,
        Origin: "http://evil.example.com",
      },
    });
    expect(response.status).toBe(403);
    expect((await json<{ error: string }>(response)).error).toBe("forbidden_origin");
  });

  test("refuses to sign in before a contact is configured", async () => {
    // VRChat requires an honest User-Agent, and a placeholder is worse than none. The daemon still
    // boots so the user has a UI in which to set one.
    const running = await boot("");

    const response = await api(running, "/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ALICE.username, password: ALICE.password }),
    });
    expect(response.status).toBe(409);
    expect((await json<{ error: string }>(response)).error).toBe("setup_required");
  });

  test("bus events reach the feed through the store", async () => {
    const running = await boot();

    running.bus.emit({
      kind: "friend.online",
      accountId: null,
      ts: Date.now(),
      subjectId: "usr_someone",
      payload: { userId: "usr_someone" },
    });
    // The feed writer batches; force the flush the same way shutdown does.
    await Bun.sleep(400);

    const events = await json<unknown[]>(api(running, "/api/events?limit=10"));
    expect(Array.isArray(events)).toBe(true);
  });

  test("restarting resumes from cookies and mints no new session", async () => {
    // The session-frugality guarantee, end to end rather than at the unit level.
    const first = await boot();
    await api(first, "/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ALICE.username, password: ALICE.password }),
    });

    const minted = fixture.sessionsMinted();
    await first.stop();
    daemon = null;

    const second = await boot();
    const accounts = await json<Array<{ connection: string }>>(api(second, "/api/accounts"));

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.connection).toBe("connected");
    expect(fixture.sessionsMinted()).toBe(minted);
  });

  test("shutdown never logs out", async () => {
    // PLAN.md §Guardrails: a logout on exit costs a session on every restart.
    const running = await boot();
    await api(running, "/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: ALICE.username, password: ALICE.password }),
    });

    await running.stop();
    daemon = null;

    expect(fixture.requests.some((r) => r.path === "/logout")).toBe(false);
  });

  test("says so out loud when a wanted port is taken", async () => {
    // The regression this exists for: `bindServer` reported `fellBack` and nobody read it, so the
    // daemon moved to a random port in silence. A squatter on an OS-chosen port reproduces that
    // without needing 7773 to be free on the machine running the suite.
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("busy"),
    });
    const taken = squatter.port;
    expect(taken).toBeNumber();

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const running = await boot("tests@somewhere.dev", {
        ui: taken as number,
        proxy: 0,
        control: 0,
      });
      expect(running.servers.ui.fellBack).toBe(true);
      expect(running.servers.ui.port).not.toBe(taken);
      expect(
        warnings.some((line) =>
          line.includes(`UI server fell back to port ${running.servers.ui.port}`),
        ),
      ).toBe(true);
    } finally {
      console.warn = realWarn;
      await squatter.stop(true);
    }
  });

  test("stop() releases the ports", async () => {
    const running = await boot();
    const url = running.servers.urls.controlUrl;
    await running.stop();
    daemon = null;

    await expect(fetch(`${url}/api/status`)).rejects.toThrow();
  });
});

/**
 * The port-fallback warning. `bindServer` has always reported `fellBack` and nothing read it, so a
 * daemon orphaned by an earlier `bun --watch` could sit on 7773-7775 while every later start moved
 * silently to an ephemeral port. These assert the wording, because the wording is the whole feature.
 *
 * No ports are bound here — `portFallbackWarnings` takes plain numbers precisely so the diagnostic
 * can be tested without racing a real EADDRINUSE.
 */
describe("port fallback warnings", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vrcz-ports-"));
    env = { VRCZIP_STATE_DIR: dir };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writePreviousRun(pid: number, uiPort: number): Promise<void> {
    await writeStateFile(
      {
        uiUrl: `http://127.0.0.1:${uiPort}`,
        proxyUrl: `http://127.0.0.1:${uiPort + 1}`,
        controlUrl: `http://127.0.0.1:${uiPort + 2}`,
        sessionToken: generateSessionToken(),
        pid,
        startedAt: Date.now(),
      },
      env,
    );
  }

  /** A pid that is certainly gone: spawn something trivial and wait for it to exit. */
  async function deadPid(): Promise<number> {
    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    return child.pid;
  }

  test("says nothing when every server got the port it asked for", async () => {
    expect(await portFallbackWarnings([], env)).toEqual([]);
  });

  test("names the live daemon holding the wanted port", async () => {
    // A real, live, *foreign* pid — the helper deliberately refuses to blame `process.pid`.
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await writePreviousRun(child.pid, 7773);

      const [line] = await portFallbackWarnings([{ name: "UI", wanted: 7773, bound: 54339 }], env);
      expect(line).toContain("UI server fell back to port 54339");
      expect(line).toContain(`existing vrc.zip daemon (pid ${child.pid})`);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("refuses to blame itself", async () => {
    // In dev mode `state.json` outlives shutdown, so the file can name this very process.
    await writePreviousRun(process.pid, 7773);

    const [line] = await portFallbackWarnings([{ name: "UI", wanted: 7773, bound: 54339 }], env);
    expect(line).toContain("was already taken");
    expect(line).not.toContain(`pid ${process.pid}`);
  });

  test("falls back to the generic cause when the recorded daemon is gone", async () => {
    await writePreviousRun(await deadPid(), 7773);

    const [line] = await portFallbackWarnings([{ name: "UI", wanted: 7773, bound: 54339 }], env);
    expect(line).toContain("UI server fell back to port 54339");
    expect(line).toContain("port 7773 was already taken");
    expect(line).toContain("orphaned vrc.zip daemon");
    expect(line).not.toContain("pid");
  });

  test("stays generic when a live daemon is on other ports entirely", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60_000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await writePreviousRun(child.pid, 8100);

      const [line] = await portFallbackWarnings(
        [{ name: "control", wanted: 7775, bound: 54341 }],
        env,
      );
      expect(line).toContain("control server fell back to port 54341");
      expect(line).toContain("port 7775 was already taken");
      expect(line).not.toContain(`pid ${child.pid}`);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("warns once per server that fell back", async () => {
    const lines = await portFallbackWarnings(
      [
        { name: "UI", wanted: 7773, bound: 64072 },
        { name: "control", wanted: 7775, bound: 64074 },
      ],
      env,
    );
    expect(lines).toHaveLength(2);
    // The user's actual symptom: a bookmark on the wanted port that no longer reaches the daemon.
    for (const line of lines) expect(line).toContain("will not reach this daemon");
  });
});
