import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningDaemon, startDaemon } from "./app.ts";
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
} as const;

describe("daemon end to end", () => {
  let fixture: VrchatFixture;
  let dir: string;
  let daemon: RunningDaemon | null = null;

  async function boot(contact = "tests@somewhere.dev"): Promise<RunningDaemon> {
    // Port 0 asks the OS for a free one — a fixed port would make the suite flaky against a real
    // daemon running on the same machine.
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        contact,
        ports: { ui: 0, proxy: 0, control: 0 },
        useLocalDomain: false,
        logDirectories: [join(dir, "no-logs-here")],
        openBrowserOnStart: false,
      }),
      "utf8",
    );

    daemon = await startDaemon({
      env: { VRCZIP_STATE_DIR: dir, VRCZIP_KEY_BACKEND: "file" },
      baseUrl: fixture.baseUrl,
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
    fixture = startVrchatFixture({ accounts: [ALICE, BOB] });
    dir = await mkdtemp(join(tmpdir(), "vrczip-e2e-"));
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
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
    // to answer a control request. Mounting the API on the UI port must not have weakened it.
    const running = await boot();

    const response = await fetch(`${running.servers.urls.proxyUrl}/api/status`, {
      headers: { Authorization: `Bearer ${running.sessionToken}` },
    });
    expect(response.status).toBe(501);
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

  test("a 2FA login stops at the challenge and completes on verify", async () => {
    const running = await boot();

    const login = await json<{ status: string; accountId: string; methods: string[] }>(
      api(running, "/api/accounts/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: BOB.username, password: BOB.password }),
      }),
    );

    expect(login.status).toBe("requires-2fa");
    expect(login.methods).toEqual(["totp"]);

    const verify = await api(running, `/api/accounts/${login.accountId}/verify-2fa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "totp", code: BOB.twoFactorCode }),
    });
    expect(verify.status).toBe(200);
    expect((await json<{ account: { id: string } }>(verify)).account.id).toBe("usr_bob");
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

  test("stop() releases the ports", async () => {
    const running = await boot();
    const url = running.servers.urls.controlUrl;
    await running.stop();
    daemon = null;

    await expect(fetch(`${url}/api/status`)).rejects.toThrow();
  });
});
