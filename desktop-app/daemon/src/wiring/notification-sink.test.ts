import { beforeEach, describe, expect, test } from "bun:test";
import { EventBus } from "../bus/event-bus.ts";
import { MEMORY, Store } from "../store/index.ts";
import { NotificationSink } from "./notification-sink.ts";

const NOW = 1_750_000_000_000;

describe("NotificationSink", () => {
  let store: Store;
  let bus: EventBus;
  let sink: NotificationSink;

  beforeEach(() => {
    store = Store.open(MEMORY);
    store.upsertAccount({
      id: "usr_a",
      display_name: "A",
      added_at: NOW,
      enabled: 1,
      last_seen_at: null,
    });
    bus = new EventBus();
    sink = new NotificationSink(store);
    sink.attach(bus);
  });

  function receive(payload: unknown, kind = "notification.received"): void {
    bus.emit({ kind, accountId: "usr_a", ts: NOW, payload });
  }

  test("persists a v1 notification", () => {
    receive({
      id: "not_1",
      type: "friendRequest",
      senderUserId: "usr_sender",
      senderUsername: "Sender",
      message: "hi",
      created_at: "2026-08-21T10:00:00.000Z",
    });

    const rows = store.listNotifications("usr_a");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("friendRequest");
    expect(rows[0]?.sender_display_name).toBe("Sender");
    // ISO on the wire, integer ms in the column.
    expect(rows[0]?.ts).toBe(Date.parse("2026-08-21T10:00:00.000Z"));
    expect(rows[0]?.seen).toBe(0);
  });

  test("falls back to receipt time rather than 0 when created_at is unusable", () => {
    // A 0 would sort the row to the beginning of time and bury it forever.
    receive({ id: "not_2", type: "invite", created_at: "not a date" });
    expect(store.listNotifications("usr_a")[0]?.ts).toBe(NOW);
  });

  test("accepts the v2 camelCase timestamp too", () => {
    receive(
      { id: "not_3", type: "invite", createdAt: "2026-08-21T11:00:00.000Z" },
      "notification.received_v2",
    );
    expect(store.listNotifications("usr_a")[0]?.ts).toBe(Date.parse("2026-08-21T11:00:00.000Z"));
  });

  test("an update replaces the existing row rather than duplicating it", () => {
    receive({ id: "not_4", type: "invite", message: "first" });
    bus.emit({
      kind: "notification.updated",
      accountId: "usr_a",
      ts: NOW + 1,
      payload: { id: "not_4", type: "invite", message: "second" },
    });

    const rows = store.listNotifications("usr_a");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe("second");
  });

  test("see-notification carries a bare id string, not an object", () => {
    // The exact shape that an unconditional JSON.parse would have swallowed upstream. If the sink
    // assumed an object here, marking-as-seen would silently never work.
    receive({ id: "not_5", type: "invite" });
    bus.emit({ kind: "notification.seen", accountId: "usr_a", ts: NOW, payload: "not_5" });

    expect(store.listNotifications("usr_a")[0]?.seen).toBe(1);
  });

  test("hide and delete mark seen rather than deleting the row", () => {
    // `clear-notification` arrives with no content at all, so acting destructively would mean
    // guessing which rows it meant. Marking seen is the recoverable reading.
    receive({ id: "not_6", type: "invite" });
    bus.emit({ kind: "notification.deleted", accountId: "usr_a", ts: NOW, payload: "not_6" });

    const rows = store.listNotifications("usr_a");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seen).toBe(1);
  });

  test("a clear with no content at all does not throw or destroy anything", () => {
    receive({ id: "not_7", type: "invite" });
    bus.emit({ kind: "notification.cleared", accountId: "usr_a", ts: NOW });

    expect(store.listNotifications("usr_a")).toHaveLength(1);
  });

  test("ignores malformed payloads instead of writing junk rows", () => {
    receive(undefined);
    receive("just a string");
    receive({ type: "invite" }); // no id
    expect(store.listNotifications("usr_a")).toHaveLength(0);
  });

  test("ignores an event with no account, which cannot be a real notification", () => {
    bus.emit({
      kind: "notification.received",
      accountId: null,
      ts: NOW,
      payload: { id: "not_8", type: "invite" },
    });
    expect(store.listNotifications("usr_a")).toHaveLength(0);
  });

  test("detach stops persisting", () => {
    sink.detach();
    receive({ id: "not_9", type: "invite" });
    expect(store.listNotifications("usr_a")).toHaveLength(0);
  });
});
