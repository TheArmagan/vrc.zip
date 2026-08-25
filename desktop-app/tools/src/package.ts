/**
 * Packaging: the whole app as one executable. See PLAN.md §Phase 5.
 *
 * Run with `bun run package` from the workspace root. Output is `dist/vrc.zip.exe` on Windows and
 * `dist/vrc.zip` on Linux — the daemon, the UI bundle, and the Bun runtime in a single file, with
 * the app icon and version metadata on it where the format carries any. Nothing else has to be
 * copied next to it: state lives in `%LOCALAPPDATA%\vrc.zip` or `~/.local/state/vrc.zip`, and the
 * UI is inside the binary rather than in a `ui/dist` a user could delete or a second app could edit.
 *
 * **Windows is the platform this is built for**, and Linux gets the same daemon: accounts,
 * presence, the feed, the log watcher, the API mirror, plugins and the UI are the app, and they are
 * all platform-neutral code that runs there unchanged. What Linux does not get is the Windows shell
 * integration around them — tray icon, toasts, the install offer, Start-menu and autostart entries,
 * the allocated console. Every one of those is already guarded at runtime (`IS_WINDOWS` in
 * `daemon/src/os/*`), so a Linux build drops them instead of failing. Say that plainly in the
 * release notes: the main features are there, the Windows-specific conveniences are not.
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

/**
 * Cross-compilation targets Bun understands. The release publishes the two x64 ones; the rest are
 * here because Bun can produce them and somebody on that machine should not have to patch this file
 * to get a binary. An unpublished target is a target nobody has run, which is a different claim from
 * "unsupported" and worth keeping distinct.
 */
const TARGETS = [
  "bun-windows-x64",
  "bun-windows-x64-baseline",
  "bun-linux-x64",
  "bun-linux-x64-baseline",
  "bun-linux-x64-musl",
  "bun-linux-arm64",
  "bun-linux-arm64-musl",
] as const;
type Target = (typeof TARGETS)[number];

/** Whether a target produces a PE binary, which is the only format the `--windows-*` flags fit. */
export function isWindowsTarget(target: string): boolean {
  return target.startsWith("bun-windows-");
}

/**
 * Where the binary lands when `--outfile` is not given.
 *
 * The extension is not cosmetic on either side: Windows will not execute a file without it, and a
 * Linux binary called `vrc.zip.exe` invites everyone who meets it to guess wrong about what it is.
 */
export function defaultOutfile(target: string): string {
  return join("dist", isWindowsTarget(target) ? "vrc.zip.exe" : "vrc.zip");
}

/**
 * The target matching the machine running the build, which is what `bun run package` should mean.
 *
 * Null rather than a fallback where Bun publishes nothing for the host. Silently handing a macOS
 * developer a Windows executable was the old behaviour, and a build that produces a file you cannot
 * run is worse than one that says which `--target` you meant.
 */
export function hostTarget(platform: string, arch: string): Target | null {
  if (platform === "win32") return arch === "x64" ? "bun-windows-x64" : null;
  if (platform === "linux") {
    if (arch === "x64") return "bun-linux-x64";
    if (arch === "arm64") return "bun-linux-arm64";
  }
  return null;
}

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
  let target: Target | null = null;
  let outfile: string | null = null;
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

  if (target === null) {
    target = hostTarget(process.platform, process.arch);
    if (target === null) {
      fail(
        `no default target for ${process.platform}/${process.arch}. Pass --target=… explicitly. Known: ${TARGETS.join(", ")}`,
      );
    }
  }

  // Resolved after the target, so `--target=bun-linux-x64` alone still writes a sensibly named file
  // rather than an `.exe` that is an ELF binary.
  return { target, outfile: outfile ?? defaultOutfile(target), skipUi };
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

  const windows = isWindowsTarget(options.target);

  // Only Windows carries an icon in the binary. ELF has nowhere to put one — a desktop entry is
  // where a Linux icon would go, and that belongs to a packaging format we do not ship yet.
  if (windows && !existsSync(join(ROOT, ICON_PATH))) {
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
      // Icon, subsystem and version metadata are PE features. Bun rejects these flags outright for
      // a non-Windows target rather than ignoring them, so they are appended, not conditionally
      // blanked — an empty `--windows-icon=` is still an error.
      ...(windows
        ? [
            /*
             * GUI subsystem: no console from Windows, so the app can make its own.
             *
             * A console-subsystem binary gets a window from the user's *default terminal
             * application*, which on Windows 11 is usually Windows Terminal painting it with its
             * default profile — PowerShell's icon and title. Double-clicking vrc.zip looked like
             * opening PowerShell. `daemon/src/os/console.ts` allocates a `conhost` window instead,
             * which takes its icon from this executable, and reroutes output into it.
             *
             * Linux needs none of this: a terminal launch already has a terminal, and a launch from
             * a desktop file has no console to hide.
             */
            "--windows-hide-console",
            `--windows-icon=${ICON_PATH}`,
            `--windows-title=${APP_NAME} (UNOFFICIAL)`,
            `--windows-publisher=${APP_NAME}`,
            `--windows-version=${windowsVersion(APP_VERSION)}`,
            // The disclaimer belongs on the file properties too, not only in the UI: this is the one
            // piece of the app someone can be handed without ever seeing a screen of ours.
            `--windows-description=${APP_NAME} — VRChat companion daemon. UNOFFICIAL, not affiliated with VRChat Inc.`,
            "--windows-copyright=GPL-3.0-or-later. Not affiliated with VRChat Inc.",
          ]
        : []),
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
