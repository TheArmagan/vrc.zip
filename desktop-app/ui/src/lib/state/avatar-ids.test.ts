/**
 * The avatar-id resolver, which is the odd one of the family.
 *
 * The other three resolvers ask VRChat through the daemon. This one asks a *third party* about a
 * file id, and the difference shows up in what its answers mean:
 *
 *  1. **Null is an answer, not a miss.** Most pictures are not avatars — a profile icon, a banner,
 *     a gallery image — so "no avatar for this file" is the common case and must be cached like any
 *     other. Treating it as a cooldown, the way `world-names` treats an unresolved world, would
 *     re-ask about every profile icon in the app forever.
 *  2. `ensure()` is the only thing that fetches, and asking twice about one file is one request.
 *  3. Aborted work goes back to *unknown*, never staying `loading` — a state nothing retries from.
 *  4. `resolveAny` prefers the earlier candidate but does not wait for it: a caller hands over four
 *     pictures and wants whichever is an avatar.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvatarFileResolution } from "../api.ts";
import { avatarIds } from "./avatar-ids.svelte.ts";

const { byFile } = vi.hoisted(() => ({
  byFile: vi.fn<(fileId: string, signal?: AbortSignal) => Promise<AvatarFileResolution>>(),
}));

/** The one network seam. `fileIdFromImageUrl` and `isAbort` stay real: they are behaviour, not transport. */
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: { ...actual.api, avatars: { ...actual.api.avatars, byFile } },
  };
});

const FILE = "file_d9ec5b06-6ea5-4ae0-ab67-78dfa3eea6df";
const OTHER = "file_00000000-0000-0000-0000-000000000001";
const AVATAR = "avtr_eb5a1798-6f23-4ec6-b879-2d01f44a69c4";
const URL_FOR = (id: string): string => `https://api.vrchat.cloud/api/1/image/${id}/2/256`;

/** Lets a test hold a request open, so "in flight" is observable rather than inferred from timing. */
function deferred(): {
  promise: Promise<AvatarFileResolution>;
  resolve: (value: AvatarFileResolution) => void;
} {
  let resolve: (value: AvatarFileResolution) => void = () => {};
  const promise = new Promise<AvatarFileResolution>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  avatarIds.clear();
  byFile.mockReset();
});

afterEach(() => {
  avatarIds.clear();
});

describe("avatarIds", () => {
  it("reads are pure and start nothing", () => {
    expect(avatarIds.get(FILE)).toBeNull();
    expect(avatarIds.entry(FILE)).toBeNull();
    expect(avatarIds.resolveAny([URL_FOR(FILE)])).toBeNull();
    expect(byFile).not.toHaveBeenCalled();
  });

  it("resolves a file to an avatar id", async () => {
    byFile.mockResolvedValue({ fileId: FILE, avatarId: AVATAR });
    avatarIds.ensure(FILE);
    await vi.waitFor(() => {
      expect(avatarIds.get(FILE)).toBe(AVATAR);
    });
    expect(avatarIds.entry(FILE)?.status).toBe("resolved");
  });

  it("caches a null answer instead of re-asking", async () => {
    // The common case: a profile icon is not an avatar. Re-asking would mean one third-party
    // request per icon per render, forever.
    byFile.mockResolvedValue({ fileId: FILE, avatarId: null });
    avatarIds.ensure(FILE);
    await vi.waitFor(() => {
      expect(avatarIds.entry(FILE)?.status).toBe("unresolved");
    });

    avatarIds.ensure(FILE);
    expect(byFile).toHaveBeenCalledTimes(1);
  });

  it("asks once for a file two callers want at the same time", async () => {
    const held = deferred();
    byFile.mockReturnValue(held.promise);

    avatarIds.ensure(FILE);
    avatarIds.ensure(FILE);
    expect(avatarIds.entry(FILE)?.status).toBe("loading");

    held.resolve({ fileId: FILE, avatarId: AVATAR });
    await vi.waitFor(() => {
      expect(avatarIds.get(FILE)).toBe(AVATAR);
    });
    expect(byFile).toHaveBeenCalledTimes(1);
  });

  it("ignores anything that is not a VRChat image URL", () => {
    // `""` is how VRChat spells an unset image, and it reaches here constantly.
    avatarIds.ensureAll(["", null, undefined, "not a url", "https://example.invalid/nope.png"]);
    expect(byFile).not.toHaveBeenCalled();
  });

  it("pulls the file id out of both URL shapes VRChat serves", async () => {
    byFile.mockResolvedValue({ fileId: FILE, avatarId: AVATAR });
    avatarIds.ensureAll([
      `https://api.vrchat.cloud/api/1/image/${FILE}/2/256`,
      `https://api.vrchat.cloud/api/1/file/${FILE}/1/1024`,
    ]);
    await vi.waitFor(() => {
      expect(avatarIds.get(FILE)).toBe(AVATAR);
    });
    // Both URLs name the same file, so they are one lookup rather than two.
    expect(byFile).toHaveBeenCalledTimes(1);
  });

  it("resolveAny takes the first candidate that resolved, not the first asked", async () => {
    byFile.mockImplementation(async (fileId) =>
      fileId === OTHER ? { fileId, avatarId: AVATAR } : { fileId, avatarId: null },
    );

    avatarIds.ensureAll([URL_FOR(FILE), URL_FOR(OTHER)]);
    await vi.waitFor(() => {
      expect(avatarIds.entry(OTHER)?.status).toBe("resolved");
    });

    // The preferred candidate answered "not an avatar", so the later one is the answer.
    expect(avatarIds.resolveAny([URL_FOR(FILE), URL_FOR(OTHER)])).toBe(AVATAR);
  });

  it("reports a failure without pretending the file is not an avatar", async () => {
    byFile.mockRejectedValue(new Error("boom"));
    avatarIds.ensure(FILE);
    await vi.waitFor(() => {
      expect(avatarIds.entry(FILE)?.status).toBe("error");
    });
    // Still null to a caller, but `unresolved` would have claimed avtr.zip answered.
    expect(avatarIds.get(FILE)).toBeNull();
    expect(avatarIds.entry(FILE)?.error).toBe("boom");
  });

  it("an aborted lookup goes back to unknown so it can be asked again", async () => {
    // A real `DOMException`: `isAbort` tests `instanceof DOMException`, so an ordinary Error with
    // the right `name` is not an abort and would be recorded as a failure.
    const abort = new DOMException("aborted", "AbortError");
    byFile.mockRejectedValueOnce(abort);
    avatarIds.ensure(FILE);
    await vi.waitFor(() => {
      expect(avatarIds.entry(FILE)).toBeNull();
    });

    // Left at `loading`, nothing would ever ask again. This is the bug the entity modals shipped.
    byFile.mockResolvedValue({ fileId: FILE, avatarId: AVATAR });
    avatarIds.ensure(FILE);
    await vi.waitFor(() => {
      expect(avatarIds.get(FILE)).toBe(AVATAR);
    });
  });

  it("pending is true only while something is actually in flight", async () => {
    const held = deferred();
    byFile.mockReturnValue(held.promise);

    avatarIds.ensureAll([URL_FOR(FILE)]);
    expect(avatarIds.pending([URL_FOR(FILE)])).toBe(true);

    held.resolve({ fileId: FILE, avatarId: null });
    await vi.waitFor(() => {
      expect(avatarIds.pending([URL_FOR(FILE)])).toBe(false);
    });
  });
});
