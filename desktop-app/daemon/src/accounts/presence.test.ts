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

  /** A second account, for the cross-account questions. Multi-account is the default posture here. */
  const BEA = {
    username: "bea@somewhere.dev",
    password: "pw",
    userId: "usr_bea",
    displayName: "Bea",
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

  /**
   * The same harness with two accounts signed in, for the questions that only exist across them.
   *
   * Written out rather than folded into `setup` with an optional second argument: every other test
   * in this file is about one account's cache, and giving them all a second account would change
   * what they are asserting to make one pair of tests shorter.
   */
  async function setupPair(
    aliceFriends: FixtureFriend[],
    beaFriends: FixtureFriend[],
  ): Promise<PresenceService> {
    fixture = startVrchatFixture({
      accounts: [
        { ...ALICE, friends: aliceFriends },
        { ...BEA, friends: beaFriends },
      ],
    });
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

    for (const account of [ALICE, BEA]) {
      await accounts.add(account.username, account.password);
      store.upsertAccount({
        id: account.userId,
        display_name: account.displayName,
        added_at: Date.now(),
        enabled: 1,
        last_seen_at: null,
      });
    }

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

  test("two accounts sharing a friend produce one row, not two", async () => {
    /*
     * The bug this exists for was a *crash*, not a duplicate. Everything that renders this list
     * keys it by user id, and a repeated key in Svelte 5 is a hard `each_key_duplicate` throw — so
     * one shared friend blanked the entire Friends screen, on exactly the multi-account setup this
     * app is built for. Found by the screenshot pipeline, whose two demo accounts are friends with
     * the same people.
     */
    const shared = { id: "usr_shared", displayName: "Ada", online: true };
    const presence = await setupPair(
      [shared, { id: "usr_only_a", displayName: "Bo", online: true }],
      [shared, { id: "usr_only_b", displayName: "Cass", online: true }],
    );
    await presence.refresh("usr_alice");
    await presence.refresh("usr_bea");

    const all = presence.listAll();
    expect(all.map((friend) => friend.id).sort()).toEqual([
      "usr_only_a",
      "usr_only_b",
      "usr_shared",
    ]);
    expect(new Set(all.map((friend) => friend.id)).size).toBe(all.length);
    // Each account's own list is untouched: the merge is a property of "all accounts", not of the
    // records themselves.
    expect(presence.list("usr_alice")).toHaveLength(2);
  });

  test("the freshest reading of a shared friend wins, not the first account's", async () => {
    // "Ada is online" and "Ada is offline" can both sit in two caches, and only one is current.
    // Taking the first account's answer would make the merged list depend on sign-in order.
    const presence = await setupPair(
      [{ id: "usr_shared", displayName: "Ada", online: false }],
      [{ id: "usr_shared", displayName: "Ada", online: true }],
    );
    await presence.refresh("usr_alice");
    await presence.refresh("usr_bea");

    expect(presence.listAll()).toHaveLength(1);
    expect(presence.listAll()[0]?.isOnline).toBe(true);
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
      kind: "friend.updated",
      accountId: "usr_alice",
      ts: Date.now(),
      payload: { userId: "usr_on_0", user: { displayName: "Iconed", status: "busy" } },
    });

    expect(presence.list("usr_alice")[0]?.iconUrl).toBe(ICON_URL);
    presence.stop();
  });

  test("a live profile read updates presence, and says whether it was news", async () => {
    const presence = await setup(friends(1, true, "on"));
    presence.start();
    await presence.refresh("usr_alice");
    expect(presence.list("usr_alice")[0]?.status).toBe("active");

    // What `GET /users/{id}` answers, which is fresher than the poll that filled the list.
    const changed = presence.observe("usr_alice", {
      id: "usr_on_0",
      status: "busy",
      statusDescription: "heads down",
      state: "online",
    });

    expect(changed).toBe(true);
    const updated = presence.list("usr_alice")[0];
    expect(updated?.status).toBe("busy");
    expect(updated?.statusDescription).toBe("heads down");
    expect(updated?.isOnline).toBe(true);

    // The same read again is not news. Otherwise every hover would announce a change and every
    // announcement would send the friends list back for a refetch.
    expect(
      presence.observe("usr_alice", {
        id: "usr_on_0",
        status: "busy",
        statusDescription: "heads down",
        state: "online",
      }),
    ).toBe(false);
    presence.stop();
  });

  test("`state` decides online-ness, not `status`", async () => {
    const presence = await setup(friends(1, true, "on"));
    presence.start();
    await presence.refresh("usr_alice");

    // VRChat keeps `status` at the user's *chosen* value while they are offline, so reading
    // online-ness off it would leave this friend online forever.
    presence.observe("usr_alice", { id: "usr_on_0", status: "active", state: "offline" });

    const updated = presence.list("usr_alice")[0];
    expect(updated?.isOnline).toBe(false);
    expect(updated?.status).toBe("active");
    presence.stop();
  });

  test("a profile read never invents a friend, and never blanks what it did not say", async () => {
    const presence = await setup([
      { id: "usr_on_0", displayName: "Iconed", online: true, userIcon: ICON_URL },
    ]);
    presence.start();
    await presence.refresh("usr_alice");

    // `GET /users/{id}` answers for anybody. Presence *is* the friends list, so a stranger read
    // through this account must not appear in it.
    expect(presence.observe("usr_alice", { id: "usr_stranger", status: "active" })).toBe(false);
    expect(presence.list("usr_alice").map((r) => r.id)).toEqual(["usr_on_0"]);

    // `""` is how VRChat spells "nothing", including in a shorter non-friend body. Writing it
    // through would strip the icon and the name off a row that already had them.
    presence.observe("usr_alice", {
      id: "usr_on_0",
      displayName: "",
      status: "join me",
      userIcon: "",
      profilePicOverride: "",
      currentAvatarImageUrl: "",
    });

    const updated = presence.list("usr_alice")[0];
    expect(updated?.status).toBe("join me");
    expect(updated?.displayName).toBe("Iconed");
    expect(updated?.iconUrl).toBe(ICON_URL);
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
