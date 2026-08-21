import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../paths.ts";

/**
 * A bounded on-disk cache for VRChat user images, plus in-flight de-duplication.
 *
 * The daemon has to proxy these — the browser cannot load `api.vrchat.cloud/api/1/image/...`
 * itself, because those need the account's auth cookie *and* the mandatory User-Agent. That makes
 * every avatar in the UI a request the daemon pays for out of the shared rate budget, so both
 * halves of this class exist for the same reason:
 *
 *  - **De-duplication.** A friends screen renders up to 200 rows at once and friends share icons
 *    (default avatars especially). Without it, one screen paint is 200 parallel fetches — the whole
 *    per-second budget spent on pictures, while presence and notifications queue behind them.
 *  - **Disk cache.** Icons change on the order of months. Re-fetching them on every restart is
 *    pure waste, and the state directory is exactly where "expensive to get, cheap to lose" lives.
 *
 * There is deliberately **no sidecar metadata file**. A second file per entry doubles the inode
 * count and introduces a torn-write state where bytes and metadata disagree; the content type is
 * recoverable from the first twelve bytes, so it is recovered rather than stored.
 */

/** Files are named by a hash of the URL, so the cache directory is flat and self-describing. */
const CACHE_DIR_NAME = "image-cache";

/** Total bytes the cache may occupy before oldest-first eviction runs. */
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * The largest single response accepted. VRChat icons are tens of kilobytes; anything approaching
 * this is either the wrong URL or someone trying to fill the user's disk through the proxy.
 */
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * How many writes may pass between eviction sweeps.
 *
 * Sweeping on every write means a full `readdir` + `stat` of thousands of files per avatar, which
 * costs far more than the few megabytes of overshoot it prevents. The cap is a budget, not a hard
 * limit, and treating it as one is the whole point.
 */
const DEFAULT_EVICT_EVERY = 32;

export interface CachedImage {
  readonly bytes: Uint8Array;
  /** Sniffed from the magic bytes — see `sniffContentType`. */
  readonly contentType: string;
}

export interface ImageCacheOptions {
  /** Overrides the directory outright. Tests use it; production derives it from the state dir. */
  readonly dir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxTotalBytes?: number;
  readonly maxImageBytes?: number;
  readonly evictEvery?: number;
}

/** What a fetcher hands back: `null` means upstream said the image does not exist. */
export type ImageFetcher = (
  url: string,
) => Promise<{ bytes: Uint8Array; contentType: string | null } | null>;

/** `application/octet-stream` is the honest answer when the bytes match nothing we know. */
export const UNKNOWN_CONTENT_TYPE = "application/octet-stream";

/**
 * Recovers a content type from the leading bytes of an image.
 *
 * Only the four formats VRChat actually serves are recognised. Guessing beyond that would be
 * inventing information, and `application/octet-stream` at least makes a browser refuse to render
 * rather than mis-render.
 */
export function sniffContentType(bytes: Uint8Array): string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // "GIF87a" and "GIF89a" share the first four bytes; the version digits are not worth checking.
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // WebP is a RIFF container: "RIFF" <4-byte length> "WEBP". The length in between is why this
  // cannot be a single prefix comparison.
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp";
  return UNKNOWN_CONTENT_TYPE;
}

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((byte, i) => bytes[offset + i] === byte);
}

/** The cache key. sha256 because the URL is attacker-influenced and must not shape a filename. */
export function cacheKeyFor(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

export class ImageCache {
  readonly #dir: string;
  readonly #maxTotalBytes: number;
  readonly #maxImageBytes: number;
  readonly #evictEvery: number;

  /**
   * URL -> the single fetch currently in flight for it. Cleared in a `finally`, so a failure does
   * not pin a rejected promise that every later caller would inherit.
   */
  readonly #inFlight = new Map<string, Promise<CachedImage | null>>();

  /**
   * Writes since the last eviction sweep. Initialised to the threshold so the *first* write of a
   * process sweeps: a daemon that is restarted more often than it writes 32 images would otherwise
   * never evict at all, and the cap would be decorative.
   */
  #writesSinceEvict: number;

  constructor(options: ImageCacheOptions = {}) {
    this.#dir = options.dir ?? join(stateDir(options.env), CACHE_DIR_NAME);
    this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.#maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.#evictEvery = options.evictEvery ?? DEFAULT_EVICT_EVERY;
    this.#writesSinceEvict = this.#evictEvery;
  }

  get maxImageBytes(): number {
    return this.#maxImageBytes;
  }

  get directory(): string {
    return this.#dir;
  }

  /**
   * Serves `url` from disk, or fetches it once and stores it.
   *
   * The de-duplication is around the *whole* operation, not just the network call: two callers
   * arriving together share one disk read as well as one fetch.
   */
  async load(url: string, fetcher: ImageFetcher): Promise<CachedImage | null> {
    const pending = this.#inFlight.get(url);
    if (pending) return await pending;

    const work = this.#loadUncached(url, fetcher).finally(() => {
      this.#inFlight.delete(url);
    });
    this.#inFlight.set(url, work);
    return await work;
  }

  async #loadUncached(url: string, fetcher: ImageFetcher): Promise<CachedImage | null> {
    const hit = await this.read(url);
    if (hit) return hit;

    const fetched = await fetcher(url);
    if (!fetched) return null;

    if (fetched.bytes.byteLength > this.#maxImageBytes) {
      throw new Error(
        `image at ${url} is ${String(fetched.bytes.byteLength)} bytes, over the ${String(this.#maxImageBytes)} byte cap`,
      );
    }

    await this.write(url, fetched.bytes);

    // Sniffing wins over the upstream header so a cache hit and a cache miss cannot answer
    // differently for the same bytes. The header is only consulted when the bytes say nothing.
    const sniffed = sniffContentType(fetched.bytes);
    const contentType =
      sniffed === UNKNOWN_CONTENT_TYPE && fetched.contentType?.startsWith("image/")
        ? fetched.contentType
        : sniffed;

    return { bytes: fetched.bytes, contentType };
  }

  /** A cache hit, or `null`. Never throws on a missing file — that is the ordinary case. */
  async read(url: string): Promise<CachedImage | null> {
    const file = Bun.file(this.#pathFor(url));
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
    if (bytes.byteLength === 0) return null;
    return { bytes, contentType: sniffContentType(bytes) };
  }

  async write(url: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await Bun.write(this.#pathFor(url), bytes);

    this.#writesSinceEvict += 1;
    if (this.#writesSinceEvict >= this.#evictEvery) {
      this.#writesSinceEvict = 0;
      await this.evict();
    }
  }

  /**
   * Drops the oldest entries until the cache fits under its cap.
   *
   * Oldest *mtime*, not least-recently-used: reads do not touch the file, and adding a touch on
   * every read would turn a cache hit into a write. An icon that was fetched long ago and is still
   * being displayed will simply be fetched again, which costs one request.
   */
  async evict(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return;
    }

    const entries: { path: string; size: number; mtime: number }[] = [];
    let total = 0;
    for (const name of names) {
      const path = join(this.#dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        entries.push({ path, size: info.size, mtime: info.mtimeMs });
        total += info.size;
      } catch {
        // Raced with another eviction or an external delete. Nothing to account for.
      }
    }

    if (total <= this.#maxTotalBytes) return;

    entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries) {
      if (total <= this.#maxTotalBytes) break;
      try {
        await rm(entry.path, { force: true });
        total -= entry.size;
      } catch {
        // Still open by a concurrent read on Windows. It will be evicted next sweep.
      }
    }
  }

  #pathFor(url: string): string {
    return join(this.#dir, cacheKeyFor(url));
  }
}
