/**
 * Frames to a GIF, through ffmpeg.
 *
 * ## Two passes, not one
 *
 * A GIF has 256 colours. ffmpeg's default palette is a fixed web-safe one, and against a dark UI
 * full of small anti-aliased text that produces visible banding in every gradient and a fringe on
 * every glyph. `palettegen` reads the actual frames and builds a palette for *them*; `paletteuse`
 * applies it. The cost is decoding the frames twice, which for fourteen stills is nothing.
 *
 * `stats_mode=diff` weights the palette toward the parts of the frame that change between them,
 * which for a slideshow of screenshots means the screenshots rather than the background they all
 * share. Dithering is `bayer:bayer_scale=5` — the ordered dither is the one that does not shimmer
 * between frames, and a shimmering background is far more distracting in a loop than a little
 * banding.
 *
 * ## ffmpeg is detected, not required
 *
 * This is a manual, occasional pipeline. Somebody refreshing one screenshot should not be stopped by
 * a missing binary they do not need, so the caller is told where to get it and the stills still
 * render. See {@link findFfmpeg}.
 */

export interface GifOptions {
  /** In order. Absolute or cwd-relative paths to PNG or JPEG frames. */
  readonly frames: readonly string[];
  readonly out: string;
  /** Frames per second. The short GIF is 1; the ad is 2. */
  readonly fps: number;
  /** Output width. Height follows the frames' aspect ratio. */
  readonly width: number;
  /** How many times to loop. 0 is forever, which is what every surface expects of a GIF. */
  readonly loop?: number;
}

/** Where ffmpeg is, or null. Checked rather than assumed — see the note above. */
export async function findFfmpeg(): Promise<string | null> {
  for (const candidate of ["ffmpeg", "ffmpeg.exe"]) {
    try {
      const probe = Bun.spawn([candidate, "-version"], { stdout: "ignore", stderr: "ignore" });
      if ((await probe.exited) === 0) return candidate;
    } catch {
      // Not on PATH. Try the next spelling, then give up quietly.
    }
  }
  return null;
}

export const FFMPEG_MISSING =
  "ffmpeg is not on PATH, so the GIFs were skipped. Everything else was written. " +
  "Install it (winget install Gyan.FFmpeg, or https://ffmpeg.org/download.html) and run this again.";

/**
 * The argv for one GIF. Pure, so a test can read the filter graph without encoding anything.
 *
 * Frames are fed through `concat` with an explicit duration per frame rather than as a numbered
 * sequence: the sequence form needs files named `%03d.png` on disk, which would mean copying every
 * frame to a temporary name just to satisfy a printf pattern.
 */
export function ffmpegArgs(options: GifOptions, listPath: string): string[] {
  const filters = [
    `fps=${String(options.fps)}`,
    `scale=${String(options.width)}:-1:flags=lanczos`,
    "split[a][b]",
    "[a]palettegen=stats_mode=diff[p]",
    "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
  ].join(",");

  return [
    "-y",
    "-f",
    "concat",
    // The frame list names files this tool wrote seconds ago in a directory it owns; without this
    // ffmpeg refuses any path outside the list's own directory.
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    filters,
    "-loop",
    String(options.loop ?? 0),
    options.out,
  ];
}

/**
 * The concat list. Each frame gets a `duration`, and the last frame is repeated.
 *
 * The repeat is a quirk of the demuxer rather than a mistake: it applies a `duration` to the file
 * *before* the next entry, so the final frame's duration is dropped and the last picture flashes
 * past. Naming it twice is the documented way to give it its share of the loop.
 */
export function concatList(frames: readonly string[], fps: number): string {
  const seconds = (1 / fps).toFixed(4);
  const lines: string[] = [];
  for (const frame of frames) {
    lines.push(`file '${frame.replaceAll("\\", "/")}'`);
    lines.push(`duration ${seconds}`);
  }
  const last = frames.at(-1);
  if (last !== undefined) lines.push(`file '${last.replaceAll("\\", "/")}'`);
  return `${lines.join("\n")}\n`;
}

export async function encodeGif(options: GifOptions): Promise<{ ok: boolean; note: string }> {
  const ffmpeg = await findFfmpeg();
  if (ffmpeg === null) return { ok: false, note: FFMPEG_MISSING };

  const listPath = `${options.out}.frames.txt`;
  await Bun.write(listPath, concatList(options.frames, options.fps));
  const child = Bun.spawn([ffmpeg, ...ffmpegArgs(options, listPath)], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await child.exited;
  if (code !== 0) {
    const stderr = await new Response(child.stderr).text();
    return {
      ok: false,
      note: `ffmpeg exited ${String(code)}:\n${stderr.split("\n").slice(-12).join("\n")}`,
    };
  }
  const size = (await Bun.file(options.out).stat()).size;
  return { ok: true, note: `${options.out} — ${(size / 1_000_000).toFixed(2)} MB` };
}
