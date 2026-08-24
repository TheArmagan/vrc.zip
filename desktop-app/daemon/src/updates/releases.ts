/**
 * Asking GitHub what the newest release is.
 *
 * ## Why this is the only place vrc.zip talks to a server that is not VRChat
 *
 * The app is local-only, and this is the one deliberate exception: a request to `api.github.com`,
 * four times a day, carrying nothing but a User-Agent. It sends no account, no id, no telemetry and
 * no contact address — in particular **not** the VRChat contact address from settings, which is an
 * email the user gave for VRChat's User-Agent requirement and has no business reaching a third
 * party. The User-Agent here is the app name, its version and the repository URL, which is what
 * GitHub asks unauthenticated callers to identify themselves with.
 *
 * ## Not through the rate limiter
 *
 * The three buckets in `net/` are VRChat's ceilings — per account, per IP, per IP for files — and
 * they exist because exceeding them gets *the user* 429'd by VRChat. GitHub is a different service
 * with a different budget (60 requests an hour for an unauthenticated IP, against which four a day
 * is nothing), and borrowing VRChat's allowance to pay for it would be the actual mistake. The
 * invariant is that nothing reaches **VRChat** except through an `Account`; this does not go there.
 *
 * ## Tags, not `/releases/latest`
 *
 * `/releases/latest` is GitHub's own answer to "which is newest", and it is the wrong answer here
 * twice over: it is whichever release was marked latest rather than whichever has the highest
 * version, and it silently hides a release published out of order. So this reads the list and
 * orders the tags itself with `compareVersions`, which is the same comparison the update-on-run
 * path uses. One definition of "newer", used by both.
 */

import { APP_VERSION, REPOSITORY_URL } from "@vrcz/shared";
import { compareVersions } from "../os/install.ts";

/**
 * What an injected `fetch` has to be, and deliberately narrower than `typeof fetch`.
 *
 * Bun's global carries `preconnect`, so a stub written as a one-line arrow is not assignable to it
 * and every test would have to cast. This is the whole of what the two callers here use, which is
 * also the honest description of the dependency.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** How many releases to look at. The newest handful is plenty to find the highest tag among. */
const PAGE_SIZE = 20;

/** Long enough for a slow connection, short enough that a hung check does not linger for a day. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The asset name the updater will install: the packaged Windows executable, exactly as the release
 * workflow uploads it. A release with no such asset is still reported as available — the user can
 * go and get it — but the in-app update button stands down, because there is nothing to download.
 */
const ASSET_NAME = "vrc.zip.exe";

/** One release, reduced to what an update decision needs. */
export interface ReleaseInfo {
  /** The tag as GitHub spells it, `v0.2.0` and all. */
  readonly tag: string;
  /** The tag with any leading `v` removed, so it can be compared with {@link APP_VERSION}. */
  readonly version: string;
  /** The release page, for the "what changed" link. */
  readonly url: string;
  readonly publishedAt: number | null;
  /** The downloadable executable, or null when the release has no Windows build attached. */
  readonly asset: ReleaseAsset | null;
}

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string;
  /** Bytes, as GitHub reports them. Used to show progress and to sanity-check what arrived. */
  readonly size: number;
}

/**
 * `https://api.github.com/repos/<owner>/<repo>/releases`, derived from {@link REPOSITORY_URL}.
 *
 * Derived rather than written out a second time: the repository URL is already a constant that the
 * About screen, the tray menu and the Installed apps entry all read, and a hand-written API URL
 * beside it is one more thing to forget when the repository moves.
 *
 * Null when the constant is not a GitHub repository URL, which is the honest answer for a fork
 * hosted somewhere else — the caller reports "cannot check" rather than guessing at a host.
 */
export function releasesApiUrl(repository: string = REPOSITORY_URL): string | null {
  let parsed: URL;
  try {
    parsed = new URL(repository);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const segments = parsed.pathname.split("/").filter((part) => part !== "");
  const owner = segments[0];
  const name = segments[1];
  if (owner === undefined || name === undefined) return null;
  const repo = name.replace(/\.git$/i, "");
  return `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${String(PAGE_SIZE)}`;
}

/**
 * What GitHub calls us, and all it is ever told.
 *
 * GitHub rejects an unauthenticated request with no User-Agent outright, so this is required rather
 * than polite. It names the app and the repository, which is what their documentation asks for, and
 * deliberately nothing about the person running it.
 */
export function updateUserAgent(version: string = APP_VERSION): string {
  return `vrc.zip/${version} (+${REPOSITORY_URL})`;
}

/**
 * Turns one entry of GitHub's `/releases` array into a {@link ReleaseInfo}.
 *
 * Defensive in the same way `pipeline/`'s decoder is, and for the same reason: this is a wire
 * shape from a service that owes us no compatibility. Anything missing a tag is dropped rather than
 * defaulted, because a release with no version is not something to compare against a version.
 *
 * Drafts and prereleases are dropped here. A draft is not published and a prerelease is not what an
 * app should offer to install over somebody's working copy without being asked; anybody who wants
 * one is the sort of person who will fetch it from the releases page by hand.
 */
export function toRelease(entry: unknown): ReleaseInfo | null {
  if (typeof entry !== "object" || entry === null) return null;
  const row = entry as Record<string, unknown>;
  if (row.draft === true || row.prerelease === true) return null;

  const tag = typeof row.tag_name === "string" ? row.tag_name.trim() : "";
  if (tag === "") return null;

  const published =
    typeof row.published_at === "string" ? Date.parse(row.published_at) : Number.NaN;
  const assets = Array.isArray(row.assets) ? row.assets : [];

  let asset: ReleaseAsset | null = null;
  for (const candidate of assets) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const file = candidate as Record<string, unknown>;
    const name = typeof file.name === "string" ? file.name : "";
    const url = typeof file.browser_download_url === "string" ? file.browser_download_url : "";
    if (name.toLowerCase() !== ASSET_NAME || url === "") continue;
    asset = { name, url, size: typeof file.size === "number" ? file.size : 0 };
    break;
  }

  return {
    tag,
    version: tag.replace(/^v/i, ""),
    url: typeof row.html_url === "string" ? row.html_url : REPOSITORY_URL,
    publishedAt: Number.isNaN(published) ? null : published,
    asset,
  };
}

/**
 * The highest version among the releases, or null when none of them beats `current`.
 *
 * Pure, and the reason the fetch is a separate function: this is the decision, and a decision that
 * can be tested against a list of tags without a network is one that can be tested at all.
 *
 * Strictly newer, matching `shouldUpdateInstalledCopy`. Running a build that is *ahead* of the
 * newest release is normal — that is what a local build of `main` is — and telling that person an
 * older version is available would be telling them to downgrade.
 */
export function newestRelease(
  releases: readonly ReleaseInfo[],
  current: string = APP_VERSION,
): ReleaseInfo | null {
  let best: ReleaseInfo | null = null;
  for (const release of releases) {
    if (compareVersions(release.version, current) <= 0) continue;
    if (best === null || compareVersions(release.version, best.version) > 0) best = release;
  }
  return best;
}

/**
 * Fetches the release list. Throws with a sentence fit to show a user; never rejects with a
 * network error object, because the caller's only use for one is to put it in a status field.
 *
 * `fetchImpl` is injected so the test can answer without a network. Nothing else passes it.
 */
export async function fetchReleases(
  fetchImpl: FetchLike = fetch,
  repository: string = REPOSITORY_URL,
): Promise<ReleaseInfo[]> {
  const url = releasesApiUrl(repository);
  if (url === null) throw new Error("vrc.zip does not know where to check for releases.");

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": updateUserAgent(),
        // Pinned, as GitHub asks: an unversioned call is one that changes shape without warning.
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Could not reach GitHub to check for updates.");
  }

  if (!response.ok) {
    // 403 here is nearly always the unauthenticated hourly limit rather than a permission problem,
    // and "try later" is more use to the reader than the status code on its own.
    throw new Error(
      response.status === 403 || response.status === 429
        ? "GitHub is rate limiting update checks right now. It will try again later."
        : `GitHub answered ${String(response.status)} when asked for the release list.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("GitHub's release list could not be read.");
  }
  if (!Array.isArray(body)) throw new Error("GitHub's release list was not a list.");

  const releases: ReleaseInfo[] = [];
  for (const entry of body) {
    const release = toRelease(entry);
    if (release !== null) releases.push(release);
  }
  return releases;
}
