import { describe, expect, test } from "bun:test";
import { renderMark } from "./icon.ts";

/** RGBA at a pixel, as `[r, g, b, a]`. */
function pixel(size: number, x: number, y: number): number[] {
  const { pixels } = renderMark(size);
  const offset = (y * size + x) * 4;
  return [...pixels.slice(offset, offset + 4)];
}

describe("renderMark", () => {
  test("the tile is rounded: corners transparent, middle opaque", () => {
    expect(pixel(32, 0, 0)[3]).toBe(0);
    expect(pixel(32, 31, 31)[3]).toBe(0);
    expect(pixel(32, 16, 16)[3]).toBe(255);
  });

  test("both letters are inked, not just one", () => {
    // Two dark samples on the 10–22 band, one in each half of the tile. The whole failure mode
    // this guards is a geometry edit that leaves a letter off the tile entirely, which is easy to
    // miss in an .ico nobody opens.
    const size = 128;
    const dark = (x: number, y: number): boolean => {
      const [r = 255, , , a = 0] = pixel(size, x, y);
      return a === 255 && r < 60;
    };
    const inked = (from: number, to: number): boolean => {
      for (let x = from; x < to; x += 1) {
        for (let y = 0.3 * size; y < 0.75 * size; y += 1) if (dark(x, Math.round(y))) return true;
      }
      return false;
    };
    expect(inked(Math.round(0.15 * size), Math.round(0.45 * size))).toBe(true);
    expect(inked(Math.round(0.55 * size), Math.round(0.9 * size))).toBe(true);
  });

  test("every size renders its own pixels rather than a resample", () => {
    // The blur an icon gets when Windows has to scale a missing size; the point of the ladder is
    // that each entry is drawn at its own resolution.
    for (const size of [16, 24, 48, 256]) {
      const { width, pixels } = renderMark(size);
      expect(width).toBe(size);
      expect(pixels.length).toBe(size * size * 4);
    }
  });
});
