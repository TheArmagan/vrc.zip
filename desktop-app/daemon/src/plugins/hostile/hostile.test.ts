/**
 * The hostile suite. PLAN.md §Phase 3 step 3.3 calls this *"the regression suite for everything above
 * it"*, and that sentence is what shapes the file.
 *
 * ## What "against the supervisor" means here
 *
 * Nothing is mocked. Every test in this file:
 *
 *  1. writes a real plugin folder,
 *  2. runs the **real install pipeline** over it — `Bun.build` with the host-builtin resolver, the
 *     deny-scan over the bundled output, content-addressing under a redirected `VRCZIP_STATE_DIR`,
 *  3. records the installed row in a real (in-memory) `Store`,
 *  4. resolves the spawn through the **real `createSpawnResolver`**, which is where "verify the hash
 *     on every load" actually runs, and
 *  5. drives it through a real `PluginRegistry` → `PluginSupervisor` → `ProcessTransport`, which
 *     spawns an actual `bun` process with the real injected prelude.
 *
 * A fake transport would hide every one of the things this file exists to catch: what a wedged event
 * loop does to a heartbeat that lives in the prelude, what an OS memory cap reports through Bun, what
 * the prelude's stdout redirect does to a plugin that tries to forge a frame.
 *
 * ## Assert the *stage*, not the refusal
 *
 * PROGRESS.md §Gotchas is explicit about this after `import("node:" + "fs")` turned out to be caught
 * by the bundler rather than by the scan: "the hostile suite should assert which stage rejected it
 * rather than only that it was rejected". So every attack here names the layer that stops it —
 * `compile`, `deny-scan`, the prelude, the supervisor, the OS — and where **nothing** stops it, the
 * test says so in as many words rather than asserting a boundary that does not exist. A test
 * asserting a boundary that is not there is worse than no test.
 *
 * ## Budgets
 *
 * This runs in CI on every push (decision 165), so every deadline here is deliberately small: a
 * heartbeat every 150ms rather than every 10s, an activation deadline of 700ms rather than 15s, a
 * crash-loop threshold of three rather than five. Restart backoff is set to a minute wherever a
 * restart is not the thing under test, so a killed plugin stays killed for the length of an
 * assertion instead of respawning underneath it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Envelope,
  PLUGIN_API_PROTOCOL_MAJOR,
  type PluginManifestInput,
} from "@vrcz/plugin-api";
import { MEMORY, Store } from "../../store/store.ts";
import type { NewPlugin } from "../../store/types.ts";
import { writeArtifact } from "../install/artifact.ts";
import { type InstallResult, installPluginFromDirectory } from "../install/pipeline.ts";
import { createSpawnResolver } from "../install/spawn-resolver.ts";
import { makeProcessTransportFactory } from "../process-transport.ts";
import { PluginRegistry, type PluginStatus, type PluginRegistry as Registry } from "../registry.ts";
import type { SupervisorNotification, SupervisorOptions } from "../supervisor.ts";

const ATTACKS = import.meta.dir;
const HARNESS = join(ATTACKS, "harness-entry.js");

/**
 * How long a `waitFor` may spend before giving up.
 *
 * Generously above every budget below, because its job is to turn "the property never held" into a
 * named failure rather than into a hung suite — it is not itself a deadline being asserted. A loaded
 * runner spends this in scheduling; the assertions are all on *what the supervisor concluded*, never
 * on how long it took.
 */
const WAIT_MS = 15_000;

/** Bun's own start-up, which is not what any of these tests are measuring. */
const HELLO_MS = 10_000;

let stateRoot: string;
let sourceRoot: string;
let env: NodeJS.ProcessEnv;
let store: Store;
/**
 * Every registry a test built, so `afterEach` can put all of them down.
 *
 * A list rather than one, because more than one test starts two plugins under two registries and a
 * supervisor left beating after the store is closed throws "Database has closed" from a timer — into
 * whichever test happens to be running next, which is a spectacularly misleading place for it.
 */
let live: Registry[];

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "vrczip-hostile-state-"));
  sourceRoot = mkdtempSync(join(tmpdir(), "vrczip-hostile-src-"));
  env = { VRCZIP_STATE_DIR: stateRoot };
  store = Store.open(MEMORY);
  live = [];
});

afterEach(async () => {
  // Killed rather than stopped: half of these plugins cannot answer a graceful stop, which is the
  // point of them, and a suite that waited politely on a spin loop would hang on its own fixtures.
  for (const registry of live) {
    for (const supervisor of registry.running) supervisor.disable("user", "end of test");
  }
  store.close();
  // Windows holds a directory open while it is any live process's cwd, and a process killed a
  // millisecond ago may not be reaped yet. A leftover temp directory is not a test failure.
  await Bun.sleep(20);
  for (const directory of [stateRoot, sourceRoot]) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Building, installing and running one attack
// ---------------------------------------------------------------------------------------------

/**
 * Writes a plugin folder around one attack file.
 *
 * The attack lands as `attack.js` and `harness-entry.js` as `index.js`, which is what makes the
 * attacks one-file-one-attack: the lifecycle plumbing every plugin needs lives in the harness and
 * says nothing about the attack. See `harness-entry.js` for why a harness is needed at all.
 */
function folder(attackFile: string, id: string): string {
  const root = join(sourceRoot, attackFile.replace(/\W+/g, "-"));
  mkdirSync(root, { recursive: true });
  const manifest: PluginManifestInput = {
    id,
    name: attackFile,
    version: "1.0.0",
    publisher: "Hostile",
    main: "index.js",
    engines: { pluginApi: PLUGIN_API_PROTOCOL_MAJOR },
  };
  writeFileSync(join(root, "vrcz-plugin.json"), JSON.stringify(manifest, null, 2));
  copyFileSync(HARNESS, join(root, "index.js"));
  copyFileSync(join(ATTACKS, attackFile), join(root, "attack.js"));
  return root;
}

/** Runs the real pipeline. Returns the result untouched so a test can assert on the stage. */
function install(attackFile: string, id: string): Promise<InstallResult> {
  return installPluginFromDirectory(folder(attackFile, id), { env });
}

/** Installs, and fails the test with the pipeline's own sentence if it refused. */
async function installOrThrow(attackFile: string, id: string): Promise<string> {
  const result = await install(attackFile, id);
  if (!result.ok) {
    throw new Error(`${attackFile} did not install (${result.stage}): ${result.message}`);
  }
  const row: NewPlugin = {
    id,
    version: result.manifest.version,
    manifest: JSON.stringify(result.manifest),
    bundle_hash: result.bundleHash,
    source_kind: "local",
    source_ref: result.sourceRef,
    trust: "unsigned",
    publisher_key: null,
    installed_at: Date.now(),
    updated_at: Date.now(),
  };
  store.upsertPlugin(row);
  return result.bundleHash;
}

interface Run {
  readonly id: string;
  readonly registry: Registry;
  readonly frames: Envelope[];
  readonly logs: { readonly stream: "stdout" | "stderr"; readonly line: string }[];
  readonly notifications: SupervisorNotification[];
  readonly statuses: PluginStatus[];
  /** The supervisor's live status, read through the registry rather than cached. */
  readonly status: () => PluginStatus;
  readonly stderr: () => string;
}

type Tuning = Omit<SupervisorOptions, "pluginId" | "spawn" | "factory" | "disableStore">;

/**
 * The OS-level ceiling every test gets unless it asks for a smaller one.
 *
 * **Deliberately huge, and the reason is Linux.** `createSpawnResolver` hands out
 * `SMOL_MEMORY_LIMIT_BYTES` (100 MiB) — which on Linux is multiplied by
 * `RLIMIT_AS_HEADROOM_FACTOR`, because there it becomes `ulimit -v` against *virtual address space*,
 * which JavaScriptCore reserves gigabytes of without ever touching. Whether `bun --smol` can start
 * under any given figure is a property of the runner rather than of anything under test, so every
 * test that is not about the cap sets it out of the way. The ones that are about it say so.
 *
 * `spawnFor` is where this has to be applied, because `memoryLimitBytes` is a *spawn* option and not
 * a supervisor one — passing it in the supervisor tuning does nothing at all, silently, which is
 * exactly the mistake this comment exists to stop the next person repeating.
 */
const NO_OS_CAP = 8 * 1024 * 1024 * 1024;

/**
 * The RSS watchdog, moved out of the way for the same reason and by the same rule as
 * {@link NO_OS_CAP} — and it has to move *with* it, which is the part worth writing down.
 *
 * JavaScriptCore grows its heap to fill whatever ceiling it is given: the same idle plugin sits at
 * ~45 MiB RSS under the production 100 MiB cap and comfortably past 100 MiB under this 8 GiB one.
 * So raising the OS cap for a test that is not about memory silently raises idle RSS too, and the
 * production watchdog default (80 MiB, deliberately just under the cap) then kills the *control*
 * plugin for growing into space this suite handed it on purpose. That is a test artefact, not a
 * defence firing, and it is exactly the kind of red the suite exists to avoid.
 *
 * Tests that are about the watchdog pass their own `rssLimitBytes` through `tuning` and override it.
 */
const NO_RSS_CAP = 8 * 1024 * 1024 * 1024;

/**
 * The whole stack, for real: install pipeline → store row → spawn resolver → registry → supervisor
 * → `ProcessTransport` → a `bun` process running the injected prelude.
 */
async function launch(
  attackFile: string,
  id: string,
  tuning: Tuning = {},
  memoryLimitBytes: number = NO_OS_CAP,
): Promise<Run> {
  await installOrThrow(attackFile, id);
  return start(id, tuning, memoryLimitBytes);
}

/** The second half of {@link launch}, separately, for the tests that install more than once. */
async function start(
  id: string,
  tuning: Tuning = {},
  memoryLimitBytes: number = NO_OS_CAP,
): Promise<Run> {
  const frames: Envelope[] = [];
  const logs: { stream: "stdout" | "stderr"; line: string }[] = [];
  const notifications: SupervisorNotification[] = [];
  const statuses: PluginStatus[] = [];

  // The real resolver — the bundle path and the hash verification are its answer, and only the OS
  // ceiling is overridden.
  const resolve = createSpawnResolver({ store, env });

  const registry = new PluginRegistry({
    store,
    factory: makeProcessTransportFactory({ env }),
    spawnFor: (pluginId) => {
      const spawn = resolve(pluginId);
      return spawn === null ? null : { ...spawn, memoryLimitBytes };
    },
    supervisor: { helloTimeoutMs: HELLO_MS, rssLimitBytes: NO_RSS_CAP, ...tuning },
    onPluginFrame: (_id, frame) => frames.push(frame),
    onLog: (_id, stream, line) => logs.push({ stream, line }),
    onStatus: (status) => statuses.push(status),
    onNotify: (notification) => notifications.push(notification),
  });
  live.push(registry);

  await registry.start(id);

  return {
    id,
    registry,
    frames,
    logs,
    notifications,
    statuses,
    status: () => {
      const found = registry.statuses().find((entry) => entry.pluginId === id);
      if (found === undefined) throw new Error(`no status for ${id}`);
      return found;
    },
    stderr: () =>
      logs
        .filter((entry) => entry.stream === "stderr")
        .map((entry) => entry.line)
        .join("\n"),
  };
}

/** Polls until `read` returns something, or fails naming what never happened. */
async function waitFor<T>(what: string, read: () => T | null | undefined): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** Waits for the supervisor to reach a verdict about this plugin, and returns it. */
function failure(run: Run) {
  return waitFor(`${run.id} to fail`, () => run.status().lastFailure);
}

/** Waits for a line the plugin logged that contains `needle`. */
function logLine(run: Run, needle: string): Promise<string> {
  return waitFor(
    `${run.id} to log ${needle}`,
    () => run.logs.find((entry) => entry.line.includes(needle))?.line,
  );
}

/**
 * Restart backoff long enough that a killed plugin stays killed for the length of an assertion.
 *
 * Every test below except the crash-loop one is about *one* verdict, and a plugin respawning
 * underneath the assertion would make the suite time-dependent for no gain.
 */
const NO_RESTART: Tuning = { baseBackoffMs: 60_000, maxBackoffMs: 60_000 };

/**
 * Heartbeat budgets, shared by the spin test and by the control.
 *
 * Sharing them is the point: the control is only evidence that the wedge detector is not a blanket
 * killer if it runs under the same detector. 150ms between beats and 120ms to answer detects a
 * wedge in about 750ms, and four consecutive misses is enough slack that a GC pause or a busy runner
 * does not fire it — the pong is answered by the prelude with no plugin code involved at all.
 */
const HEARTBEAT: Tuning = {
  heartbeatIntervalMs: 150,
  pingTimeoutMs: 120,
  maxMissedBeats: 4,
  ...NO_RESTART,
};

// ---------------------------------------------------------------------------------------------
// The attacks
// ---------------------------------------------------------------------------------------------

describe("the spin loop", () => {
  test("a plugin that wedges after activating stops answering, and is killed", async () => {
    const run = await launch("spin.js", "hostile.spin", HEARTBEAT);

    // It gets all the way to healthy first, which is what makes the heartbeat the only thing that
    // can catch it: nothing about a spinning process looks wrong from the outside.
    await waitFor("spin to reach running", () => (run.status().state === "running" ? true : null));

    const verdict = await failure(run);
    expect(verdict.kind).toBe("heartbeat-lost");
    // The echo lives in the prelude, so the miss is evidence about the runtime rather than about
    // the author — a plugin cannot answer a ping it never gets a turn of the loop to read.
    expect(verdict.detail).toContain("not responding");
    expect(run.status().missedBeats).toBeGreaterThanOrEqual(4);
    // Killed, not stopped: "please exit" travels over the loop it is refusing to yield.
    await waitFor("spin to be gone", () =>
      run.registry.get(run.id)?.state === "backoff" ? 1 : null,
    );
  }, 30_000);

  test("a plugin that wedges before activating is caught by the deadline, not the heartbeat", async () => {
    // The distinction is a property of the supervisor: the heartbeat is armed on entering `running`,
    // which is reached by answering `activate`. A plugin that never gets there is never heartbeated.
    const run = await launch("spin-at-load.js", "hostile.spin-at-load", {
      activateTimeoutMs: 700,
      ...HEARTBEAT,
    });

    const verdict = await failure(run);
    expect(verdict.kind).toBe("activate-hung");
    // `hello` is sent by the prelude *before* it imports the bundle, so this is not a hello timeout
    // even though the plugin's own code never ran a single yielding line.
    expect(run.statuses.some((status) => status.state === "activating")).toBe(true);
    expect(run.status().missedBeats).toBe(0);
  }, 30_000);
});

describe("the memory bomb", () => {
  test("the RSS watchdog kills a plugin that eats the machine", async () => {
    // No OS cap in play here (the ceiling is far above the watchdog's), so this is the watchdog
    // alone.
    //
    // **The figure it reads is the `rss` the prelude puts on every pong, and nothing else**, which
    // is worth being precise about because `SupervisorOptions.readRssBytes` describes an OS reading
    // that "always wins" — and no caller in this codebase supplies one. So the watchdog's only
    // input today is the number the measured party chose to send, which is exactly the source its
    // own doc comment says is not to be relied on for a hostile plugin. That is why the budgets here
    // are generous enough for the bomb to keep answering: with tighter ones the *heartbeat* fires
    // first, and the watchdog is never reached at all.
    const run = await launch("memory-bomb.js", "hostile.memory-bomb", {
      heartbeatIntervalMs: 200,
      pingTimeoutMs: 190,
      maxMissedBeats: 6,
      rssLimitBytes: 192 * 1024 * 1024,
      ...NO_RESTART,
    });

    const verdict = await failure(run);
    expect(verdict.kind).toBe("rss-exceeded");
    expect(verdict.detail).toContain("over its");
    expect(run.status().rssBytes).toBeGreaterThan(192 * 1024 * 1024);
  }, 30_000);

  /**
   * The OS cap, which fails the *allocation* rather than noticing afterwards.
   *
   * **Windows only, and that is a real limitation of this suite rather than a preference.** CI runs
   * on `ubuntu-latest`, where the mechanism is `RLIMIT_AS` — a cap on *virtual address space*, and
   * JavaScriptCore reserves gigabytes of address space it never touches. A cap low enough to bite
   * quickly stops `bun` starting at all, and one high enough for `bun` to start needs the bomb to
   * touch multiple gigabytes of real pages on a shared runner. So the assertion that the OS cap
   * kills an over-allocating child is made where it can be made honestly, and its absence in CI is
   * stated rather than papered over with a test that would pass for the wrong reason.
   *
   * The polite control runs under the *same* cap in the same test, so a cap so low that nothing can
   * start fails loudly instead of passing as a kill.
   */
  test.skipIf(process.platform !== "win32")(
    "the Windows Job Object refuses the allocation, and a load-time refusal is a crash",
    async () => {
      const CAP = 192 * 1024 * 1024;

      const control = await launch("polite.js", "hostile.polite-capped", NO_RESTART, CAP);
      await waitFor("the control to run under the cap", () =>
        control.status().state === "running" ? true : null,
      );

      const run = await launch(
        "memory-bomb-at-load.js",
        "hostile.memory-bomb-capped",
        // High enough that the watchdog cannot be what fires: the cap has to be.
        { rssLimitBytes: 8 * 1024 * 1024 * 1024, ...NO_RESTART },
        CAP,
      );

      const verdict = await failure(run);
      // PROGRESS.md §Gotchas: crossing the cap reads as a *crash*, not a kill. The allocation is
      // refused inside the plugin, JSC raises `RangeError: Out of memory`, and the process exits 1
      // on its own — nothing signals it and nothing terminates it. That holds here because the
      // refusal happens during module evaluation, so it rejects the prelude's own `import()`.
      expect(verdict.kind).toBe("crashed");
      expect(verdict.detail).toContain("exit code 1");
      // And the control is still up, so the cap is a ceiling rather than a blanket refusal to run.
      expect(control.status().state).toBe("running");
    },
    45_000,
  );

  /**
   * **The same cap, crossed from a timer callback instead of at load, and it does not read as a
   * crash at all.** PROGRESS.md §Gotchas says "crossing that cap reads as a crash, not a kill … the
   * process exits 1 on its own". That is true only of a refusal during module evaluation, where the
   * rejection lands on the prelude's own `import()`. From a timer the `RangeError: Out of memory` is
   * an *uncaught exception*, and the prelude installs a handler for those deliberately, so that a
   * plugin throwing asynchronously loses that turn rather than the process. Nothing exits.
   *
   * What happens instead, measured: a few `Out of memory` lines reach stderr and then **the process
   * goes catatonic**. It is alive, its loop is not blocked, and it can no longer do anything at all
   * — because at the commit ceiling even the prelude's own pong path cannot allocate the string it
   * would answer with. So it stops logging, stops answering, and never reports another `rss`.
   *
   * The heartbeat is what catches it, and that is a genuinely good outcome: the mechanism written
   * for a spinning event loop also covers a process that has run out of room to think. But it is not
   * the mechanism the Gotcha names, and the RSS watchdog specifically cannot be it — `rssBytes`
   * stays `null` for the whole episode, because the only source of that number is a pong the plugin
   * can no longer produce.
   */
  test.skipIf(process.platform !== "win32")(
    "a refusal after activation is swallowed, and the heartbeat is what catches it",
    async () => {
      const run = await launch(
        "memory-bomb.js",
        "hostile.memory-bomb-swallowed",
        {
          heartbeatIntervalMs: 150,
          pingTimeoutMs: 140,
          maxMissedBeats: 3,
          // Deliberately above the OS cap, so the watchdog cannot be what fires and the question is
          // what is left when it cannot.
          rssLimitBytes: 2 * 1024 * 1024 * 1024,
          ...NO_RESTART,
        },
        192 * 1024 * 1024,
      );

      const verdict = await failure(run);
      expect(verdict.kind).toBe("heartbeat-lost");
      // Read from the recorded history rather than raced against: it activated normally first, so
      // the cap is a ceiling on what it can hold and not a refusal to let it run.
      expect(run.statuses.some((status) => status.state === "running")).toBe(true);
      // Not `crashed`, and not `rss-exceeded`. The watchdog had nothing to read: the only source of
      // an RSS figure in this codebase is the pong, and a process at its commit ceiling cannot send
      // one. `SupervisorOptions.readRssBytes` describes an OS reading that would have covered this,
      // and no caller anywhere supplies one.
      expect(run.status().rssBytes).toBeNull();
    },
    45_000,
  );
});

describe('import("node:" + "fs")', () => {
  test("the literal concatenation is rejected at compile, never reaching the deny-scan", async () => {
    const result = await install("filesystem-folded.js", "hostile.filesystem-folded");
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // The stage is the assertion. PROGRESS.md §Gotchas: Bun constant-folds `"node:" + "fs"` before
    // resolving, so the attack the deny-scan's `dynamic-import` rule was written for never reaches
    // it. The resolver plugin in `bundle.ts` is what makes the promise true, and it fails earlier
    // and names the author's own file — a better failure, but a different one.
    expect(result.stage).toBe("compile");
    expect(result.message).toContain("node:fs");
    expect(result.message).toContain("not available to plugins");
    expect(result.findings).toBeUndefined();
  }, 30_000);

  test("a specifier the bundler cannot fold is rejected one stage later, by the scan", async () => {
    // `["no", "de:", "fs"].join("")` is the same attack past the constant folder, so the compile
    // step sees an ordinary dynamic import and the deny-scan is what refuses it. Two spellings, two
    // layers — which is exactly why "was it rejected" is the wrong assertion to write.
    const result = await install("filesystem.js", "hostile.filesystem");
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.stage).toBe("deny-scan");
    expect(result.findings?.map((finding) => finding.rule)).toContain("dynamic-import");
    expect(result.findings?.[0]?.line).toBeGreaterThan(0);

    // **And that is the *only* finding**, from a file that also builds a function out of a string
    // and reaches for `require`. `const make = Function; make("…")` defeats the
    // `function-constructor` rule, which matches on the callee identifier; `require` appears only
    // inside the string that function would evaluate, and a string is not an identifier. Both routes
    // survive the scan. Asserted so the gap is a recorded fact rather than something rediscovered.
    expect(result.findings?.map((finding) => finding.rule)).not.toContain("function-constructor");
    expect(result.findings?.map((finding) => finding.rule)).not.toContain("require");
  }, 30_000);

  test("nothing behind those two stages stops it, and the suite says so", async () => {
    // Not a defence being asserted — the opposite. The prelude cannot disable the `import()`
    // operator and does not pretend to, so this pins *why* the install-time stages are load-bearing:
    // there is nothing behind them at run time except the process boundary itself. The bundle is
    // written straight to the artifact store, going around the pipeline that would have refused it.
    const source = [
      "const host = globalThis.__vrczHost;",
      "const name = ['no', 'de:', 'fs'].join('');",
      "import(name).then(",
      "  (fs) => host.log('FS-REACHED ' + typeof fs.readFileSync),",
      "  (error) => host.log('FS-REFUSED ' + String(error)),",
      ");",
      "export function activate() { return { reached: true }; }",
      "",
    ].join("\n");

    const bundle = new TextEncoder().encode(source);
    const written = writeArtifact("hostile.smuggled", bundle, env);
    store.upsertPlugin({
      id: "hostile.smuggled",
      version: "1.0.0",
      manifest: JSON.stringify({
        id: "hostile.smuggled",
        name: "smuggled",
        version: "1.0.0",
        publisher: "Hostile",
        main: "index.js",
        engines: { pluginApi: PLUGIN_API_PROTOCOL_MAJOR },
      } satisfies PluginManifestInput),
      bundle_hash: written.hash,
      source_kind: "local",
      source_ref: "smuggled",
      trust: "unsigned",
      publisher_key: null,
      installed_at: Date.now(),
      updated_at: Date.now(),
    });

    const run = await start("hostile.smuggled", NO_RESTART);
    const line = await logLine(run, "FS-");
    // `FS-REACHED function`. The filesystem is right there, and the only reason a real plugin never
    // gets here is that the install pipeline refused to write this artifact in the first place.
    expect(line).toContain("FS-REACHED function");
  }, 30_000);
});

describe("the event flood", () => {
  test("the frame channel has no backpressure yet, and the log channel does", async () => {
    const run = await launch("flood.js", "hostile.flood", {
      heartbeatIntervalMs: 150,
      pingTimeoutMs: 120,
      maxMissedBeats: 4,
      ...NO_RESTART,
    });

    // 1. It gets through activation while flooding, which is itself the first assertion: the burst
    //    starts at module scope, before anything is listening, and the lifecycle frame still lands.
    await waitFor("flood to activate", () => (run.status().state === "running" ? true : null));

    // 2. The frame channel. `req` is a tag a plugin may send, so every one of these is a valid frame
    //    and the host takes all of them.
    await waitFor("flood frames", () =>
      run.frames.filter((frame) => frame.t === "req").length > 200 ? true : null,
    );

    // 3. The log channel. `process.stdout.write` is replaced by the prelude with a write to stderr,
    //    so the raw half of the flood becomes log lines and meets the transport's token bucket.
    await logLine(run, "logging too fast");

    // 4. The host stays healthy under both. The heartbeat is answered throughout, because the flood
    //    yields — which is the difference between this attack and the spin loop.
    expect(run.status().state).toBe("running");
    expect(run.status().lastFailure).toBeNull();

    // 5. **The gap, stated rather than asserted away.** Credit windows, per-tick batching and the
    //    `dropped` frame are step 3.6 and do not exist. Nothing bounds how many frames a plugin can
    //    push at the host: `onPluginFrame` is called once per frame, forever, and the only thing
    //    between a flooding plugin and unbounded host work is that nothing is subscribed yet. This
    //    assertion documents the state of the world; when 3.6 lands it should start failing, and the
    //    replacement is a bound on the count rather than a floor under it.
    const delivered = run.frames.length;
    await Bun.sleep(250);
    expect(run.frames.length).toBeGreaterThan(delivered);

    // 6. Disable still works instantly against a plugin doing this, which is the promise that has to
    //    hold whether or not backpressure exists.
    run.registry.disable(run.id, "user", "flood");
    expect(run.status().state).toBe("disabled");
  }, 30_000);
});

describe("a lifecycle hook that never returns", () => {
  test("activate is caught by the activation deadline, and named as hung", async () => {
    const run = await launch("hang.js", "hostile.hang", { activateTimeoutMs: 700, ...NO_RESTART });

    const verdict = await failure(run);
    // `activate-hung` and `activate-failed` are different sentences to put in front of a user: one
    // is a plugin waiting on something that is never coming, the other is a plugin that said it
    // could not start.
    expect(verdict.kind).toBe("activate-hung");
    expect(verdict.detail).toContain("not responding");
    // The process was perfectly responsive the whole time — flat memory, every heartbeat answered.
    // Only the deadline catches this one, which is why it is a separate mechanism from the wedge.
    expect(run.status().missedBeats).toBe(0);
  }, 30_000);

  test("a hook that throws is a different verdict from one that hangs", async () => {
    const root = join(sourceRoot, "activate-throws");
    mkdirSync(root, { recursive: true });
    const manifest: PluginManifestInput = {
      id: "hostile.activate-throws",
      name: "activate-throws",
      version: "1.0.0",
      publisher: "Hostile",
      main: "index.js",
      engines: { pluginApi: PLUGIN_API_PROTOCOL_MAJOR },
    };
    writeFileSync(join(root, "vrcz-plugin.json"), JSON.stringify(manifest));
    copyFileSync(HARNESS, join(root, "index.js"));
    writeFileSync(
      join(root, "attack.js"),
      "export function activate() { throw new Error('nope'); }\n",
    );
    const result = await installPluginFromDirectory(root, { env });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    store.upsertPlugin({
      id: manifest.id,
      version: "1.0.0",
      manifest: JSON.stringify(result.manifest),
      bundle_hash: result.bundleHash,
      source_kind: "local",
      source_ref: result.sourceRef,
      trust: "unsigned",
      publisher_key: null,
      installed_at: Date.now(),
      updated_at: Date.now(),
    });

    const run = await start(manifest.id, { activateTimeoutMs: 5_000, ...NO_RESTART });
    const verdict = await failure(run);
    expect(verdict.kind).toBe("activate-failed");
    expect(verdict.detail).toContain("nope");
  }, 30_000);
});

describe("forged frames", () => {
  test("the prelude refuses pong and hello; the host's direction check refuses the rest", async () => {
    const run = await launch("liar.js", "hostile.liar", NO_RESTART);

    // 1. The two the prelude will not even put on the wire. Forging a pong would defeat the very
    //    heartbeat the prelude exists to make unforgeable, and `hello` is a frame the host is
    //    entitled to treat as arriving exactly once.
    await logLine(run, "may not send a pong");
    await logLine(run, "may not send a hello");

    // 2. The three host-only tags the prelude *does* pass on, refused by the host's own direction
    //    check in `decodeEnvelope`. Reported as protocol errors, which the supervisor surfaces as a
    //    log line rather than acting on — a lie is counted, not obeyed.
    await logLine(run, "A plugin may not send a event frame");
    await logLine(run, "A plugin may not send a dropped frame");
    await logLine(run, "A plugin may not send a lifecycle frame");

    // 3. And the raw channel, which is not a channel: `process.stdout.write` was replaced with a
    //    write to stderr, so the lies told that way arrive as log text rather than as frames.
    await logLine(run, '"t":"event"');
    expect(run.frames.some((frame) => frame.t === "event")).toBe(false);
    expect(run.frames.some((frame) => frame.t === "dropped")).toBe(false);
    expect(run.frames.some((frame) => frame.t === "lifecycle")).toBe(false);

    // 4. The supervisor was never persuaded it was healthy by a pong it did not ask for, and the
    //    plugin is still up: a lie is *counted*, not fatal.
    expect(run.status().missedBeats).toBe(0);
    expect(run.status().lastFailure).toBeNull();
  }, 30_000);
});

describe("what the deny-scan does not catch", () => {
  /**
   * Each of these installs **successfully**. That is the finding, not a bug in the fixture: the scan
   * catches syntax and every one of these is the same capability written with no syntax left to
   * catch. What the tests assert is the layer that actually stops them at run time.
   */
  test("computed reaches for the runtime pass the scan, and the prelude is what stops them", async () => {
    const result = await install("globals.js", "hostile.globals");
    expect(result.ok).toBe(true);

    const run = await launch("globals.js", "hostile.globals-run", NO_RESTART);
    const line = await logLine(run, "SURVEY ");
    const survey = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, string>;

    // The Function constructor is reachable off any object, so the `function-constructor` rule is a
    // convenience and not a gate. It is stated here so nobody reads that rule as a boundary.
    expect(survey["function-constructor"]).toBe("function");
    expect(survey["function-constructor-reaches-globalthis"]).toBe("object");
    // But the realm it evaluates in is the scrubbed one, which is the property that matters: a
    // function built from a string cannot conjure back a global the prelude removed.
    expect(survey["function-constructor-reaches-fetch"]).toBe("undefined");

    // Computed spellings walk past the scan and land on nothing, because the prelude removed the
    // members rather than the syntax.
    expect(survey["computed-process-binding"]).toBe("undefined");
    expect(survey["computed-require"]).toBe("undefined");
    expect(survey["bun-file"]).toBe("undefined");
    expect(survey["bun-spawn"]).toBe("undefined");

    // `process.env` is emptied by the prelude.
    expect(survey["process-env-keys"]).toBe("[]");

    // **The two genuine disclosures, asserted as disclosures.**
    //
    // `Bun.env` is non-writable, so `process.env = {}` does not touch it and the Windows variables
    // Bun synthesises survive there. They are blanked (decision 166) *except* `TEMP`/`TMP`, which
    // point at the plugin's own data directory — and under the default state tree that directory is
    // inside the user's profile, so it spells out the account name that every other variable was
    // blanked to hide. Here the state tree is redirected, so the assertion is that the path is the
    // one the host chose rather than anything about the developer's machine.
    const bunEnv = JSON.parse(survey["bun-env"] ?? "{}") as Record<string, string>;
    for (const name of ["USERNAME", "USERPROFILE", "HOMEPATH", "LOGONSERVER", "PATH"]) {
      expect(bunEnv[name] ?? "").toBe("");
    }
    expect(bunEnv.TEMP ?? "").toContain(stateRoot);

    // And `import.meta.url` is the absolute path of the content-addressed artifact. No rule covers
    // it, nothing scrubs it, and under the default state tree it names the user's home directory.
    expect(survey["import-meta-url"] ?? "").toContain("plugins/hostile.globals-run");
  }, 30_000);

  test("network globals have no scan rule at all, and the prelude really does remove them", async () => {
    // The scan is silent about `fetch`, `WebSocket` and `XMLHttpRequest`, which is correct only for
    // exactly as long as this test passes. If any of these comes back callable, a plugin can reach
    // VRChat outside the rate limiter and the scope check, and exfiltrate whatever it has seen.
    const result = await install("network.js", "hostile.network");
    expect(result.ok).toBe(true);

    const run = await launch("network.js", "hostile.network-run", NO_RESTART);
    const line = await logLine(run, "NETWORK ");
    const survey = JSON.parse(line.slice(line.indexOf("{"))) as Record<string, string>;

    for (const name of [
      "fetch",
      "computed-fetch",
      "WebSocket",
      "XMLHttpRequest",
      "EventSource",
      "Worker",
      "navigator",
      "Bun.connect",
      "Bun.serve",
    ]) {
      expect([name, survey[name]]).toEqual([name, "undefined"]);
    }
    expect(survey["actually-fetch"]).toBe("unreachable");

    // The scan deliberately allows `eval("a literal")` on the grounds that it is exactly as powerful
    // as writing the literal out. It is — and the binding is gone anyway, so a scan-clean bundle
    // containing an `eval` call finds nothing to call.
    expect(survey["eval-literal"]).toContain("not a function");
    expect(survey["indirect-eval"]).toBe("undefined");
  }, 30_000);
});

describe("crash-loop auto-disable", () => {
  test("survives, and a fresh registry over the same store will not start it", async () => {
    const run = await launch("crash.js", "hostile.crash", {
      baseBackoffMs: 10,
      maxBackoffMs: 20,
      crashLoopThreshold: 3,
      crashWindowMs: 60_000,
      stableAfterMs: 60_000,
    });

    const notification = await waitFor("the auto-disable notification", () => run.notifications[0]);
    expect(notification.title).toContain("hostile.crash");
    expect(notification.body).toContain("was disabled");

    const disabled = run.status().disabled;
    expect(disabled?.reason).toBe("crash-loop");
    expect(run.status().state).toBe("disabled");

    // The durable half. `PluginDisableStore` exists for exactly this: an auto-disable that did not
    // outlive the daemon would be a crash loop with extra steps, one per boot, forever.
    const row = store.getPlugin("hostile.crash");
    expect(row?.disabled_at).not.toBeNull();
    expect(row?.disabled_by).toBe("crash-loop");

    // A whole new registry — the daemon restarting — and the plugin does not spawn at all.
    const second = await start("hostile.crash", { baseBackoffMs: 10, crashLoopThreshold: 3 });
    expect(second.registry.get("hostile.crash")).toBeNull();
    expect(second.status().state).toBe("disabled");
    expect(second.logs).toEqual([]);
  }, 45_000);
});

describe("the control", () => {
  test("polite.js activates, stays running, and nothing fires", async () => {
    // A supervisor that killed everything would pass every other test in this file. This is the only
    // one that notices, so it runs under the same heartbeat budgets as the spin loop.
    const run = await launch("polite.js", "hostile.polite", HEARTBEAT);

    await waitFor("polite to activate", () => (run.status().state === "running" ? true : null));

    // Several heartbeat intervals with nothing happening.
    await Bun.sleep(900);

    expect(run.status().state).toBe("running");
    expect(run.status().lastFailure).toBeNull();
    expect(run.status().missedBeats).toBe(0);
    expect(run.status().restarts).toBe(0);
    expect(run.status().disabled).toBeNull();
    expect(run.notifications).toEqual([]);

    // And it stops the *polite* way, which is the half of the contract the spin loop cannot exercise.
    await run.registry.stopAll(3_000);
    expect(run.status().state).toBe("idle");
  }, 30_000);
});
