import { describe, expect, test } from "bun:test";
import { MEMORY, Store } from "../store/store.ts";
import { AVATAR_ID_NEGATIVE_TTL_MS, AvatarIdResolver, fileIdFromImageUrl } from "./avatar-ids.ts";

const FILE_ID = "file_d9ec5b06-6ea5-4ae0-ab67-78dfa3eea6df";
const AVATAR_ID = "avtr_eb5a1798-6f23-4ec6-b879-2d01f44a69c4";
const T0 = 1_700_000_000_000;

describe("fileIdFromImageUrl", () => {
  test("reads both shapes VRChat serves", () => {
    expect(fileIdFromImageUrl(`https://api.vrchat.cloud/api/1/image/${FILE_ID}/2/256`)).toBe(
      FILE_ID,
    );
    expect(fileIdFromImageUrl(`https://api.vrchat.cloud/api/1/file/${FILE_ID}/1/1024`)).toBe(
      FILE_ID,
    );
  });

  test("ignores the query and the fragment", () => {
    expect(fileIdFromImageUrl(`https://api.vrchat.cloud/api/1/image/${FILE_ID}/2/256?v=2#x`)).toBe(
      FILE_ID,
    );
  });

  test("a URL with no file segment is null, not a guess", () => {
    expect(fileIdFromImageUrl("https://api.vrchat.cloud/api/1/image/")).toBeNull();
    expect(fileIdFromImageUrl("https://api.vrchat.cloud/api/1/user/usr_abc/1/256")).toBeNull();
    // `file` on its own is a path segment, not an id: the prefix is `file_`.
    expect(fileIdFromImageUrl("https://api.vrchat.cloud/api/1/file/1/1024")).toBeNull();
  });

  test("a non-URL string is null rather than a throw", () => {
    // VRChat sends `""` for an unset image field, so this is an ordinary input here.
    expect(fileIdFromImageUrl("")).toBeNull();
    expect(fileIdFromImageUrl("not a url at all")).toBeNull();
    expect(fileIdFromImageUrl(FILE_ID)).toBeNull();
    expect(fileIdFromImageUrl("//api.vrchat.cloud/api/1/image/file_x/2/256")).toBeNull();
  });

  test("only http(s) — a data URL never becomes a third-party lookup", () => {
    expect(fileIdFromImageUrl(`data:text/plain,/${FILE_ID}/2/256`)).toBeNull();
  });

  test("an encoded separator cannot smuggle a second path segment out", () => {
    // `file_a%2F..%2Fx` decodes to something with a slash in it, which is not a file id.
    expect(fileIdFromImageUrl("https://api.vrchat.cloud/api/1/image/file_a%2F..%2Fx/2/256")).toBe(
      null,
    );
  });
});

/** A resolver over a real store, with a fake clock and a stubbed avtr.zip. */
function harness(
  options: {
    respond?: (fileId: string, call: number) => Response;
    enabled?: () => boolean;
    store?: Store | null;
    ratePerSecond?: number;
  } = {},
) {
  const store = options.store === undefined ? Store.open(MEMORY) : options.store;
  const requests: string[] = [];
  const sleeps: number[] = [];
  let now = T0;
  let calls = 0;

  const resolver = new AvatarIdResolver({
    userAgent: "vrc.zip/test (tests@somewhere.dev)",
    baseUrl: "https://avtr.example",
    ...(store === null ? {} : { store }),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.ratePerSecond === undefined ? {} : { ratePerSecond: options.ratePerSecond }),
    now: () => now,
    // Advances the fake clock, which is what lets the bucket refill without real time passing.
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    fetch: async (input) => {
      requests.push(input);
      calls += 1;
      const fileId = input.slice(input.lastIndexOf("/") + 1);
      return (
        options.respond?.(fileId, calls) ??
        Response.json({ success: true, fileId: fileId.slice("file_".length), avatarId: AVATAR_ID })
      );
    },
  });

  return {
    resolver,
    store,
    requests,
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
    stop: () => store?.close(),
  };
}

describe("AvatarIdResolver", () => {
  test("resolves a file id and persists the mapping", async () => {
    const h = harness();
    try {
      expect(await h.resolver.resolve(FILE_ID)).toBe(AVATAR_ID);
      expect(h.requests).toEqual([`https://avtr.example/v3/avatars/by-file/${FILE_ID}`]);

      // The row, not the return value: this is the half that has to survive a restart.
      expect(h.store?.getAvatarFileId(FILE_ID)).toEqual({
        file_id: FILE_ID,
        avatar_id: AVATAR_ID,
        resolved_at: T0,
      });
    } finally {
      h.stop();
    }
  });

  test("sends the mandatory User-Agent and nothing identifying", async () => {
    let seen: Headers | undefined;
    const store = Store.open(MEMORY);
    const resolver = new AvatarIdResolver({
      userAgent: "vrc.zip/9.9.9 (someone@somewhere.dev)",
      baseUrl: "https://avtr.example",
      store,
      fetch: async (_input, init) => {
        seen = new Headers(init?.headers);
        return Response.json({ success: true, avatarId: AVATAR_ID });
      },
    });

    try {
      await resolver.resolve(FILE_ID);
      expect(seen?.get("user-agent")).toBe("vrc.zip/9.9.9 (someone@somewhere.dev)");
      expect(seen?.get("cookie")).toBeNull();
      expect(seen?.get("authorization")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a positive answer is never re-asked, in memory or from the store", async () => {
    const h = harness();
    try {
      await h.resolver.resolve(FILE_ID);
      await h.resolver.resolve(FILE_ID);
      // Far past any negative cooldown: a positive answer does not expire.
      h.advance(AVATAR_ID_NEGATIVE_TTL_MS * 10);
      await h.resolver.resolve(FILE_ID);
      expect(h.requests).toHaveLength(1);

      // A fresh resolver over the same store makes no request at all — the point of persisting.
      const second = harness({ store: h.store });
      expect(await second.resolver.resolve(FILE_ID)).toBe(AVATAR_ID);
      expect(second.requests).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("a negative answer is a cooldown, not a verdict", async () => {
    let call = 0;
    const h = harness({
      respond: (_fileId, n) => {
        call = n;
        return n === 1
          ? new Response("{}", { status: 404 })
          : Response.json({
              success: true,
              avatarId: AVATAR_ID,
            });
      },
    });
    try {
      expect(await h.resolver.resolve(FILE_ID)).toBeNull();
      expect(h.store?.getAvatarFileId(FILE_ID)).toEqual({
        file_id: FILE_ID,
        avatar_id: null,
        resolved_at: T0,
      });

      // Inside the cooldown: still null, still one request.
      expect(await h.resolver.resolve(FILE_ID)).toBeNull();
      expect(h.requests).toHaveLength(1);

      // Past it: asked again, and this time avtr.zip knows.
      h.advance(AVATAR_ID_NEGATIVE_TTL_MS + 1);
      expect(await h.resolver.resolve(FILE_ID)).toBe(AVATAR_ID);
      expect(call).toBe(2);
      expect(h.store?.getAvatarFileId(FILE_ID)?.avatar_id).toBe(AVATAR_ID);
    } finally {
      h.stop();
    }
  });

  test("`success: false` and an unrecognisable id are negative answers, not crashes", async () => {
    const h = harness({
      respond: (_fileId, n) =>
        n === 1
          ? Response.json({ success: false })
          : Response.json({ success: true, avatarId: "../../etc/passwd" }),
    });
    try {
      expect(await h.resolver.resolve(FILE_ID)).toBeNull();
      expect(await h.resolver.resolve("file_11111111-1111-1111-1111-111111111111")).toBeNull();
    } finally {
      h.stop();
    }
  });

  test("an upstream failure is not an answer and is not cached", async () => {
    const h = harness({
      respond: (_fileId, n) =>
        n === 1
          ? new Response("nope", { status: 503 })
          : Response.json({ success: true, avatarId: AVATAR_ID }),
    });
    try {
      expect(await h.resolver.resolve(FILE_ID)).toBeNull();
      // Nothing written: a five-minute outage must not become six hours of unopenable rows.
      expect(h.store?.getAvatarFileId(FILE_ID)).toBeNull();
      expect(await h.resolver.resolve(FILE_ID)).toBe(AVATAR_ID);
    } finally {
      h.stop();
    }
  });

  test("a thrown fetch is null rather than a rejection the caller inherits", async () => {
    const store = Store.open(MEMORY);
    const resolver = new AvatarIdResolver({
      userAgent: "vrc.zip/test (tests@somewhere.dev)",
      store,
      fetch: async () => {
        throw new Error("network down");
      },
    });
    try {
      expect(await resolver.resolve(FILE_ID)).toBeNull();
      expect(store.getAvatarFileId(FILE_ID)).toBeNull();
    } finally {
      store.close();
    }
  });

  test("N rows naming one file are one request", async () => {
    const h = harness({
      respond: () => Response.json({ success: true, avatarId: AVATAR_ID }),
    });
    try {
      const answers = await Promise.all(
        Array.from({ length: 8 }, () => h.resolver.resolve(FILE_ID)),
      );
      expect(answers).toEqual(Array.from({ length: 8 }, () => AVATAR_ID));
      expect(h.requests).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("holds itself to its own ceiling, separate from VRChat's", async () => {
    const h = harness({ ratePerSecond: 10 });
    try {
      // Distinct ids, so nothing is served from a cache or de-duplicated: twenty real requests.
      for (let i = 0; i < 20; i++) {
        const fileId = `file_00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`;
        expect(await h.resolver.resolve(fileId)).toBe(AVATAR_ID);
      }
      expect(h.requests).toHaveLength(20);
      // Ten fit in the initial bucket; the rest wait for refills rather than going straight out.
      expect(h.sleeps).toHaveLength(10);
      expect(h.sleeps.every((ms) => ms > 0)).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("with the setting off it makes no third-party request at all", async () => {
    const h = harness({ enabled: () => false });
    try {
      expect(await h.resolver.resolve(FILE_ID)).toBeNull();
      expect(h.requests).toHaveLength(0);
      // And nothing was written, so turning it back on asks for real.
      expect(h.store?.getAvatarFileId(FILE_ID)).toBeNull();
    } finally {
      h.stop();
    }
  });

  test("with the setting off it still serves what the machine already knows", async () => {
    let allowed = true;
    const h = harness({ enabled: () => allowed });
    try {
      expect(await h.resolver.resolve(FILE_ID)).toBe(AVATAR_ID);
      allowed = false;
      // "Make no more requests", not "forget what you learned".
      expect(await h.resolver.resolve(FILE_ID)).toBe(AVATAR_ID);
      expect(h.requests).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("something that is not a file id never leaves the machine", async () => {
    const h = harness();
    try {
      expect(await h.resolver.resolve("avtr_something")).toBeNull();
      expect(await h.resolver.resolve("file_../../secrets")).toBeNull();
      expect(await h.resolver.resolve("")).toBeNull();
      expect(h.requests).toHaveLength(0);
    } finally {
      h.stop();
    }
  });

  test("works without a store, it just re-learns after a restart", async () => {
    const h = harness({ store: null });
    expect(await h.resolver.resolve(FILE_ID)).toBe(AVATAR_ID);
    expect(await h.resolver.resolve(FILE_ID)).toBe(AVATAR_ID);
    expect(h.requests).toHaveLength(1);
  });
});
