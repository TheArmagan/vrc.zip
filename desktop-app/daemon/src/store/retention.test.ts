import { describe, expect, test } from "bun:test";
import {
  applyRetentionUpdate,
  describeRetention,
  FALLBACK_RETAIN_DAYS,
  GLOBAL_DEFAULT_KIND,
  LAST_RUN_META_KEY,
  NEVER_DELETED_TABLES,
  nextRunDelay,
  planRetention,
  resolveRetainDays,
  rulesFrom,
  runRetention,
  startRetentionScheduler,
} from "./retention.ts";
import { MEMORY, Store } from "./store.ts";
import type { EventsDailyRow } from "./types.ts";

const DAY = 86_400_000;
/** A round "now" so day buckets in the assertions are obvious. 2024-01-31T00:00:00Z. */
const NOW = 1_706_659_200_000;
const ACCOUNT = "usr_test";

function seed(): Store {
  const store = Store.open(MEMORY);
  store.upsertAccount({
    id: ACCOUNT,
    display_name: "Tester",
    added_at: NOW - 400 * DAY,
    enabled: 1,
    last_seen_at: NOW,
  });
  return store;
}

function addEvent(
  store: Store,
  kind: string,
  ts: number,
  subject: string | null = "usr_other",
  payload: string | null = null,
): void {
  store.insertEvent({
    account_id: ACCOUNT,
    ts,
    session_id: null,
    kind,
    subject_id: subject,
    location: null,
    payload,
  });
}

function dailyRows(store: Store): EventsDailyRow[] {
  return store.db
    .query<EventsDailyRow, []>(`SELECT * FROM events_daily ORDER BY day, kind, subject_id`)
    .all();
}

function count(store: Store, table: string): number {
  return store.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
}

describe("resolveRetainDays", () => {
  const rules = rulesFrom([
    { kind: GLOBAL_DEFAULT_KIND, retain_days: 90, updated_at: 0 },
    { kind: "gamelog.*", retain_days: 90, updated_at: 0 },
    { kind: "gamelog.player_join", retain_days: 30, updated_at: 0 },
    { kind: "notification.*", retain_days: 365, updated_at: 0 },
  ]);

  test("prefers an exact match", () => {
    expect(resolveRetainDays(rules, "gamelog.player_join")).toBe(30);
  });

  test("falls back to the longest matching prefix pattern", () => {
    expect(resolveRetainDays(rules, "gamelog.portal")).toBe(90);
    expect(resolveRetainDays(rules, "notification.friendRequest")).toBe(365);
  });

  test("falls back to the global default for an unconfigured kind", () => {
    expect(resolveRetainDays(rules, "brand.new.kind")).toBe(90);
  });

  test("falls back to a hard default when even the global row is gone", () => {
    expect(resolveRetainDays(new Map(), "anything")).toBe(FALLBACK_RETAIN_DAYS);
  });

  test("overrides shadow the stored config", () => {
    const previewed = rulesFrom([{ kind: GLOBAL_DEFAULT_KIND, retain_days: 90, updated_at: 0 }], {
      "friend.location": 7,
    });
    expect(resolveRetainDays(previewed, "friend.location")).toBe(7);
  });
});

describe("runRetention", () => {
  test("rolls expiring rows into events_daily with correct counts, then deletes them", () => {
    const store = seed();
    // gamelog.player_join keeps 30 days. Two rows on one expired day, one on another, plus a
    // fresh row that must survive.
    addEvent(store, "gamelog.player_join", NOW - 40 * DAY, "usr_a");
    addEvent(store, "gamelog.player_join", NOW - 40 * DAY + 1000, "usr_a");
    addEvent(store, "gamelog.player_join", NOW - 41 * DAY, "usr_b");
    addEvent(store, "gamelog.player_join", NOW - 1 * DAY, "usr_a");

    const result = runRetention(store, { now: NOW });

    expect(result.totalDeleted).toBe(3);
    expect(result.deletedByKind).toEqual({ "gamelog.player_join": 3 });
    expect(count(store, "events")).toBe(1);

    const rows = dailyRows(store);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => ({ kind: r.kind, subject: r.subject_id, count: r.count }))).toEqual([
      { kind: "gamelog.player_join", subject: "usr_b", count: 1 },
      { kind: "gamelog.player_join", subject: "usr_a", count: 2 },
    ]);
    // Days are UTC midnights, so they divide evenly.
    for (const row of rows) expect(row.day % DAY).toBe(0);

    store.close();
  });

  test("sums payload.duration_ms into total_ms and ignores non-JSON payloads", () => {
    const store = seed();
    const ts = NOW - 40 * DAY;
    addEvent(store, "gamelog.player_join", ts, "usr_a", JSON.stringify({ duration_ms: 1500 }));
    addEvent(store, "gamelog.player_join", ts + 1, "usr_a", JSON.stringify({ duration_ms: 500 }));
    addEvent(store, "gamelog.player_join", ts + 2, "usr_a", "not json at all");

    runRetention(store, { now: NOW });

    const rows = dailyRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
    expect(rows[0]?.total_ms).toBe(2000);
    store.close();
  });

  test("accumulates into an existing events_daily bucket rather than replacing it", () => {
    const store = seed();
    const ts = NOW - 40 * DAY;
    addEvent(store, "gamelog.player_join", ts, "usr_a");
    runRetention(store, { now: NOW });
    addEvent(store, "gamelog.player_join", ts + 1, "usr_a");
    runRetention(store, { now: NOW });

    const rows = dailyRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(2);
    store.close();
  });

  test("applies each kind's own window", () => {
    const store = seed();
    // 60 days old: past player_join's 30d window, inside friend.online's 90d one.
    addEvent(store, "gamelog.player_join", NOW - 60 * DAY);
    addEvent(store, "friend.online", NOW - 60 * DAY);
    addEvent(store, "notification.friendRequest", NOW - 300 * DAY);

    runRetention(store, { now: NOW });

    const remaining = store
      .countEventsByKind()
      .map((r) => r.kind)
      .sort();
    expect(remaining).toEqual(["friend.online", "notification.friendRequest"]);
    store.close();
  });

  test("an unconfigured kind still expires under the global default", () => {
    const store = seed();
    addEvent(store, "brand.new.kind", NOW - 200 * DAY);
    addEvent(store, "brand.new.kind", NOW - 10 * DAY);

    runRetention(store, { now: NOW });

    expect(count(store, "events")).toBe(1);
    store.close();
  });

  test("never deletes from the protected tables", () => {
    const store = seed();
    const old = NOW - 3000 * DAY;
    store.upsertFriend({
      account_id: ACCOUNT,
      user_id: "usr_a",
      display_name: "A",
      trust_level: "trusted",
      friended_at: old,
      unfriended_at: null,
    });
    store.insertFriendHistory({
      account_id: ACCOUNT,
      ts: old,
      type: "displayName",
      user_id: "usr_a",
      display_name: "A",
      previous_display_name: "Older A",
      trust_level: null,
      previous_trust_level: null,
    });
    store.putNote(ACCOUNT, "usr_a", "met in 2016", old);
    store.recordAvatarSeen(ACCOUNT, "avtr_a", old);
    store.putUserCache(ACCOUNT, "usr_a", old, `{"id":"usr_a"}`);
    // Configure an absurdly short window to prove config cannot reach these tables.
    store.setRetentionConfig(GLOBAL_DEFAULT_KIND, 1, NOW);
    addEvent(store, "gamelog.player_join", old);

    runRetention(store, { now: NOW });

    expect(count(store, "events")).toBe(0);
    for (const table of NEVER_DELETED_TABLES) expect(count(store, table)).toBe(1);
    store.close();
  });

  test("records the run timestamp in meta", () => {
    const store = seed();
    addEvent(store, "gamelog.player_join", NOW - 90 * DAY);
    runRetention(store, { now: NOW });
    expect(store.getMeta(LAST_RUN_META_KEY)).toBe(String(NOW));
    store.close();
  });

  test("is a no-op when nothing has expired", () => {
    const store = seed();
    addEvent(store, "gamelog.player_join", NOW - 1 * DAY);

    const result = runRetention(store, { now: NOW });

    expect(result.totalDeleted).toBe(0);
    expect(result.deletedByKind).toEqual({});
    expect(dailyRows(store)).toHaveLength(0);
    expect(count(store, "events")).toBe(1);
    store.close();
  });
});

describe("planRetention", () => {
  test("matches what the real run then deletes", () => {
    const store = seed();
    addEvent(store, "gamelog.player_join", NOW - 60 * DAY, "usr_a");
    addEvent(store, "gamelog.player_join", NOW - 60 * DAY, "usr_b");
    addEvent(store, "gamelog.player_join", NOW - 2 * DAY, "usr_a");
    addEvent(store, "friend.location", NOW - 45 * DAY, "usr_a");
    addEvent(store, "friend.status", NOW - 45 * DAY, "usr_a");
    addEvent(store, "notification.friendRequest", NOW - 500 * DAY, "usr_a");

    const plan = planRetention(store, { now: NOW });
    const expected = Object.fromEntries(
      plan.entries.filter((e) => e.rows > 0).map((e) => [e.kind, e.rows]),
    );

    const result = runRetention(store, { now: NOW });

    expect(result.deletedByKind).toEqual(expected);
    expect(result.totalDeleted).toBe(plan.totalRows);
    // And the dry run really was a dry run: it left the same rows behind that the plan predicted.
    for (const entry of plan.entries) {
      const left =
        store.db
          .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`)
          .get(entry.kind)?.n ?? -1;
      expect(left).toBe(entry.remaining);
    }
    store.close();
  });

  test("previews a proposed config change without touching anything", () => {
    const store = seed();
    for (let i = 1; i <= 20; i += 1) addEvent(store, "friend.online", NOW - i * DAY);

    const asIs = planRetention(store, { now: NOW });
    expect(asIs.totalRows).toBe(0);

    const shortened = planRetention(store, { now: NOW, overrides: { "friend.online": 7 } });
    expect(shortened.totalRows).toBe(13);
    expect(shortened.entries[0]?.retainDays).toBe(7);
    expect(count(store, "events")).toBe(20);

    // Applying that config for real deletes exactly what the preview promised.
    store.setRetentionConfig("friend.online", 7, NOW);
    const result = runRetention(store, { now: NOW });
    expect(result.totalDeleted).toBe(shortened.totalRows);
    store.close();
  });

  test("reports every kind present, including ones with nothing to delete", () => {
    const store = seed();
    addEvent(store, "friend.online", NOW - 1 * DAY);
    addEvent(store, "gamelog.player_join", NOW - 400 * DAY);

    const plan = planRetention(store, { now: NOW });

    expect(plan.entries.map((e) => e.kind)).toEqual(["friend.online", "gamelog.player_join"]);
    expect(plan.entries[0]?.rows).toBe(0);
    expect(plan.entries[1]?.rows).toBe(1);
    store.close();
  });
});

describe("nextRunDelay", () => {
  test("lands on the requested hour, in the future, plus jitter", () => {
    const noon = new Date(2024, 0, 15, 12, 0, 0, 0).getTime();
    const delay = nextRunDelay(noon, 4, 0, 0);
    const at = new Date(noon + delay);

    expect(delay).toBeGreaterThan(0);
    expect(at.getHours()).toBe(4);
    expect(at.getDate()).toBe(16);
  });

  test("adds at most jitterMs", () => {
    const noon = new Date(2024, 0, 15, 12, 0, 0, 0).getTime();
    const base = nextRunDelay(noon, 4, 0, 0);
    expect(nextRunDelay(noon, 4, 3_600_000, 0.5)).toBe(base + 1_800_000);
    expect(nextRunDelay(noon, 4, 3_600_000, 0.999999) - base).toBeLessThan(3_600_000);
  });
});

describe("startRetentionScheduler", () => {
  test("schedules a future run and can be stopped without running", () => {
    const store = seed();
    addEvent(store, "gamelog.player_join", NOW - 400 * DAY);
    const now = Date.now();

    const scheduler = startRetentionScheduler(store, { hour: 4, jitterMs: 0, random: () => 0 });

    expect(scheduler.nextRunAt).toBeGreaterThan(now);
    scheduler.stop();
    expect(count(store, "events")).toBe(1);
    store.close();
  });
});

describe("describeRetention", () => {
  test("reports the default, the rules, and per-kind provenance", () => {
    const store = seed();
    store.setRetentionConfig(GLOBAL_DEFAULT_KIND, 90, NOW);
    store.setRetentionConfig("gamelog.*", 30, NOW);
    store.setRetentionConfig("friend.online", 7, NOW);

    addEvent(store, "gamelog.player-join", NOW - 40 * DAY);
    addEvent(store, "gamelog.player-join", NOW - 10 * DAY);
    addEvent(store, "friend.online", NOW - 10 * DAY);
    addEvent(store, "user.avatar", NOW - 10 * DAY);

    const described = describeRetention(store, { now: NOW, nextRunAt: NOW + DAY });

    expect(described.defaultRetainDays).toBe(90);
    // The `'*'` row is never listed as a rule — it has its own field, and a row reading "*" in a
    // list of event kinds is a row somebody will set to one day. Everything else 001 seeds is
    // there too, which is why this checks membership and ordering rather than the whole list.
    expect(described.rules).toContainEqual({ kind: "friend.online", retainDays: 7 });
    expect(described.rules).toContainEqual({ kind: "gamelog.*", retainDays: 30 });
    expect(described.rules.some((rule) => rule.kind === GLOBAL_DEFAULT_KIND)).toBe(false);
    expect(described.rules.map((rule) => rule.kind)).toEqual(
      [...described.rules.map((rule) => rule.kind)].sort((a, b) => a.localeCompare(b)),
    );

    const byKind = new Map(described.kinds.map((entry) => [entry.kind, entry]));
    expect(byKind.get("gamelog.player-join")).toEqual({
      kind: "gamelog.player-join",
      retainDays: 30,
      source: "prefix",
      rows: 2,
      expiring: 1,
    });
    expect(byKind.get("friend.online")?.source).toBe("exact");
    expect(byKind.get("user.avatar")).toMatchObject({ retainDays: 90, source: "default" });

    // The 40-day-old gamelog row against the 30-day family rule, plus the 10-day-old
    // `friend.online` against the 7-day exact rule.
    expect(described.totalExpiring).toBe(2);
    expect(described.nextRunAt).toBe(NOW + DAY);
    expect(described.preview).toBe(false);
    expect(described.lastRunAt).toBeNull();
    store.close();
  });

  test("falls back rather than keeping forever when the '*' row is gone", () => {
    const store = seed();
    store.deleteRetentionConfig(GLOBAL_DEFAULT_KIND);
    addEvent(store, "user.avatar", NOW - 10 * DAY);

    const described = describeRetention(store, { now: NOW });
    expect(described.defaultRetainDays).toBe(FALLBACK_RETAIN_DAYS);
    expect(described.kinds[0]?.source).toBe("fallback");
    store.close();
  });

  test("overrides preview a change without writing it", () => {
    const store = seed();
    store.setRetentionConfig(GLOBAL_DEFAULT_KIND, 90, NOW);
    addEvent(store, "user.avatar", NOW - 40 * DAY);

    const before = describeRetention(store, { now: NOW });
    expect(before.totalExpiring).toBe(0);

    const previewed = describeRetention(store, {
      now: NOW,
      overrides: { [GLOBAL_DEFAULT_KIND]: 7 },
      preview: true,
    });
    expect(previewed.totalExpiring).toBe(1);
    expect(previewed.preview).toBe(true);

    // The row is still there, and the stored config is still 90 — a preview that wrote anything
    // would be a preview that deleted something.
    expect(count(store, "events")).toBe(1);
    expect(describeRetention(store, { now: NOW }).defaultRetainDays).toBe(90);
    store.close();
  });

  test("carries the last completed pass's timestamp", () => {
    const store = seed();
    addEvent(store, "user.avatar", NOW - 400 * DAY);
    runRetention(store, { now: NOW });
    expect(describeRetention(store, { now: NOW }).lastRunAt).toBe(NOW);
    store.close();
  });
});

describe("applyRetentionUpdate", () => {
  test("a number sets, null deletes, and an absent key is left alone", () => {
    const store = seed();
    store.setRetentionConfig("gamelog.*", 30, NOW);
    store.setRetentionConfig("friend.online", 7, NOW);

    applyRetentionUpdate(store, { rules: { "gamelog.*": null, "user.avatar": 14 } }, NOW);

    const rules = new Map(store.listRetentionConfig().map((row) => [row.kind, row.retain_days]));
    expect(rules.has("gamelog.*")).toBe(false);
    expect(rules.get("user.avatar")).toBe(14);
    expect(rules.get("friend.online")).toBe(7);
    store.close();
  });

  test("defaultRetainDays is the only way to move the '*' row", () => {
    const store = seed();
    applyRetentionUpdate(store, { defaultRetainDays: 45 }, NOW);
    expect(describeRetention(store, { now: NOW }).defaultRetainDays).toBe(45);

    // A `'*'` key inside `rules` is ignored rather than honoured: deleting it would silently swap
    // the user's explicit default for a built-in constant.
    applyRetentionUpdate(store, { rules: { [GLOBAL_DEFAULT_KIND]: null } }, NOW);
    expect(describeRetention(store, { now: NOW }).defaultRetainDays).toBe(45);
    store.close();
  });
});
