/**
 * The Windows executable icon: the same mark the UI serves at `/favicon.ico`, rendered to a
 * multi-size `.ico`. See PLAN.md §Phase 5.
 *
 * Run with `bun run icon` from the workspace root. Output lands in `tools/assets/vrczip.ico` and is
 * **committed**, so packaging needs nothing but Bun — this script is only for changing the mark.
 *
 * Two halves, and the split is deliberate:
 *
 * - **Rasterising is ours.** The mark is four straight lines and a rounded rectangle, so a few
 *   dozen lines of coverage maths beat taking on an SVG renderer, and the result is identical on
 *   every machine rather than depending on which rasteriser a toolchain happened to link.
 * - **Encoding is ffmpeg's.** It has an ICO muxer that takes one stream per size, which is exactly
 *   the shape of the problem, and hand-rolling a PNG encoder (CRC-32, zlib framing, Adler-32) to
 *   produce a file that changes once a year is not a trade worth making.
 *
 * ffmpeg is therefore a prerequisite of *this script*, not of the build.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const OUT_PATH = join(ROOT, "tools", "assets", "vrczip.ico");

/**
 * Every size Windows asks for, including the display-scaling ones.
 *
 * 16 (title bar, taskbar), 32 (desktop), 48 (Explorer medium), 256 (extra large, and the installer)
 * are the obvious four. The rest are what display scaling turns those into: 125% wants 20, 150%
 * wants 24, 200% wants 32 and 96. A size that is missing is not skipped — Windows resamples the
 * nearest larger entry, badly, and the result is the blur that makes an icon look cheap. Each one
 * here is rendered from the geometry instead, so nothing is ever a resample.
 */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256] as const;

/** Amber tile, near-black mark. Kept to two colours so it still reads at 16px. */
const TILE = { r: 0xf5, g: 0xc4, b: 0x51 } as const;
const INK = { r: 0x15, g: 0x15, b: 0x15 } as const;

/**
 * The mark, in the 32-unit space `daemon/src/servers/ui.ts` draws it in: "VZ" cut out of a rounded
 * tile. Kept in those units so both copies can be checked against each other by eye.
 */
const VIEWBOX = 32;
const CORNER_RADIUS = 6;
const STROKE_WIDTH = 2.8;

/**
 * "VZ" as **one** polyline, drawn without lifting the pen: down into the V, back up its right arm,
 * straight on into the Z's top bar, down the diagonal, out along the bottom.
 *
 * The V's right arm and the Z's left edge are the same stroke, which is what makes it a monogram
 * rather than two letters that happen to touch. It also means there is nothing sticking out: the
 * only square caps are at the very start and the very end, and every corner in between is a round
 * join, so no cap can poke past a corner as a notch.
 *
 * The stroke is a hair thinner than a single letter would want: two letters in one tile means each
 * is ~13 units wide instead of 16, and 3 units of ink across that closes up the counters at 16px.
 */
const STROKES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [4, 9.5],
    [10.5, 22.5],
    [17, 9.5],
    [28, 9.5],
    [16.5, 22.5],
    [28, 22.5],
  ],
];

/** Subsamples per axis. 4 means 16 samples a pixel, which is enough to hide the stairs at 16px. */
const SUPERSAMPLE = 4;

interface Rgba {
  readonly width: number;
  readonly pixels: Uint8Array;
}

export function renderMark(size: number): Rgba {
  const pixels = new Uint8Array(size * size * 4);
  const scale = size / VIEWBOX;
  const step = 1 / (SUPERSAMPLE * scale);
  const origin = step / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let tileHits = 0;
      let inkHits = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          // Sample in viewBox units, at the centre of each subpixel.
          const px = x / scale + origin + sx * step;
          const py = y / scale + origin + sy * step;
          if (insideTile(px, py)) tileHits += 1;
          if (insideStroke(px, py)) inkHits += 1;
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const tileAlpha = tileHits / samples;
      // The stroke lies inside the tile, so it can only paint where the tile does; clipping here
      // keeps the ink from bleeding past a rounded corner into transparent pixels.
      const inkAlpha = Math.min(inkHits / samples, tileAlpha);

      const alpha = tileAlpha;
      const offset = (y * size + x) * 4;
      if (alpha === 0) continue;

      // Composite ink over tile, then un-premultiply: PNG and BMP both want straight alpha.
      pixels[offset] = blend(INK.r, TILE.r, inkAlpha, tileAlpha, alpha);
      pixels[offset + 1] = blend(INK.g, TILE.g, inkAlpha, tileAlpha, alpha);
      pixels[offset + 2] = blend(INK.b, TILE.b, inkAlpha, tileAlpha, alpha);
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return { width: size, pixels };
}

function blend(
  ink: number,
  tile: number,
  inkAlpha: number,
  tileAlpha: number,
  alpha: number,
): number {
  const premultiplied = ink * inkAlpha + tile * (tileAlpha - inkAlpha);
  return Math.round(Math.min(255, Math.max(0, premultiplied / alpha)));
}

/** Signed-distance test for the rounded tile filling the viewBox. */
function insideTile(x: number, y: number): boolean {
  const half = VIEWBOX / 2;
  const dx = Math.abs(x - half) - (half - CORNER_RADIUS);
  const dy = Math.abs(y - half) - (half - CORNER_RADIUS);
  const outsideX = Math.max(dx, 0);
  const outsideY = Math.max(dy, 0);
  const distance = Math.hypot(outsideX, outsideY) + Math.min(Math.max(dx, dy), 0) - CORNER_RADIUS;
  return distance <= 0;
}

/**
 * The stroked polyline, as the union of three boxes.
 *
 * Only the two real ends are extended by half the stroke width — that is the SVG's
 * `stroke-linecap="square"`. Extending at the joins too would be simpler, and it is what the first
 * cut did, but the extension pokes out past each corner as a visible notch at 256px. Leaving the
 * joins unextended bevels them instead, which is what a corner is supposed to look like.
 */
function insideStroke(x: number, y: number): boolean {
  const half = STROKE_WIDTH / 2;
  for (const points of STROKES) {
    for (let i = 0; i + 1 < points.length; i += 1) {
      const from = points[i];
      const to = points[i + 1];
      if (from === undefined || to === undefined) continue;

      const capStart = i === 0 ? half : 0;
      const capEnd = i + 2 === points.length ? half : 0;

      const vx = to[0] - from[0];
      const vy = to[1] - from[1];
      const length = Math.hypot(vx, vy);
      if (length === 0) continue;

      // Project into the segment's own frame: `along` runs down it, `across` is perpendicular.
      const ux = vx / length;
      const uy = vy / length;
      const rx = x - from[0];
      const ry = y - from[1];
      const along = rx * ux + ry * uy;
      const across = Math.abs(rx * -uy + ry * ux);
      if (across <= half && along >= -capStart && along <= length + capEnd) return true;
    }

    // Round joins. Two boxes meeting at the V's apex leave a notch on the outside of the angle,
    // and at 256px it is plainly a defect rather than a bevel; a disc at each interior vertex
    // fills it. Cheap, because there are two of them in the whole mark.
    for (let i = 1; i + 1 < points.length; i += 1) {
      const joint = points[i];
      if (joint === undefined) continue;
      if (Math.hypot(x - joint[0], y - joint[1]) <= half) return true;
    }
  }
  return false;
}

/** Raw RGBA frames -> a multi-size `.ico`, via ffmpeg's ICO muxer (one input stream per size). */
async function writeIcon(outPath: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "vrcz-icon-"));
  try {
    const argv: string[] = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"];
    for (const size of SIZES) {
      const frame = renderMark(size);
      const path = join(scratch, `${size}.rgba`);
      await writeFile(path, frame.pixels);
      argv.push("-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${size}x${size}`, "-i", path);
    }
    for (let i = 0; i < SIZES.length; i += 1) argv.push("-map", `${i}:v`);
    // PNG-compressed entries rather than BMP: a 256x256 BMP entry alone is 256KB of the icon, and
    // every Windows since Vista reads the PNG form.
    argv.push("-c:v", "png", "-f", "ico", outPath);

    await mkdir(join(outPath, ".."), { recursive: true });
    const ffmpeg = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([ffmpeg.exited, new Response(ffmpeg.stderr).text()]);
    if (code !== 0) {
      throw new Error(`ffmpeg exited ${code}${stderr === "" ? "" : `:\n${stderr.trim()}`}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await writeIcon(OUT_PATH);
  } catch (error) {
    console.error(`icon: ${error instanceof Error ? error.message : String(error)}`);
    console.error("icon: ffmpeg has to be on PATH to regenerate the icon (the .ico is committed).");
    process.exit(1);
  }
  const size = (await Bun.file(OUT_PATH).arrayBuffer()).byteLength;
  console.log(`icon: wrote ${OUT_PATH} (${SIZES.join(", ")}px, ${(size / 1024).toFixed(1)} KB)`);
}
