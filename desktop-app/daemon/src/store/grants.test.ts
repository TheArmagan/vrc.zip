import { beforeEach, describe, expect, test } from "bun:test";
import { hashProxyToken, mintPairingCode, mintProxyToken } from "../security/proxy-tokens.ts";
import { MEMORY, Store } from "./store.ts";

/**
 * The proxy's own state: grants, pending consent, and the audit log. PLAN.md §Phase 2.
 *
 * These assert the *row*, not a return value — a grant that looks issued but was never written is
 * an app that works until the daemon restarts, which is the worst shape of bug this table can have.
 */

let store: Store;

beforeEach(() => {
  store = Store.open(MEMORY);
  store.upsertAccount({
    id: "usr_alice",
    display_name: "Alice",
    added_at: 1,
    enabled: 1,
    last_seen_at: null,
  });
  store.upsertAccount({
    id: "usr_bob",
    display_name: "Bob",
    added_at: 1,
    enabled: 1,
    last_seen_at: null,
  });
});

function issue(
  accountId = "usr_alice",
  overrides: Partial<{ name: string; contact: string; scopes: string[] }> = {},
): { id: string; token: string } {
  const minted = mintProxyToken();
  const id = crypto.randomUUID();
  store.insertGrant({
    id,
    account_id: accountId,
    app_name: overrides.name ?? "MyApp",
    app_version: "1.0.0",
    app_contact: overrides.contact ?? "me@somewhere.dev",
    scopes: JSON.stringify(overrides.scopes ?? ["friends:read"]),
    token_hash: minted.hash,
    two_factor_hash: null,
    created_at: 1_000,
  });
  return { id, token: minted.token };
}

describe("grants", () => {
  test("a token is looked up by hash, and the plaintext is never in the table", () => {
    const { id, token } = issue();

    expect(store.grantByTokenHash(hashProxyToken(token))?.id).toBe(id);

    // The point of hashing: dumping the table yields nothing that authenticates anything.
    const dumped = JSON.stringify(store.listGrants());
    expect(dumped).not.toContain(token);
  });

  test("a revoked grant is not merely flagged — it stops resolving", () => {
    // Checked in SQL rather than by the caller, so code that forgets the check cannot honour a
    // revoked token: the row simply is not there.
    const { id, token } = issue();
    store.revokeGrant(id, 2_000);

    expect(store.grantByTokenHash(hashProxyToken(token))).toBeNull();
    expect(store.getGrant(id)?.revoked_at).toBe(2_000);
  });

  test("revoking is idempotent and keeps the first revocation time", () => {
    const { id } = issue();
    store.revokeGrant(id, 2_000);
    store.revokeGrant(id, 9_000);
    expect(store.getGrant(id)?.revoked_at).toBe(2_000);
  });

  test("revoking one app's access to one account touches no other grant", () => {
    // One grant per (app, account) is the whole model — an app bound to three accounts must lose
    // exactly the one the user revoked.
    const alice = issue("usr_alice");
    const bob = issue("usr_bob");
    const other = issue("usr_alice", { name: "OtherApp", contact: "other@somewhere.dev" });

    store.revokeGrant(alice.id, 2_000);

    expect(store.grantByTokenHash(hashProxyToken(alice.token))).toBeNull();
    expect(store.grantByTokenHash(hashProxyToken(bob.token))?.id).toBe(bob.id);
    expect(store.grantByTokenHash(hashProxyToken(other.token))?.id).toBe(other.id);
  });

  test("the kill switch closes every live grant, or every one for an account", () => {
    issue("usr_alice");
    issue("usr_bob");
    const already = issue("usr_alice", { name: "Gone" });
    store.revokeGrant(already.id, 500);

    expect(store.revokeGrants(3_000, "usr_alice")).toBe(1);
    expect(store.revokeGrants(3_000)).toBe(1);
    expect(store.listGrants().every((grant) => grant.revoked_at !== null)).toBe(true);
  });

  test("scopes are stored as granted, not re-derived later", () => {
    // A later registry change must not silently widen or narrow a grant the user already approved.
    const { id } = issue("usr_alice", { scopes: ["friends:read", "invite:send"] });
    expect(JSON.parse(store.getGrant(id)?.scopes ?? "[]")).toEqual(["friends:read", "invite:send"]);
  });

  test("escalation finds the app's existing grant by identity, not by version", () => {
    // A version bump must not orphan a grant and raise a fresh consent sheet.
    const { id } = issue("usr_alice", { name: "MyApp", contact: "me@somewhere.dev" });

    expect(store.findGrantForApp("usr_alice", "MyApp", "me@somewhere.dev")?.id).toBe(id);
    // A different contact is a different app that happened to pick the same name.
    expect(store.findGrantForApp("usr_alice", "MyApp", "someone@else.dev")).toBeNull();
    expect(store.findGrantForApp("usr_bob", "MyApp", "me@somewhere.dev")).toBeNull();
  });

  test("a grant follows its account when the account is removed", () => {
    const { token } = issue("usr_alice");
    store.deleteAccount("usr_alice");
    expect(store.grantByTokenHash(hashProxyToken(token))).toBeNull();
  });

  test("the proxy's twoFactorAuth value resolves the same way", () => {
    const { id } = issue();
    const device = mintProxyToken();
    store.setGrantTwoFactorHash(id, device.hash);
    expect(store.grantByTwoFactorHash(device.hash)?.id).toBe(id);
  });
});

describe("pairing requests", () => {
  function pending(overrides: Partial<{ account: string | null; expires: number }> = {}) {
    const id = crypto.randomUUID();
    const half = mintProxyToken();
    const code = mintPairingCode();
    store.insertPairingRequest({
      id,
      account_id: overrides.account === undefined ? "usr_alice" : overrides.account,
      requested_username: "alice@somewhere.dev",
      app_name: "MyApp",
      app_version: "1.0.0",
      app_contact: "me@somewhere.dev",
      scopes: JSON.stringify(["friends:read"]),
      half_token_hash: half.hash,
      code_hash: code.hash,
      created_at: 1_000,
      expires_at: overrides.expires ?? 301_000,
    });
    return { id, half, code };
  }

  test("the app's half-authenticated cookie finds its pending request", () => {
    const { id, half } = pending();
    expect(store.pairingByHalfToken(half.hash, 2_000)?.id).toBe(id);
  });

  test("an expired request never matches, even before the sweeper runs", () => {
    // Expiry is enforced at lookup, not only by housekeeping — a sweeper that has not run yet must
    // not be the difference between a live code and a dead one.
    const { half } = pending({ expires: 1_500 });
    expect(store.pairingByHalfToken(half.hash, 2_000)).toBeNull();
  });

  test("a resolved request stops matching, so a code is single-use", () => {
    const { id, half } = pending();
    store.resolvePairing(id, 2_000, "approved", null);
    expect(store.pairingByHalfToken(half.hash, 2_100)).toBeNull();
  });

  test("resolving twice keeps the first outcome", () => {
    const { id } = pending();
    store.resolvePairing(id, 2_000, "approved", null);
    store.resolvePairing(id, 3_000, "denied", null);
    expect(store.getPairingRequest(id)?.outcome).toBe("approved");
  });

  test("wrong-code attempts are counted per app identity", () => {
    // Six digits is 20 bits. That is only safe because attempts are counted and codes expire.
    const { id } = pending();
    store.bumpPairingAttempts(id);
    store.bumpPairingAttempts(id);

    expect(store.countPairingAttempts("MyApp", "me@somewhere.dev", 0)).toBe(2);
    expect(store.countPairingAttempts("OtherApp", "me@somewhere.dev", 0)).toBe(0);
    // Only attempts inside the window count, or a brake would never release.
    expect(store.countPairingAttempts("MyApp", "me@somewhere.dev", 5_000)).toBe(0);
  });

  test("a request may start with no account and gain one at the sheet", () => {
    // The reserved "let the user choose" username, and the "add this account first" case.
    const { id } = pending({ account: null });
    expect(store.getPairingRequest(id)?.account_id).toBeNull();

    store.setPairingAccount(id, "usr_bob");
    expect(store.getPairingRequest(id)?.account_id).toBe("usr_bob");
  });

  test("the sweeper marks lapsed requests expired rather than deleting them", () => {
    // A user who comes back later should see what an app asked for and when, not an empty list.
    const { id } = pending({ expires: 1_500 });
    pending({ expires: 900_000 });

    expect(store.expirePairings(2_000)).toBe(1);
    expect(store.getPairingRequest(id)?.outcome).toBe("expired");
    expect(store.listPendingPairings(2_000)).toHaveLength(1);
  });
});

describe("audit log", () => {
  test("records a mutating call against the grant that made it", () => {
    const { id } = issue();
    store.appendAudit({
      ts: 5_000,
      grant_id: id,
      account_id: "usr_alice",
      app_name: "MyApp",
      method: "POST",
      path: "/api/1/invite/usr_bob",
      operation_id: "inviteUser",
      scope: "invite:send",
      outcome: "allowed",
      status: 200,
    });

    const [entry] = store.listAudit({ grantId: id });
    expect(entry?.operation_id).toBe("inviteUser");
    expect(entry?.outcome).toBe("allowed");
  });

  test("a denied call with no grant at all is still recorded", () => {
    // The rows that matter most are often the ones with nothing to attribute them to.
    store.appendAudit({
      ts: 6_000,
      grant_id: null,
      account_id: null,
      app_name: "Unknown",
      method: "PUT",
      path: "/api/1/users/usr_x/delete",
      operation_id: "deleteUser",
      scope: null,
      outcome: "hard_denied",
      status: 403,
    });

    expect(store.listAudit()[0]?.outcome).toBe("hard_denied");
  });

  test("revoking a grant does not take its history with it", () => {
    const { id } = issue();
    store.appendAudit({
      ts: 5_000,
      grant_id: id,
      account_id: "usr_alice",
      app_name: "MyApp",
      method: "POST",
      path: "/api/1/invite/usr_bob",
      operation_id: "inviteUser",
      scope: "invite:send",
      outcome: "allowed",
      status: 200,
    });
    store.revokeGrant(id, 6_000);

    // "This app had access between these two times, and here is what it did" is exactly the
    // question a user asks after something goes wrong.
    expect(store.listAudit({ grantId: id })).toHaveLength(1);
  });

  test("history outlives the account the calls were made as", () => {
    const { id } = issue("usr_alice");
    store.appendAudit({
      ts: 5_000,
      grant_id: id,
      account_id: "usr_alice",
      app_name: "MyApp",
      method: "POST",
      path: "/api/1/invite/usr_bob",
      operation_id: "inviteUser",
      scope: "invite:send",
      outcome: "allowed",
      status: 200,
    });
    store.deleteAccount("usr_alice");

    expect(store.listAudit()).toHaveLength(1);
  });

  test("newest first, and paged with `before`", () => {
    for (const ts of [1_000, 2_000, 3_000]) {
      store.appendAudit({
        ts,
        grant_id: null,
        account_id: null,
        app_name: "MyApp",
        method: "POST",
        path: "/api/1/x",
        operation_id: null,
        scope: null,
        outcome: "allowed",
        status: 200,
      });
    }

    expect(store.listAudit().map((row) => row.ts)).toEqual([3_000, 2_000, 1_000]);
    expect(store.listAudit({ before: 3_000, limit: 1 }).map((row) => row.ts)).toEqual([2_000]);
  });
});
