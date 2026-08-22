/**
 * The resolver contract, as it applies to world names.
 *
 * All three resolvers (`world-names`, `instance-info`, `user-profiles`) promise the same four
 * things, and each of them is a bug that has already been shipped somewhere in this app:
 *
 *  1. `get()`/`status()` are **pure** — safe to call inside a `$derived`, and they never fetch. A
 *     resolver that fetched from a getter would re-request on every render forever.
 *  2. `ensure()` is the only thing that fetches.
 *  3. Ids asked for in the same tick **batch** into one request. A feed page names twenty worlds
 *     across a hundred rows; that is one request, not a hundred.
 *  4. A miss is a **cooldown, not a verdict**. The batch endpoint answers with a map and simply
 *     omits what it could not resolve — which is also what it does when no account is signed in.
 *     Caching that as "does not exist" would freeze every world name in the app for the session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldSummary } from "../api.ts";
import { worldNames } from "./world-names.svelte.ts";

const { listWorlds } = vi.hoisted(() => ({
  listWorlds:
    vi.fn<
      (
        ids: readonly string[],
        accountId?: string | null,
        signal?: AbortSignal,
      ) => Promise<Record<string, WorldSummary>>
    >(),
}));

/**
 * The network seam is `api.worlds.list`, and only that. Everything else in `api.ts` — `isAbort`,
 * `MAX_WORLD_IDS`, the error classes — is real, because those are part of the behaviour under test
 * rather than part of the transport.
 */
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: { ...actual.api, worlds: { ...actual.api.worlds, list: listWorlds } },
  };
});

const UNRESOLVED_COOLDOWN = 5 * 60_000;
const FAILED_COOLDOWN = 30_000;

function world(id: string, name: string): WorldSummary {
  return { id, name, thumbnailImageUrl: null, authorName: null, capacity: null };
}

/**
 * Runs the pending microtask flush *and* the async load it starts. A real `setTimeout(0)` is the
 * simplest thing that drains both, and it stays real here because only `Date` is faked.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeEach(() => {
  // Only `Date`: the resolver's flush is a `queueMicrotask`, which no timer mock touches, and
  // faking `setTimeout` would deadlock `settle()`. The cooldowns are pure `Date.now()` arithmetic.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_700_000_000_000);
  listWorlds.mockReset();
  listWorlds.mockResolvedValue({});
  // A module-level singleton: the cache outlives a test unless it is emptied.
  worldNames.clear();
});

afterEach(async () => {
  await settle();
  vi.useRealTimers();
});

describe("get() and status() are pure", () => {
  it("answer for an id nobody has asked for without starting a request", async () => {
    expect(worldNames.get("wrld_a")).toBeNull();
    expect(worldNames.status("wrld_a")).toBe("unknown");
    await settle();
    expect(listWorlds).not.toHaveBeenCalled();
  });

  it("treat null, undefined and the empty string as nothing to resolve", async () => {
    for (const id of [null, undefined, ""]) {
      expect(worldNames.get(id)).toBeNull();
      expect(worldNames.status(id)).toBe("unknown");
      worldNames.ensure(id);
    }
    await settle();
    expect(listWorlds).not.toHaveBeenCalled();
  });
});

describe("ensure() is the only thing that fetches", () => {
  it("fetches when asked, and nothing else on the class does", async () => {
    worldNames.prime(world("wrld_primed", "Primed"));
    worldNames.markUnresolved("wrld_gone");
    worldNames.get("wrld_gone");
    worldNames.status("wrld_primed");
    await settle();
    expect(listWorlds).not.toHaveBeenCalled();

    worldNames.ensure("wrld_a");
    await settle();
    expect(listWorlds).toHaveBeenCalledTimes(1);
  });

  it("does not re-fetch a world it already holds", async () => {
    worldNames.prime(world("wrld_primed", "The Great Pug"));
    worldNames.ensure("wrld_primed");
    await settle();
    expect(listWorlds).not.toHaveBeenCalled();
    expect(worldNames.get("wrld_primed")?.name).toBe("The Great Pug");
    expect(worldNames.status("wrld_primed")).toBe("ready");
  });

  it("publishes the resolved name through get(), which was pure a moment ago", async () => {
    listWorlds.mockResolvedValue({ wrld_a: world("wrld_a", "Black Cat") });
    worldNames.ensure("wrld_a");
    expect(worldNames.status("wrld_a")).toBe("loading");
    await settle();
    expect(worldNames.status("wrld_a")).toBe("ready");
    expect(worldNames.get("wrld_a")?.name).toBe("Black Cat");
  });
});

describe("ids batch within a microtask", () => {
  it("coalesces everything asked for in one tick into a single request", async () => {
    worldNames.ensure("wrld_a");
    worldNames.ensure("wrld_b");
    worldNames.ensure("wrld_c");

    // A microtask, not a timer: one `await` is enough for the request to be in flight.
    await Promise.resolve();
    expect(listWorlds).toHaveBeenCalledTimes(1);
    expect(listWorlds.mock.calls[0]?.[0]).toEqual(["wrld_a", "wrld_b", "wrld_c"]);
    await settle();
  });

  it("queues an id only once however many rows ask for it", async () => {
    for (let row = 0; row < 20; row += 1) worldNames.ensure("wrld_a");
    await settle();
    expect(listWorlds).toHaveBeenCalledTimes(1);
    expect(listWorlds.mock.calls[0]?.[0]).toEqual(["wrld_a"]);
  });

  it("never queues an id that is still in flight", async () => {
    worldNames.ensure("wrld_a");
    await Promise.resolve();
    // The first request has left; the row that mounts now must not start a second one.
    worldNames.ensure("wrld_a");
    await settle();
    expect(listWorlds).toHaveBeenCalledTimes(1);
  });

  it("splits by asking account, because whose credentials are spent is part of the question", async () => {
    worldNames.ensure("wrld_a", "acc_one");
    worldNames.ensure("wrld_b", "acc_two");
    await settle();
    expect(listWorlds).toHaveBeenCalledTimes(2);
    expect(listWorlds).toHaveBeenCalledWith(["wrld_a"], "acc_one");
    expect(listWorlds).toHaveBeenCalledWith(["wrld_b"], "acc_two");
  });
});

describe("a miss is a cooldown, not a verdict", () => {
  it("does not immediately re-ask for an id the batch answer left out", async () => {
    worldNames.ensure("wrld_missing");
    await settle();
    expect(worldNames.status("wrld_missing")).toBe("unresolved");
    expect(listWorlds).toHaveBeenCalledTimes(1);

    // This is the property that keeps a feed of deleted worlds from costing a request per frame.
    for (let frame = 0; frame < 10; frame += 1) worldNames.ensure("wrld_missing");
    await settle();
    expect(listWorlds).toHaveBeenCalledTimes(1);
  });

  it("asks again once the cooldown expires, so signing an account in heals the page", async () => {
    worldNames.ensure("wrld_missing");
    await settle();
    expect(listWorlds).toHaveBeenCalledTimes(1);

    // Absence from the map has two causes and the response cannot tell them apart: the world is
    // gone, or nobody was signed in and the daemon answered from cache alone. A permanent verdict
    // would freeze the second case for the whole session.
    vi.setSystemTime(Date.now() + UNRESOLVED_COOLDOWN + 1);
    listWorlds.mockResolvedValue({ wrld_missing: world("wrld_missing", "Found At Last") });
    worldNames.ensure("wrld_missing");
    await settle();

    expect(listWorlds).toHaveBeenCalledTimes(2);
    expect(worldNames.status("wrld_missing")).toBe("ready");
    expect(worldNames.get("wrld_missing")?.name).toBe("Found At Last");
  });

  it("keeps the short-id fallback rather than an error while unresolved", async () => {
    worldNames.ensure("wrld_missing");
    await settle();
    // `unresolved` is not an error state: the row shows `wrld_missin…`, which is what an unresolved
    // world should look like.
    expect(worldNames.status("wrld_missing")).toBe("unresolved");
    expect(worldNames.get("wrld_missing")).toBeNull();
  });

  it("treats a request that never landed as a fact about the network, on a shorter cooldown", async () => {
    listWorlds.mockRejectedValue(new Error("daemon is not running"));
    worldNames.ensure("wrld_a");
    await settle();
    expect(worldNames.status("wrld_a")).toBe("failed");

    worldNames.ensure("wrld_a");
    await settle();
    expect(listWorlds).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + FAILED_COOLDOWN + 1);
    listWorlds.mockResolvedValue({ wrld_a: world("wrld_a", "Back Online") });
    worldNames.ensure("wrld_a");
    await settle();
    expect(listWorlds).toHaveBeenCalledTimes(2);
    expect(worldNames.status("wrld_a")).toBe("ready");
  });

  it("lets markUnresolved record the one genuine verdict, which the batch route cannot give", async () => {
    // The single-world route 404s a deleted world; the modal hands that back so every row stops
    // asking about something VRChat has said is gone.
    worldNames.markUnresolved("wrld_deleted");
    expect(worldNames.status("wrld_deleted")).toBe("unresolved");
    worldNames.ensure("wrld_deleted");
    await settle();
    expect(listWorlds).not.toHaveBeenCalled();
  });
});
