import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus/event-bus.ts";
import { RateLimiter } from "../net/rate-limiter.ts";
import { KEY_BYTES, type MasterKey } from "../security/keychain.ts";
import { SecretsStore } from "../security/secrets.ts";
import { startVrchatFixture, type VrchatFixture } from "../testing/vrchat-fixture.ts";
import { AccountManager } from "./manager.ts";

const UA = "vrc.zip/0.1.0 (tests@somewhere.dev)";

const ALICE = {
  username: "alice@somewhere.dev",
  password: "alice-password",
  userId: "usr_alice",
  displayName: "Alice",
} as const;

const BOB = {
  username: "bob@somewhere.dev",
  password: "bob-password",
  userId: "usr_bob",
  displayName: "Bob",
  twoFactorMethods: ["totp"],
  twoFactorCode: "654321",
} as const;

describe("account authentication", () => {
  let fixture: VrchatFixture;
  let dir: string;
  let secrets: SecretsStore;
  let bus: EventBus;

  async function manager(): Promise<AccountManager> {
    return new AccountManager({
      secrets,
      bus,
      limiter: new RateLimiter({ burst: 100, globalBurst: 100 }),
      userAgent: UA,
      baseUrl: fixture.baseUrl,
    });
  }

  beforeEach(async () => {
    fixture = startVrchatFixture({ accounts: [ALICE, BOB] });
    dir = await mkdtemp(join(tmpdir(), "vrczip-auth-"));
    const key: MasterKey = {
      key: Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_BYTES))),
      backend: "file",
      degraded: true,
    };
    secrets = await SecretsStore.open(key, { VRCZIP_STATE_DIR: dir });
    bus = new EventBus();
  });

  afterEach(async () => {
    fixture.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("logs in an account without 2FA", async () => {
    const accounts = await manager();
    const { result, account } = await accounts.add(ALICE.username, ALICE.password);

    expect(result.status).toBe("ok");
    expect(account.user?.displayName).toBe("Alice");
    expect(account.state).toBe("online");
    // The pending id is replaced by the real one, so nothing written later is orphaned.
    expect(account.id).toBe("usr_alice");
    expect(secrets.accountIds()).toEqual(["usr_alice"]);
  });

  test("rejects a wrong password without leaving a half-added account behind", async () => {
    const accounts = await manager();
    await expect(accounts.add(ALICE.username, "wrong")).rejects.toThrow(/Incorrect username/);
    expect(accounts.list()).toEqual([]);
    expect(secrets.accountIds()).toEqual([]);
  });

  test("stops at 2FA, keeps the pre-2FA auth cookie, and completes on verify", async () => {
    const accounts = await manager();
    const { result, account } = await accounts.add(BOB.username, BOB.password);

    expect(result).toEqual({ status: "requires-2fa", methods: ["totp"] });
    expect(account.state).toBe("awaiting-2fa");
    // The verify call authenticates against this cookie. Without it, a correct code would fail.
    expect(account.jar.get("auth")).toBeDefined();

    const user = await accounts.verifyTwoFactor(account.id, "totp", BOB.twoFactorCode);
    expect(user.displayName).toBe("Bob");
    expect(account.state).toBe("online");
  });

  test("a wrong 2FA code stays retryable rather than dropping to an error state", async () => {
    const accounts = await manager();
    const { account } = await accounts.add(BOB.username, BOB.password);

    await expect(accounts.verifyTwoFactor(account.id, "totp", "000000")).rejects.toThrow(
      /not accepted/,
    );
    // Dropping to `error` would make the UI throw away a login one correct digit from working.
    expect(account.state).toBe("awaiting-2fa");

    await accounts.verifyTwoFactor(account.id, "totp", BOB.twoFactorCode);
    expect(account.state).toBe("online");
  });

  test("refuses a 2FA method VRChat did not ask for", async () => {
    const accounts = await manager();
    const { account } = await accounts.add(BOB.username, BOB.password);
    await expect(accounts.verifyTwoFactor(account.id, "emailOtp", "654321")).rejects.toThrow(
      /did not ask for/,
    );
  });

  test("persists both cookies, and resuming mints no new session", async () => {
    // The session-frugality guarantee. A daemon restarted ten times must cost zero sessions.
    const first = await manager();
    const { account } = await first.add(BOB.username, BOB.password);
    await first.verifyTwoFactor(account.id, "totp", BOB.twoFactorCode);

    const stored = secrets.get("usr_bob");
    expect(stored?.cookies.map((c) => c.name).sort()).toEqual(["auth", "twoFactorAuth"]);

    const mintedAfterLogin = fixture.sessionsMinted();
    const second = await manager();
    await second.loadAll();

    expect(second.get("usr_bob")?.state).toBe("online");
    expect(fixture.sessionsMinted()).toBe(mintedAfterLogin);
    // Resume validates with GET /auth, which does not mint.
    expect(fixture.requests.some((r) => r.path === "/auth" && r.method === "GET")).toBe(true);
  });

  test("re-authenticates once behind the mutex when concurrent requests all 401", async () => {
    // Ten in-flight requests against an expired session must produce one login, not ten — each one
    // would be a session against an undisclosed cap.
    const accounts = await manager();
    await accounts.add(ALICE.username, ALICE.password);
    const account = accounts.get("usr_alice");
    if (!account) throw new Error("account missing");

    const before = fixture.sessionsMinted();
    fixture.expireAllSessions();

    const { vrcFetch } = await import("../net/request.ts");
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => vrcFetch(account.context(), "/auth/user/friends")),
    );

    expect(responses.every((r) => r.ok)).toBe(true);
    expect(fixture.sessionsMinted() - before).toBe(1);
  });

  test("two accounts never share cookies", async () => {
    // PLAN.md §1.10 manual check, made automatic: GET /users/{id} returns different fields
    // depending on who is asking, so cookie bleed is a correctness bug.
    const accounts = await manager();
    await accounts.add(ALICE.username, ALICE.password);
    const { account: bob } = await accounts.add(BOB.username, BOB.password);
    await accounts.verifyTwoFactor(bob.id, "totp", BOB.twoFactorCode);

    const alice = accounts.get("usr_alice");
    if (!alice) throw new Error("alice missing");

    expect(alice.jar.get("auth")).not.toBe(bob.jar.get("auth"));

    const { vrcFetch } = await import("../net/request.ts");
    await vrcFetch(alice.context(), "/auth/user/friends");
    const aliceRequest = fixture.requests.at(-1);
    expect(aliceRequest?.headers.get("Cookie")).toContain(alice.jar.get("auth") ?? "");
    expect(aliceRequest?.headers.get("Cookie")).not.toContain("usr_bob");
  });

  test("backs off and recovers through a 429", async () => {
    const accounts = await manager();
    fixture.setRateLimitNext(2);

    const { result } = await accounts.add(ALICE.username, ALICE.password);
    expect(result.status).toBe("ok");
  });

  test("a missing User-Agent is a 403 with waf_code 13799", async () => {
    // Guards the fixture itself: if this ever stops failing, the fixture has stopped modelling
    // the behaviour the rest of the suite relies on.
    const response = await fetch(`${fixture.baseUrl}/auth`, { headers: { "User-Agent": "" } });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { waf_code: number } }).error.waf_code).toBe(13799);
  });

  test("removing an account forgets its credentials", async () => {
    const accounts = await manager();
    await accounts.add(ALICE.username, ALICE.password);
    await accounts.remove("usr_alice");

    expect(accounts.list()).toEqual([]);
    expect(secrets.accountIds()).toEqual([]);
  });

  test("shutdown goes offline without logging out", async () => {
    // PLAN.md §Guardrails: never PUT /logout on shutdown, or the next start costs a session.
    const accounts = await manager();
    await accounts.add(ALICE.username, ALICE.password);
    accounts.shutdown();

    expect(fixture.requests.some((r) => r.path === "/logout")).toBe(false);
    expect(accounts.get("usr_alice")?.state).toBe("offline");
  });
});
