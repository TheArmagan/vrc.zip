import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus/event-bus.ts";
import { RateLimiter } from "../net/rate-limiter.ts";
import { KEY_BYTES, type MasterKey } from "../security/keychain.ts";
import { SecretsStore } from "../security/secrets.ts";
import { MEMORY, Store } from "../store/index.ts";
import {
  type FixtureFriend,
  startVrchatFixture,
  type VrchatFixture,
} from "../testing/vrchat-fixture.ts";
import { AccountManager } from "./manager.ts";
import { PresenceService, trustLevelOf } from "./presence.ts";

const UA = "vrc.zip/0.1.0 (tests@somewhere.dev)";
const ICON_URL = "https://api.vrchat.cloud/api/1/file/file_icon/1/256";

function friends(count: number, online: boolean, prefix: string): FixtureFriend[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `usr_${prefix}_${String(i)}`,
    displayName: `${prefix}-${String(i)}`,
    online,
  }));
}

describe("trustLevelOf", () => {
  test("takes the highest rank present, not the first", () => {
    // Accounts accumulate trust tags; reading the first match would rank a veteran as basic.
    expect(trustLevelOf(["system_trust_basic", "system_trust_veteran"])).toBe("veteran");
    expect(trustLevelOf(["system_trust_known"])).toBe("known");
  });

  test("no tags is a visitor, and troll overrides everything", () => {
    expect(trustLevelOf(undefined)).toBe("visitor");
    expect(trustLevelOf([])).toBe("visitor");
    expect(trustLevelOf(["system_trust_veteran", "system_troll"])).toBe("troll");
  });
});

describe("PresenceService", () => {
  let fixture: VrchatFixture;
  let dir: string;
  let store: Store;
  let bus: EventBus;
  let accounts: AccountManager;

  const ALICE = {
    username: "alice@somewhere.dev",
    password: "pw",
    userId: "usr_alice",
    displayName: "Alice",
  };

  async function setup(accountFriends: FixtureFriend[]): Promise<PresenceService> {
    fixture = startVrchatFixture({ accounts: [{ ...ALICE, friends: accountFriends }] });
    dir = await mkdtemp(join(tmpdir(), "vrczip-presence-"));

    const key: MasterKey = {
      key: Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_BYTES))),
      backend: "file",
      degraded: true,
    };
    const secrets = await SecretsStore.open(key, { VRCZIP_STATE_DIR: dir });

    store = Store.open(MEMORY);
    bus = new EventBus();
    accounts = new AccountManager({
      secrets,
      bus,
      limiter: new RateLimiter({ burst: 500, globalBurst: 500 }),
      userAgent: UA,
      baseUrl: fixture.baseUrl,
    });

    await accounts.add(ALICE.username, ALICE.password);
    store.upsertAccount({
      id: "usr_alice",
      display_name: "Alice",
      added_at: Date.now(),
      enabled: 1,
      last_seen_at: null,
    });

    return new PresenceService({ accounts, store, bus });
  }

  beforeEach(() => {
    dir = "";
  });

  afterEach(async () => {
    store?.close();
    fixture?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("fetches both the online and the offline half of the list", async () => {
    // `offline` is a filter, not a field. Fetching one pass would make every offline friend vanish
    // from the UI rather than show as offline.
    const presence = await setup([...friends(3, true, "on"), ...friends(2, false, "off")]);
    await presence.refresh("usr_alice");

    const list = presence.list("usr_alice");
    expect(list).toHaveLength(5);
    expect(list.filter((f) => f.isOnline)).toHaveLength(3);
    expect(list.filter((f) => !f.isOnline)).toHaveLength(2);
  });

  test("pages past VRChat's 100-item cap", async () => {
    const presence = await setup(friends(250, true, "on"));
    await presence.refresh("usr_alice");
    expect(presence.list("usr_alice")).toHaveLength(250);
  });

  test("stops paging on a short page rather than probing one more", async () => {
    const presence = await setup(friends(150, true, "on"));
    await presence.refresh("usr_alice");

    const friendCalls = fixture.requests.filter((r) => r.path === "/auth/user/friends");
    // 150 online = 2 pages (100 + 50, short -> stop). Offline = 1 empty short page.
    expect(friendCalls).toHaveLength(3);
  });

  test("sorts online friends first, then by name", async () => {
    const presence = await setup([
      { id: "usr_z", displayName: "Zoe", online: true },
      { id: "usr_a", displayName: "Adam", online: false },
      { id: "usr_m", displayName: "Mia", online: true },
    ]);
    await presence.refresh("usr_alice");

    expect(presence.list("usr_alice").map((f) => f.displayName)).toEqual(["Mia", "Zoe", "Adam"]);
  });

  test("records the friendship in friend_log without overwriting friended_at", async () => {
    // friend_log is never auto-deleted; resetting the date on every poll would destroy the only
    // copy of "friends since".
    const presence = await setup(friends(1, true, "on"));
    await presence.refresh("usr_alice");

    const first = store.getFriend("usr_alice", "usr_on_0");
    expect(first).not.toBeNull();

    await Bun.sleep(5);
    await presence.refresh("usr_alice");
    expect(store.getFriend("usr_alice", "usr_on_0")?.friended_at).toBe(first?.friended_at ?? -1);
  });

  test("pipeline events update presence without a poll", async () => {
    const presence = await setup(friends(1, false, "off"));
    presence.start();
    await presence.refresh("usr_alice");
    expect(presence.list("usr_alice")[0]?.isOnline).toBe(false);

    bus.emit({
      kind: "friend.online",
      accountId: "usr_alice",
      ts: Date.now(),
      payload: { userId: "usr_off_0", location: "wrld_abc:42" },
    });

    const updated = presence.list("usr_alice")[0];
    expect(updated?.isOnline).toBe(true);
    expect(updated?.location).toBe("wrld_abc:42");
    presence.stop();
  });

  test("friend.offline clears the location instead of leaving a stale one", async () => {
    const presence = await setup(friends(1, true, "on"));
    presence.start();
    await presence.refresh("usr_alice");

    bus.emit({
      kind: "friend.offline",
      accountId: "usr_alice",
      ts: Date.now(),
      payload: { userId: "usr_on_0" },
    });

    const updated = presence.list("usr_alice")[0];
    expect(updated?.isOnline).toBe(false);
    expect(updated?.location).toBeNull();
    presence.stop();
  });

  test("friend-active's lowercase `userid` still resolves", async () => {
    const presence = await setup(friends(1, false, "off"));
    presence.start();
    await presence.refresh("usr_alice");

    bus.emit({
      kind: "friend.active",
      accountId: "usr_alice",
      ts: Date.now(),
      payload: { userid: "usr_off_0" },
    });

    expect(presence.list("usr_alice")[0]?.isOnline).toBe(true);
    presence.stop();
  });

  test('iconUrl is picked from the friend record, and "" means no icon', async () => {
    const presence = await setup([
      { id: "usr_on_0", displayName: "Iconed", online: true, userIcon: ICON_URL },
      { id: "usr_on_1", displayName: "Plain", online: true },
    ]);
    presence.start();
    await presence.refresh("usr_alice");

    const byName = new Map(presence.list("usr_alice").map((r) => [r.displayName, r.iconUrl]));
    expect(byName.get("Iconed")).toBe(ICON_URL);
    // Every image field on this one is `""`. Absent, not blank.
    expect(byName.get("Plain")).toBeNull();
    presence.stop();
  });

  test("a partial pipeline user never blanks an icon we already have", async () => {
    const presence = await setup([
      { id: "usr_on_0", displayName: "Iconed", online: true, userIcon: ICON_URL },
    ]);
    presence.start();
    await presence.refresh("usr_alice");

    // `friend-update` frames carry a partial user with no image fields at all. Overwriting from it
    // would make every icon blink out the moment its owner changed status.
    bus.emit({
      kind: "friend.update",
      accountId: "usr_alice",
      ts: Date.now(),
      payload: { userId: "usr_on_0", user: { displayName: "Iconed", status: "busy" } },
    });

    expect(presence.list("usr_alice")[0]?.iconUrl).toBe(ICON_URL);
    presence.stop();
  });

  test("friend.removed drops the friend from presence", async () => {
    const presence = await setup(friends(2, true, "on"));
    presence.start();
    await presence.refresh("usr_alice");

    bus.emit({
      kind: "friend.removed",
      accountId: "usr_alice",
      ts: Date.now(),
      payload: { userId: "usr_on_0" },
    });

    expect(presence.list("usr_alice")).toHaveLength(1);
    presence.stop();
  });

  test("another account's events never touch this account's presence", async () => {
    const presence = await setup(friends(1, false, "off"));
    presence.start();
    await presence.refresh("usr_alice");

    bus.emit({
      kind: "friend.online",
      accountId: "usr_someone_else",
      ts: Date.now(),
      payload: { userId: "usr_off_0" },
    });

    expect(presence.list("usr_alice")[0]?.isOnline).toBe(false);
    presence.stop();
  });

  test("presence is not persisted, so a restart cannot serve stale online rows", async () => {
    const presence = await setup(friends(2, true, "on"));
    await presence.refresh("usr_alice");

    // The friendships are on disk; the presence is not.
    expect(store.listFriends("usr_alice")).toHaveLength(2);
    const fresh = new PresenceService({ accounts, store, bus });
    expect(fresh.list("usr_alice")).toEqual([]);
  });
});
