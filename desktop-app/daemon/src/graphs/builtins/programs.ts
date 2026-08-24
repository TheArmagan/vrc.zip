/**
 * Starting things on this computer: VRChat, and anything else.
 *
 * The palette could already open a *link* and show an instance in a client that was running. It
 * could not start the client, which is the first half of half the automations somebody actually
 * wants — "when my shift ends, launch VRChat in desktop mode with OSC on" is two nodes and one of
 * them did not exist.
 *
 * ## The launch options are rows, not thirty checkboxes
 *
 * VRChat documents about a dozen options and Unity another eighteen that are not `-force-*`, which
 * is past {@link MAX_NODE_CONFIG_FIELDS} before the node has a path field. So they are one `options`
 * field: pick from a catalogue that documents itself, fill in a value where the option takes one.
 * The catalogue lives in the definition and is not hashed, so an option VRChat adds next release is
 * a line here and marks nobody's saved graph stale.
 *
 * **The two families join their values differently**, and the rule is read off the option rather
 * than stored beside it: VRChat's own options are `--name=value`, Unity's are `-name value`. That is
 * the actual convention of the two documents, so a catalogue entry is just its flag.
 *
 * ## Running a program is the user's call, and the guards are the ones already there
 *
 * `Open an executable` starts whatever it is pointed at, with the user's own privileges. That is the
 * posture this whole app states rather than hides (PLAN.md §Phase 3 correction 6), and a graph is
 * the user's own document: it rehearses every outbound action until they arm it with a
 * hold-to-confirm gesture, and this node is an outbound action like an invite or a webhook. What
 * this file *does* owe is the mechanical half — an argv array and never a command line, so an
 * argument with a `&&` in it is text rather than a second program. See `os/run-program.ts`.
 */

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import { parseOptionRows } from "@vrcz/plugin-api/nodes";
import type { EventBus } from "../../bus/event-bus.ts";
/*
 * The one thing this file takes from `os/`, and it is a pure string function rather than a
 * capability: the author types a line of arguments into a config box, and one line has to become a
 * list the same way a shell would split it. Everything that actually *starts* something arrives
 * through the seams below, so a test of these nodes cannot launch anything.
 */
import { splitArguments } from "../../os/run-program.ts";
import type { ExecuteContext } from "../types.ts";
import type { BuiltinNode } from "./types.ts";

/* -------------------------------------------------------------------------------------------- */
/* The seams                                                                                      */
/* -------------------------------------------------------------------------------------------- */

export interface GraphProgramResult {
  readonly started: boolean;
  readonly pid: number | null;
  readonly reason?: string;
}

/**
 * Starting a program, as the graph runtime needs it.
 *
 * Structurally satisfied by `os/run-program.ts`'s `runProgram`, which never rejects and answers with
 * whether the process started. Injected rather than imported for the reason every other OS seam here
 * is: `graphs/` does not reach into `os/`, and a test must not be able to launch anything.
 */
export type GraphRunProgram = (request: {
  readonly path: string;
  readonly args: readonly string[];
  readonly directory?: string | undefined;
}) => Promise<GraphProgramResult>;

/** Asking Steam to run one of its apps. Satisfied by `openSteamUrl` over `steamRunUrl`. */
export type GraphRunSteamApp = (
  appId: string,
  args: readonly string[],
) => Promise<GraphProgramResult>;

export interface ProgramDeps {
  readonly bus: EventBus;
  /** Absent leaves both nodes in the palette failing with a sentence, like the other OS nodes. */
  readonly run?: GraphRunProgram | undefined;
  readonly steam?: GraphRunSteamApp | undefined;
  readonly now?: () => number;
}

/* -------------------------------------------------------------------------------------------- */
/* Shared plumbing                                                                                */
/* -------------------------------------------------------------------------------------------- */

const CATEGORY = "Send";

/** VRChat on Steam. Named here because this is the node that knows it. */
const VRCHAT_APP_ID = "438100";

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value) ?? "";
  return String(value);
}

function configText(config: NodeConfigValues, key: string): string {
  const raw = config[key];
  return typeof raw === "string" ? raw.trim() : "";
}

/** The same rehearsal note every other action writes. See `actions.ts`. */
function rehearse(deps: ProgramDeps, context: ExecuteContext, what: string): void {
  deps.bus.emit({
    kind: "graph.note",
    accountId: context.accountId,
    ts: (deps.now ?? Date.now)(),
    subjectId: context.graphId,
    payload: { graphId: context.graphId, node: context.nodeId, dryRun: true, note: what },
  });
}

/* -------------------------------------------------------------------------------------------- */
/* The launch option catalogue                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * Every documented launch option that is not a `-force-*` one.
 *
 * The `-force-*` family is left out deliberately: it overrides the graphics API and the device, it
 * is the fastest way to make a client that will not start, and a graph is a bad place to find that
 * out. Somebody who wants one can type it into the extra arguments, which is the escape hatch for
 * exactly this.
 *
 * `argumentLabel` present means the option takes a value; absent means it is a flag. Which is the
 * only thing the handler needs to know, because the joining rule comes from the flag itself.
 */
const LAUNCH_OPTIONS: readonly {
  value: string;
  label: string;
  argumentLabel?: string;
  placeholder?: string;
  group?: string;
}[] = [
  // VRChat's own, from docs.vrchat.com/docs/launch-options.
  { value: "--no-vr", label: "Desktop mode, no VR", group: "VRChat" },
  {
    value: "--profile",
    label: "Profile (a second signed-in account)",
    argumentLabel: "Number",
    placeholder: "1",
    group: "VRChat",
  },
  {
    value: "--fps",
    label: "Frame rate cap (0 uncaps it)",
    argumentLabel: "Frames",
    placeholder: "90",
    group: "VRChat",
  },
  {
    value: "--affinity",
    label: "Pin to these CPU cores",
    argumentLabel: "Hex mask",
    placeholder: "FF",
    group: "VRChat",
  },
  {
    value: "--osc",
    label: "OSC ports",
    argumentLabel: "in:ip:out",
    placeholder: "9001:127.0.0.1:9000",
    group: "VRChat",
  },
  {
    value: "--midi",
    label: "MIDI device",
    argumentLabel: "Device",
    placeholder: "device-name",
    group: "VRChat",
  },
  { value: "--enable-debug-gui", label: "Debug menus", group: "VRChat" },
  { value: "--enable-sdk-log-levels", label: "SDK log levels", group: "VRChat" },
  { value: "--enable-udon-debug-logging", label: "Udon debug logging", group: "VRChat" },
  { value: "--watch-worlds", label: "Reload a world as it changes (SDK)", group: "VRChat" },
  { value: "--watch-avatars", label: "Reload an avatar as it changes (SDK)", group: "VRChat" },
  { value: "--enable-hw-video-decoding", label: "Hardware video decoding on", group: "VRChat" },
  { value: "--disable-hw-video-decoding", label: "Hardware video decoding off", group: "VRChat" },

  // Unity's, from docs.unity3d.com/Manual/PlayerCommandLineArguments.html, minus `-force-*`.
  {
    value: "-screen-width",
    label: "Window width",
    argumentLabel: "Pixels",
    placeholder: "1920",
    group: "Unity",
  },
  {
    value: "-screen-height",
    label: "Window height",
    argumentLabel: "Pixels",
    placeholder: "1080",
    group: "Unity",
  },
  {
    value: "-screen-fullscreen",
    label: "Full screen (1) or windowed (0)",
    argumentLabel: "0 or 1",
    placeholder: "0",
    group: "Unity",
  },
  {
    value: "-screen-quality",
    label: "Quality level, by name",
    argumentLabel: "Name",
    placeholder: "Beautiful",
    group: "Unity",
  },
  {
    value: "-monitor",
    label: "Which monitor (1 is the first)",
    argumentLabel: "Number",
    placeholder: "1",
    group: "Unity",
  },
  { value: "-popupwindow", label: "A window with no frame", group: "Unity" },
  {
    value: "-window-mode",
    label: "Full-screen window mode",
    argumentLabel: "Mode",
    placeholder: "borderless",
    group: "Unity",
  },
  {
    value: "-logFile",
    label: "Write the log here",
    argumentLabel: "Path",
    placeholder: "C:\\logs\\vrchat.log",
    group: "Unity",
  },
  { value: "-nolog", label: "Write no log at all", group: "Unity" },
  { value: "-single-instance", label: "Refuse a second copy", group: "Unity" },
  { value: "-disable-gpu-skinning", label: "GPU skinning off", group: "Unity" },
  { value: "-no-stereo-rendering", label: "Stereo rendering off", group: "Unity" },
  { value: "-batchmode", label: "No interface at all", group: "Unity" },
  { value: "-nographics", label: "No graphics device", group: "Unity" },
  { value: "-systemallocator", label: "The system memory allocator", group: "Unity" },
  { value: "-disable-assembly-updater", label: "Skip the assembly updater", group: "Unity" },
  {
    value: "-parentHWND",
    label: "Embed in this window",
    argumentLabel: "Handle",
    placeholder: "0",
    group: "Unity",
  },
  {
    value: "-vrmode",
    label: "Start in this VR device (deprecated)",
    argumentLabel: "Device",
    placeholder: "None",
    group: "Unity",
  },
];

/** Which of them take a value, so the handler knows whether to join one on. */
const TAKES_VALUE = new Set(
  LAUNCH_OPTIONS.filter((option) => option.argumentLabel !== undefined).map(
    (option) => option.value,
  ),
);

/**
 * The rows, as argv.
 *
 * The joining rule is read off the flag rather than stored: `--name=value` is what VRChat's own
 * options take, `-name value` is what Unity's do, and the leading dashes say which document an
 * option came out of. An option this build does not recognise is passed through under the same rule,
 * because the catalogue is not hashed and a graph authored against a newer release is allowed to
 * name something newer — dropping it would quietly change what the author asked for.
 *
 * A row with no option at all is skipped: the editor adds one before anything is chosen.
 */
export function launchArguments(config: NodeConfigValues, field: string): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const row of parseOptionRows(config[field])) {
    const flag = row.option.trim();
    if (flag === "" || seen.has(flag)) continue;
    seen.add(flag);
    const value = row.value.trim();
    // A known flag with no value is the flag alone. A known *valued* option with nothing filled in
    // is skipped rather than sent bare: `--fps=` is not what "I have not decided yet" means.
    if (value === "") {
      if (TAKES_VALUE.has(flag)) continue;
      args.push(flag);
      continue;
    }
    if (flag.startsWith("--")) {
      args.push(`${flag}=${value}`);
      continue;
    }
    args.push(flag, value);
  }
  return args;
}

/* -------------------------------------------------------------------------------------------- */
/* The definitions                                                                                */
/* -------------------------------------------------------------------------------------------- */

const OPEN_VRCHAT: NodeDefinition = {
  id: "open-vrchat",
  kind: "action",
  title: "Open VRChat",
  description: "Starts the client, through Steam or straight from the executable.",
  category: CATEGORY,
  inputs: [
    {
      id: "arguments",
      label: "Extra arguments",
      type: "string",
      description: "Added after the ones below. One line, quotes group.",
    },
    {
      id: "path",
      label: "Program",
      type: "string",
      description: "Overrides the path below. Ignored when this is going through Steam.",
    },
  ],
  outputs: [
    {
      id: "started",
      label: "Started",
      type: "boolean",
      description:
        "That the launch was handed over. Through Steam that is all anybody can know: Steam decides what happens next.",
    },
    {
      id: "pid",
      label: "Process",
      type: "number",
      description: "What was started. Zero for a Steam launch, where the client is Steam's child.",
    },
  ],
  config: [
    {
      kind: "select",
      id: "via",
      label: "Start it",
      default: "steam",
      description:
        "Steam is the one to pick if VRChat was installed through it: it sets the overlay and the account up the way the client expects.",
      options: [
        { value: "steam", label: "through Steam" },
        { value: "executable", label: "from the executable" },
      ],
    },
    {
      kind: "text",
      id: "path",
      label: "Program",
      placeholder: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\VRChat\\launch.exe",
      description:
        "Used when this is not going through Steam. `launch.exe` is VRChat's own launcher and picks VR or desktop; `VRChat.exe` is the client itself.",
    },
    {
      kind: "options",
      id: "options",
      label: "Launch options",
      max: LAUNCH_OPTIONS.length,
      description:
        "VRChat's own options and Unity's, as documented. The -force- ones are left out on purpose: they override the graphics device and a graph is a bad place to discover a client that will not start. Type one into the extra arguments if you want it.",
      choices: LAUNCH_OPTIONS,
    },
    {
      kind: "text",
      id: "extra",
      label: "Extra arguments",
      placeholder: "--enable-debug-gui",
      description:
        "Anything not in the list. One line, split the way a shell would split it: quotes group, and nothing else is interpreted.",
    },
  ],
  body: [{ kind: "literal", text: "open VRChat" }],
};

const OPEN_STEAM_APP: NodeDefinition = {
  id: "open-steam-app",
  kind: "action",
  title: "Open a Steam app",
  description: "Asks Steam to launch one of its apps, by id.",
  category: CATEGORY,
  inputs: [
    {
      id: "appId",
      label: "App",
      type: "string",
      description: "Overrides the id below, for a graph that works out which app to start.",
    },
    {
      id: "arguments",
      label: "Arguments",
      type: "string",
      description: "Added after the ones below. One line, quotes group.",
    },
  ],
  outputs: [
    {
      id: "started",
      label: "Started",
      type: "boolean",
      description:
        "That Steam was handed the link. Whether it starts the app, asks to install it, or does nothing is Steam's decision and this cannot see it.",
    },
  ],
  config: [
    {
      kind: "text",
      id: "appId",
      label: "App id",
      placeholder: "438100",
      description:
        "The number in the app's Steam store URL. 438100 is VRChat, which has a node of its own.",
      required: true,
    },
    {
      kind: "text",
      id: "arguments",
      label: "Arguments",
      placeholder: "--no-vr",
      description:
        "Passed on to the app. One line, split the way a shell would split it, then encoded into the steam:// link.",
    },
  ],
  body: [
    { kind: "literal", text: "steam app " },
    { kind: "config", field: "appId", fallback: "?" },
  ],
};

const OPEN_EXECUTABLE: NodeDefinition = {
  id: "open-executable",
  kind: "action",
  title: "Open an executable",
  description: "Runs a program on this computer, with whatever arguments you give it.",
  category: CATEGORY,
  inputs: [
    {
      id: "path",
      label: "Program",
      type: "string",
      description: "Overrides the path below, for a graph that works out what to run.",
    },
    {
      id: "arguments",
      label: "Arguments",
      type: "string",
      description: "Added after the ones below. One line, quotes group.",
    },
  ],
  outputs: [
    {
      id: "started",
      label: "Started",
      type: "boolean",
      description: "That the process started. What it then does is its own business.",
    },
    { id: "pid", label: "Process", type: "number" },
  ],
  config: [
    {
      kind: "text",
      id: "path",
      label: "Program",
      placeholder: "C:\\Windows\\System32\\notepad.exe",
      description: "The executable. A bare name is looked up on this machine's PATH.",
      required: true,
    },
    {
      kind: "text",
      id: "arguments",
      label: "Arguments",
      placeholder: '--flag "a value"',
      description:
        "One line, split the way a shell would split it: quotes group, a backslash escapes a quote, and nothing else is interpreted. No wildcards, no variables, and no operators — every argument reaches the program as text.",
    },
    {
      kind: "text",
      id: "directory",
      label: "Start it in",
      placeholder: "C:\\Users\\me\\project",
      description: "The working directory. Left blank, it inherits vrc.zip's own.",
    },
  ],
  body: [
    { kind: "literal", text: "run " },
    { kind: "config", field: "path", fallback: "a program" },
  ],
};

/* -------------------------------------------------------------------------------------------- */
/* Execution                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * A failed launch throws rather than answering false, which is the opposite of what `Open a link`
 * does and is deliberate.
 *
 * A link has one plausible failure and nothing useful to say about it. A path has several — it is
 * not there, it is a directory, it is not runnable — and the sentence naming which is the entire
 * value of the answer. Thrown, it reaches the `error` port on the node, which is the mechanism this
 * whole palette uses for "tell me when this breaks", and it stops a graph that was about to carry on
 * as though the program were running. `Started` then means what it says.
 */
function failure(path: string, result: GraphProgramResult): Error {
  const named = path === "" ? "the program" : `"${path}"`;
  return new Error(
    result.reason === undefined
      ? `Could not start ${named}.`
      : `Could not start ${named}: ${result.reason}`,
  );
}

export function programNodes(deps: ProgramDeps): BuiltinNode[] {
  return [
    {
      definition: OPEN_VRCHAT,
      execute: async (inputs, config, context): Promise<PortValues> => {
        const via = configText(config, "via") || "steam";
        const steam = via === "steam";
        const path = text(inputs.path).trim() || configText(config, "path");
        const args = [
          ...launchArguments(config, "options"),
          ...splitArguments(configText(config, "extra")),
          ...splitArguments(text(inputs.arguments)),
        ];

        // Checked before the rehearsal rather than after it. The rehearsal is what somebody reads
        // at the hold-to-confirm gesture that arms the graph, so a run that cannot happen must not
        // rehearse as though it could: "open VRChat from (no path)" used to read like a plan.
        if (!steam && path === "") {
          throw new Error("Say where VRChat is, or start it through Steam.");
        }

        if (context.dryRun) {
          const how = steam ? "through Steam" : `from ${path}`;
          rehearse(deps, context, `open VRChat ${how}: ${args.join(" ").slice(0, 200)}`);
          return { started: false, pid: 0 };
        }

        if (steam) {
          if (deps.steam === undefined) throw new Error("This daemon cannot start programs.");
          const result = await deps.steam(VRCHAT_APP_ID, args);
          if (!result.started) throw failure("Steam", result);
          // Steam's own child, not ours: the pid we could report is the one that handed the URL
          // over and exited, which would be a lie dressed as a number.
          return { started: true, pid: 0 };
        }

        if (deps.run === undefined) throw new Error("This daemon cannot start programs.");
        const result = await deps.run({ path, args });
        if (!result.started) throw failure(path, result);
        return { started: true, pid: result.pid ?? 0 };
      },
    },
    {
      definition: OPEN_STEAM_APP,
      execute: async (inputs, config, context): Promise<PortValues> => {
        const appId = text(inputs.appId).trim() || configText(config, "appId");
        const args = [
          ...splitArguments(configText(config, "arguments")),
          ...splitArguments(text(inputs.arguments)),
        ];

        // Digits only, and this is a guard rather than tidiness: the id is interpolated into a URL
        // that the operating system's protocol handler parses. Anything else in it is somebody
        // else's parser being handed a caller-chosen string, which is where a link becomes an
        // injection. The arguments beside it are encoded for the same reason.
        //
        // Ahead of the dry-run branch, because a rehearsal is what a graph is armed on the strength
        // of: rehearsing an id this node will refuse is rehearsing a different node.
        if (!/^\d+$/.test(appId)) {
          throw new Error(`"${appId}" is not a Steam app id. They are numbers, like 438100.`);
        }

        if (context.dryRun) {
          rehearse(deps, context, `open steam app ${appId}: ${args.join(" ").slice(0, 200)}`);
          return { started: false };
        }

        if (deps.steam === undefined) throw new Error("This daemon cannot start programs.");
        const result = await deps.steam(appId, args);
        if (!result.started) throw failure(`Steam app ${appId}`, result);
        return { started: true };
      },
    },
    {
      definition: OPEN_EXECUTABLE,
      execute: async (inputs, config, context): Promise<PortValues> => {
        const path = text(inputs.path).trim() || configText(config, "path");
        const directory = configText(config, "directory");
        const args = [
          ...splitArguments(configText(config, "arguments")),
          ...splitArguments(text(inputs.arguments)),
        ];

        // Before the rehearsal: `run ` with nothing after it is not a plan anybody can approve.
        if (path === "") throw new Error("Say which program to run.");

        if (context.dryRun) {
          const listed = args.length === 0 ? "" : ` ${args.join(" ")}`;
          rehearse(deps, context, `run ${path}${listed}`.slice(0, 200));
          return { started: false, pid: 0 };
        }

        if (deps.run === undefined) throw new Error("This daemon cannot start programs.");
        const result = await deps.run({
          path,
          args,
          ...(directory === "" ? {} : { directory }),
        });
        if (!result.started) throw failure(path, result);
        return { started: true, pid: result.pid ?? 0 };
      },
    },
  ];
}
