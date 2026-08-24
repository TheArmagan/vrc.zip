/**
 * Starting a program on this machine, for the graph nodes that launch things.
 *
 * ## The one rule
 *
 * **An argv array, and never a shell.** A path with a space in it, an argument with a quote in it,
 * and an argument somebody typed a `&&` into are all just characters. The moment this reached a
 * shell — `cmd /c`, `sh -c` — every argument would become executable text, and the arguments here
 * are typed into a graph that gets exported, shared and imported again.
 *
 * Off Windows that is `Bun.spawn`, which takes the list as a list. On Windows the launch goes
 * through `os/detached.ts` so it can outlive the daemon, and `CreateProcessW` takes a command line
 * rather than an argv — so the list is joined with `CommandLineToArgvW`'s quoting rules, which the
 * child then un-joins into the same list. Still no shell anywhere: nothing expands `%VAR%`, nothing
 * acts on `&&`, nothing globs.
 *
 * That is also why {@link splitArguments} exists rather than `value.split(" ")`. The author types one
 * line, and one line has to become a list the same way a shell would split it, quotes included,
 * *without* any of a shell's other behaviour: no globbing, no variable expansion, no operators.
 *
 * ## What this does not decide
 *
 * Whether running the program is a good idea. A graph is the user's own document and its outbound
 * actions are armed behind a hold-to-confirm gesture, exactly like a webhook or an invite; until
 * then every action rehearses instead. That posture is the whole answer here, and it is the same one
 * PLAN.md §Phase 3 correction 6 states for plugins: this app runs the user's automations with the
 * user's own privileges and says so, rather than pretending to a sandbox it does not have.
 *
 * Best-effort in the same way every other opener in `os/` is: a missing executable, a path that is a
 * directory, a machine that refuses the launch — all normal, none of them a reason to reject. The
 * result says whether the process started, never that it did anything useful.
 */

import { startDetached } from "./detached.ts";
import { openerArgv } from "./open-url.ts";

/** VRChat on Steam. The one app id this file knows, because it is the one node that names it. */
export const VRCHAT_STEAM_APP_ID = "438100";

export interface RunProgramRequest {
  /** The executable. Absolute, or anything the OS will resolve on its own PATH. */
  readonly path: string;
  readonly args: readonly string[];
  /** Where to start it. Absent means wherever the daemon happens to be. */
  readonly directory?: string | undefined;
}

export interface RunProgramResult {
  readonly started: boolean;
  /** The child's pid, for a graph that wants to say what it started. Null when nothing started. */
  readonly pid: number | null;
  /** Why not. For the node's error, so "no such file" does not read as "it worked". */
  readonly reason?: string;
}

/**
 * Starts a program and lets go of it.
 *
 * Never awaited, for the reason `openUrl` has: the point of this is to launch something the user
 * will then use for an hour, and awaiting the exit would hold a graph run open for exactly that
 * long. The pid is the only handle a caller gets, which is honest — this is a launcher, not a job
 * runner.
 *
 * **On Windows it goes through `os/detached.ts`, not `Bun.spawn`**, and that is a bug fix rather
 * than a preference: Bun kills its subprocesses when the parent exits, `unref()` included, so a
 * VRChat launched from a graph died the moment somebody quit vrc.zip. "For an hour" is the whole
 * contract of this function, and it was true only for as long as the daemon happened to run.
 *
 * The one rule at the top of this file survives the change. `CreateProcessW` takes a command line
 * rather than an argv, so the list is joined — but joined with `CommandLineToArgvW`'s own quoting
 * rules, which is the inverse of how the child will parse it, and not a shell. Nothing expands a
 * `%VAR%`, nothing acts on an `&&`, nothing globs a `*`. That is the same property `Bun.spawn` has,
 * arrived at by a different route, and `os/detached.ts` owns the quoting so there is one copy of it.
 */
export async function runProgram(request: RunProgramRequest): Promise<RunProgramResult> {
  const path = request.path.trim();
  if (path === "") return { started: false, pid: null, reason: "no program was named" };
  const directory =
    request.directory === undefined || request.directory.trim() === ""
      ? undefined
      : request.directory;

  if (process.platform === "win32") {
    const pid = startDetached({
      path,
      args: request.args,
      ...(directory === undefined ? {} : { directory }),
    });
    return await Promise.resolve(
      pid === null
        ? { started: false, pid: null, reason: `${path} could not be started` }
        : { started: true, pid },
    );
  }

  try {
    const child = Bun.spawn([path, ...request.args], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      // `CREATE_NO_WINDOW`: a daemon that may have no console of its own has none to lend a child.
      windowsHide: true,
      ...(directory === undefined ? {} : { cwd: directory }),
    });
    child.unref();
    return await Promise.resolve({ started: true, pid: child.pid });
  } catch (error) {
    // ENOENT for a path that is not there, EACCES for one that is not runnable. Both are ordinary.
    return { started: false, pid: null, reason: String(error) };
  }
}

/**
 * Hands a `steam://` URL to the operating system, which is how Steam is asked to launch a game.
 *
 * **Not through `cmd /c start`,** which every other opener in this project uses. That one is a
 * shell: it re-parses the command line it is given, so a `&` or a `%name%` inside the URL would be
 * cmd's rather than Steam's — and this URL carries launch options the author typed. `explorer.exe`
 * hands the string to the protocol handler with no parsing in between. The arguments are
 * percent-encoded on top of that, so the belt holds even if the braces go.
 */
export async function openSteamUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<RunProgramResult> {
  if (!url.startsWith("steam://")) {
    return { started: false, pid: null, reason: "not a steam link" };
  }
  const argv = platform === "win32" ? ["explorer.exe", url] : openerArgv(url, platform);
  if (argv === null) {
    return { started: false, pid: null, reason: `no way to open a link on ${platform}` };
  }
  const [command, ...rest] = argv;
  if (command === undefined) return { started: false, pid: null, reason: "empty argv" };
  return await runProgram({ path: command, args: rest });
}

/**
 * The `steam://` URL that runs an app, with arguments where there are any.
 *
 * `steam://run/<id>//<args>/` is the documented form that carries arguments; the bare
 * `steam://run/<id>` is the one for none. The arguments go through `encodeURIComponent` because they
 * are travelling inside a URL that a protocol handler will unpick — a space or a `#` left raw ends
 * the argument list somewhere the author did not mean it to end.
 */
export function steamRunUrl(appId: string, args: readonly string[]): string {
  if (args.length === 0) return `steam://run/${appId}`;
  return `steam://run/${appId}//${encodeURIComponent(args.join(" "))}/`;
}

/**
 * One line of arguments, split the way a person means it.
 *
 * Quotes group, both kinds, and a quote can be escaped with a backslash. Whitespace outside quotes
 * separates. Nothing else happens: no globbing, no `$HOME`, no `%APPDATA%`, no operators — this
 * turns text into a list, and the list is launched as a list, so anything that looks like shell
 * syntax stays a literal character in an argument.
 *
 * An unclosed quote keeps what it has rather than throwing. Somebody is typing, and half a quoted
 * path is an ordinary intermediate state rather than a fault.
 */
export function splitArguments(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === undefined) break;

    if (char === "\\") {
      const next = line[index + 1];
      // Only a quote is escapable. A lone backslash is a path separator on the platform this runs
      // on most, and eating those would turn `C:\Users` into `C:Users`.
      if (next === '"' || next === "'" || next === "\\") {
        current += next;
        started = true;
        index += 1;
        continue;
      }
      current += char;
      started = true;
      continue;
    }

    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      // An empty pair of quotes is a real, empty argument — `--name ""` says so deliberately.
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }

    current += char;
    started = true;
  }

  if (started) args.push(current);
  return args;
}
