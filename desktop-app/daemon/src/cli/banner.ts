/**
 * What the console says: the banner, the startup summary, `--help`, and `--version`.
 *
 * ## Why this is a file rather than a pile of `console.log`s
 *
 * The startup output is the *entire* interface for anyone who double-clicked the executable. It has
 * to carry the launch URL with its token, say plainly that this is unofficial, and bury neither in
 * noise. Keeping the wording in one place is what makes it reviewable as writing rather than as
 * scattered strings.
 *
 * ## Colour
 *
 * **Yellow is the accent**, the same one the UI's UNOFFICIAL badge uses — so the terminal and the
 * app read as one product rather than two things that happen to ship together.
 *
 * `chalk` decides *whether* to colour: it already knows about `NO_COLOR`, `FORCE_COLOR`, dumb
 * terminals and a redirected stdout, and each of those is a rule somebody would otherwise
 * re-derive here and get subtly wrong. What chalk does not do is ask an old Windows `conhost` to
 * interpret escape sequences at all — that is `os/console.ts`, and it runs first.
 *
 * Nothing below uses colour to *carry* meaning. Strip it and every line still says the same thing,
 * which is the property a redirected log needs.
 */

import { APP_NAME, APP_VERSION } from "@vrcz/shared";
import chalk from "chalk";

/**
 * The brand yellow, as a truecolor hex rather than the terminal's own "yellow".
 *
 * `chalk.yellow` is whatever the user's palette says yellow is, which on a lot of themes is a muddy
 * olive and on a few is orange — so the app would be a different colour on every machine. `#f5c454`
 * is the same colour the UI uses, and chalk degrades it on its own: truecolor terminals get it
 * exactly, 256-colour terminals get the nearest, 16-colour terminals get yellow, and a pipe gets
 * nothing.
 */
const BRAND_YELLOW = "#f5c454";
const accent = chalk.hex(BRAND_YELLOW);

/**
 * Turns colour on for a console we allocated ourselves.
 *
 * Chalk decides its level from `process.stdout.isTTY`, and in a GUI-subsystem process that is
 * `undefined` — Bun's stdout was bound before any console existed. Measured: `chalk.level` comes
 * back **0**, so every style is a no-op and the output is plain no matter what the window can do.
 *
 * The window *can* do truecolor: `enableAnsiColour` has already asked it to interpret escapes, and
 * reading the screen buffer back shows the sequences consumed rather than printed. So the level is
 * set by hand, and only on the path where the host is known — never as a blanket `FORCE_COLOR`,
 * which would also paint a pipe somebody is redirecting into a file.
 */
export function forceColour(): void {
  chalk.level = 3;
}

/**
 * The wordmark: VZ, in block characters.
 *
 * Six lines, which is the size at which the mark reads without becoming the thing you scroll past.
 * Drawn with box-drawing characters rather than plain ASCII because the console is written to with
 * `WriteConsoleW` — UTF-16 all the way down — and the default console font renders them; an
 * ASCII-only fallback would be uglier everywhere to protect a raster-font case nobody is in.
 *
 * It prints on every start, including each restart under `bun --watch`. That is the cost of having
 * one, and it is why it is six lines and not sixteen.
 */
export function banner(): string {
  return [
    "",
    accent("  ██╗   ██╗███████╗"),
    accent("  ██║   ██║╚══███╔╝"),
    accent("  ██║   ██║  ███╔╝ "),
    accent("  ╚██╗ ██╔╝ ███╔╝  "),
    accent("   ╚████╔╝ ███████╗"),
    accent("    ╚═══╝  ╚══════╝"),
    "",
    `  ${accent.bold("vrc.zip")} ${chalk.dim(`v${APP_VERSION}`)}`,
    `  ${chalk.dim("VRChat companion daemon.")} ${accent("UNOFFICIAL")} ${chalk.dim("— not affiliated with VRChat Inc.")}`,
    "",
  ].join("\n");
}

export interface StartupUrls {
  readonly uiUrl: string;
  readonly proxyUrl: string;
  readonly controlUrl: string;
  /** Absent when the forward proxy is switched off in settings, or failed to start. */
  readonly forwardProxyUrl?: string | undefined;
  readonly launchUrl: string;
}

/**
 * Every URL the daemon serves, in one block.
 *
 * **One block on purpose.** The forward proxy used to announce itself from inside its own startup
 * path, so its URL appeared several lines above the others, in a different format, before the
 * summary listing everything else — the one screen a user reads had the addresses in two places and
 * neither list was complete. Where a thing is *printed* should follow what it *is*, not which
 * module happened to be constructing itself at the time.
 */
export function startupSummary(urls: StartupUrls): string {
  const rows: [string, string, string][] = [
    ["UI", urls.uiUrl, "the app"],
    ["proxy", urls.proxyUrl, "VRChat API mirror"],
    ["control", urls.controlUrl, "consent, tokens, event stream"],
  ];
  if (urls.forwardProxyUrl !== undefined) {
    rows.push(["forward", urls.forwardProxyUrl, "configure an app with this"]);
  }

  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(
    ([label, url, note]) =>
      `  ${chalk.dim(label.padEnd(width))}  ${url}  ${chalk.dim(`(${note})`)}`,
  );

  return [
    ...lines,
    "",
    // The one line somebody has to act on, so it is the only one that is accented.
    `  ${accent("Open:")} ${urls.launchUrl}`,
    `  ${chalk.dim("That link carries this session's token. Treat it like a password.")}`,
  ].join("\n");
}

/** A note that is an *instruction* rather than an address, so it stays out of the URL block. */
export function note(message: string): string {
  return `  ${chalk.dim(message)}`;
}

/** Something the user has to act on. Accented for the same reason `Open:` is. */
export function attention(message: string): string {
  return `  ${accent(message)}`;
}

export function versionText(): string {
  return `${APP_NAME} ${APP_VERSION}`;
}

/**
 * `--help`.
 *
 * Written for someone who ran the executable expecting a window and got a terminal, so it says what
 * the thing *is* before it lists flags. A usage block opening with `[options]` assumes a reader who
 * already knows.
 */
export function helpText(): string {
  return [
    banner(),
    `  ${chalk.bold("vrc.zip")} runs in the background and serves its interface in your browser.`,
    "  Start it with no arguments and open the link it prints.",
    "",
    `  ${chalk.bold("Usage")}`,
    "    vrc.zip [options]                 start the daemon",
    "    vrc.zip create-plugin <folder>    scaffold a new plugin",
    "    vrc.zip dev <folder>              install a plugin, and reinstall it on every save",
    "",
    `  ${chalk.bold("Options")}`,
    "    --open, --no-open                 open a browser on start, or do not.",
    "                                      Packaged builds open by default; from source they do not.",
    "    --help, -h                        this",
    "    --version, -v                     print the version and exit",
    "",
    `  ${chalk.bold("Environment")}`,
    "    VRCZIP_STATE_DIR                  where credentials, the database and state.json live.",
    "                                      Point it somewhere disposable to try things safely.",
    "    VRCZIP_STABLE_TOKEN=1             keep the session token across restarts",
    "    VRCZIP_PROXY_LOG=basic|headers|body   log what reaches the mirror while debugging an app",
    "    NO_COLOR                          plain output",
    "",
    `  ${chalk.bold("For plugin authors")}`,
    "    vrc.zip create-plugin my-plugin",
    "    cd my-plugin && bun install",
    "    vrc.zip dev .",
    "",
    `  ${chalk.dim("Everything binds to 127.0.0.1. Nothing here listens on a network interface.")}`,
    "",
  ].join("\n");
}
