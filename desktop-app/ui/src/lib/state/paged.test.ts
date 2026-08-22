import { beforeEach, describe, expect, test, vi } from "vitest";
import { type Page, PagedList } from "./paged.svelte.ts";

interface Row {
  readonly id: string;
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

/** A fetcher whose pages are scripted, recording every call so re-entry is observable. */
function scripted(pages: Page<Row>[]) {
  const calls: { offset: number; limit: number }[] = [];
  let index = 0;
  const fetcher = vi.fn(async (offset: number, limit: number): Promise<Page<Row>> => {
    calls.push({ offset, limit });
    const page = pages[index] ?? { items: [], hasMore: false };
    index += 1;
    return page;
  });
  return { fetcher, calls };
}

/**
 * The exact rejection a real abort produces.
 *
 * A plain `Error` with `name = "AbortError"` is not enough: `isAbort` tests
 * `instanceof DOMException`, so a hand-rolled lookalike is classified as an ordinary failure and
 * paints an error. Worth knowing when stubbing transports elsewhere.
 */
function abortError(): DOMException {
  const controller = new AbortController();
  controller.abort();
  return controller.signal.reason as DOMException;
}

describe("PagedList: the first page", () => {
  test("ensure() loads it and lands on ready", async () => {
    const { fetcher } = scripted([{ items: rows("a", "b"), hasMore: false }]);
    const list = new PagedList<Row>(fetcher, 2);

    expect(list.phase).toBe("idle");
    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));

    expect(list.items.map((r) => r.id)).toEqual(["a", "b"]);
    expect(list.hasMore).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("ensure() is idempotent, so a tab and its parent may both call it", async () => {
    const { fetcher } = scripted([{ items: rows("a"), hasMore: false }]);
    const list = new PagedList<Row>(fetcher, 10);

    list.ensure();
    list.ensure();
    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("an empty first page is `ready` and empty, not an error", async () => {
    // A group with no posts is a fact about the group. Rendering it as a failure would be a lie.
    const { fetcher } = scripted([{ items: [], hasMore: false }]);
    const list = new PagedList<Row>(fetcher, 10);

    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));

    expect(list.isEmpty).toBe(true);
    expect(list.failure).toBeNull();
  });
});

describe("PagedList: paging", () => {
  test("loadMore appends and advances the offset by what is held", async () => {
    const { fetcher, calls } = scripted([
      { items: rows("a", "b"), hasMore: true },
      { items: rows("c", "d"), hasMore: false },
    ]);
    const list = new PagedList<Row>(fetcher, 2);

    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));
    list.loadMore();
    await vi.waitFor(() => expect(list.items).toHaveLength(4));

    expect(list.items.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(calls).toEqual([
      { offset: 0, limit: 2 },
      { offset: 2, limit: 2 },
    ]);
    expect(list.hasMore).toBe(false);
  });

  test("a repeated row across pages is dropped rather than crashing the {#each}", async () => {
    // Offset paging over a list that is being mutated upstream WILL repeat a row: someone joins the
    // group between page 1 and page 2 and every later row shifts by one. A duplicate key is a hard
    // runtime error in Svelte 5 - the whole list stops rendering - so this is not a tidiness test.
    const { fetcher } = scripted([
      { items: rows("a", "b"), hasMore: true },
      { items: rows("b", "c"), hasMore: false },
    ]);
    const list = new PagedList<Row>(fetcher, 2);

    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));
    list.loadMore();
    await vi.waitFor(() => expect(list.hasMore).toBe(false));

    expect(list.items.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("duplicates inside a single page are dropped too", async () => {
    const { fetcher } = scripted([{ items: rows("a", "a", "b"), hasMore: false }]);
    const list = new PagedList<Row>(fetcher, 10);

    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));

    expect(list.items.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("a second loadMore while one is in flight does not fetch a duplicate page", async () => {
    // The sentinel legitimately fires more than once - a fast scroll, a resize, a re-render - so
    // re-entry is guarded rather than assumed away.
    // Held on an object rather than in a `let`: TypeScript narrows a `let` assigned only inside a
    // callback down to `null`, and the later `release()` then fails to compile.
    const gate: { release: () => void } = { release: () => {} };
    const fetcher = vi.fn(async (offset: number): Promise<Page<Row>> => {
      if (offset === 0) return { items: rows("a"), hasMore: true };
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return { items: rows("b"), hasMore: false };
    });
    const list = new PagedList<Row>(fetcher, 1);

    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));

    list.loadMore();
    list.loadMore();
    list.loadMore();
    await vi.waitFor(() => expect(list.loadingMore).toBe(true));

    expect(fetcher).toHaveBeenCalledTimes(2);
    gate.release();
    await vi.waitFor(() => expect(list.loadingMore).toBe(false));
  });

  test("loadMore does nothing once the list is exhausted", async () => {
    const { fetcher } = scripted([{ items: rows("a"), hasMore: false }]);
    const list = new PagedList<Row>(fetcher, 10);

    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));
    list.loadMore();
    list.loadMore();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("loadMore before the first page has landed does nothing", () => {
    const { fetcher } = scripted([{ items: rows("a"), hasMore: true }]);
    const list = new PagedList<Row>(fetcher, 10);

    list.loadMore();

    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("PagedList: failure", () => {
  test("a failed first page is an error state with a classified failure", async () => {
    const fetcher = vi.fn(async (): Promise<Page<Row>> => {
      throw new Error("boom");
    });
    const list = new PagedList<Row>(fetcher, 10);

    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("error"));

    expect(list.failure).toBe("other");
    expect(list.error).not.toBeNull();
  });

  test("a failed later page keeps the rows already loaded", async () => {
    // Losing forty rows because the forty-first request failed is the wrong trade.
    let first = true;
    const fetcher = vi.fn(async (): Promise<Page<Row>> => {
      if (first) {
        first = false;
        return { items: rows("a", "b"), hasMore: true };
      }
      throw new Error("boom");
    });
    const list = new PagedList<Row>(fetcher, 2);

    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));
    list.loadMore();
    await vi.waitFor(() => expect(list.moreError).not.toBeNull());

    expect(list.phase).toBe("ready");
    expect(list.items.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("an abandoned load paints nothing", async () => {
    // Abandonment is not failure. An error over a subject the reader already left is worse than
    // no error at all.
    const fetcher = vi.fn(async (): Promise<Page<Row>> => {
      throw abortError();
    });
    const list = new PagedList<Row>(fetcher, 10);

    list.ensure();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await Promise.resolve();

    expect(list.phase).toBe("loading");
    expect(list.error).toBeNull();
  });

  test("retry re-reads the first page from the top", async () => {
    let attempt = 0;
    const fetcher = vi.fn(async (): Promise<Page<Row>> => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return { items: rows("a"), hasMore: false };
    });
    const list = new PagedList<Row>(fetcher, 10);

    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("error"));
    list.retry();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));

    expect(list.items.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("PagedList: reset", () => {
  let list: PagedList<Row>;
  let fetcher: ReturnType<typeof scripted>["fetcher"];

  beforeEach(() => {
    ({ fetcher } = scripted([
      { items: rows("a"), hasMore: true },
      { items: rows("b"), hasMore: true },
    ]));
    list = new PagedList<Row>(fetcher, 1);
  });

  test("clears the rows and lets ensure() run again", async () => {
    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));

    list.reset();
    expect(list.items).toEqual([]);
    expect(list.phase).toBe("idle");
    expect(list.hasMore).toBe(true);

    list.ensure();
    await vi.waitFor(() => expect(list.phase).toBe("ready"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("a page in flight when reset lands cannot write into the fresh list", async () => {
    // The generation guard, not the abort signal, is what covers this: a fetch that has already
    // resolved is not stopped by aborting it, and the `await` after it still runs.
    const gate: { release: (page: Page<Row>) => void } = { release: () => {} };
    const slow = vi.fn(
      async (): Promise<Page<Row>> =>
        new Promise<Page<Row>>((resolve) => {
          gate.release = resolve;
        }),
    );
    const slowList = new PagedList<Row>(slow, 10);

    slowList.ensure();
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());

    slowList.reset();
    gate.release({ items: rows("stale"), hasMore: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(slowList.items).toEqual([]);
    expect(slowList.phase).toBe("idle");
  });
});
