/**
 * The picture pipeline: `bun run docs <step>`.
 *
 * Four steps, in order, and the middle one is a person with a browser:
 *
 *   1. `docs stage`   stands up a daemon full of an invented evening, and prints the shot list.
 *   2. *(capture)*    somebody screenshots each route into `docs/screenshots/<id>.jpg`.
 *   3. `docs pages`   writes the composited HTML — captions, poster, GIF frames — and serves it.
 *   4. *(capture)*    somebody screenshots each page into `docs/renders/` and `build/docs/frames/`.
 *   5. `docs gif`     encodes the two GIFs from those frames.
 *
 * ## Why the capture step is not automated
 *
 * It could be — CDP over a headless Chrome would do it. It is not, because half the shots need a
 * *state* rather than a URL: a palette mid-search, a wire half-dragged, a consent sheet open. Driving
 * those from a script means a second, worse copy of the app's own interaction code, kept in step with
 * an editor that changes weekly. The manifest in `docs/shots.ts` names what to do instead, in
 * English, and whoever is holding the browser does it.
 *
 * So this is a tool that removes everything *except* the judgement: the data is invented and
 * repeatable, the layout is code, the encoding is one command. What is left is aiming.
 */

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { evening } from "./docs/demo.ts";
import { cropFor, encodeGif } from "./docs/gif.ts";
import {
  AD_ASPECT,
  adEndPage,
  adFramePage,
  adTitlePage,
  CAPTURE,
  captionPage,
  posterPage,
  SHORT_ASPECT,
  shortFramePage,
} from "./docs/pages.ts";
import { seed } from "./docs/seed.ts";
import { SHORT_FRAMES, SHOTS, shot, shotsFor } from "./docs/shots.ts";
import { startVrchatStub } from "./docs/vrchat-stub.ts";

/** Everything is relative to `desktop-app/`, which is where every other script here is run from. */
const ROOT = resolve(import.meta.dir, "../..");
const REPO = resolve(ROOT, "..");
const DOCS = join(REPO, "docs");
const BUILD = join(ROOT, "build", "docs");
/** Deliberately inside `desktop-app/` and gitignored: it holds a keychain-backed secrets file. */
const STATE = join(ROOT, ".docs-state");

function say(line = ""): void {
  console.log(line);
}

/* -------------------------------------------------------------------------------------------- */
/* stage                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * Stands the app up against the stub, signs the demo accounts in, seeds what has no upstream, and
 * then stays running so somebody can take the pictures.
 *
 * The daemon is a child process rather than an in-process `startDaemon`, which keeps `tools` from
 * depending on daemon internals — it is started exactly the way a user starts it, with the two
 * loopback-only env overrides that exist for this (see `UPSTREAM_ENV` in `daemon/src/app.ts`).
 */
async function stage(): Promise<void> {
  await rm(STATE, { recursive: true, force: true });
  await mkdir(STATE, { recursive: true });
  const logs = join(STATE, "logs");
  await mkdir(logs, { recursive: true });

  const stub = startVrchatStub();
  say(`stub VRChat  ${stub.baseUrl}`);

  // Written before the daemon starts: without a contact address every sign-in fails
  // `setup_required`, which is the correct behaviour and would stop the whole run.
  await Bun.write(
    join(STATE, "settings.json"),
    `${JSON.stringify(
      {
        // The repository URL as the contact, because the contact rules refuse a placeholder — and
        // rightly: a fake one in a real User-Agent is what gets a tool blocked. It shows up in the
        // Settings screenshot, so it also has to be something honest to show.
        contact: "https://github.com/TheArmagan/vrc.zip",
        openBrowserOnStart: false,
        /*
         * **Not the machine's real VRChat logs**, and this is the most important line in the file.
         *
         * Log discovery would find them, the watcher would tail them, and the demo database would
         * fill with the operator's own evening — real display names, real worlds, real join times —
         * bound for a screenshot in a public README. It happened on the first run of this pipeline:
         * a thousand `gamelog.*` rows appeared in a database that had been created ten seconds
         * earlier. An empty directory makes that impossible rather than unlikely.
         */
        logDirectories: [logs],
      },
      null,
      2,
    )}\n`,
  );

  const daemon = Bun.spawn(["bun", join(ROOT, "daemon", "src", "index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      VRCZIP_STATE_DIR: STATE,
      VRCZIP_STABLE_TOKEN: "1",
      VRCZIP_VRCHAT_BASE_URL: stub.baseUrl,
      VRCZIP_PIPELINE_URL: stub.pipelineUrl,
      // A screenshot run must not put toasts on the operator's desktop.
      VRCZIP_NO_DESKTOP_NOTIFICATIONS: "1",
    },
    stdout: "pipe",
    stderr: "inherit",
  });

  const { control, ui, token } = await readLaunch(daemon);
  say(`daemon       ${ui}`);

  await signIn(control, token);
  const result = seed(join(STATE, "vrczip.sqlite"), evening(Date.now()));
  say(
    `seeded       ${String(result.sessions)} sessions, ${String(result.events)} events, ` +
      `${String(result.graphs)} graphs, ${String(result.storeEntries)} store entries`,
  );
  await stub.pushEvents(evening(Date.now()));

  say();
  say(`Open: ${ui}/?token=${token}`);
  say();
  plan();
  say("Leave this running. Ctrl+C when the shots are taken.");

  const stop = (): void => {
    daemon.kill();
    stub.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await daemon.exited;
  stub.stop();
}

/** Reads the daemon's own startup banner for the ports it actually bound. */
async function readLaunch(
  daemon: Bun.Subprocess<"ignore", "pipe", "inherit">,
): Promise<{ ui: string; control: string; token: string }> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of daemon.stdout) {
    buffered += decoder.decode(chunk as Uint8Array);
    process.stdout.write(decoder.decode(chunk as Uint8Array));
    const open = /Open: (http:\/\/127\.0\.0\.1:\d+)\/\?token=([0-9a-f]+)/.exec(buffered);
    const control = /control\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(buffered);
    if (open !== null && control !== null) {
      return { ui: open[1] ?? "", control: control[1] ?? "", token: open[2] ?? "" };
    }
  }
  throw new Error("The daemon exited before printing its launch URL.");
}

/** Signs both demo accounts in through the control API, answering the 2FA the stub demands. */
async function signIn(control: string, token: string): Promise<void> {
  const { ACCOUNTS, TWO_FACTOR_CODE } = await import("./docs/demo.ts");
  for (const account of ACCOUNTS) {
    const login = await post(control, token, "/api/accounts/login", {
      username: account.username,
      password: account.password,
    });
    const result = login as { status?: string; accountId?: string };
    if (result.status === "requires-2fa") {
      await post(control, token, `/api/accounts/${String(result.accountId)}/verify-2fa`, {
        method: "totp",
        code: TWO_FACTOR_CODE,
      });
    }
    say(`signed in    ${account.displayName}`);
  }
}

async function post(control: string, token: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${control}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → ${String(response.status)} ${text}`);
  return text === "" ? null : (JSON.parse(text) as unknown);
}

/* -------------------------------------------------------------------------------------------- */
/* plan                                                                                           */
/* -------------------------------------------------------------------------------------------- */

function plan(): void {
  say("Capture each of these to docs/screenshots/<id>.jpg, 1440x900 unless noted:");
  for (const entry of SHOTS) {
    const hold = entry.hold === undefined ? "" : `  ← ${entry.hold}`;
    say(`  ${entry.id.padEnd(18)} #${entry.route}${hold}`);
  }
  say();
}

/* -------------------------------------------------------------------------------------------- */
/* pages                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * Writes every composited page and serves the build directory next to `docs/`, so a page can
 * reference `../../docs/screenshots/feed.jpg` and the browser will load it.
 *
 * A server rather than `file://` because Chrome refuses to screenshot cleanly across `file://`
 * origins, and because a URL is something the capture step can be pointed at repeatably.
 */
async function pages(): Promise<void> {
  await mkdir(join(BUILD, "frames"), { recursive: true });
  const href = (id: string) => `/shots/${id}.jpg`;

  const written: string[] = [];
  const write = async (name: string, html: string): Promise<void> => {
    await Bun.write(join(BUILD, name), html);
    written.push(name);
  };

  for (const entry of SHOTS)
    await write(`render-${entry.id}.html`, captionPage(entry, href(entry.id)));
  await write("poster.html", posterPage("graph-editor", href));

  // The short GIF: three screens, one second each.
  for (const [index, id] of SHORT_FRAMES.entries()) {
    await write(`short-${String(index + 1)}.html`, shortFramePage(shot(id), href(id)));
  }

  // The ad: a title card, one frame per feature, and somewhere for the loop to land.
  await write(
    "ad-01.html",
    adTitlePage(
      "Everything about VRChat, on your own machine.",
      "Multi-account, local-only, and it automates itself.",
    ),
  );
  const features = shotsFor("ad");
  for (const [index, entry] of features.entries()) {
    await write(
      `ad-${String(index + 2).padStart(2, "0")}.html`,
      adFramePage(entry, href(entry.id)),
    );
  }
  await write(`ad-${String(features.length + 2).padStart(2, "0")}.html`, adEndPage());

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const file = path.startsWith("/shots/")
        ? Bun.file(join(DOCS, "screenshots", path.slice("/shots/".length)))
        : Bun.file(join(BUILD, path === "/" ? "poster.html" : path.slice(1)));
      return (await file.exists()) ? new Response(file) : new Response("not here", { status: 404 });
    },
  });

  const base = `http://127.0.0.1:${String(server.port)}`;
  say(`Wrote ${String(written.length)} pages to build/docs, served at ${base}`);
  say();
  // Every page is authored to exactly one viewport, so there is one capture size for all of them
  // and nothing to remember per page. See the note at the top of `pages.ts`.
  say(
    `Capture each page whole, at ${String(CAPTURE.width)}x${String(CAPTURE.height)}. ` +
      `The GIF frames are cropped out of that by ffmpeg.`,
  );
  say();
  say("Captions → docs/renders/<id>.jpg:");
  for (const entry of SHOTS) say(`  ${base}/render-${entry.id}.html`);
  say();
  say(`Poster   → docs/poster.jpg — ${base}/poster.html`);
  say();
  say("Short GIF frames → build/docs/frames/short-N.png:");
  for (const index of SHORT_FRAMES.keys()) say(`  ${base}/short-${String(index + 1)}.html`);
  say();
  say("Ad GIF frames → build/docs/frames/ad-NN.png:");
  for (const name of written.filter((entry) => entry.startsWith("ad-"))) say(`  ${base}/${name}`);
  say();
  say("Ctrl+C when every page has been captured.");
  await new Promise(() => {
    // Serve until interrupted. There is nothing to wait for but the person with the browser.
  });
}

/* -------------------------------------------------------------------------------------------- */
/* gif                                                                                            */
/* -------------------------------------------------------------------------------------------- */

async function gifs(): Promise<void> {
  const frames = join(BUILD, "frames");
  const short = SHORT_FRAMES.map((_, index) => join(frames, `short-${String(index + 1)}.png`));
  const adFiles = [...new Bun.Glob("ad-*.png").scanSync(frames)]
    .sort()
    .map((name) => join(frames, name));

  for (const [label, options] of [
    [
      "short",
      {
        frames: short,
        out: join(DOCS, "vrc-zip-short.gif"),
        fps: 1,
        // 720 wide rather than the frame's own 492: the frames are captured at a fixed viewport
        // height, so upscaling here is what gets a portrait GIF to a size a phone will not squint
        // at. Lanczos on a 1.5x upscale of flat UI colour is close to lossless.
        width: 720,
        crop: cropFor(SHORT_ASPECT, CAPTURE),
      },
    ],
    [
      "ad",
      {
        frames: adFiles,
        out: join(DOCS, "vrc-zip.gif"),
        fps: 2,
        // Below the frame's own 1312, which is the one knob that reliably keeps the file under
        // Discord's free-tier limit without touching the palette.
        width: 1000,
        crop: cropFor(AD_ASPECT, CAPTURE),
      },
    ],
  ] as const) {
    const missing = options.frames.filter((frame) => !Bun.file(frame).size);
    if (options.frames.length === 0 || missing.length > 0) {
      say(`${label}: skipped — capture the frames first (${String(missing.length)} missing).`);
      continue;
    }
    const result = await encodeGif(options);
    say(`${label}: ${result.note}`);
  }
}

/* -------------------------------------------------------------------------------------------- */

const step = process.argv[2] ?? "help";
if (step === "stage") await stage();
else if (step === "plan") plan();
else if (step === "pages") await pages();
else if (step === "gif") await gifs();
else {
  say("bun run docs <step>");
  say();
  say("  stage   run the app against an invented evening, and print the shot list");
  say("  plan    print the shot list on its own");
  say("  pages   write and serve the captioned renders, the poster and the GIF frames");
  say("  gif     encode the two GIFs from captured frames");
}
