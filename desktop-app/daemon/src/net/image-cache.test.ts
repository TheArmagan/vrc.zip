import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKeyFor, ImageCache, sniffContentType, UNKNOWN_CONTENT_TYPE } from "./image-cache.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a]);
const GIF = new Uint8Array([...Buffer.from("GIF89a", "ascii"), 1, 2]);
const WEBP = new Uint8Array([
  ...Buffer.from("RIFF", "ascii"),
  0x20,
  0,
  0,
  0,
  ...Buffer.from("WEBP", "ascii"),
]);

describe("sniffContentType", () => {
  test("recognises the four formats VRChat serves", () => {
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(JPEG)).toBe("image/jpeg");
    expect(sniffContentType(GIF)).toBe("image/gif");
    expect(sniffContentType(WEBP)).toBe("image/webp");
  });

  test("does not guess", () => {
    expect(sniffContentType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(
      UNKNOWN_CONTENT_TYPE,
    );
    expect(sniffContentType(new Uint8Array())).toBe(UNKNOWN_CONTENT_TYPE);
    // Truncated magic must not match — a two-byte buffer is not a PNG.
    expect(sniffContentType(new Uint8Array([0x89, 0x50]))).toBe(UNKNOWN_CONTENT_TYPE);
    // RIFF without the WEBP fourcc is some other RIFF container.
    expect(sniffContentType(new Uint8Array([...Buffer.from("RIFF????AVI ", "ascii")]))).toBe(
      UNKNOWN_CONTENT_TYPE,
    );
  });
});

describe("ImageCache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vrczip-images-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("fetches once, then serves from disk", async () => {
    const cache = new ImageCache({ dir });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return { bytes: PNG, contentType: "image/png" };
    };

    const first = await cache.load("https://api.vrchat.cloud/a.png", fetcher);
    const second = await cache.load("https://api.vrchat.cloud/a.png", fetcher);

    expect(calls).toBe(1);
    expect(first?.contentType).toBe("image/png");
    expect(second?.bytes).toEqual(PNG);
    // The content type survives a restart with no sidecar file, because it is sniffed back.
    expect(
      (await new ImageCache({ dir }).read("https://api.vrchat.cloud/a.png"))?.contentType,
    ).toBe("image/png");
  });

  test("de-duplicates concurrent fetches of the same url", async () => {
    const cache = new ImageCache({ dir });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      await Bun.sleep(10);
      return { bytes: JPEG, contentType: "image/jpeg" };
    };

    // A 200-friend list shares icons; without de-duplication this is 200 requests for one image.
    const results = await Promise.all(
      Array.from({ length: 25 }, () => cache.load("https://api.vrchat.cloud/dup.jpg", fetcher)),
    );

    expect(calls).toBe(1);
    expect(results.every((r) => r?.contentType === "image/jpeg")).toBe(true);
  });

  test("a failed fetch is not pinned for later callers", async () => {
    const cache = new ImageCache({ dir });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) throw new Error("upstream blew up");
      return { bytes: PNG, contentType: "image/png" };
    };

    await expect(cache.load("https://api.vrchat.cloud/flaky.png", fetcher)).rejects.toThrow(
      /blew up/,
    );
    expect((await cache.load("https://api.vrchat.cloud/flaky.png", fetcher))?.bytes).toEqual(PNG);
  });

  test("a 404 is not cached and not turned into bytes", async () => {
    const cache = new ImageCache({ dir });
    expect(await cache.load("https://api.vrchat.cloud/gone.png", async () => null)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  test("refuses a response over the per-image cap", async () => {
    const cache = new ImageCache({ dir, maxImageBytes: 8 });
    await expect(
      cache.load("https://api.vrchat.cloud/huge.png", async () => ({
        bytes: new Uint8Array(64),
        contentType: "image/png",
      })),
    ).rejects.toThrow(/over the 8 byte cap/);
    expect(await readdir(dir)).toEqual([]);
  });

  test("evicts oldest-first once the total cap is exceeded", async () => {
    // `evictEvery: 1` sweeps on every write; production checks occasionally, because a readdir +
    // stat of the whole directory per avatar costs more than the overshoot it prevents.
    const cache = new ImageCache({ dir, maxTotalBytes: 250, evictEvery: 1 });

    const write = async (name: string, mtimeSeconds: number) => {
      const url = `https://api.vrchat.cloud/${name}`;
      await cache.write(url, new Uint8Array(100));
      // mtime, not access order, is what eviction ranks by — reads deliberately do not touch files.
      const path = join(dir, cacheKeyFor(url));
      await utimes(path, mtimeSeconds, mtimeSeconds);
      return url;
    };

    const oldest = await write("a.png", 1_000);
    const middle = await write("b.png", 2_000);
    const newest = await write("c.png", 3_000);

    await cache.evict();

    expect(await cache.read(oldest)).toBeNull();
    expect((await cache.read(middle))?.bytes.byteLength).toBe(100);
    expect((await cache.read(newest))?.bytes.byteLength).toBe(100);
  });

  test("keys files by a hash of the url, so the caller cannot shape a filename", () => {
    const key = cacheKeyFor("https://api.vrchat.cloud/../../etc/passwd");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKeyFor("https://api.vrchat.cloud/a")).not.toBe(
      cacheKeyFor("https://api.vrchat.cloud/b"),
    );
  });
});
