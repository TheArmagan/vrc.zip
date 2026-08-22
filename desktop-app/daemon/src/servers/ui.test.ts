import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSessionToken } from "../security/session-token.ts";
import { createUiApp, SESSION_COOKIE } from "./ui.ts";

const PORT = 7773;
const TOKEN = generateSessionToken();

let dist: string;

beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), "vrcz-ui-"));
});

afterEach(async () => {
  await rm(dist, { recursive: true, force: true });
});

async function call(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const app = createUiApp({
    port: PORT,
    token: () => TOKEN,
    distDir: dist,
    controlUrl: "http://127.0.0.1:7775",
  });
  return await app.fetch(
    new Request(`http://127.0.0.1:${PORT}${path}`, {
      headers: { host: `127.0.0.1:${PORT}`, ...headers },
    }),
  );
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

describe("UI server guards", () => {
  test("a foreign Host is rejected", async () => {
    expect((await call("/", { ...AUTH, host: "evil.example" })).status).toBe(403);
  });

  test("no token is 401", async () => {
    expect((await call("/")).status).toBe(401);
  });

  test("the launch URL's ?token= is exchanged for a session cookie", async () => {
    const res = await call(`/?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=${TOKEN}`);
    // Subresource requests carry no headers of their own, so the cookie has to do the work.
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("the cookie authenticates later requests, which carry no headers", async () => {
    const res = await call("/app.js", { cookie: `${SESSION_COOKIE}=${TOKEN}` });
    expect(res.status).not.toBe(401);
  });

  test("a forged cookie is still 401", async () => {
    const res = await call("/", { cookie: `${SESSION_COOKIE}=${generateSessionToken()}` });
    expect(res.status).toBe(401);
  });
});

describe("UI server static serving", () => {
  test("explains itself when the UI has not been built", async () => {
    const res = await call("/", AUTH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("UI is not built");
    expect(body).toContain("bun run --filter @vrcz/ui build");
  });

  test("serves built files, and falls back to index.html for client-side routes", async () => {
    await writeFile(join(dist, "index.html"), "<!doctype html><title>vrc.zip</title>");
    await writeFile(join(dist, "app.js"), "export const ok = 1;\n");

    expect(await (await call("/app.js", AUTH)).text()).toContain("export const ok");
    expect(await (await call("/", AUTH)).text()).toContain("<title>vrc.zip</title>");
    // A client-side route: no such file, but the shell knows how to render it.
    expect(await (await call("/accounts/usr_1", AUTH)).text()).toContain("<title>vrc.zip</title>");
  });

  test("404s a missing asset rather than serving it the shell", async () => {
    await writeFile(join(dist, "index.html"), "<!doctype html><title>vrc.zip</title>");
    // Serving HTML in place of a missing chunk turns a build error into a baffling syntax error.
    expect((await call("/assets/missing-chunk.js", AUTH)).status).toBe(404);
  });

  test("answers /favicon.ico with an icon, built or not", async () => {
    // The browser asks for it unprompted, so both states have to answer: unbuilt, the catch-all
    // would hand back the placeholder *page* as the tab icon; built, there is no such file at all.
    for (const _ of [0, 1]) {
      const res = await call("/favicon.ico", AUTH);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/svg+xml");
      expect(await res.text()).toContain("<svg");
      await writeFile(join(dist, "index.html"), "<!doctype html><title>vrc.zip</title>");
    }
  });

  test("refuses to walk out of the dist directory", async () => {
    await writeFile(join(dist, "index.html"), "<!doctype html><title>vrc.zip</title>");
    const outside = join(dist, "..", "escaped.txt");
    await writeFile(outside, "secret");
    try {
      const res = await call("/..%2Fescaped.txt", AUTH);
      expect(await res.text()).not.toContain("secret");
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe("UI server session cookie", () => {
  /**
   * The launch URL carries `?token=`, but a browser attaches no headers to `<script>` and `<link>`
   * loads. The cookie exchange is the only thing that makes subresources authenticate, so these
   * assert the exchange survives the *specific* shape of response the static handler returns.
   */

  test("issues the cookie on a real file response, not just the placeholder", async () => {
    // The bug this exists for: the static handler returns `new Response(Bun.file(...))`, which
    // replaces `c.res` wholesale and discards a cookie set before the handler ran. It stayed
    // invisible while `ui/dist` was missing, because the placeholder path uses `c.html()` and
    // keeps its headers — so the failure only appeared once the UI was actually built, and it
    // appeared as a blank page with a healthy-looking daemon.
    await writeFile(join(dist, "index.html"), "<!doctype html><title>vrc.zip</title>", "utf8");

    const response = await call(`/?token=${TOKEN}`);
    expect(response.status).toBe(200);

    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain(`${SESSION_COOKIE}=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // No `secure`: the runtime default is plain http on loopback, where a secure cookie is dropped.
    expect(cookie?.toLowerCase()).not.toContain("secure");
  });

  test("an asset authenticates on the cookie alone", async () => {
    await writeFile(join(dist, "index.html"), "<!doctype html>", "utf8");
    await writeFile(join(dist, "app.js"), "export default 1;", "utf8");

    const denied = await call("/app.js");
    expect(denied.status).toBe(401);

    const allowed = await call("/app.js", { cookie: `${SESSION_COOKIE}=${TOKEN}` });
    expect(allowed.status).toBe(200);
  });

  test("a wrong cookie is rejected like any other bad token", async () => {
    await writeFile(join(dist, "index.html"), "<!doctype html>", "utf8");
    const response = await call("/", { cookie: `${SESSION_COOKIE}=${generateSessionToken()}` });
    expect(response.status).toBe(401);
  });
});

describe("UI server embedded bundle", () => {
  /** What `Bun.embeddedFiles` looks like once `--asset=ui/dist` has run: paths, not directories. */
  const bundle = new Map<string, Blob>([
    ["index.html", new File(["<!doctype html><title>packaged</title>"], "index.html")],
    [
      "assets/app.js",
      new File(["export const packaged = 1;\n"], "app.js", { type: "text/javascript" }),
    ],
  ]);

  async function callPackaged(path: string): Promise<Response> {
    const app = createUiApp({
      port: PORT,
      token: () => TOKEN,
      // A `dist` that exists on disk, to prove the embedded copy is what answers.
      distDir: dist,
      embedded: bundle,
      controlUrl: "http://127.0.0.1:7775",
    });
    return await app.fetch(
      new Request(`http://127.0.0.1:${PORT}${path}`, {
        headers: { host: `127.0.0.1:${PORT}`, ...AUTH },
      }),
    );
  }

  test("serves the embedded shell and assets", async () => {
    expect(await (await callPackaged("/")).text()).toContain("<title>packaged</title>");
    const asset = await callPackaged("/assets/app.js");
    // Bun records the content type at build time and it rides along on the blob, so no mime table
    // of ours is involved. Read before the body: on a blob-backed response the header is derived
    // from the blob, and consuming the body drops it.
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(await asset.text()).toContain("export const packaged");
  });

  test("client-side routes get the shell, missing assets are still 404", async () => {
    expect(await (await callPackaged("/accounts/usr_1")).text()).toContain("packaged");
    expect((await callPackaged("/assets/missing-chunk.js")).status).toBe(404);
  });

  test("a file on disk never shadows the embedded bundle", async () => {
    // A `ui/dist` beside a shipped exe belongs to whoever put it there. The packaged build reads
    // itself and nothing else, so this file must not be reachable.
    await writeFile(join(dist, "index.html"), "<!doctype html><title>on-disk</title>");
    expect(await (await callPackaged("/")).text()).not.toContain("on-disk");
  });

  test("a traversal cannot address anything outside the bundle", async () => {
    expect((await callPackaged("/..%2F..%2Fsecrets.enc")).status).toBe(404);
  });
});
