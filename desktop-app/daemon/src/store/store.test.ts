import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY, Store } from "./store.ts";

const ACCOUNT = "usr_test";
const T0 = 1_700_000_000_000;

/** A disposable directory, because the orphan sweep needs a real file reopened by a second Store. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "vrcz-store-"));
}

function seed(): Store {
  const store = Store.open(MEMORY);
  store.upsertAccount({
    id: ACCOUNT,
    display_name: "Tester",
    added_at: T0,
    enabled: 1,
    last_seen_at: null,
  });
  return store;
}

describe("accounts", () => {
  test("upsert updates rather than duplicating, and keeps last_seen_at on a null write", () => {
    const store = seed();
    store.touchAccount(ACCOUNT, T0 + 5);
    store.upsertAccount({
      id: ACCOUNT,
      display_name: "Renamed",
      added_at: T0,
      enabled: 0,
      last_seen_at: null,
    });

    const row = store.getAccount(ACCOUNT);
    expect(row?.display_name).toBe("Renamed");
    expect(row?.enabled).toBe(0);
    expect(row?.last_seen_at).toBe(T0 + 5);
    expect(store.listAccounts()).toHaveLength(1);
    store.close();
  });

  test("deleting an account cascades to its events", () => {
    const store = seed();
    store.insertEvent({
      account_id: ACCOUNT,
      ts: T0,
      session_id: null,
      kind: "friend.online",
      subject_id: "usr_a",
      location: null,
      payload: null,
    });

    store.deleteAccount(ACCOUNT);

    expect(store.listEvents(ACCOUNT, T0 + 1, 10)).toHaveLength(0);
    store.close();
  });

  test("an event for an unknown account is rejected by the foreign key", () => {
    const store = seed();
    expect(() =>
      store.insertEvent({
        account_id: "usr_nope",
        ts: T0,
        session_id: null,
        kind: "friend.online",
        subject_id: null,
        location: null,
        payload: null,
      }),
    ).toThrow();
    store.close();
  });
});

describe("sessions", () => {
  test("start, relocate, and end a session", () => {
    const store = seed();
    const id = store.startSession({
      account_id: ACCOUNT,
      display_name: "Tester",
      log_path: "C:/logs/output_log_1.txt",
      log_inode: null,
      started_at: T0,
      vr_mode: "desktop",
      current_location: null,
      current_world_id: null,
    });

    store.updateSessionLocation(id, "wrld_x:1234", "wrld_x");
    store.endSession(id, T0 + 1000, "clean");

    const row = store.getSession(id);
    expect(row?.current_world_id).toBe("wrld_x");
    expect(row?.ended_at).toBe(T0 + 1000);
    expect(row?.exit_kind).toBe("clean");
    expect(store.listOpenSessions()).toHaveLength(0);
    expect(store.listSessions(ACCOUNT)).toHaveLength(1);
    store.close();
  });

  test("re-starting the same log file at the same instant returns the same session", () => {
    const store = seed();
    const session = {
      account_id: ACCOUNT,
      display_name: "Tester",
      log_path: "C:/logs/output_log_1.txt",
      log_inode: 7,
      started_at: T0,
      vr_mode: null,
      current_location: null,
      current_world_id: null,
    };

    expect(store.startSession(session)).toBe(store.startSession(session));
    store.close();
  });

  test("re-adopting a still-live log file reopens its session rather than forking a new one", () => {
    // The daemon restarts (constantly, under `bun --watch`) while a client keeps running. The
    // watcher re-adopts the same file and must land on the same row — reopened, not duplicated.
    const store = seed();
    const session = {
      account_id: ACCOUNT,
      display_name: "Tester",
      log_path: "C:/logs/output_log_1.txt",
      log_inode: null,
      started_at: T0,
      vr_mode: null,
      current_location: null,
      current_world_id: null,
    };
    const id = store.startSession(session);
    store.endSession(id, T0 + 1000, "unknown");
    expect(store.listOpenSessions()).toHaveLength(0);

    expect(store.startSession(session)).toBe(id);
    expect(store.listOpenSessions()).toHaveLength(1);
    expect(store.getSession(id)?.exit_kind).toBeNull();
    store.close();
  });

  test("sessions left open by a previous process are closed when the database is opened", () => {
    // "The game closed but it still shows as live." A row open at open-time belongs to a process
    // that is gone; nothing else in the system would ever close it.
    const dir = tempDir();
    const path = join(dir, "orphans.sqlite");

    const first = Store.open(path);
    first.upsertAccount({
      id: ACCOUNT,
      display_name: "Tester",
      added_at: T0,
      enabled: 1,
      last_seen_at: null,
    });
    const id = first.startSession({
      account_id: ACCOUNT,
      display_name: "Tester",
      log_path: "C:/logs/output_log_1.txt",
      log_inode: null,
      started_at: T0,
      vr_mode: null,
      current_location: null,
      current_world_id: null,
    });
    first.insertEvents([
      {
        account_id: ACCOUNT,
        ts: T0 + 4000,
        session_id: id,
        kind: "gamelog.player_join",
        subject_id: null,
        location: null,
        payload: null,
      },
    ]);
    expect(first.listOpenSessions()).toHaveLength(1);
    first.close();

    // A new process opens the same database.
    const second = Store.open(path);
    expect(second.orphanedSessionsClosed).toBe(1);
    expect(second.listOpenSessions()).toHaveLength(0);
    // Ended at the last event actually observed, not at "now" — the daemon may have been down for
    // hours, and stretching the session over that gap would be a fabricated fact.
    expect(second.getSession(id)?.ended_at).toBe(T0 + 4000);
    expect(second.getSession(id)?.exit_kind).toBe("unknown");
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("events", () => {
  test("feed pages newest-first and honours the exclusive upper bound", () => {
    const store = seed();
    for (let i = 0; i < 5; i += 1) {
      store.insertEvent({
        account_id: ACCOUNT,
        ts: T0 + i,
        session_id: null,
        kind: "friend.online",
        subject_id: `usr_${i}`,
        location: null,
        payload: null,
      });
    }

    const page = store.listEvents(ACCOUNT, T0 + 3, 10);
    expect(page.map((e) => e.ts)).toEqual([T0 + 2, T0 + 1, T0]);
    expect(store.listEvents(ACCOUNT, T0 + 99, 2)).toHaveLength(2);
    store.close();
  });

  test("bulk insert runs in one transaction and rolls back whole on failure", () => {
    const store = seed();
    const good = {
      account_id: ACCOUNT,
      ts: T0,
      session_id: null,
      kind: "friend.online",
      subject_id: null,
      location: null,
      payload: null,
    };

    expect(store.insertEvents([good, { ...good, ts: T0 + 1 }])).toBe(2);
    expect(() =>
      store.insertEvents([
        { ...good, ts: T0 + 2 },
        { ...good, account_id: "nope" },
      ]),
    ).toThrow();
    expect(store.listEvents(ACCOUNT, T0 + 99, 10)).toHaveLength(2);
    store.close();
  });

  test("subject lookups cross accounts", () => {
    const store = seed();
    store.insertEvent({
      account_id: ACCOUNT,
      ts: T0,
      session_id: null,
      kind: "gamelog.player_join",
      subject_id: "usr_a",
      location: "wrld_x:1",
      payload: null,
    });

    expect(store.listEventsBySubject("usr_a", T0 + 1, 10)).toHaveLength(1);
    expect(store.countEventsByKind()).toEqual([{ kind: "gamelog.player_join", count: 1 }]);
    expect(store.distinctEventKinds()).toEqual(["gamelog.player_join"]);
    store.close();
  });
});

describe("friend log, caches, notes, notifications, avatars", () => {
  test("friend upsert flips to unfriended without losing the row", () => {
    const store = seed();
    const friend = {
      account_id: ACCOUNT,
      user_id: "usr_a",
      display_name: "A",
      trust_level: "known",
      friended_at: T0,
      unfriended_at: null,
    };
    store.upsertFriend(friend);
    expect(store.listFriends(ACCOUNT)).toHaveLength(1);

    store.upsertFriend({ ...friend, unfriended_at: T0 + 10 });

    expect(store.listFriends(ACCOUNT)).toHaveLength(0);
    expect(store.getFriend(ACCOUNT, "usr_a")?.unfriended_at).toBe(T0 + 10);
    store.close();
  });

  test("friend history is append-only and newest-first", () => {
    const store = seed();
    for (const ts of [T0, T0 + 1]) {
      store.insertFriendHistory({
        account_id: ACCOUNT,
        ts,
        type: "displayName",
        user_id: "usr_a",
        display_name: "New",
        previous_display_name: "Old",
        trust_level: null,
        previous_trust_level: null,
      });
    }

    expect(store.listFriendHistory(ACCOUNT, T0 + 99, 10).map((r) => r.ts)).toEqual([T0 + 1, T0]);
    store.close();
  });

  test("caches replace on refetch", () => {
    const store = seed();
    store.putUserCache("usr_a", T0, `{"v":1}`);
    store.putUserCache("usr_a", T0 + 1, `{"v":2}`);
    store.putWorldCache("wrld_a", T0, `{}`);
    store.putAvatarCache("avtr_a", T0, `{}`);

    expect(store.getUserCache("usr_a")).toEqual({
      id: "usr_a",
      fetched_at: T0 + 1,
      data: `{"v":2}`,
    });
    expect(store.getWorldCache("wrld_a")?.id).toBe("wrld_a");
    expect(store.getAvatarCache("avtr_a")?.id).toBe("avtr_a");
    expect(store.getUserCache("usr_missing")).toBeNull();
    store.close();
  });

  test("notes round-trip and delete", () => {
    const store = seed();
    store.putNote(ACCOUNT, "usr_a", "first", T0);
    store.putNote(ACCOUNT, "usr_a", "second", T0 + 1);

    expect(store.getNote(ACCOUNT, "usr_a")?.note).toBe("second");
    store.deleteNote(ACCOUNT, "usr_a");
    expect(store.getNote(ACCOUNT, "usr_a")).toBeNull();
    store.close();
  });

  test("notifications upsert by id and can be marked seen", () => {
    const store = seed();
    store.putNotification({
      id: "not_1",
      account_id: ACCOUNT,
      ts: T0,
      type: "friendRequest",
      sender_user_id: "usr_a",
      sender_display_name: "A",
      message: null,
      seen: 0,
      data: null,
    });
    store.markNotificationSeen("not_1");

    const rows = store.listNotifications(ACCOUNT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seen).toBe(1);
    store.close();
  });

  test("avatar history widens its window and counts sightings", () => {
    const store = seed();
    store.recordAvatarSeen(ACCOUNT, "avtr_a", T0 + 100);
    store.recordAvatarSeen(ACCOUNT, "avtr_a", T0);

    const row = store.listAvatarHistory(ACCOUNT)[0];
    expect(row?.first_seen).toBe(T0);
    expect(row?.last_seen).toBe(T0 + 100);
    expect(row?.seen_count).toBe(2);
    store.close();
  });
});

describe("retention config and housekeeping", () => {
  test("ships with defaults including the global fallback", () => {
    const store = seed();
    const config = new Map(store.listRetentionConfig().map((r) => [r.kind, r.retain_days]));

    expect(config.get("*")).toBe(90);
    expect(config.get("gamelog.player_join")).toBe(30);
    expect(config.get("notification.*")).toBe(365);
    store.close();
  });

  test("set and delete a window, and reject a nonsensical one", () => {
    const store = seed();
    store.setRetentionConfig("friend.location", 14, T0);
    expect(store.listRetentionConfig().find((r) => r.kind === "friend.location")?.retain_days).toBe(
      14,
    );

    store.deleteRetentionConfig("friend.location");
    expect(store.listRetentionConfig().find((r) => r.kind === "friend.location")).toBeUndefined();

    expect(() => store.setRetentionConfig("friend.location", 0, T0)).toThrow(RangeError);
    expect(() => store.setRetentionConfig("friend.location", 1.5, T0)).toThrow(RangeError);
    store.close();
  });

  test("meta round-trips and reports null for absent keys", () => {
    const store = seed();
    store.setMeta("k", "v1");
    store.setMeta("k", "v2");

    expect(store.getMeta("k")).toBe("v2");
    expect(store.getMeta("absent")).toBeNull();
    store.close();
  });

  test("reports a database size", () => {
    const store = seed();
    expect(store.dbSizeBytes()).toBeGreaterThan(0);
    store.incrementalVacuum();
    store.close();
  });
});
