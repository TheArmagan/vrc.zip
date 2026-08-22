/**
 * The prelude: host code that runs inside the plugin process, before any plugin code exists.
 *
 * ## What it is for
 *
 * Four jobs, and only the first two are load-bearing:
 *
 *  1. **It owns the heartbeat echo.** A `ping` is answered here and never reaches plugin code, so a
 *     plugin cannot forget to answer, cannot answer wrongly, and — the property that actually
 *     matters — a plugin spinning its event loop stops answering no matter what it intended, because
 *     the reply needs a turn of the loop it is refusing to yield. A missed heartbeat is therefore
 *     evidence about the runtime, not about the author.
 *  2. **It owns the wire.** stdout carries frames and nothing else, `console.*` and
 *     `process.stdout.write` are redirected to stderr, and the plugin talks to the host through one
 *     small seam rather than by writing bytes.
 *  3. It sends the single `hello` frame, and reports `rss` on each pong.
 *  4. It scrubs globals.
 *
 * ## What it is NOT
 *
 * **This is not a security sandbox, and calling it one would be a lie** (PLAN.md §Phase 3
 * correction 6: do not call it a sandbox until it is one). The scrubbing in job 4 is *hygiene* — it
 * makes the dangerous thing awkward and obvious rather than reflexive — and here is exactly what it
 * cannot do:
 *
 *  - **A prelude cannot disable the `import()` operator.** `await import("node:" + "fs")` reaches
 *    the filesystem, and there is no global to remove that changes that. This is stated plainly in
 *    PLAN.md and it is the whole reason the real defences are elsewhere: the install-time deny-scan
 *    over the *bundled output* (which rejects non-literal `import()` before the code ever runs), and
 *    the process boundary itself, which is what a future AppContainer or seccomp profile attaches
 *    to.
 *  - **`globalThis.Bun` cannot be removed.** Measured, not assumed: its property descriptor is
 *    `{writable: false, configurable: false}`, so it survives assignment, `delete` and
 *    `defineProperty`. Its *members* are writable, so the dangerous ones are overwritten with
 *    `undefined` — but `Bun.env` is itself non-writable and stays.
 *  - **`Function` cannot be scrubbed.** `(function(){}).constructor` reaches it from any function
 *    value, so removing the global would break the runtime and stop nothing.
 *
 * So the honest summary: a plugin that *wants* to escape the scrub can, in about one line. What the
 * scrub buys is that a plugin doing something dangerous had to write that line, which is a thing a
 * reviewer and a deny-scan can both see.
 *
 * ## Why the source is a string, injected with `bun -e`
 *
 * Not a file on disk, which was the obvious alternative. Two reasons, in order:
 *
 *  - A prelude materialised at a predictable path is a file some other local process can rewrite
 *    between the write and the spawn. That is a TOCTOU on the exact code that enforces the
 *    boundary, and it would be the single most valuable file on the machine to win a race against.
 *  - It works identically from source and inside the compiled single-file `.exe`, with nothing for
 *    the packaging step to remember to copy.
 *
 * The cost is a Windows command-line budget of 32767 characters, which is why
 * {@link MAX_PRELUDE_SOURCE_BYTES} exists and is asserted by the tests: the prelude may not grow
 * into that limit unnoticed.
 *
 * ## Everything it needs is captured at module load
 *
 * Plugin code runs after this and may replace `console`, `JSON.stringify`, `process.stdout`, or
 * anything else. The prelude keeps its own references, taken before the bundle is imported, so the
 * heartbeat keeps answering through whatever the plugin does to the environment underneath it.
 */

import { MAX_FRAME_BYTES, PLUGIN_API_PROTOCOL_MAJOR } from "@vrcz/plugin-api";

/**
 * What the host tells the prelude, encoded as the **last** argv element.
 *
 * Last rather than first because `bun -e <code> <arg>` puts the first user argument at `argv[1]`
 * while `bun <file> <arg>` puts the file there. Reading from the end is correct under both, which
 * keeps the prelude runnable as a file if a future dev mode ever wants that.
 */
export interface PreludeConfig {
  readonly pluginId: string;
  /**
   * `file://` URL of the content-addressed bundle.
   *
   * A URL rather than a path because `import()` of a bare Windows path (`C:\…`) is not a valid
   * specifier, and building the URL host-side keeps `node:url` out of the prelude, which imports
   * nothing at all.
   */
  readonly bundleUrl: string;
}

export function encodePreludeConfig(config: PreludeConfig): string {
  return JSON.stringify(config);
}

/**
 * Byte budget for {@link PRELUDE_SOURCE}.
 *
 * Windows caps a command line at 32767 characters, and the prelude shares that with the runtime
 * path, `--smol`, and the config JSON. Half the budget is a wide margin and a hard stop: a prelude
 * that outgrows this needs the on-disk materialisation the header argues against, which is a
 * decision someone should make deliberately rather than discover from a spawn failure on one
 * user's machine.
 */
export const MAX_PRELUDE_SOURCE_BYTES = 16_384;

/**
 * Constants injected as literals rather than duplicated by hand.
 *
 * This is the whole answer to "the prelude cannot import `@vrcz/plugin-api`, so how do its
 * constants stay honest": they are not written twice. `PLUGIN_API_PROTOCOL_MAJOR` reaching the
 * `hello` frame through this line is also why a `hello` protocol mismatch is not a thing that
 * happens — the prelude is host code and always speaks the host's major. A real mismatch is caught
 * at install, against the manifest's `engines.pluginApi`.
 */
const PRELUDE_CONSTANTS = [
  `var VRCZ_PROTOCOL = ${String(PLUGIN_API_PROTOCOL_MAJOR)};`,
  `var VRCZ_MAX_FRAME_BYTES = ${String(MAX_FRAME_BYTES)};`,
].join("\n");

/**
 * The prelude body.
 *
 * Written in plain ES5-flavoured JavaScript with no template literals, because it lives inside one:
 * a backtick or a `${` here is a syntax error in *this* file, which is a fast failure but an
 * obscure one. `var` and `function` throughout for the same reason the file imports nothing — this
 * is the code that has to work when everything around it is hostile, so it uses the smallest
 * surface that does the job.
 */
const PRELUDE_BODY = `
(function () {
  "use strict";

  var G = globalThis;
  var B = G.Bun;
  var P = G.process;

  // ---------------------------------------------------------------------------------------------
  // Capture. Everything below is taken before plugin code exists, because plugin code may replace
  // any of it and the heartbeat has to keep working when it does.
  // ---------------------------------------------------------------------------------------------

  var stdin = B.stdin.stream();
  var writeOut = P.stdout.write.bind(P.stdout);
  var writeErr = P.stderr.write.bind(P.stderr);
  var stringify = JSON.stringify;
  var parseJson = JSON.parse;
  var defineProp = Object.defineProperty;
  var freeze = Object.freeze;
  var encoder = new G.TextEncoder();
  var decoder = new G.TextDecoder();
  var exit = P.exit.bind(P);
  var onProcess = P.on.bind(P);

  var readRss = null;
  try {
    if (typeof P.memoryUsage === "function" && typeof P.memoryUsage.rss === "function") {
      readRss = P.memoryUsage.rss.bind(P.memoryUsage);
    }
  } catch (e) {
    readRss = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Diagnostics. Always stderr: stdout is the frame channel and nothing else may touch it.
  // ---------------------------------------------------------------------------------------------

  function show(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return String(value.stack || value.message || value);
    try {
      var text = stringify(value);
      return typeof text === "string" ? text : String(value);
    } catch (e) {
      return String(value);
    }
  }

  function note() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(show(arguments[i]));
    try {
      writeErr(parts.join(" ") + "\\n");
    } catch (e) {
      // stderr is gone. There is nowhere left to say so.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------------------------

  var config = null;
  try {
    config = parseJson(P.argv[P.argv.length - 1]);
  } catch (e) {
    config = null;
  }
  if (config === null || typeof config !== "object" || typeof config.pluginId !== "string") {
    note("[vrc.zip] plugin host started without a valid config; refusing to run");
    exit(78);
    return;
  }
  var pluginId = config.pluginId;

  // ---------------------------------------------------------------------------------------------
  // Sending frames
  // ---------------------------------------------------------------------------------------------

  function sendFrame(frame) {
    var text;
    try {
      text = stringify(frame);
    } catch (e) {
      note("[vrc.zip] dropped a frame that could not be encoded:", e);
      return false;
    }
    if (typeof text !== "string") return false;
    // The cheap guard first. JSON.stringify never emits more than 3 UTF-8 bytes per UTF-16 code
    // unit, so a short string cannot possibly be over the cap and does not need encoding to find
    // out. The sender checks at all so a plugin fails locally with its payload still in hand,
    // instead of learning from an E_TOO_LARGE it cannot act on.
    if (text.length * 3 > VRCZ_MAX_FRAME_BYTES && encoder.encode(text).length > VRCZ_MAX_FRAME_BYTES) {
      note("[vrc.zip] dropped an oversized frame from", pluginId);
      return false;
    }
    try {
      writeOut(text + "\\n");
      return true;
    } catch (e) {
      return false;
    }
  }

  function sendPong(nonce) {
    var frame = { t: "pong", nonce: nonce };
    if (readRss !== null) {
      try {
        frame.rss = readRss();
      } catch (e) {
        // A runtime that cannot report RSS just omits it; the field is optional on the wire and the
        // supervisor falls back to reading the pid.
      }
    }
    sendFrame(frame);
  }

  // ---------------------------------------------------------------------------------------------
  // The seam. How the plugin-side runtime (a later step) attaches to the wire.
  // ---------------------------------------------------------------------------------------------

  var frameHandler = null;
  /*
   * Frames that arrived before the plugin attached a handler.
   *
   * Measured, not theorised: the host sends a lifecycle activate frame as soon as it sees hello,
   * and hello goes out before the bundle is imported. A plugin that registers its handler during
   * module evaluation - which is what definePlugin does, and what every plugin will do - can
   * therefore miss its own activation frame. Dropping it meant a 15s activation timeout, a restart,
   * and a plugin that only worked on the second attempt.
   *
   * Capped, because an unbounded queue for a plugin that never attaches is a slow leak. Sixteen is
   * far more than the handful of frames that can precede attachment; past it the oldest goes and
   * says so.
   */
  var buffered = [];
  var BUFFER_LIMIT = 16;

  var host = freeze({
    pluginId: pluginId,
    protocol: VRCZ_PROTOCOL,
    // A plugin may send through here, and the host still direction-checks and authorises every
    // frame it receives. Two tags are refused locally anyway: 'pong' because forging one would
    // defeat the heartbeat this file exists to make unforgeable, and 'hello' because the host is
    // entitled to treat it as arriving exactly once.
    send: function (frame) {
      if (frame === null || typeof frame !== "object") return false;
      if (frame.t === "pong" || frame.t === "hello") {
        note("[vrc.zip] a plugin may not send a", String(frame.t), "frame");
        return false;
      }
      return sendFrame(frame);
    },
    onFrame: function (fn) {
      frameHandler = typeof fn === "function" ? fn : null;
      if (frameHandler === null || buffered.length === 0) return;
      var queued = buffered;
      buffered = [];
      for (var i = 0; i < queued.length; i++) {
        try {
          frameHandler(queued[i]);
        } catch (e) {
          note("[vrc.zip] the frame handler threw on a buffered frame:", e);
        }
      }
    },
    log: function (message) {
      note(show(message));
    },
  });

  try {
    defineProp(G, "__vrczHost", {
      value: host,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch (e) {
    note("[vrc.zip] could not install the host seam:", e);
  }

  // ---------------------------------------------------------------------------------------------
  // Receiving frames. Newline-delimited JSON on stdin, with the same byte cap the host applies.
  // ---------------------------------------------------------------------------------------------

  function handleLine(text) {
    if (text.length === 0) return;
    var frame;
    try {
      frame = parseJson(text);
    } catch (e) {
      note("[vrc.zip] host sent a line that was not JSON");
      return;
    }
    if (frame === null || typeof frame !== "object") return;

    // The heartbeat is answered here and never handed on. Deliberately before any plugin-supplied
    // code runs, so a handler that throws, blocks or was never registered cannot cost a pong.
    if (frame.t === "ping") {
      sendPong(frame.nonce);
      return;
    }

    var handler = frameHandler;
    if (handler === null) {
      if (buffered.length >= BUFFER_LIMIT) {
        buffered.shift();
        note("[vrc.zip] dropped a host frame that arrived before a handler was attached");
      }
      buffered.push(frame);
      return;
    }
    try {
      handler(frame);
    } catch (e) {
      note("[vrc.zip] the frame handler threw:", e);
    }
  }

  async function readLoop() {
    var reader = stdin.getReader();
    var parts = [];
    var pending = 0;
    var skipping = false;

    function push(bytes) {
      if (skipping) return;
      if (pending + bytes.length > VRCZ_MAX_FRAME_BYTES) {
        // Drop what is held and keep dropping to the next newline. Buffering past the cap to
        // report a better error would be the denial of service the cap exists to prevent.
        parts = [];
        pending = 0;
        skipping = true;
        note("[vrc.zip] host frame exceeded the size cap and was dropped");
        return;
      }
      parts.push(bytes);
      pending += bytes.length;
    }

    function flushLine() {
      if (skipping) {
        skipping = false;
        parts = [];
        pending = 0;
        return;
      }
      if (pending === 0) return;
      var joined = new Uint8Array(pending);
      var at = 0;
      for (var i = 0; i < parts.length; i++) {
        joined.set(parts[i], at);
        at += parts[i].length;
      }
      parts = [];
      pending = 0;
      var text = decoder.decode(joined);
      if (text.charCodeAt(text.length - 1) === 13) text = text.slice(0, -1);
      handleLine(text);
    }

    for (;;) {
      var step;
      try {
        step = await reader.read();
      } catch (e) {
        break;
      }
      if (step.done) break;
      var chunk = step.value;
      if (!chunk || chunk.length === 0) continue;
      var start = 0;
      for (;;) {
        var nl = chunk.indexOf(10, start);
        if (nl === -1) {
          push(chunk.subarray(start));
          break;
        }
        push(chunk.subarray(start, nl));
        flushLine();
        start = nl + 1;
      }
    }

    // stdin closing is the host asking for a graceful stop. It is the only shutdown signal that
    // means the same thing on Windows as it does on Linux, which is why the host uses it rather
    // than a signal.
    exit(0);
  }

  // ---------------------------------------------------------------------------------------------
  // Crash containment. A plugin that throws asynchronously loses that turn, not the process: the
  // supervisor decides what a failing plugin costs, and it cannot decide anything about a process
  // that already exited.
  // ---------------------------------------------------------------------------------------------

  onProcess("uncaughtException", function (err) {
    note("[vrc.zip] uncaught exception in", pluginId + ":", err);
  });
  onProcess("unhandledRejection", function (err) {
    note("[vrc.zip] unhandled rejection in", pluginId + ":", err);
  });

  // ---------------------------------------------------------------------------------------------
  // Scrubbing. Hygiene, not containment. See the file header for what this provably cannot do.
  // ---------------------------------------------------------------------------------------------

  function scrub(target, name) {
    if (target === null || target === undefined) return false;
    try {
      defineProp(target, name, { value: undefined, writable: false, configurable: false });
      return target[name] === undefined;
    } catch (e) {
      return false;
    }
  }

  // Network belongs to the host: every VRChat call is a call against the *user's* account and has
  // to pass the rate limiter, the scope check and the dry-run gate. A plugin reaching the network
  // directly bypasses all three, so the globals that do it are removed rather than proxied.
  var GLOBAL_SCRUBS = [
    "fetch",
    "WebSocket",
    "XMLHttpRequest",
    "EventSource",
    "navigator",
    "Worker",
    "SharedWorker",
    "eval",
    "require",
  ];
  for (var g = 0; g < GLOBAL_SCRUBS.length; g++) scrub(G, GLOBAL_SCRUBS[g]);

  // 'Bun' itself is non-writable and non-configurable, so it stays. Its members are writable, and
  // these are the ones that reach a file, a socket, a subprocess or native code.
  var BUN_SCRUBS = [
    "spawn",
    "spawnSync",
    "file",
    "write",
    "$",
    "connect",
    "listen",
    "serve",
    "udpSocket",
    "dlopen",
    "FFI",
    "unsafe",
    "which",
    "openInEditor",
    "secrets",
    "s3",
    "redis",
    "embeddedFiles",
    "stdin",
    "stdout",
    "stderr",
  ];
  if (B !== null && B !== undefined) {
    for (var b = 0; b < BUN_SCRUBS.length; b++) scrub(B, BUN_SCRUBS[b]);
  }

  var PROCESS_SCRUBS = ["binding", "dlopen", "getBuiltinModule", "chdir", "kill"];
  for (var p = 0; p < PROCESS_SCRUBS.length; p++) scrub(P, PROCESS_SCRUBS[p]);

  // The host already spawns with an empty environment, so this removes the small baseline Windows
  // synthesises anyway (PATH, USERNAME, USERPROFILE, TEMP). Cheap, and it means a plugin reading
  // process.env sees the same nothing on every platform.
  try {
    P.env = {};
  } catch (e) {
    // Non-writable on some runtimes. The spawn-time empty env is the defence that matters.
  }

  // stdout is the frame channel. Anything a plugin prints goes to stderr, where the host reads it
  // as a log line rather than as a corrupted frame. A plugin can still reach fd 1 through
  // node:fs, which the host handles by treating a non-frame stdout line as a log.
  try {
    P.stdout.write = function (chunk) {
      try {
        writeErr(chunk);
      } catch (e) {
        // Nothing to do; a failed log is not worth a throw inside plugin code.
      }
      return true;
    };
  } catch (e) {
    note("[vrc.zip] could not redirect stdout");
  }

  var CONSOLE_METHODS = ["log", "info", "debug", "warn", "error", "trace", "dir", "table"];
  var consoleObject = G.console;
  if (consoleObject) {
    for (var c = 0; c < CONSOLE_METHODS.length; c++) {
      try {
        consoleObject[CONSOLE_METHODS[c]] = note;
      } catch (e) {
        // Leave whatever could not be replaced; it writes to stderr in Bun anyway for most methods.
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------------------------

  // hello first, so the host's arrival deadline is satisfied by the prelude rather than by however
  // long the plugin's own module graph takes to evaluate.
  sendFrame({ t: "hello", protocol: VRCZ_PROTOCOL, pluginId: pluginId });

  // Not awaited: it runs for the life of the process and keeps it alive.
  readLoop();

  if (typeof config.bundleUrl === "string" && config.bundleUrl.length > 0) {
    import(config.bundleUrl).then(null, function (err) {
      note("[vrc.zip] plugin failed to load:", err);
      exit(1);
    });
  }
})();
`;

/**
 * The complete injected source, constants first.
 *
 * Exported as a string so the transport can hand it to `bun -e` and so tests can assert against the
 * same bytes that actually run.
 */
export const PRELUDE_SOURCE = `${PRELUDE_CONSTANTS}\n${PRELUDE_BODY}`;
