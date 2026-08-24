import { describe, expect, test } from "bun:test";
import {
  fetchReleases,
  newestRelease,
  releasesApiUrl,
  toRelease,
  updateUserAgent,
} from "./releases.ts";

/**
 * The release check, without a network.
 *
 * Nothing here reaches `api.github.com`. The three things worth asserting are all decisions — which
 * URL, which entries survive the decoder, and which tag wins — and every one of them is a pure
 * function precisely so this file can exist. `fetchReleases` takes its `fetch`, so even the one
 * test that exercises the request never opens a socket.
 */

/** One entry shaped the way GitHub's `/releases` array is, with only the fields the decoder reads. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: "v0.2.0",
    html_url: "https://github.com/TheArmagan/vrc.zip/releases/tag/v0.2.0",
    published_at: "2026-08-01T12:00:00Z",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "vrc.zip.exe",
        browser_download_url: "https://github.com/x/y/releases/download/v0.2.0/vrc.zip.exe",
        size: 90_000_000,
      },
    ],
    ...overrides,
  };
}

describe("releasesApiUrl", () => {
  test("is derived from the repository constant, not written out again", () => {
    expect(releasesApiUrl("https://github.com/TheArmagan/vrc.zip")).toBe(
      "https://api.github.com/repos/TheArmagan/vrc.zip/releases?per_page=20",
    );
    // A `.git` suffix and a trailing slash are both things a repository URL is spelled with.
    expect(releasesApiUrl("https://github.com/TheArmagan/vrc.zip.git")).toContain(
      "/repos/TheArmagan/vrc.zip/releases",
    );
  });

  test("declines anything that is not a GitHub repository", () => {
    // A fork hosted elsewhere gets "cannot check", which is honest. Guessing at an API host for it
    // would mean this app making requests to a server nobody named.
    expect(releasesApiUrl("https://gitlab.com/someone/vrc.zip")).toBe(null);
    expect(releasesApiUrl("https://github.com/TheArmagan")).toBe(null);
    expect(releasesApiUrl("not a url")).toBe(null);
  });
});

describe("the User-Agent", () => {
  test("names the app and nothing about the person running it", () => {
    const agent = updateUserAgent("1.2.3");
    expect(agent).toBe("vrc.zip/1.2.3 (+https://github.com/TheArmagan/vrc.zip)");
    // The guard that matters. The VRChat contact address is an email the user gave for VRChat's
    // User-Agent requirement, and it has no business reaching GitHub.
    expect(agent).not.toContain("@");
  });
});

describe("toRelease", () => {
  test("reads the tag, the page and the Windows asset", () => {
    const release = toRelease(entry());
    expect(release?.tag).toBe("v0.2.0");
    // The `v` comes off, because `compareVersions` is fed this against `APP_VERSION`, which has none.
    expect(release?.version).toBe("0.2.0");
    expect(release?.asset?.size).toBe(90_000_000);
  });

  test("drops drafts and prereleases", () => {
    // Neither is something to offer to install over somebody's working copy unasked.
    expect(toRelease(entry({ draft: true }))).toBe(null);
    expect(toRelease(entry({ prerelease: true }))).toBe(null);
  });

  test("drops anything without a tag, and survives everything else", () => {
    expect(toRelease(entry({ tag_name: "" }))).toBe(null);
    expect(toRelease(entry({ tag_name: 7 }))).toBe(null);
    expect(toRelease(null)).toBe(null);
    expect(toRelease("a string")).toBe(null);
  });

  test("a release with no executable is still a release", () => {
    /*
     * The point of reporting it anyway: the news is that a newer version exists, which is true
     * whether or not this app can fetch it. `asset: null` is what makes `canInstall` false, so the
     * banner says "get it from the release page" rather than offering a button that cannot work.
     */
    const release = toRelease(
      entry({ assets: [{ name: "notes.txt", browser_download_url: "x" }] }),
    );
    expect(release?.version).toBe("0.2.0");
    expect(release?.asset).toBe(null);
  });

  test("ignores an unparseable published date rather than dropping the release", () => {
    expect(toRelease(entry({ published_at: "whenever" }))?.publishedAt).toBe(null);
  });
});

describe("newestRelease", () => {
  const list = [
    toRelease(entry({ tag_name: "v0.9.0" })),
    toRelease(entry({ tag_name: "v0.10.0" })),
    toRelease(entry({ tag_name: "v0.2.0" })),
  ].flatMap((release) => (release === null ? [] : [release]));

  test("picks the highest version, not the first or the last", () => {
    // The reason this is not `list[0]`: GitHub returns creation order, and a patch published after
    // a bigger release is a normal thing that would otherwise win.
    expect(newestRelease(list, "0.1.5")?.version).toBe("0.10.0");
  });

  test("nothing is newer than itself", () => {
    expect(newestRelease(list, "0.10.0")).toBe(null);
  });

  test("a build ahead of every release is not offered a downgrade", () => {
    // What a local build of `main` looks like. Telling that person 0.10.0 is "available" would be
    // telling them to go backwards.
    expect(newestRelease(list, "1.0.0")).toBe(null);
  });
});

describe("fetchReleases", () => {
  test("decodes the list and asks with the headers GitHub requires", async () => {
    let seen: Request | string | undefined;
    let headers: Record<string, string> = {};
    const releases = await fetchReleases((input, init) => {
      seen = input as string;
      headers = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(
        new Response(JSON.stringify([entry(), entry({ tag_name: "v0.3.0" })]), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    expect(String(seen)).toContain("api.github.com");
    // Absent, GitHub refuses an unauthenticated request outright.
    expect(headers["user-agent"]).toContain("vrc.zip/");
    expect(releases.map((release) => release.version)).toEqual(["0.2.0", "0.3.0"]);
  });

  test("turns a rate limit into a sentence rather than a status code", async () => {
    const failure = fetchReleases(() => Promise.resolve(new Response("", { status: 403 })));
    // The message is shown in the settings screen verbatim, so it has to read as English.
    expect(failure).rejects.toThrow(/rate limiting/i);
  });

  test("a body that is not a list is a failure, not an empty result", async () => {
    // An empty result would be indistinguishable from "no releases", which would quietly disable
    // update checking for as long as whatever is answering keeps answering wrongly.
    const failure = fetchReleases(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Not Found" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    expect(failure).rejects.toThrow(/not a list/i);
  });

  test("a network failure is a sentence too", async () => {
    const failure = fetchReleases(() => Promise.reject(new Error("ENOTFOUND")));
    expect(failure).rejects.toThrow(/Could not reach GitHub/);
  });
});
