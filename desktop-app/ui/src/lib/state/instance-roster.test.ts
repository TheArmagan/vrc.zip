/**
 * The cap on the per-user fallback, and the hover path that is the other half of it.
 *
 * `EAGER_FILL_LIMIT` exists because a room of eighty strangers is this app's most plausible way to
 * draw a 429 — so the fallback describes a screenful on sight and leaves the rest to hover. Three
 * properties make that a saving rather than a rename of the same traffic, and each of them is a bug
 * if it stops holding:
 *
 *  1. The eager batch is **one** request for at most `EAGER_FILL_LIMIT` ids, whatever the room size.
 *  2. A deferred id must never drive a refetch. `#missesSomeone` counts an undescribed player as an
 *     incomplete snapshot, and a deferred id is undescribed forever — left alone, the cap would
 *     re-read the whole room every `JOIN_FLOOR_MS` for as long as the screen was open, which is
 *     worse than the uncapped version it replaced.
 *  3. Hover ids raised in one tick batch into one request, and a miss is a cooldown rather than a
 *     verdict — the usual reason VRChat says nothing about someone is this moment, not that person.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceUser, InstanceUsers } from "../api.ts";
import { instanceRoster } from "./instance-roster.svelte.ts";

const { instanceUsers, batchUsers } = vi.hoisted(() => ({
  instanceUsers:
    vi.fn<
      (location: string, accountId?: string | null, signal?: AbortSignal) => Promise<InstanceUsers>
    >(),
  batchUsers:
    vi.fn<
      (
        ids: readonly string[],
        accountId?: string | null,
        signal?: AbortSignal,
      ) => Promise<InstanceUser[]>
    >(),
}));

/**
 * The two network seams and nothing else. `ApiError` and `isAbort` stay real, because how this
 * classifies a failure is behaviour under test rather than transport.
 */
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      instanceUsers,
      users: { ...actual.api.users, batch: batchUsers },
    },
  };
});

const EAGER_FILL_LIMIT = 24;
const JOIN_FLOOR_MS = 3_000;
const MISS_COOLDOWN_MS = 30_000;

const ACCOUNT = "usr_viewer";

function user(id: string): InstanceUser {
  return {
    id,
    displayName: `Name ${id}`,
    iconUrl: null,
    trustLevel: "user",
    ageVerificationStatus: null,
    ageVerified: false,
    isFriend: false,
    status: null,
    platform: null,
    developerType: null,
  };
}

/** Ids in the log's order, so a slice assertion says which end of the room was described. */
function ids(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `usr_${prefix}_${index}`);
}

/** VRChat's answer for essentially every instance: a well-formed 200 that describes nobody. */
function unavailable(location: string): InstanceUsers {
  return { location, fetchedAt: Date.now(), source: "unavailable", users: [] };
}

/**
 * Drains the microtask flush *and* the async loads it starts. A real `setTimeout(0)` is the
 * simplest thing that covers both, and it stays real because only `Date` is faked.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  // Only `Date`. The hover flush is a `queueMicrotask`, which no timer mock touches, and faking
  // `setTimeout` would deadlock `settle()`. Every window in this file is `Date.now()` arithmetic.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_700_000_000_000);
  instanceUsers.mockReset();
  batchUsers.mockReset();
  instanceUsers.mockImplementation(async (location) => unavailable(location));
  batchUsers.mockResolvedValue([]);
  // A module-level singleton: entries and armed retries outlive a test unless it is emptied.
  instanceRoster.clear();
});

afterEach(async () => {
  await settle();
  instanceRoster.clear();
  vi.useRealTimers();
});

describe("the eager fill is capped", () => {
  it("describes a screenful in one request and defers the rest of the room", async () => {
    const location = "wrld_big:1";
    const observed = ids(30, "big");
    batchUsers.mockImplementation(async (wanted) => wanted.map(user));

    instanceRoster.ensure(location, ACCOUNT, observed);
    await settle();

    // One request for the whole room, not one per person past the cap.
    expect(batchUsers).toHaveBeenCalledTimes(1);
    const [asked, askedAccount] = batchUsers.mock.calls[0] ?? [];
    expect(asked).toEqual(observed.slice(0, EAGER_FILL_LIMIT));
    expect(askedAccount).toBe(ACCOUNT);

    const entry = instanceRoster.entry(location, ACCOUNT);
    expect(entry?.users.map((each) => each.id)).toEqual(observed.slice(0, EAGER_FILL_LIMIT));
    expect(entry?.deferred).toEqual(observed.slice(EAGER_FILL_LIMIT));
    expect(entry?.filledIndividually).toBe(true);
    // Still `unavailable`: VRChat did refuse to describe the instance, and the sentence under the
    // toolbar is what changes, not the status.
    expect(entry?.status).toBe("unavailable");
    expect(entry?.reason).toBe("not-owner");
  });

  it("defers nobody in a room that fits under the cap", async () => {
    const location = "wrld_small:1";
    const observed = ids(5, "small");
    batchUsers.mockImplementation(async (wanted) => wanted.map(user));

    instanceRoster.ensure(location, ACCOUNT, observed);
    await settle();

    expect(batchUsers.mock.calls[0]?.[0]).toEqual(observed);
    expect(instanceRoster.entry(location, ACCOUNT)?.deferred).toEqual([]);
  });
});

describe("a deferred id is a decision, not a gap", () => {
  it("does not refetch the room for people the cap deliberately skipped", async () => {
    const location = "wrld_hold:1";
    const observed = ids(30, "hold");
    batchUsers.mockImplementation(async (wanted) => wanted.map(user));

    instanceRoster.ensure(location, ACCOUNT, observed);
    await settle();
    expect(instanceUsers).toHaveBeenCalledTimes(1);
    expect(batchUsers).toHaveBeenCalledTimes(1);

    // Past the join floor and inside the freshness window. If `#missesSomeone` counted the six
    // deferred ids, this is where the cap would quietly turn into a poll every three seconds.
    vi.setSystemTime(Date.now() + JOIN_FLOOR_MS + 1);
    for (let frame = 0; frame < 5; frame += 1) instanceRoster.ensure(location, ACCOUNT, observed);
    await settle();

    expect(instanceUsers).toHaveBeenCalledTimes(1);
    expect(batchUsers).toHaveBeenCalledTimes(1);
  });

  it("still refetches for somebody genuinely new, which is what the floor is for", async () => {
    const location = "wrld_join:1";
    const observed = ids(30, "join");
    batchUsers.mockImplementation(async (wanted) => wanted.map(user));

    instanceRoster.ensure(location, ACCOUNT, observed);
    await settle();
    expect(instanceUsers).toHaveBeenCalledTimes(1);

    // A real arrival: neither described nor deferred, so the join floor applies and it beats the
    // freshness window it would otherwise wait out.
    vi.setSystemTime(Date.now() + JOIN_FLOOR_MS + 1);
    instanceRoster.ensure(location, ACCOUNT, [...observed, "usr_late_arrival"]);
    await settle();

    expect(instanceUsers).toHaveBeenCalledTimes(2);
  });
});

describe("hover hydrates a deferred person", () => {
  it("coalesces everything a pointer sweep raises in one tick into a single request", async () => {
    const location = "wrld_hover:1";
    const observed = ids(30, "hover");
    batchUsers.mockImplementation(async (wanted) => wanted.map(user));

    instanceRoster.ensure(location, ACCOUNT, observed);
    await settle();
    batchUsers.mockClear();

    const deferred = observed.slice(EAGER_FILL_LIMIT);
    const [first, second, third] = deferred;
    instanceRoster.ensureUser(location, ACCOUNT, first ?? null);
    instanceRoster.ensureUser(location, ACCOUNT, second ?? null);
    instanceRoster.ensureUser(location, ACCOUNT, third ?? null);
    await settle();

    expect(batchUsers).toHaveBeenCalledTimes(1);
    expect(batchUsers.mock.calls[0]?.[0]).toEqual([first, second, third]);
    expect(batchUsers.mock.calls[0]?.[1]).toBe(ACCOUNT);

    const entry = instanceRoster.entry(location, ACCOUNT);
    const described = new Set(entry?.users.map((each) => each.id));
    expect(described.has(first ?? "")).toBe(true);
    expect(described.has(third ?? "")).toBe(true);
    expect(entry?.filledIndividually).toBe(true);
    // Asked about, so no longer a deliberate omission — the remaining three are.
    expect(entry?.deferred).toEqual(deferred.slice(3));
  });

  it("sets filledIndividually on a room the eager batch could not describe at all", async () => {
    const location = "wrld_none:1";
    const observed = ids(30, "none");
    batchUsers.mockResolvedValue([]);

    instanceRoster.ensure(location, ACCOUNT, observed);
    await settle();
    expect(instanceRoster.entry(location, ACCOUNT)?.filledIndividually).toBe(false);

    const target = observed[EAGER_FILL_LIMIT] ?? "";
    batchUsers.mockResolvedValue([user(target)]);
    instanceRoster.ensureUser(location, ACCOUNT, target);
    await settle();

    const entry = instanceRoster.entry(location, ACCOUNT);
    expect(entry?.filledIndividually).toBe(true);
    expect(entry?.users.map((each) => each.id)).toEqual([target]);
  });
});

describe("ensureUser is free to call on every mouseenter", () => {
  it("costs nothing for somebody already described", async () => {
    const location = "wrld_known:1";
    const observed = ids(30, "known");
    batchUsers.mockImplementation(async (wanted) => wanted.map(user));

    instanceRoster.ensure(location, ACCOUNT, observed);
    await settle();
    batchUsers.mockClear();

    // Dragging a pointer back across the top of the roster is the common motion, and it is free.
    for (const id of observed.slice(0, EAGER_FILL_LIMIT)) {
      instanceRoster.ensureUser(location, ACCOUNT, id);
    }
    await settle();
    expect(batchUsers).not.toHaveBeenCalled();
  });

  it("has nothing to merge into for an unknown location or an id-less log row", async () => {
    // No `ensure()` has answered for this location, so there is no roster this person is part of.
    instanceRoster.ensureUser("wrld_unseen:1", ACCOUNT, "usr_unseen");
    // VRChat has shipped the join line both with and without an id; the second kind is left with
    // its name rather than guessed at.
    instanceRoster.ensureUser(null, ACCOUNT, "usr_x");
    instanceRoster.ensureUser("wrld_unseen:1", ACCOUNT, null);
    instanceRoster.ensureUser("", ACCOUNT, "usr_x");
    instanceRoster.ensureUser("wrld_unseen:1", ACCOUNT, "");
    await settle();

    expect(batchUsers).not.toHaveBeenCalled();
    expect(instanceUsers).not.toHaveBeenCalled();
  });

  it("holds a miss on a cooldown and then asks again, because absence is about the moment", async () => {
    const location = "wrld_miss:1";
    const observed = ids(30, "miss");
    batchUsers.mockResolvedValue([]);

    instanceRoster.ensure(location, ACCOUNT, observed);
    await settle();
    batchUsers.mockClear();

    const target = observed[EAGER_FILL_LIMIT] ?? "";
    instanceRoster.ensureUser(location, ACCOUNT, target);
    await settle();
    expect(batchUsers).toHaveBeenCalledTimes(1);

    // Hovering the same row again inside the cooldown is what would otherwise turn one unlucky
    // lookup into a request per mouseenter.
    for (let hover = 0; hover < 5; hover += 1) {
      instanceRoster.ensureUser(location, ACCOUNT, target);
    }
    await settle();
    expect(batchUsers).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + MISS_COOLDOWN_MS + 1);
    batchUsers.mockResolvedValue([user(target)]);
    instanceRoster.ensureUser(location, ACCOUNT, target);
    await settle();

    expect(batchUsers).toHaveBeenCalledTimes(2);
    expect(instanceRoster.entry(location, ACCOUNT)?.users.map((each) => each.id)).toEqual([target]);
  });

  it("keeps the row's existing chips when a hover lookup fails outright", async () => {
    const location = "wrld_fail:1";
    const observed = ids(30, "fail");
    batchUsers.mockImplementation(async (wanted) => wanted.map(user));

    instanceRoster.ensure(location, ACCOUNT, observed);
    await settle();
    const before = instanceRoster.entry(location, ACCOUNT)?.users.length ?? 0;

    // Deliberately quiet: a failed hover is decoration the user asked for by moving a pointer, not
    // grounds to withdraw what is already on screen.
    batchUsers.mockRejectedValue(new Error("daemon is not running"));
    instanceRoster.ensureUser(location, ACCOUNT, observed[EAGER_FILL_LIMIT] ?? "");
    await settle();

    const entry = instanceRoster.entry(location, ACCOUNT);
    expect(entry?.users.length).toBe(before);
    expect(entry?.status).toBe("unavailable");
  });
});
