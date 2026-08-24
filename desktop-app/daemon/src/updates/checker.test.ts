import { describe, expect, test } from "bun:test";
import { APP_VERSION } from "@vrcz/shared";
import { createUpdateChecker } from "./checker.ts";
import type { FetchLike } from "./releases.ts";

/**
 * The checker's bookkeeping, with a `fetch` that answers from an array.
 *
 * Nothing here starts a timer that matters or installs anything: `install()` is exercised only on
 * the paths where it refuses, because the path where it agrees renames the executable this test is
 * running out of. That half is `apply.ts`'s, and it is the one part of this subsystem that only a
 * real run can prove.
 */

/** A release list with one entry at `version`, carrying an executable unless told otherwise. */
function releaseList(version: string, withAsset = true): string {
  return JSON.stringify([
    {
      tag_name: `v${version}`,
      html_url: `https://github.com/TheArmagan/vrc.zip/releases/tag/v${version}`,
      published_at: "2026-08-01T12:00:00Z",
      assets: withAsset
        ? [
            {
              name: "vrc.zip.exe",
              browser_download_url: "https://example.invalid/vrc.zip.exe",
              size: 90_000_000,
            },
          ]
        : [],
    },
  ]);
}

const answering =
  (body: string, status = 200): FetchLike =>
  () =>
    Promise.resolve(
      new Response(body, { status, headers: { "content-type": "application/json" } }),
    );

describe("the update checker", () => {
  test("reports the running version before it has checked anything", () => {
    const checker = createUpdateChecker({ canInstall: true, fetchImpl: answering("[]") });
    const status = checker.status();
    // The banner reads this on a cold tab's first frame, so "nothing known yet" has to be a status
    // rather than a null: `available: false` renders nothing, which is right.
    expect(status.current).toBe(APP_VERSION);
    expect(status.available).toBe(false);
    expect(status.checkedAt).toBe(null);
    expect(status.error).toBe(null);
  });

  test("finds a newer release and reports it once", async () => {
    let announcements = 0;
    const checker = createUpdateChecker({
      canInstall: true,
      fetchImpl: answering(releaseList("999.0.0")),
      onAvailable: () => {
        announcements += 1;
      },
    });

    const first = await checker.check();
    expect(first.available).toBe(true);
    expect(first.latest).toBe("999.0.0");
    expect(first.canInstall).toBe(true);
    expect(first.checkedAt).not.toBe(null);

    // The second check finds the same release. A six-hourly timer that logged the same line four
    // times a day is the reason the announcement is deduplicated on the version rather than fired
    // whenever one is found.
    await checker.check();
    expect(announcements).toBe(1);
  });

  test("an older release is not an update", async () => {
    const checker = createUpdateChecker({
      canInstall: true,
      fetchImpl: answering(releaseList("0.0.1")),
    });
    const status = await checker.check();
    expect(status.available).toBe(false);
    expect(status.latest).toBe(null);
  });

  test("a release with no executable is news without a button", async () => {
    const checker = createUpdateChecker({
      canInstall: true,
      fetchImpl: answering(releaseList("999.0.0", false)),
    });
    const status = await checker.check();
    expect(status.available).toBe(true);
    // Both halves of `canInstall`: this one fails on the release, not on the build.
    expect(status.canInstall).toBe(false);
    expect((await checker.install()).ok).toBe(false);
  });

  test("a build that cannot replace itself still gets the news", async () => {
    const checker = createUpdateChecker({
      canInstall: false,
      fetchImpl: answering(releaseList("999.0.0")),
    });
    const status = await checker.check();
    expect(status.available).toBe(true);
    expect(status.canInstall).toBe(false);

    const attempt = await checker.install();
    expect(attempt).toEqual({
      ok: false,
      restarting: false,
      reason: "There is no update this copy of vrc.zip can install itself.",
    });
  });

  test("a failed check keeps the last known answer and says what went wrong", async () => {
    let body = releaseList("999.0.0");
    let status = 200;
    const checker = createUpdateChecker({
      canInstall: true,
      fetchImpl: () =>
        Promise.resolve(
          new Response(body, { status, headers: { "content-type": "application/json" } }),
        ),
    });

    await checker.check();
    body = "";
    status = 500;
    const failed = await checker.check();

    // The release survives the failure, deliberately: a banner that vanished because GitHub was
    // briefly unreachable would be telling the user the update went away.
    expect(failed.available).toBe(true);
    expect(failed.latest).toBe("999.0.0");
    expect(failed.error).toContain("500");
  });

  test("installing with nothing found refuses rather than throwing", async () => {
    const checker = createUpdateChecker({ canInstall: true, fetchImpl: answering("[]") });
    expect((await checker.install()).ok).toBe(false);
  });

  test("stop is safe before start, and start twice leaves one timer", () => {
    const checker = createUpdateChecker({
      canInstall: true,
      fetchImpl: answering("[]"),
      intervalMs: 60_000,
    });
    checker.stop();
    checker.start();
    checker.start();
    checker.stop();
    // Nothing to assert beyond "the suite ends": a leaked interval would hold `bun test` open.
    expect(checker.status().installing).toBe(false);
  });
});
