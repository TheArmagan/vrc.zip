import { describe, expect, test } from "bun:test";
import type { NodeConfigValues, PortValues } from "@vrcz/plugin-api/nodes";
import { validateNodeDefinition } from "@vrcz/plugin-api/nodes";
import type { BusEvent } from "../../bus/event-bus.ts";
import { EventBus } from "../../bus/event-bus.ts";
import type { ExecuteContext } from "../types.ts";
import { createBuiltinNodes } from "./index.ts";
import { launchArguments, programNodes } from "./programs.ts";

const T0 = 1_700_000_000_000;

interface Started {
  readonly path: string;
  readonly args: readonly string[];
  readonly directory?: string | undefined;
}

interface Harness {
  /** Every program the run started. Never a real process — see the seams. */
  readonly started: Started[];
  /** Every Steam launch the run asked for. */
  readonly steam: { appId: string; args: readonly string[] }[];
  readonly notes: string[];
  run(
    type: string,
    inputs: PortValues,
    config?: NodeConfigValues,
    context?: Partial<ExecuteContext>,
  ): Promise<PortValues>;
}

function harness(options: { canRun?: boolean; fails?: boolean } = {}): Harness {
  const bus = new EventBus();
  const events: BusEvent[] = [];
  const started: Started[] = [];
  const steam: { appId: string; args: readonly string[] }[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  const able = options.canRun !== false;
  const answer = options.fails === true;
  const nodes = createBuiltinNodes({
    bus,
    now: () => T0,
    ...(able
      ? {
          run: async (request) => {
            started.push(request);
            return await Promise.resolve(
              answer
                ? { started: false, pid: null, reason: "no such file" }
                : { started: true, pid: 4242 },
            );
          },
          steam: async (appId, args) => {
            steam.push({ appId, args });
            return await Promise.resolve(
              answer
                ? { started: false, pid: null, reason: "no steam" }
                : { started: true, pid: 0 },
            );
          },
        }
      : {}),
  });

  return {
    started,
    steam,
    get notes() {
      return events
        .filter((event) => event.kind === "graph.note")
        .map((event) => String((event.payload as { note?: unknown }).note));
    },
    run: (type, inputs, config = {}, context = {}) =>
      nodes.execute(`vrcz/${type}`, inputs, config, {
        graphId: "g1",
        runId: "r1",
        nodeId: "n1",
        dryRun: false,
        accountId: "usr_me",
        ...context,
      }),
  };
}

/** The rows as they are stored: a JSON array inside a string, like every repeatable field. */
function options(...list: { option: string; value?: string }[]): NodeConfigValues {
  return {
    options: JSON.stringify(list.map((row) => ({ option: row.option, value: row.value ?? "" }))),
  };
}

describe("the launcher node set", () => {
  const nodes = programNodes({ bus: new EventBus() });

  test("three nodes, all valid definitions a plugin could also have declared", () => {
    expect(nodes.map((node) => node.definition.id)).toEqual([
      "open-vrchat",
      "open-steam-app",
      "open-executable",
    ]);
    for (const node of nodes) {
      const result = validateNodeDefinition(node.definition);
      expect(result.ok, `${node.definition.id}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  test("they are registered as built-ins under the reserved namespace", () => {
    const builtins = createBuiltinNodes({ bus: new EventBus() });
    for (const node of nodes) expect(builtins.has(`vrcz/${node.definition.id}`)).toBe(true);
  });

  test("a set built without a bus has no launchers at all", () => {
    // The rule every action follows: a node that cannot say what it *would* have done is worse
    // than a node that is not offered.
    expect(createBuiltinNodes().has("vrcz/open-executable")).toBe(false);
  });

  test("the catalogue offers no -force- option", () => {
    // Deliberately left out: they override the graphics device, and a graph is a bad place to find
    // out the client will not start. The extra arguments box is the escape hatch.
    const field = nodes[0]?.definition.config?.find((entry) => entry.id === "options");
    expect(field?.kind).toBe("options");
    if (field?.kind !== "options") throw new Error("unreachable");
    expect(field.choices.length).toBeGreaterThan(25);
    expect(field.choices.some((choice) => choice.value.startsWith("-force"))).toBe(false);
  });
});

describe("turning option rows into arguments", () => {
  test("VRChat's options join with an equals sign and Unity's with a space", () => {
    // The rule is read off the flag rather than stored beside it: that is the actual convention of
    // the two documents the catalogue came out of.
    expect(
      launchArguments(
        options({ option: "--fps", value: "90" }, { option: "-monitor", value: "2" }),
        "options",
      ),
    ).toEqual(["--fps=90", "-monitor", "2"]);
  });

  test("a flag is the flag alone", () => {
    expect(
      launchArguments(options({ option: "--no-vr" }, { option: "-popupwindow" }), "options"),
    ).toEqual(["--no-vr", "-popupwindow"]);
  });

  test("an option that takes a value and has none is skipped, not sent bare", () => {
    // `--fps=` is not what "I have not decided yet" means, and the editor adds a row before there
    // is anything in it.
    expect(launchArguments(options({ option: "--fps" }, { option: "--no-vr" }), "options")).toEqual(
      ["--no-vr"],
    );
  });

  test("an option this build does not know is passed through under the same rule", () => {
    // The catalogue is not hashed, so a graph authored against a newer release names newer options.
    // Dropping them would quietly change what the author asked for.
    expect(
      launchArguments(
        options({ option: "--brand-new", value: "7" }, { option: "-newer" }),
        "options",
      ),
    ).toEqual(["--brand-new=7", "-newer"]);
  });

  test("the same option twice keeps the first, and a blank row contributes nothing", () => {
    expect(
      launchArguments(
        options({ option: "--fps", value: "60" }, { option: "--fps", value: "90" }, { option: "" }),
        "options",
      ),
    ).toEqual(["--fps=60"]);
  });

  test("nonsense in the field is no arguments rather than a failed run", () => {
    expect(launchArguments({ options: "not json" }, "options")).toEqual([]);
    expect(launchArguments({}, "options")).toEqual([]);
  });
});

describe("Open VRChat", () => {
  test("through Steam it hands the app id and the arguments over", async () => {
    const h = harness();
    const result = await h.run(
      "open-vrchat",
      {},
      {
        ...options({ option: "--no-vr" }, { option: "--fps", value: "90" }),
        extra: "--enable-debug-gui",
      },
    );
    expect(result).toEqual({ started: true, pid: 0 });
    expect(h.steam[0]).toEqual({
      appId: "438100",
      args: ["--no-vr", "--fps=90", "--enable-debug-gui"],
    });
    expect(h.started).toHaveLength(0);
  });

  test("from the executable it spawns the path, with the same arguments", async () => {
    const h = harness();
    const result = await h.run(
      "open-vrchat",
      {},
      { via: "executable", path: "C:\\VRChat\\launch.exe", ...options({ option: "--no-vr" }) },
    );
    expect(result).toEqual({ started: true, pid: 4242 });
    expect(h.started[0]).toEqual({ path: "C:\\VRChat\\launch.exe", args: ["--no-vr"] });
    expect(h.steam).toHaveLength(0);
  });

  test("a wired path overrides the one in the config", async () => {
    const h = harness();
    await h.run(
      "open-vrchat",
      { path: "D:\\other\\VRChat.exe" },
      { via: "executable", path: "C:\\VRChat\\launch.exe" },
    );
    expect(h.started[0]?.path).toBe("D:\\other\\VRChat.exe");
  });

  test("wired arguments come after the configured ones", async () => {
    const h = harness();
    await h.run(
      "open-vrchat",
      { arguments: '--osc=9001:127.0.0.1:9000 --midi "my device"' },
      { ...options({ option: "--no-vr" }), extra: "--fps=90" },
    );
    expect(h.steam[0]?.args).toEqual([
      "--no-vr",
      "--fps=90",
      "--osc=9001:127.0.0.1:9000",
      "--midi",
      "my device",
    ]);
  });

  test("the executable with no path says which half is missing", async () => {
    const h = harness();
    await expect(h.run("open-vrchat", {}, { via: "executable" })).rejects.toThrow(
      /Say where VRChat is/,
    );
    expect(h.started).toHaveLength(0);
  });

  test("a rehearsal says what it would have done and starts nothing", async () => {
    const h = harness();
    const result = await h.run("open-vrchat", {}, options({ option: "--no-vr" }), { dryRun: true });
    expect(result).toEqual({ started: false, pid: 0 });
    expect(h.steam).toHaveLength(0);
    expect(h.started).toHaveLength(0);
    expect(h.notes[0]).toContain("open VRChat through Steam");
    expect(h.notes[0]).toContain("--no-vr");
  });

  test("a rehearsal with no path says which half is missing, rather than rehearsing (no path)", async () => {
    const h = harness();
    await expect(h.run("open-vrchat", {}, { via: "executable" }, { dryRun: true })).rejects.toThrow(
      /Say where VRChat is/,
    );
    expect(h.notes).toHaveLength(0);
  });

  test("a launch that failed throws the reason rather than answering false", async () => {
    // A path has several ways to be wrong and the sentence naming which is the whole value of the
    // answer. Thrown, it reaches the node's error port; false would be a graph carrying on.
    const h = harness({ fails: true });
    await expect(
      h.run("open-vrchat", {}, { via: "executable", path: "C:\\nope.exe" }),
    ).rejects.toThrow(/Could not start "C:\\nope.exe": no such file/);
  });

  test("a build that cannot start programs says so", async () => {
    const h = harness({ canRun: false });
    await expect(h.run("open-vrchat", {}, {})).rejects.toThrow(/cannot start programs/);
  });
});

describe("Open a Steam app", () => {
  test("it launches by id, with arguments", async () => {
    const h = harness();
    const result = await h.run("open-steam-app", {}, { appId: "620", arguments: "-novid" });
    expect(result).toEqual({ started: true });
    expect(h.steam[0]).toEqual({ appId: "620", args: ["-novid"] });
  });

  test("a wired id overrides the configured one", async () => {
    const h = harness();
    await h.run("open-steam-app", { appId: "440" }, { appId: "620" });
    expect(h.steam[0]?.appId).toBe("440");
  });

  test("anything that is not a number is refused before it reaches a URL", async () => {
    // The id is interpolated into a link the operating system parses, which is somebody else's
    // parser being handed a caller-chosen string.
    const h = harness();
    for (const appId of ["", "620&calc", "../../x", "vrchat"]) {
      await expect(h.run("open-steam-app", {}, { appId })).rejects.toThrow(/Steam app id/);
    }
    expect(h.steam).toHaveLength(0);
  });

  test("a rehearsal refuses an id the real run would refuse", async () => {
    // Same rule as the executable: the guard belongs ahead of the dry-run branch, or the evidence
    // the graph is armed on is evidence about a different node.
    const h = harness();
    await expect(
      h.run("open-steam-app", {}, { appId: "620&calc" }, { dryRun: true }),
    ).rejects.toThrow(/Steam app id/);
    expect(h.notes).toHaveLength(0);
  });

  test("a rehearsal starts nothing", async () => {
    const h = harness();
    const result = await h.run("open-steam-app", {}, { appId: "620" }, { dryRun: true });
    expect(result).toEqual({ started: false });
    expect(h.steam).toHaveLength(0);
    expect(h.notes[0]).toContain("open steam app 620");
  });
});

describe("Open an executable", () => {
  test("it runs the path with the split arguments and the working directory", async () => {
    const h = harness();
    const result = await h.run(
      "open-executable",
      {},
      {
        path: "C:\\Windows\\notepad.exe",
        arguments: '--open "C:\\Program Files\\a b.txt"',
        directory: "C:\\work",
      },
    );
    expect(result).toEqual({ started: true, pid: 4242 });
    expect(h.started[0]).toEqual({
      path: "C:\\Windows\\notepad.exe",
      args: ["--open", "C:\\Program Files\\a b.txt"],
      directory: "C:\\work",
    });
  });

  test("nothing in the arguments is interpreted as a second command", async () => {
    // The property the whole file exists to keep: every argument reaches the program as text.
    const h = harness();
    await h.run("open-executable", {}, { path: "a.exe", arguments: "&& calc.exe | tee $HOME" });
    expect(h.started[0]?.args).toEqual(["&&", "calc.exe", "|", "tee", "$HOME"]);
  });

  test("a wired path and wired arguments both apply", async () => {
    const h = harness();
    await h.run(
      "open-executable",
      { path: "b.exe", arguments: "--from-graph" },
      { path: "a.exe", arguments: "--from-config" },
    );
    expect(h.started[0]).toEqual({ path: "b.exe", args: ["--from-config", "--from-graph"] });
  });

  test("no path at all says so rather than spawning something", async () => {
    const h = harness();
    await expect(h.run("open-executable", {}, {})).rejects.toThrow(/Say which program to run/);
    expect(h.started).toHaveLength(0);
  });

  test("a rehearsal of a run that cannot happen says so instead of rehearsing it", async () => {
    // The rehearsal is what somebody reads at the hold-to-confirm gesture that arms the graph, so a
    // node that will refuse itself has to refuse now: "run " with nothing after it read like a plan.
    const h = harness();
    await expect(h.run("open-executable", {}, {}, { dryRun: true })).rejects.toThrow(
      /Say which program to run/,
    );
    expect(h.notes).toHaveLength(0);
    expect(h.started).toHaveLength(0);
  });

  test("a rehearsal says what it would have run", async () => {
    const h = harness();
    const result = await h.run(
      "open-executable",
      {},
      { path: "a.exe", arguments: "--x" },
      { dryRun: true },
    );
    expect(result).toEqual({ started: false, pid: 0 });
    expect(h.started).toHaveLength(0);
    expect(h.notes[0]).toBe("run a.exe --x");
  });
});
