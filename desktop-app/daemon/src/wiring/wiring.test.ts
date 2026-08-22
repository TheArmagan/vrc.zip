import { describe, expect, test } from "bun:test";
import { EventBus } from "../bus/event-bus.ts";
import type { SessionEvent, SessionSnapshot } from "../game-logs/index.ts";
import type { DecodedPipelineEvent } from "../pipeline/index.ts";
import { MEMORY, Store } from "../store/index.ts";
import { FeedWriter } from "./feed-writer.ts";
import { createLogSink } from "./log-bridge.ts";
import { busKindFor, toBusEvent } from "./pipeline-bridge.ts";

const NOW = 1_750_000_000_000;

/**
 * `events.account_id` and `sessions.account_id` are foreign keys, so an account row has to exist
 * before anything can reference it. That ordering is a real constraint on the daemon, not a test
 * artifact — the composition root upserts accounts before the feed writer is attached.
 */
function openStoreWithAccounts(...ids: string[]): Store {
  const store = Store.open(MEMORY);
  for (const id of ids) {
    store.upsertAccount({
      id,
      display_name: id,
      added_at: NOW,
      enabled: 1,
      last_seen_at: null,
    });
  }
  return store;
}

function decoded(type: string, data: unknown): DecodedPipelineEvent {
  return {
    kind: "event",
    type,
    data,
    raw: data,
    frame: JSON.stringify({ type, content: JSON.stringify(data) }),
    receivedAt: NOW,
  } as DecodedPipelineEvent;
}

describe("pipeline bridge", () => {
  test("maps wire names onto the dotted bus taxonomy", () => {
    expect(busKindFor("friend-online")).toBe("friend.online");
    expect(busKindFor("friend-location")).toBe("friend.location");
    // The case a naive replace("-", ".") gets wrong: this must not become
    // "notification.v2-delete", which would silently match no filter.
    expect(busKindFor("notification-v2-delete")).toBe("notification.deleted");
    expect(busKindFor("notification-v2-update")).toBe("notification.updated");
  });

  test("extracts the subject from a normal payload", () => {
    const event = toBusEvent("usr_a", decoded("friend-online", { userId: "usr_friend" }));
    expect(event.kind).toBe("friend.online");
    expect(event.subjectId).toBe("usr_friend");
    expect(event.accountId).toBe("usr_a");
  });

  test("reads friend-active's lowercase `userid`", () => {
    // A real upstream typo. Reading only the correct spelling drops the subject on every
    // friend-active event, which is the sort of thing nobody notices for months.
    const event = toBusEvent("usr_a", decoded("friend-active", { userid: "usr_friend" }));
    expect(event.subjectId).toBe("usr_friend");
  });

  test("carries VRChat's odd location values through untouched", () => {
    for (const location of ["", "offline", "traveling", "traveling:traveling", "private"]) {
      const event = toBusEvent("usr_a", decoded("friend-location", { userId: "u", location }));
      expect(event.location).toBe(location);
    }
  });

  test("survives a payload with no subject at all", () => {
    const event = toBusEvent("usr_a", decoded("clear-notification", undefined));
    expect(event.subjectId).toBeNull();
    expect(event.location).toBeNull();
  });
});

describe("feed writer", () => {
  function harness() {
    const store = openStoreWithAccounts("usr_a");
    const bus = new EventBus();
    const writer = new FeedWriter(store, { flushIntervalMs: 5 });
    writer.attach(bus);
    return { store, bus, writer };
  }

  test("batches rather than writing per event", () => {
    const { bus, writer, store } = harness();
    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: "friend.online", accountId: "usr_a", ts: NOW + i, subjectId: "usr_f" });
    }
    // Still queued: emit must stay synchronous and cheap, so the writer only pushes onto an array.
    expect(writer.pending).toBe(5);

    writer.flush();
    expect(store.listEvents("usr_a", NOW + 100, 10)).toHaveLength(5);
    store.close();
  });

  test("flushes early once the batch cap is reached", () => {
    const store = openStoreWithAccounts("usr_a");
    const bus = new EventBus();
    const writer = new FeedWriter(store, { maxBatch: 3 });
    writer.attach(bus);

    for (let i = 0; i < 3; i++) {
      bus.emit({ kind: "gamelog.player_join", accountId: "usr_a", ts: NOW + i });
    }
    // A burst must not grow unbounded waiting for a timer.
    expect(writer.pending).toBe(0);
    expect(store.listEvents("usr_a", NOW + 100, 10)).toHaveLength(3);
    store.close();
  });

  test("does not persist ephemeral UI state", () => {
    const { bus, writer, store } = harness();
    bus.emit({ kind: "account.state", accountId: "usr_a", ts: NOW });
    bus.emit({ kind: "session.update", accountId: "usr_a", ts: NOW });
    writer.flush();

    expect(store.listEvents("usr_a", NOW + 100, 10)).toHaveLength(0);
    store.close();
  });

  test("stores events from an unlinked game client", () => {
    // A VRChat client signed into an account vrc.zip does not manage is a normal state. Its events
    // must persist with a null account rather than being dropped or misattributed.
    const { bus, writer, store } = harness();
    bus.emit({ kind: "gamelog.player_join", accountId: null, ts: NOW, subjectId: "usr_stranger" });
    writer.flush();

    const rows = store.listEventsBySubject("usr_stranger", NOW + 100, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.account_id).toBeNull();
    store.close();
  });

  test("detach flushes what is queued", () => {
    const { bus, writer, store } = harness();
    bus.emit({ kind: "friend.online", accountId: "usr_a", ts: NOW });
    writer.detach();

    expect(store.listEvents("usr_a", NOW + 100, 10)).toHaveLength(1);
    // And stops listening.
    bus.emit({ kind: "friend.online", accountId: "usr_a", ts: NOW + 1 });
    expect(writer.pending).toBe(0);
    store.close();
  });
});

describe("log bridge", () => {
  function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
    return {
      id: "sess-1",
      accountId: null,
      userId: null,
      displayName: null,
      logPath: "C:/logs/output_log_2026-08-21.txt",
      logKey: "key-1",
      startedAt: NOW,
      endedAt: null,
      exitKind: null,
      vrMode: null,
      currentLocation: null,
      ...overrides,
    } as SessionSnapshot;
  }

  test("writes a session row and emits session.start", () => {
    const store = Store.open(MEMORY);
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => {
      seen.push(e.kind);
    });

    const sink = createLogSink(store, bus);
    sink.sessionStart(snapshot());

    expect(store.listOpenSessions()).toHaveLength(1);
    expect(seen).toEqual(["session.start"]);
    store.close();
  });

  test("an unlinked session persists with a null account", () => {
    const store = Store.open(MEMORY);
    const sink = createLogSink(store, new EventBus());
    sink.sessionStart(snapshot({ displayName: "SomeStranger" }));

    const open = store.listOpenSessions();
    expect(open[0]?.account_id).toBeNull();
    expect(open[0]?.display_name).toBe("SomeStranger");
    store.close();
  });

  test("two concurrent clients are two sessions, not one", () => {
    // VRCX assumes one game client. We do not — this is the divergence.
    const store = openStoreWithAccounts("usr_a", "usr_b");
    const sink = createLogSink(store, new EventBus());
    // Distinct log paths: two running clients each write their own output_log_*.txt, and the
    // store enforces that with a unique index on (log_path, started_at).
    sink.sessionStart(
      snapshot({ id: "sess-1", logKey: "key-1", accountId: "usr_a", logPath: "C:/logs/a.txt" }),
    );
    sink.sessionStart(
      snapshot({ id: "sess-2", logKey: "key-2", accountId: "usr_b", logPath: "C:/logs/b.txt" }),
    );

    expect(store.listOpenSessions()).toHaveLength(2);
    store.close();
  });

  test("ending a session records the exit kind and closes only that row", () => {
    const store = Store.open(MEMORY);
    const sink = createLogSink(store, new EventBus());
    sink.sessionStart(snapshot({ id: "sess-1", logKey: "key-1", logPath: "C:/logs/a.txt" }));
    sink.sessionStart(snapshot({ id: "sess-2", logKey: "key-2", logPath: "C:/logs/b.txt" }));

    sink.sessionEnd("sess-1", NOW + 5000, "crash");

    // Killing one client must not disturb the other's session.
    const open = store.listOpenSessions();
    expect(open).toHaveLength(1);
    expect(open[0]?.log_path).toBe("C:/logs/b.txt");
    store.close();
  });

  test("retroactive attribution reaches the database, not just the bus", () => {
    // The regression this exists for: `sessionUpdate` emitted a correct `session.update` event and
    // wrote nothing to SQLite. The UI looked right until you reloaded, `GET /api/sessions` served
    // `accountId: null` forever, and every session row in a months-old database was unattributed.
    // Asserting the bus event alone is exactly what let it through — so assert the row.
    const store = openStoreWithAccounts("usr_a");
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => {
      seen.push(e.kind);
    });

    const sink = createLogSink(store, bus);
    sink.sessionStart(snapshot());
    expect(store.listOpenSessions()[0]?.account_id).toBeNull();

    // The `User Authenticated:` line lands seconds into the log.
    sink.sessionUpdate("sess-1", {
      accountId: "usr_a",
      displayName: "Armagan",
      userId: "usr_a",
    });

    const row = store.listOpenSessions()[0];
    expect(row?.account_id).toBe("usr_a");
    expect(row?.display_name).toBe("Armagan");
    expect(seen).toEqual(["session.start", "session.update"]);
    store.close();
  });

  test("a later patch cannot blank an attribution already known", () => {
    // Identity only ever becomes more known. A vr-mode patch carries no account, and must not be
    // read as "this session has no account".
    const store = openStoreWithAccounts("usr_a");
    const sink = createLogSink(store, new EventBus());
    sink.sessionStart(snapshot());
    sink.sessionUpdate("sess-1", { accountId: "usr_a", displayName: "Armagan" });
    sink.sessionUpdate("sess-1", { vrMode: "vr" });

    const row = store.listOpenSessions()[0];
    expect(row?.account_id).toBe("usr_a");
    expect(row?.display_name).toBe("Armagan");
    expect(row?.vr_mode).toBe("vr");
    store.close();
  });

  test("the world id is persisted alongside the location, not dropped", () => {
    // `current_world_id` was hardcoded null at the call site while `current_location` held a real
    // `wrld_…`. The two disagreeing in the live database is what exposed it.
    const store = openStoreWithAccounts("usr_a");
    const sink = createLogSink(store, new EventBus());
    sink.sessionStart(snapshot());
    sink.sessionUpdate("sess-1", {
      currentLocation: "wrld_1234:5678~region(eu)",
      currentWorldId: "wrld_1234",
    });

    const row = store.listOpenSessions()[0];
    expect(row?.current_location).toBe("wrld_1234:5678~region(eu)");
    expect(row?.current_world_id).toBe("wrld_1234");
    store.close();
  });

  test("gamelog events reach the bus with their session and subject", () => {
    const store = openStoreWithAccounts("usr_a");
    const bus = new EventBus();
    const sink = createLogSink(store, bus);
    sink.sessionStart(snapshot({ id: "sess-1", accountId: "usr_a" }));
    const rowId = store.listOpenSessions()[0]?.id;

    const events: Array<{
      kind: string;
      sessionId: number | null | undefined;
      subjectId: string | null | undefined;
    }> = [];
    bus.subscribe(
      (e) => {
        events.push({ kind: e.kind, sessionId: e.sessionId, subjectId: e.subjectId });
      },
      { kinds: ["gamelog.*"] },
    );

    sink.event({
      kind: "player-join",
      at: NOW,
      sessionId: "sess-1",
      accountId: "usr_a",
      accountDisplayName: "Alice",
      logPath: "C:/logs/x.txt",
      displayName: "SomePlayer",
      userId: "usr_player",
    } as unknown as SessionEvent);

    // The store row id, not the watcher's string — the same identifier /api/sessions returns, so a
    // consumer can join the two without correlating on start time.
    expect(events).toEqual([
      { kind: "gamelog.player_join", sessionId: rowId, subjectId: "usr_player" },
    ]);
    store.close();
  });

  test("a gamelog event's sessionId joins directly against /api/sessions", () => {
    // Without this, a consumer holding a stream event and a REST session list has two different
    // identifiers and is reduced to correlating on start time — which mis-attributes two clients
    // launched in the same second. One id, published on both surfaces.
    const store = openStoreWithAccounts("usr_a", "usr_b");
    const bus = new EventBus();
    const sink = createLogSink(store, bus);

    sink.sessionStart(
      snapshot({ id: "sess-a", logKey: "k1", accountId: "usr_a", logPath: "C:/logs/a.txt" }),
    );
    sink.sessionStart(
      snapshot({ id: "sess-b", logKey: "k2", accountId: "usr_b", logPath: "C:/logs/b.txt" }),
    );

    const seen: Array<number | null | undefined> = [];
    bus.subscribe(
      (e) => {
        seen.push(e.sessionId);
      },
      { kinds: ["gamelog.*"] },
    );

    sink.event({
      kind: "player-join",
      at: NOW,
      sessionId: "sess-b",
      accountId: "usr_b",
      accountDisplayName: "B",
      logPath: "C:/logs/b.txt",
      displayName: "P",
      userId: "usr_p",
    } as unknown as SessionEvent);

    const sessions = store.listOpenSessions();
    const bRow = sessions.find((row) => row.log_path === "C:/logs/b.txt");
    expect(seen[0]).toBe(bRow?.id);
    // And it is genuinely discriminating: the two clients have different ids.
    expect(sessions[0]?.id).not.toBe(sessions[1]?.id);
    store.close();
  });

  test("an unmapped parser kind is dropped rather than emitted as a bare string", () => {
    const store = Store.open(MEMORY);
    const bus = new EventBus();
    const sink = createLogSink(store, bus);

    const seen: string[] = [];
    bus.subscribe((e) => {
      seen.push(e.kind);
    });

    sink.event({
      kind: "unknown",
      at: NOW,
      sessionId: "sess-1",
      accountId: null,
      accountDisplayName: null,
      logPath: "C:/logs/x.txt",
    } as unknown as SessionEvent);

    expect(seen).toEqual([]);
    store.close();
  });
});
