import { describe, expect, test } from "bun:test";
import { MAX_FRAME_BYTES, PLUGIN_API_PROTOCOL_MAJOR } from "@vrcz/plugin-api";
import { encodePreludeConfig, MAX_PRELUDE_SOURCE_BYTES, PRELUDE_SOURCE } from "./prelude.ts";

/**
 * The prelude is injected as `bun -e` source, so most of what is worth asserting about it can only
 * be seen by running it. These tests do that against a throwaway script rather than a plugin
 * bundle, so they stay about the prelude itself; the prelude-plus-transport pair is covered in
 * `process-transport.test.ts`.
 */

interface Ran {
  readonly frames: Record<string, unknown>[];
  readonly stdoutLines: string[];
  readonly stderr: string;
  readonly code: number | null;
}

/**
 * Runs the real prelude in a real child, feeds it `input`, and returns what came back.
 *
 * `bundleSource`, when given, is written to a temp file and imported by the prelude exactly as a
 * plugin bundle would be.
 */
async function run(options: {
  input?: string;
  bundleSource?: string;
  closeStdin?: boolean;
}): Promise<Ran> {
  let bundleUrl = "";
  if (options.bundleSource !== undefined) {
    const path = `${Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp"}/vrczip-prelude-${crypto.randomUUID()}.mjs`;
    await Bun.write(path, options.bundleSource);
    bundleUrl = Bun.pathToFileURL(path).href;
  }

  const child = Bun.spawn(
    [
      process.execPath,
      "--smol",
      "-e",
      PRELUDE_SOURCE,
      encodePreludeConfig({ pluginId: "prelude.test", bundleUrl }),
    ],
    { env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  if (options.input !== undefined) {
    child.stdin.write(options.input);
    await child.stdin.flush();
  }
  if (options.closeStdin !== false) {
    // Closing stdin is the graceful stop, so it is also how a test gets the child to finish.
    setTimeout(() => {
      void child.stdin.end();
    }, 250);
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const stdoutLines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const frames: Record<string, unknown>[] = [];
  for (const line of stdoutLines) {
    if (!line.startsWith("{")) continue;
    try {
      frames.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Left out of `frames` on purpose; `stdoutLines` still has it for a test that wants it.
    }
  }
  return { frames, stdoutLines, stderr, code };
}

describe("the injected source", () => {
  test("fits the command-line budget it is spawned through", () => {
    const bytes = new TextEncoder().encode(PRELUDE_SOURCE).length;
    expect(bytes).toBeLessThan(MAX_PRELUDE_SOURCE_BYTES);
  });

  test("carries the canonical constants as literals rather than a second copy", () => {
    // Not a style check. The prelude cannot import `@vrcz/plugin-api`, so the only thing standing
    // between it and a silently drifting protocol major is that these are injected.
    expect(PRELUDE_SOURCE).toContain(`var VRCZ_PROTOCOL = ${String(PLUGIN_API_PROTOCOL_MAJOR)};`);
    expect(PRELUDE_SOURCE).toContain(`var VRCZ_MAX_FRAME_BYTES = ${String(MAX_FRAME_BYTES)};`);
  });
});

describe("boot", () => {
  test("sends exactly one hello, with the host's protocol major", async () => {
    const ran = await run({});
    const hellos = ran.frames.filter((frame) => frame.t === "hello");
    expect(hellos).toHaveLength(1);
    expect(hellos[0]).toEqual({
      t: "hello",
      protocol: PLUGIN_API_PROTOCOL_MAJOR,
      pluginId: "prelude.test",
    });
    expect(ran.code).toBe(0);
  }, 20_000);

  test("closing stdin is the graceful stop", async () => {
    const ran = await run({});
    expect(ran.code).toBe(0);
  }, 20_000);

  test("refuses to run without a config", async () => {
    const child = Bun.spawn([process.execPath, "-e", PRELUDE_SOURCE, "not json"], {
      env: {},
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(78);
    expect(stderr).toContain("without a valid config");
  }, 20_000);
});

describe("the heartbeat", () => {
  test("is answered by the prelude, with an rss reading, without any plugin code", async () => {
    const ran = await run({
      input: `${JSON.stringify({ t: "ping", nonce: "n1", deadline: Date.now() + 5000 })}\n`,
    });
    const pong = ran.frames.find((frame) => frame.t === "pong");
    expect(pong?.nonce).toBe("n1");
    expect(typeof pong?.rss).toBe("number");
    expect(pong?.rss as number).toBeGreaterThan(0);
  }, 20_000);

  test("keeps answering when the plugin's own frame handler throws", async () => {
    // The whole reason the echo lives here: a plugin cannot break it by being broken.
    const ran = await run({
      bundleSource: `globalThis.__vrczHost.onFrame(() => { throw new Error("handler is broken"); });`,
      input: [
        JSON.stringify({ t: "req", id: "1", method: "x.y", deadline: Date.now() + 5000 }),
        JSON.stringify({ t: "ping", nonce: "n2", deadline: Date.now() + 5000 }),
        "",
      ].join("\n"),
    });
    expect(ran.frames.some((frame) => frame.t === "pong" && frame.nonce === "n2")).toBe(true);
    expect(ran.stderr).toContain("handler is broken");
  }, 20_000);

  test("keeps answering after the plugin replaces the globals it uses", async () => {
    const ran = await run({
      bundleSource: [
        "JSON.stringify = () => { throw new Error('no stringify for you'); };",
        "globalThis.console = null;",
        "process.stdout = null;",
        "process.memoryUsage = null;",
      ].join("\n"),
      input: `${JSON.stringify({ t: "ping", nonce: "n3", deadline: Date.now() + 5000 })}\n`,
    });
    expect(ran.frames.some((frame) => frame.t === "pong" && frame.nonce === "n3")).toBe(true);
  }, 20_000);

  test("a plugin cannot forge a pong through the seam", async () => {
    // A spinning plugin cannot answer, and a plugin that never sees a nonce cannot answer early.
    // Refusing the tag outright closes the third door.
    const ran = await run({
      bundleSource: `globalThis.__vrczHost.send({ t: "pong", nonce: "forged" });`,
    });
    expect(ran.frames.some((frame) => frame.t === "pong")).toBe(false);
    expect(ran.stderr).toContain("may not send a pong frame");
  }, 20_000);
});

describe("the wire", () => {
  test("keeps stdout free of anything that is not a frame", async () => {
    const ran = await run({
      bundleSource: [
        `console.log("a console line");`,
        `process.stdout.write("a direct write\\n");`,
      ].join("\n"),
    });
    expect(ran.stdoutLines.every((line) => line.startsWith("{"))).toBe(true);
    expect(ran.stderr).toContain("a console line");
    expect(ran.stderr).toContain("a direct write");
  }, 20_000);

  test("drops an oversized outbound frame rather than writing a truncated one", async () => {
    const ran = await run({
      bundleSource: `globalThis.__vrczHost.send({ t: "credit", sub: "s", credits: 1, pad: "z".repeat(${String(MAX_FRAME_BYTES)}) });`,
    });
    expect(ran.frames.some((frame) => frame.t === "credit")).toBe(false);
    expect(ran.stderr).toContain("oversized frame");
  }, 20_000);

  test("drops an oversized inbound line without buffering it", async () => {
    const ran = await run({
      input: `${"x".repeat(MAX_FRAME_BYTES + 1024)}\n${JSON.stringify({ t: "ping", nonce: "after", deadline: Date.now() + 5000 })}\n`,
    });
    expect(ran.stderr).toContain("exceeded the size cap");
    // Resynchronised: the frame after the flood is still answered.
    expect(ran.frames.some((frame) => frame.t === "pong" && frame.nonce === "after")).toBe(true);
  }, 20_000);
});

describe("crash containment", () => {
  test("an async throw costs the turn, not the process", async () => {
    const ran = await run({
      bundleSource: [
        `setTimeout(() => { throw new Error("late boom"); }, 10);`,
        `Promise.reject(new Error("late rejection"));`,
      ].join("\n"),
      input: `${JSON.stringify({ t: "ping", nonce: "alive", deadline: Date.now() + 5000 })}\n`,
    });
    expect(ran.stderr).toContain("late boom");
    expect(ran.stderr).toContain("late rejection");
    expect(ran.frames.some((frame) => frame.t === "pong" && frame.nonce === "alive")).toBe(true);
    expect(ran.code).toBe(0);
  }, 20_000);

  test("a bundle that throws at load exits non-zero and says why", async () => {
    const ran = await run({ bundleSource: `throw new Error("bad bundle");` });
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("bad bundle");
  }, 20_000);
});

describe("scrubbing", () => {
  test("removes the globals that reach the network", async () => {
    const ran = await run({
      bundleSource: [
        "const report = {",
        "  fetch: typeof globalThis.fetch,",
        "  ws: typeof globalThis.WebSocket,",
        "  spawn: typeof Bun.spawn,",
        "  file: typeof Bun.file,",
        "  ffi: typeof Bun.FFI,",
        "  env: Object.keys(process.env).length,",
        "};",
        "globalThis.__vrczHost.log(JSON.stringify(report));",
      ].join("\n"),
    });
    expect(ran.stderr).toContain(
      JSON.stringify({
        fetch: "undefined",
        ws: "undefined",
        spawn: "undefined",
        file: "undefined",
        ffi: "undefined",
        env: 0,
      }),
    );
  }, 20_000);

  test("cannot stop a plugin from importing node:fs, and does not pretend to", async () => {
    // PLAN.md says this plainly: a prelude cannot disable the `import()` operator. The test exists
    // so that the day someone claims the prelude is a sandbox, this failing assumption is written
    // down and executable rather than buried in a comment.
    const ran = await run({
      bundleSource: [
        `const fs = await import("node:" + "fs");`,
        `globalThis.__vrczHost.log("readFileSync is " + typeof fs.readFileSync);`,
      ].join("\n"),
    });
    expect(ran.stderr).toContain("readFileSync is function");
  }, 20_000);
});
