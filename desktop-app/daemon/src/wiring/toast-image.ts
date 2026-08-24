/**
 * Turning "the picture I want on this notification" into a file Windows will actually draw.
 *
 * A toast raised by an app that is not packaged **cannot load an image over the network**. Windows
 * does not report that; it draws the toast without the picture, which looks exactly like an image
 * that is the wrong size or a path that is misspelled. So anything that is not already a local file
 * has to become one before the toast is built.
 *
 * For this app that is not an inconvenience, it is the whole feature: the picture somebody wants on
 * a notification is nearly always a VRChat avatar, and a VRChat image URL cannot be fetched by
 * anything that is not carrying the auth cookie and the mandatory User-Agent. The daemon already has
 * exactly one thing that can — the same path `GET /api/image` serves from — so this reuses it rather
 * than opening a second way to fetch a caller-chosen URL.
 *
 * **The allowlist is `parseImageUrl`'s, unchanged.** Exact host match, https only, and a throw for
 * everything else. A graph node is a place a user pastes a URL, which makes it the same threat as
 * the query parameter that function was written for, and giving it its own laxer copy of the rule
 * would be the ordinary way an allowlist stops meaning anything.
 */

import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CachedImage } from "../net/image-cache.ts";
import { stateDir } from "../paths.ts";
import { parseImageUrl } from "../servers/control.ts";

/** Where the decoded copies live. Beside the state tree, because they are derived and disposable. */
const DIRECTORY = "toast-images";

/**
 * How many to keep.
 *
 * One file per distinct picture a notification has ever used, which for a graph that toasts about
 * friends is roughly "one per friend" and then flat. The sweep is cheap and rare; the cap exists so
 * a graph pointed at something that changes every run cannot fill a disk one avatar at a time.
 */
const KEEP = 64;

/** The extension Windows wants. It sniffs the bytes, but only after the extension gets it to look. */
function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".png";
  }
}

export interface ToastImageOptions {
  /** The control API's own image fetcher: cache, allowlist, account, rate limiter and all. */
  readonly fetchImage: (url: string) => Promise<CachedImage | null>;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Builds the resolver `DesktopNotifier` calls for an image it was given a URL for.
 *
 * Answers null for everything it cannot turn into a file, which the notifier treats as "no image"
 * and not as a failure — a notification that arrives without its picture is still the notification.
 */
export function createToastImageResolver(
  options: ToastImageOptions,
): (source: string) => Promise<string | null> {
  const directory = join(stateDir(options.env), DIRECTORY);

  return async (source: string): Promise<string | null> => {
    const target = normalise(source);
    if (target === null) return null;

    let allowed: string;
    try {
      allowed = parseImageUrl(target);
    } catch {
      return null;
    }

    let image: CachedImage | null;
    try {
      image = await options.fetchImage(allowed);
    } catch {
      return null;
    }
    if (image === null) return null;

    const name =
      new Bun.CryptoHasher("sha256").update(allowed, "utf8").digest("hex").slice(0, 32) +
      extensionFor(image.contentType);
    const path = join(directory, name);
    try {
      await mkdir(directory, { recursive: true });
      await Bun.write(path, image.bytes);
    } catch {
      return null;
    }
    void sweep(directory);
    return path;
  };
}

/**
 * The daemon's own `/api/image` URL is unwrapped rather than fetched.
 *
 * A graph is very likely to be handed one of those — it is what every avatar in the UI is addressed
 * by — and fetching it would mean the daemon making an HTTP request to itself, carrying a session
 * token, to reach bytes it already has. The inner URL then goes through the same allowlist as any
 * other, so unwrapping widens nothing.
 */
function normalise(source: string): string | null {
  const trimmed = source.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.pathname === "/api/image") return url.searchParams.get("url");
  return trimmed;
}

/** Keeps the newest {@link KEEP} files. Best-effort, and never the caller's problem. */
async function sweep(directory: string): Promise<void> {
  try {
    const names = await readdir(directory);
    if (names.length <= KEEP) return;
    const entries = await Promise.all(
      names.map(async (name) => {
        const path = join(directory, name);
        try {
          return { path, at: (await stat(path)).mtimeMs };
        } catch {
          return { path, at: 0 };
        }
      }),
    );
    entries.sort((left, right) => right.at - left.at);
    for (const entry of entries.slice(KEEP)) {
      try {
        await unlink(entry.path);
      } catch {
        // Still open by a toast that is on screen. It goes on the next sweep.
      }
    }
  } catch {
    // A directory we cannot read is a sweep that does not happen.
  }
}
