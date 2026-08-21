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
