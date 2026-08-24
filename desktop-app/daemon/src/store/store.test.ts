import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY, Store } from "./store.ts";
import type { NewGraph, NewGraphRun } from "./types.ts";

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

  test("the filtered page narrows by kinds, family prefix and free text in SQL", () => {
    const store = seed();
    const base = {
      account_id: ACCOUNT,
      ts: T0,
      session_id: null,
      subject_id: null,
      location: null,
      payload: null,
    };
    store.insertEvent({ ...base, ts: T0 + 1, kind: "friend.online", subject_id: "usr_a" });
    store.insertEvent({ ...base, ts: T0 + 2, kind: "friend.offline", subject_id: "usr_b" });
    store.insertEvent({
      ...base,
      ts: T0 + 3,
      kind: "gamelog.player_join",
      payload: JSON.stringify({ displayName: "Ada Lovelace" }),
    });
    // A kind from a daemon newer than this build. It still belongs to the `gamelog` family, and a
    // family filter assembled from a hardcoded kind list is exactly what would drop it.
    store.insertEvent({ ...base, ts: T0 + 4, kind: "gamelog.invented_later" });

    const byKinds = store.listEventsFiltered({
      kinds: ["friend.online", "friend.offline"],
      before: T0 + 99,
      limit: 10,
    });
    expect(byKinds.map((event) => event.kind)).toEqual(["friend.offline", "friend.online"]);

    const byFamily = store.listEventsFiltered({
      families: ["gamelog"],
      before: T0 + 99,
      limit: 10,
    });
    expect(byFamily.map((event) => event.kind)).toEqual([
      "gamelog.invented_later",
      "gamelog.player_join",
    ]);

    // Case-insensitive, and it reaches into the payload — which is where a player's name lives.
    const bySearch = store.listEventsFiltered({ search: "ada lov", before: T0 + 99, limit: 10 });
    expect(bySearch.map((event) => event.ts)).toEqual([T0 + 3]);

    // A LIKE metacharacter is a literal, not a wildcard: `%` must not match everything.
    expect(store.listEventsFiltered({ search: "%", before: T0 + 99, limit: 10 })).toHaveLength(0);

    // Kinds and families intersect rather than union. The game log scopes itself to a family and
    // then offers per-kind checkboxes inside it; ORed, ticking one would widen the query back to
    // the whole family and the filter would appear to do nothing.
    const both = store.listEventsFiltered({
      kinds: ["gamelog.player_join", "friend.online"],
      families: ["gamelog"],
      before: T0 + 99,
      limit: 10,
    });
    expect(both.map((event) => event.kind)).toEqual(["gamelog.player_join"]);
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

  /*
   * The whole point of `listAllEvents`. A game client signed into an account vrc.zip does not
   * manage writes `gamelog.*` rows with `account_id IS NULL` (PLAN.md §1.7), and the control API
   * used to answer "no accountId" by fanning out over the known accounts — which can never see
   * those rows no matter how far the user scrolls.
   */
  test("the all-accounts feed returns rows with a null account_id", () => {
    const store = seed();
    const sessionId = store.startSession({
      account_id: null,
      display_name: "Unmanaged",
      log_path: "C:/logs/output_log_unmanaged.txt",
      log_inode: null,
      started_at: T0,
      vr_mode: null,
      current_location: null,
      current_world_id: null,
    });
    store.insertEvent({
      account_id: null,
      ts: T0 + 1,
      session_id: sessionId,
      kind: "gamelog.player_join",
      subject_id: "usr_stranger",
      location: "wrld_x:1",
      payload: null,
    });
    store.insertEvent({
      account_id: ACCOUNT,
      ts: T0,
      session_id: null,
      kind: "friend.online",
      subject_id: "usr_a",
      location: null,
      payload: null,
    });

    const all = store.listAllEvents(T0 + 99, 10);
    expect(all.map((e) => e.account_id)).toEqual([null, ACCOUNT]);
    // And the per-account query still refuses to invent an owner for the unmanaged row.
    expect(store.listEvents(ACCOUNT, T0 + 99, 10)).toHaveLength(1);
    store.close();
  });

  test("session and kind filters page in SQL rather than after the limit", () => {
    const store = seed();
    const sessionId = store.startSession({
      account_id: ACCOUNT,
      display_name: "Tester",
      log_path: "C:/logs/output_log_a.txt",
      log_inode: null,
      started_at: T0,
      vr_mode: "desktop",
      current_location: null,
      current_world_id: null,
    });
    const otherSession = store.startSession({
      account_id: ACCOUNT,
      display_name: "Tester",
      log_path: "C:/logs/output_log_b.txt",
      log_inode: null,
      started_at: T0,
      vr_mode: "vr",
      current_location: null,
      current_world_id: null,
    });

    // Interleaved so a page of joins can only come out right if SQL did the filtering: a JS
    // filter over `LIMIT 2` would see one join and one leave and return a single row.
    for (let i = 0; i < 4; i += 1) {
      store.insertEvent({
        account_id: ACCOUNT,
        ts: T0 + i * 2,
        session_id: sessionId,
        kind: "gamelog.player_join",
        subject_id: `usr_${i}`,
        location: null,
        payload: null,
      });
      store.insertEvent({
        account_id: ACCOUNT,
        ts: T0 + i * 2 + 1,
        session_id: sessionId,
        kind: "gamelog.player_leave",
        subject_id: `usr_${i}`,
        location: null,
        payload: null,
      });
    }
    store.insertEvent({
      account_id: ACCOUNT,
      ts: T0 + 100,
      session_id: otherSession,
      kind: "gamelog.player_join",
      subject_id: "usr_elsewhere",
      location: null,
      payload: null,
    });

    expect(store.listEventsBySession(sessionId, T0 + 999, 100)).toHaveLength(8);
    expect(
      store.listEventsBySession(sessionId, T0 + 999, 2, "gamelog.player_join").map((e) => e.ts),
    ).toEqual([T0 + 6, T0 + 4]);
    // Paging with `before` walks the same filtered sequence.
    expect(
      store.listEventsBySession(sessionId, T0 + 4, 2, "gamelog.player_join").map((e) => e.ts),
    ).toEqual([T0 + 2, T0]);
    expect(store.listEventsBySession(otherSession, T0 + 999, 100)).toHaveLength(1);

    expect(store.listEvents(ACCOUNT, T0 + 999, 100, "gamelog.player_join")).toHaveLength(5);
    expect(store.listAllEvents(T0 + 999, 100, "gamelog.player_leave")).toHaveLength(4);
    expect(store.listEventsBySubject("usr_0", T0 + 999, 100, "gamelog.player_leave")).toHaveLength(
      1,
    );
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
    store.putUserCache(ACCOUNT, "usr_a", T0, `{"v":1}`);
    store.putUserCache(ACCOUNT, "usr_a", T0 + 1, `{"v":2}`);
    store.putWorldCache("wrld_a", T0, `{}`);
    store.putAvatarCache("avtr_a", T0, `{}`);

    expect(store.getUserCache(ACCOUNT, "usr_a")).toEqual({
      id: "usr_a",
      fetched_at: T0 + 1,
      data: `{"v":2}`,
    });
    expect(store.getWorldCache("wrld_a")?.id).toBe("wrld_a");
    expect(store.getAvatarCache("avtr_a")?.id).toBe("avtr_a");
    expect(store.getUserCache(ACCOUNT, "usr_missing")).toBeNull();
    store.close();
  });

  /*
   * The reason migration 002 exists. `GET /users/{id}` shows a friend fields it hides from a
   * stranger, so two accounts looking at the same person hold genuinely different bodies — and
   * before this key change the second fetch overwrote the first.
   */
  test("the user cache is per (account, user), not per user", () => {
    const store = seed();
    const other = "usr_other_viewer";
    store.upsertAccount({
      id: other,
      display_name: "Other",
      added_at: T0,
      enabled: 1,
      last_seen_at: null,
    });

    store.putUserCache(ACCOUNT, "usr_a", T0, `{"isFriend":true,"location":"wrld_a:1"}`);
    store.putUserCache(other, "usr_a", T0 + 1, `{"isFriend":false,"location":""}`);

    expect(store.getUserCache(ACCOUNT, "usr_a")?.data).toBe(
      `{"isFriend":true,"location":"wrld_a:1"}`,
    );
    expect(store.getUserCache(other, "usr_a")?.data).toBe(`{"isFriend":false,"location":""}`);
    // A third account has never looked, and must not inherit either view.
    expect(store.getUserCache("usr_nobody", "usr_a")).toBeNull();
    store.close();
  });

  test("deleting an account drops only its own cached views", () => {
    const store = seed();
    const other = "usr_other_viewer";
    store.upsertAccount({
      id: other,
      display_name: "Other",
      added_at: T0,
      enabled: 1,
      last_seen_at: null,
    });
    store.putUserCache(ACCOUNT, "usr_a", T0, `{"v":1}`);
    store.putUserCache(other, "usr_a", T0, `{"v":2}`);

    store.deleteAccount(other);

    expect(store.getUserCache(ACCOUNT, "usr_a")?.data).toBe(`{"v":1}`);
    expect(store.getUserCache(other, "usr_a")).toBeNull();
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

// ---------------------------------------------------------------------------
// graphs (Phase 4)
// ---------------------------------------------------------------------------

function addGraph(store: Store, id = "g1", overrides: Partial<NewGraph> = {}): void {
  store.insertGraph({
    id,
    name: "Greet arrivals",
    description: "",
    enabled: 0,
    armed: 0,
    concurrency: "parallel",
    account_id: ACCOUNT,
    definition: JSON.stringify({ nodes: [], edges: [] }),
    created_at: T0,
    updated_at: T0,
    ...overrides,
  });
}

function addRun(
  store: Store,
  id = "r1",
  graphId = "g1",
  overrides: Partial<NewGraphRun> = {},
): void {
  store.insertGraphRun({
    id,
    graph_id: graphId,
    trigger_node: "n_trigger",
    status: "running",
    dry_run: 1,
    state: "{}",
    started_at: T0,
    updated_at: T0,
    ...overrides,
  });
}

describe("graphs", () => {
  test("round-trips, and a new graph is neither enabled nor armed", () => {
    const store = seed();
    addGraph(store);

    const row = store.getGraph("g1");
    expect(row?.name).toBe("Greet arrivals");
    expect(row?.enabled).toBe(0);
    expect(row?.armed).toBe(0);
    expect(row?.concurrency).toBe("parallel");
    expect(row?.disabled_reason).toBeNull();
    expect(store.listGraphs()).toHaveLength(1);
    expect(store.listEnabledGraphs()).toHaveLength(0);
    store.close();
  });

  test("a save cannot arm a graph or switch it on", () => {
    const store = seed();
    addGraph(store);
    store.setGraphEnabled("g1", true);
    store.setGraphArmed("g1", true);

    store.updateGraph(
      "g1",
      {
        name: "Renamed",
        description: "now with a body",
        concurrency: "queue",
        account_id: null,
        definition: '{"nodes":[1]}',
      },
      T0 + 10,
    );

    const row = store.getGraph("g1");
    expect(row?.name).toBe("Renamed");
    expect(row?.concurrency).toBe("queue");
    expect(row?.definition).toBe('{"nodes":[1]}');
    expect(row?.updated_at).toBe(T0 + 10);
    // The point of the test: the two switches are untouched by a document save, in both directions.
    expect(row?.enabled).toBe(1);
    expect(row?.armed).toBe(1);
    store.close();
  });

  test("disabling carries a reason, and enabling clears it", () => {
    const store = seed();
    addGraph(store, "g1", { enabled: 1 });

    store.setGraphEnabled("g1", false, "Hit 200 runs in an hour");
    expect(store.getGraph("g1")?.enabled).toBe(0);
    expect(store.getGraph("g1")?.disabled_reason).toBe("Hit 200 runs in an hour");

    store.setGraphEnabled("g1", true);
    expect(store.getGraph("g1")?.disabled_reason).toBeNull();
    store.close();
  });

  test("removing an account leaves the graph, without an acting account", () => {
    const store = seed();
    addGraph(store);
    store.deleteAccount(ACCOUNT);

    // ON DELETE SET NULL, not CASCADE: removing an account must not silently delete the
    // automations that referenced it.
    const row = store.getGraph("g1");
    expect(row).not.toBeNull();
    expect(row?.account_id).toBeNull();
    store.close();
  });

  test("rejects a concurrency mode and a run status that are not in the vocabulary", () => {
    const store = seed();
    expect(() => addGraph(store, "bad", { concurrency: "whenever" })).toThrow();
    addGraph(store);
    expect(() => addRun(store, "bad", "g1", { status: "finished" })).toThrow();
    store.close();
  });
});

describe("graph runs", () => {
  test("a parked run counts as live and comes back when it is due", () => {
    const store = seed();
    addGraph(store, "g1", { enabled: 1 });
    addRun(store, "r1");

    expect(store.countLiveGraphRuns("g1")).toBe(1);

    store.parkGraphRun("r1", "n_wait", T0 + 60_000, '{"done":["n_trigger"]}', T0 + 1);
    const parked = store.getGraphRun("r1");
    expect(parked?.status).toBe("waiting");
    expect(parked?.wait_node).toBe("n_wait");
    expect(parked?.resume_at).toBe(T0 + 60_000);
    // Still live. A run that waits has not finished, and treating it as a free slot is how one
    // graph ends up with fifty copies of itself in flight.
    expect(store.countLiveGraphRuns("g1")).toBe(1);

    expect(store.listDueGraphRuns(T0 + 59_999)).toHaveLength(0);
    expect(store.listDueGraphRuns(T0 + 60_000).map((r) => r.id)).toEqual(["r1"]);
    store.close();
  });

  test("advancing a run clears the parking", () => {
    const store = seed();
    addGraph(store);
    addRun(store);
    store.parkGraphRun("r1", "n_wait", T0 + 60_000, "{}", T0 + 1);

    store.updateGraphRunState("r1", "running", '{"done":["n_wait"]}', T0 + 2);
    const row = store.getGraphRun("r1");
    expect(row?.status).toBe("running");
    expect(row?.wait_node).toBeNull();
    expect(row?.resume_at).toBeNull();
    expect(store.listDueGraphRuns(T0 + 999_999)).toHaveLength(0);
    store.close();
  });

  test("queued runs come back oldest first, and by status", () => {
    const store = seed();
    addGraph(store);
    addRun(store, "r1", "g1", { status: "queued", started_at: T0 + 20 });
    addRun(store, "r2", "g1", { status: "queued", started_at: T0 + 10 });
    addRun(store, "r3", "g1", { status: "running" });

    expect(store.nextQueuedGraphRun("g1")?.id).toBe("r2");
    expect(store.countGraphRunsByStatus("g1", "queued")).toBe(2);
    expect(store.listGraphRunsByStatus("queued").map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(store.countLiveGraphRuns("g1")).toBe(3);
    store.close();
  });

  test("the last run of every graph comes back in one scan, and never-run graphs are absent", () => {
    // What the Graphs list draws as "ran 2m ago". Absent rather than zero, because a graph that has
    // never run and one that ran at the epoch are different sentences.
    const store = seed();
    addGraph(store, "g1");
    addGraph(store, "g2");
    addGraph(store, "g3");
    addRun(store, "r1", "g1", { started_at: T0 });
    addRun(store, "r2", "g1", { started_at: T0 + 5000 });
    addRun(store, "r3", "g2", { started_at: T0 + 100 });

    const times = store.lastGraphRunTimes();
    expect(times.get("g1")).toBe(T0 + 5000);
    expect(times.get("g2")).toBe(T0 + 100);
    expect(times.has("g3")).toBe(false);
    store.close();
  });

  test("a run ends by being deleted, and deleting the graph takes its runs with it", () => {
    const store = seed();
    addGraph(store);
    addRun(store, "r1");
    addRun(store, "r2");

    store.deleteGraphRun("r1");
    expect(store.getGraphRun("r1")).toBeNull();
    expect(store.listGraphRuns("g1")).toHaveLength(1);

    store.deleteGraph("g1");
    expect(store.getGraphRun("r2")).toBeNull();
    store.close();
  });

  test("the graph retention windows are seeded", () => {
    const store = seed();
    const byKind = new Map(store.listRetentionConfig().map((r) => [r.kind, r.retain_days]));

    expect(byKind.get("graph.*")).toBe(30);
    expect(byKind.get("graph.run.dropped")).toBe(7);
    // A note a graph wrote to tell the user something outlives the run that produced it.
    expect(byKind.get("graph.note")).toBe(365);
    store.close();
  });
});
