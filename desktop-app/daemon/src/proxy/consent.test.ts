import { beforeEach, expect, test } from "bun:test";
import { hashProxyToken } from "../security/proxy-tokens.ts";
import { MEMORY, Store } from "../store/store.ts";
import { ConsentRegistry, MAX_PAIRING_ATTEMPTS, PAIRING_TTL_MS } from "./consent.ts";

/**
 * The parts of the pairing flow that need a clock, which the handshake tests deliberately do not
 * drive: expiry, and the brute-force brake. Six digits is twenty bits and is only safe because of
 * these two.
 */

let store: Store;
let clock: number;
let registry: ConsentRegistry;

const APP = { name: "MyApp", version: "1.0.0", contact: "me@somewhere.dev" };

beforeEach(() => {
  store = Store.open(MEMORY);
  store.upsertAccount({
    id: "usr_alice",
    display_name: "Alice",
    added_at: 1,
    enabled: 1,
    last_seen_at: null,
  });
  clock = 1_000_000;
  registry = new ConsentRegistry({
    store,
    now: () => clock,
    mintCode: () => ({ token: "424242", hash: hashProxyToken("424242") }),
  });
});

function open(accountId: string | null = "usr_alice") {
  return registry.open({
    accountId,
    requestedUsername: "alice@somewhere.dev",
    app: APP,
    scopes: ["friends:read"],
    newScopes: ["friends:read"],
  });
}

test("the plaintext code is in memory only, never in the database", () => {
  // A six-digit code sitting in a readable table is a bypass of the whole consent gesture.
  const { pending } = open();
  expect(pending.code).toBe("424242");

  const row = store.getPairingRequest(pending.id);
  expect(JSON.stringify(row)).not.toContain("424242");
  expect(row?.code_hash).toBe(hashProxyToken("424242"));
});

test("a code expires, and an expired sheet stops being offered to the user", () => {
  const { halfToken, pending } = open();
  expect(registry.byHalfToken(halfToken)?.id).toBe(pending.id);

  clock += PAIRING_TTL_MS + 1;

  expect(registry.byHalfToken(halfToken)).toBeNull();
  expect(registry.list()).toHaveLength(0);
  expect(registry.verify(halfToken, "424242").ok).toBe(false);
  // Marked expired rather than deleted: a user coming back later still sees what was asked, and when.
  expect(store.getPairingRequest(pending.id)?.outcome).toBe("expired");
});

test("wrong codes are counted, and the brake stops a brute-force", () => {
  const first = open();
  for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) {
    expect(registry.verify(first.halfToken, "000000")).toEqual({ ok: false, reason: "wrong-code" });
  }

  // Even the right code is refused now.
  expect(registry.verify(first.halfToken, "424242")).toEqual({ ok: false, reason: "rate-limited" });
});

test("an app cannot buy more guesses by opening a fresh login", () => {
  // Counted per app identity rather than per request, which is the difference between a brake and
  // a formality — otherwise the attacker just logs in again every eight tries.
  const first = open();
  for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) registry.verify(first.halfToken, "000000");

  const second = open();
  expect(registry.verify(second.halfToken, "424242")).toEqual({
    ok: false,
    reason: "rate-limited",
  });
});

test("the brake releases on its own once the window passes", () => {
  // An app being retried by a confused user recovers without needing a restart.
  const first = open();
  for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) registry.verify(first.halfToken, "000000");

  clock += PAIRING_TTL_MS + 1;
  const second = open();
  expect(registry.verify(second.halfToken, "424242").ok).toBe(true);
});

test("a request with no account refuses even the right code", () => {
  // Pairing to nothing would either fail later or pick an account on the user's behalf.
  const { halfToken } = open(null);
  expect(registry.verify(halfToken, "424242")).toEqual({ ok: false, reason: "no-account" });
});

test("denying at the sheet kills the request immediately", () => {
  const { halfToken, pending } = open();
  expect(registry.deny(pending.id)).toBe(true);

  expect(registry.verify(halfToken, "424242")).toEqual({ ok: false, reason: "unknown" });
  expect(store.getPairingRequest(pending.id)?.outcome).toBe("denied");
});

test("approving ties the request to the grant it became, and is single-use", () => {
  const { halfToken, pending } = open();
  // A real grant row: `pairing_requests.grant_id` is a foreign key, which is what stops a request
  // from being marked approved against a grant that was never written.
  store.insertGrant({
    id: "grant_1",
    account_id: "usr_alice",
    app_name: APP.name,
    app_version: APP.version,
    app_contact: APP.contact,
    scopes: JSON.stringify(["friends:read"]),
    token_hash: hashProxyToken("token"),
    two_factor_hash: null,
    created_at: clock,
  });
  registry.approve(pending.id, "grant_1");

  expect(store.getPairingRequest(pending.id)?.grant_id).toBe("grant_1");
  expect(registry.verify(halfToken, "424242")).toEqual({ ok: false, reason: "unknown" });
});

test("attaching an account updates both the sheet and the row", () => {
  const { pending } = open(null);
  expect(registry.attachAccount(pending.id, "usr_alice")).toBe(true);

  expect(registry.get(pending.id)?.accountId).toBe("usr_alice");
  expect(store.getPairingRequest(pending.id)?.account_id).toBe("usr_alice");
  expect(registry.attachAccount("no-such-id", "usr_alice")).toBe(false);
});

test("pending requests are listed oldest first, so the sheet order is stable", () => {
  const first = open();
  clock += 10;
  const second = open();

  expect(registry.list().map((entry) => entry.id)).toEqual([first.pending.id, second.pending.id]);
});
