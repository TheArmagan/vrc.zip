import { describe, expect, test } from "bun:test";
import { ACCOUNTS, evening, FRIENDS, NOTIFICATIONS, WORLDS } from "./demo.ts";
import { concatList, cropFor, ffmpegArgs } from "./gif.ts";
import {
  AD_ASPECT,
  allPages,
  CAPTURE,
  escapeHtml,
  frameBox,
  posterPage,
  SHORT_ASPECT,
} from "./pages.ts";
import { SHORT_FRAMES, SHOTS, shot, shotsFor } from "./shots.ts";

/**
 * The parts of the picture pipeline that can be wrong *silently*.
 *
 * Most of this tool fails loudly — a missing screenshot is a broken image, a bad ffmpeg filter is a
 * non-zero exit. What is asserted here is the opposite: an invented person who is somehow real, a
 * caption on the wrong shot, a GIF whose last frame is dropped. Every one of those produces a file
 * that looks fine and says the wrong thing.
 */

describe("the invented evening", () => {
  test("nothing in it is a real VRChat id", () => {
    // The whole reason the demo world exists. A real id here would put a real person's profile one
    // paste away from a screenshot in a public README.
    const ids = [...ACCOUNTS.map((a) => a.id), ...FRIENDS.map((f) => f.id)];
    for (const id of ids) {
      expect(id).toMatch(/^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    for (const world of WORLDS) expect(world.id).toMatch(/^wrld_[0-9a-f-]{36}$/);
  });

  test("every id is unique", () => {
    const ids = [...ACCOUNTS.map((a) => a.id), ...FRIENDS.map((f) => f.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const names = FRIENDS.map((friend) => friend.displayName);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the friends cover every state the row draws differently", () => {
    // A screenshot of fourteen identical "active" rows documents a list, not a screen.
    const statuses = new Set(FRIENDS.map((friend) => friend.status));
    expect(statuses.size).toBeGreaterThanOrEqual(4);
    expect(FRIENDS.some((friend) => friend.location === "private")).toBe(true);
    expect(FRIENDS.some((friend) => friend.platform === "android")).toBe(true);
    expect(new Set(FRIENDS.map((friend) => friend.trust)).size).toBeGreaterThanOrEqual(3);
  });

  test("every notification is from somebody in the friend list", () => {
    // A notification from a stranger renders as a bare id, which reads as a bug in the screenshot.
    const known = new Set(FRIENDS.map((friend) => friend.id));
    for (const notification of NOTIFICATIONS) expect(known.has(notification.senderId)).toBe(true);
  });

  test("the evening is relative, so a shot taken next year still reads as tonight", () => {
    const at = evening(1_800_000_000_000);
    expect(at.ago(12)).toBe(1_800_000_000_000 - 12 * 60_000);
  });
});

describe("the shot list", () => {
  test("ids are unique and file-safe", () => {
    const ids = SHOTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  test("every caption is a sentence, not a label", () => {
    // The caption is read by somebody who has not opened the app. "Friends" tells them nothing.
    for (const entry of SHOTS) {
      expect(entry.caption.length).toBeGreaterThan(30);
      expect(entry.caption.endsWith(".")).toBe(true);
    }
  });

  test("nothing names the app it replaces", () => {
    // Deliberate: the pictures are about what this does, and naming a competitor in a README makes
    // the reader think about that one instead.
    const prose = SHOTS.map((entry) => `${entry.title} ${entry.caption}`)
      .join(" ")
      .toLowerCase();
    expect(prose).not.toContain("vrcx");
  });

  test("every surface a page is built for has shots in it", () => {
    for (const surface of ["poster", "hero", "short", "ad"] as const) {
      expect(shotsFor(surface).length).toBeGreaterThan(0);
    }
    for (const id of SHORT_FRAMES) expect(() => shot(id)).not.toThrow();
    expect(SHORT_FRAMES).toHaveLength(3);
  });

  test("an unknown id fails loudly rather than rendering an empty frame", () => {
    expect(() => shot("nope")).toThrow(/No shot called nope/);
  });
});

describe("the pages", () => {
  test("one page per shot, plus the poster", () => {
    const pages = allPages((id) => `/shots/${id}.jpg`);
    expect(pages.size).toBe(SHOTS.length + 1);
    expect(pages.has("poster.html")).toBe(true);
  });

  test("captions are escaped into the markup", () => {
    // Every caption is authored here, so this is not an injection defence — it is what stops an
    // apostrophe or an ampersand in a sentence from silently truncating a page.
    expect(escapeHtml('a & b <c> "d"')).toBe("a &amp; b &lt;c&gt; &quot;d&quot;");
  });

  test("the poster leads with its hero and does not repeat it in the grid", () => {
    const html = posterPage("graph-editor", (id) => `/shots/${id}.jpg`);
    const hero = html.split("/shots/graph-editor.jpg").length - 1;
    expect(hero).toBe(1);
    expect(html).toContain("UNOFFICIAL");
  });
});

describe("the GIF encoding", () => {
  test("the last frame is named twice, or it flashes past", () => {
    // A quirk of ffmpeg's concat demuxer: `duration` applies to the file *before* the next entry,
    // so the final frame's duration is dropped unless the file is listed again.
    const list = concatList(["a.png", "b.png"], 2);
    expect(list.split("\n").filter((line) => line === "file 'b.png'")).toHaveLength(2);
    expect(list).toContain("duration 0.5000");
  });

  test("windows paths are written with forward slashes", () => {
    // ffmpeg's list parser treats a backslash as an escape, so `C:\frames\a.png` loses its
    // separators and the encode fails with a file-not-found on a path that is plainly there.
    expect(concatList(["C:\\frames\\a.png"], 1)).toContain("file 'C:/frames/a.png'");
  });

  test("the crop the pages compose to is the crop ffmpeg takes back out", () => {
    // Two halves of one decision, in two files. If they drift, every GIF frame is off-centre by a
    // few pixels and nothing fails — which is exactly the kind of wrong this file is for.
    for (const aspect of [SHORT_ASPECT, AD_ASPECT]) {
      const box = frameBox(aspect);
      expect(cropFor(aspect, CAPTURE)).toBe(
        `${String(box.width)}:${String(box.height)}:${String(box.left)}:0`,
      );
      // Odd widths are refused by several encoders, and a frame wider than the capture is a frame
      // with its edges already gone.
      expect(box.width % 2).toBe(0);
      expect(box.width).toBeLessThanOrEqual(CAPTURE.width);
    }
  });

  test("the filter graph builds a palette from the frames rather than using the default one", () => {
    const args = ffmpegArgs({ frames: [], out: "out.gif", fps: 2, width: 1280 }, "list.txt");
    const filters = args[args.indexOf("-vf") + 1] ?? "";
    expect(filters).toContain("palettegen=stats_mode=diff");
    expect(filters).toContain("paletteuse");
    expect(filters).toContain("scale=1280:-1");
    // Loops forever, which is what every surface expects of a GIF.
    expect(args[args.indexOf("-loop") + 1]).toBe("0");
  });
});
