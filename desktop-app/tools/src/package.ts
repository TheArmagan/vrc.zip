/**
 * Packaging: the whole app as one Windows executable. See PLAN.md §Phase 5.
 *
 * Run with `bun run package` from the workspace root. Output is `dist/vrc.zip.exe` — the daemon,
 * the UI bundle, and the Bun runtime in a single file with the app icon and version metadata on it.
 * Nothing else has to be copied next to it: state lives in `%LOCALAPPDATA%\vrc.zip`, and the UI is
 * inside the binary rather than in a `ui/dist` a user could delete or a second app could edit.
 *
 * Two things worth knowing about the shape of the build:
 *
 * - **The UI rides along as an embedded asset**, not as a generated import map. `--asset=ui/dist`
 *   embeds the tree under the directory's own name — `dist/index.html`, not `ui/dist/index.html` —
 *   `Bun.embeddedFiles` hands the files back at runtime as blobs that already know their content
 *   type, and `daemon/src/servers/embedded-ui.ts` serves them. Running
 *   from source, that list is empty and the UI server falls back to the directory on disk, so there
 *   is one code path here and no build-only branch to rot.
 * - **The console stays.** `--windows-hide-console` would hide the launch URL, the first-run notice
 *   and the forward-proxy banner, and leave no obvious way to stop the daemon. A tray icon and a
 *   windowed shell are the answer to that (PLAN.md §Phase 5), not a silenced terminal.
 *
 * This supersedes the `bun.exe` + `app/` layout described in PLAN.md §Phase 5, which stays the plan
 * for the day plugins land — see the decision log in PROGRESS.md.
 */
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { APP_NAME, APP_VERSION } from "@vrcz/shared";

const ROOT = join(import.meta.dir, "..", "..");
const ICON_PATH = join("tools", "assets", "vrczip.ico");
const UI_DIST = join("ui", "dist");
const DEFAULT_OUTFILE = join("dist", "vrc.zip.exe");

/** Cross-compilation targets Bun understands. Only the first is shipped today. */
const TARGETS = ["bun-windows-x64", "bun-windows-x64-baseline"] as const;
type Target = (typeof TARGETS)[number];

interface Options {
  target: Target;
  outfile: string;
  /** Skips `vite build`. For iterating on the packaging itself, never for a release. */
  skipUi: boolean;
}

function fail(message: string): never {
  console.error(`package: ${message}`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Options {
  let target: Target = "bun-windows-x64";
  let outfile = DEFAULT_OUTFILE;
  let skipUi = false;

  for (const arg of argv) {
    if (arg === "--skip-ui") {
      skipUi = true;
    } else if (arg.startsWith("--target=")) {
      const value = arg.slice("--target=".length);
      if (!TARGETS.includes(value as Target)) {
        fail(`unknown --target ${value}. Known: ${TARGETS.join(", ")}`);
      }
      target = value as Target;
    } else if (arg.startsWith("--outfile=")) {
      outfile = arg.slice("--outfile=".length);
    } else {
      fail(
        `unknown argument ${arg}. Usage: bun run package [--target=…] [--outfile=…] [--skip-ui]`,
      );
    }
  }

  return { target, outfile, skipUi };
}

/** Runs a command in the workspace root, inheriting stdio, and exits on failure. */
async function run(argv: string[], what: string): Promise<void> {
  const child = Bun.spawn(argv, {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) fail(`${what} failed (exit ${code})`);
}

/**
 * The `1.2.3.4` Windows wants, from the `0.1.0` we keep.
 *
 * The field is four 16-bit integers, so anything that will not fit — a `rc` tag, a number past
 * 65535 — becomes a zero *in place*. Dropping it instead would slide the fields left and print
 * `1.70000.3` as version 1.3, which is a different release.
 */
export function windowsVersion(version: string): string {
  const fields = version
    .split(/[.+-]/)
    .slice(0, 4)
    .map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : 0;
    });
  const [major = 0, minor = 0, patch = 0, build = 0] = fields;
  return `${major}.${minor}.${patch}.${build}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(join(ROOT, ICON_PATH))) {
    fail(`icon missing at ${ICON_PATH}. Regenerate it with \`bun run icon\` (needs ffmpeg).`);
  }

  if (options.skipUi) {
    console.log("package: --skip-ui, using whatever is in ui/dist");
  } else {
    console.log("package: building the UI bundle");
    await run(["bun", "run", "--filter", "@vrcz/ui", "build"], "ui build");
  }

  // A missing bundle would otherwise compile cleanly into an exe that serves the "UI not built"
  // placeholder — a shippable-looking binary with no app in it.
  if (!existsSync(join(ROOT, UI_DIST, "index.html"))) {
    fail(`no UI bundle at ${UI_DIST}/index.html — run without --skip-ui`);
  }

  const outfile = resolve(ROOT, options.outfile);
  await mkdir(join(outfile, ".."), { recursive: true });

  console.log(`package: compiling ${options.target}`);
  await run(
    [
      "bun",
      "build",
      "--compile",
      `--target=${options.target}`,
      // Bun names the embedded files after the asset directory itself, so these arrive as
      // `dist/…` whatever the path here looks like. See EMBEDDED_UI_PREFIX in @vrcz/shared.
      `--asset=${UI_DIST}`,
      `--outfile=${outfile}`,
      `--windows-icon=${ICON_PATH}`,
      `--windows-title=${APP_NAME} (UNOFFICIAL)`,
      `--windows-publisher=${APP_NAME}`,
      `--windows-version=${windowsVersion(APP_VERSION)}`,
      // The disclaimer belongs on the file properties too, not only in the UI: this is the one
      // piece of the app someone can be handed without ever seeing a screen of ours.
      `--windows-description=${APP_NAME} — VRChat companion daemon. UNOFFICIAL, not affiliated with VRChat Inc.`,
      "--windows-copyright=GPL-3.0-or-later. Not affiliated with VRChat Inc.",
      join("daemon", "src", "index.ts"),
    ],
    "bun build --compile",
  );

  const { size } = await stat(outfile);
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(outfile).bytes())
    .digest("hex");

  console.log("");
  console.log(`package: ${relative(ROOT, outfile)}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`package: sha256 ${digest}`);
}

if (import.meta.main) await main();
