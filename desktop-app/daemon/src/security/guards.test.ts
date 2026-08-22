import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { hostGuard, originGuard, sessionAuth, TOKEN_HEADER } from "./guards.ts";
import { generateSessionToken } from "./session-token.ts";

const PORT = 7775;
const TOKEN = generateSessionToken();

function guardedApp() {
  return new Hono()
    .use(hostGuard(PORT))
    .use(originGuard(PORT))
    .use(sessionAuth(() => TOKEN))
    .get("/ping", (c) => c.text("pong"));
}

/** Hono is asked directly rather than over a socket: `Request` carries `Host` faithfully in Bun. */
async function call(headers: Record<string, string>, query = ""): Promise<Response> {
  return await guardedApp().fetch(
    new Request(`http://127.0.0.1:${PORT}/ping${query}`, { headers }),
  );
}

const AUTHORIZED = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` };

describe("hostGuard", () => {
  test("accepts every allowed loopback name at the bound port", async () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
      const res = await call({ host, authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(200);
    }
  });

  test("rejects a foreign Host — this is the DNS-rebinding defense", async () => {
    for (const host of [
      "evil.example",
      `evil.example:${PORT}`,
      "127.0.0.1",
      `127.0.0.1:${PORT + 1}`,
      `attacker.local.vrc.zip:${PORT}`,
      `local.vrc.zip.evil.example:${PORT}`,
      // `local.vrc.zip` was allowed while that opt-in was planned. It is cut (PROGRESS.md decision
      // 101), and a hostname nobody here controls any more must be rejected, not merely unused.
      `local.vrc.zip:${PORT}`,
    ]) {
      const res = await call({ host, authorization: `Bearer ${TOKEN}` });
      expect(res.status).toBe(403);
    }
  });

  test("rejects a request with no Host at all", async () => {
    const app = guardedApp();
    const request = new Request(`http://127.0.0.1:${PORT}/ping`);
    request.headers.delete("host");
    const res = await app.fetch(request);
    expect(res.status).toBe(403);
  });

  test("runs before auth, so a rebinding attempt learns nothing about the token", async () => {
    const res = await call({ host: "evil.example" });
    expect(res.status).toBe(403);
  });
});

describe("originGuard", () => {
  test("allows an absent Origin — non-browser clients send none", async () => {
    const res = await call(AUTHORIZED);
    expect(res.status).toBe(200);
  });

  test("allows every loopback origin at the bound port", async () => {
    for (const origin of [
      `http://127.0.0.1:${PORT}`,
      `http://localhost:${PORT}`,
      `https://127.0.0.1:${PORT}`,
      `https://localhost:${PORT}`,
    ]) {
      const res = await call({ ...AUTHORIZED, origin });
      expect(res.status).toBe(200);
    }
  });

  test("rejects a present but foreign Origin", async () => {
    for (const origin of [
      "http://evil.example",
      `http://evil.example:${PORT}`,
      `http://127.0.0.1:${PORT + 1}`,
      `http://local.vrc.zip:${PORT}`,
      "null",
    ]) {
      const res = await call({ ...AUTHORIZED, origin });
      expect(res.status).toBe(403);
    }
  });
});

describe("sessionAuth", () => {
  test("401s with no token", async () => {
    const res = await call({ host: `127.0.0.1:${PORT}` });
    expect(res.status).toBe(401);
  });

  test("401s with the wrong token, in every transport", async () => {
    const wrong = generateSessionToken();
    const host = `127.0.0.1:${PORT}`;
    expect((await call({ host, authorization: `Bearer ${wrong}` })).status).toBe(401);
    expect((await call({ host, [TOKEN_HEADER]: wrong })).status).toBe(401);
    expect((await call({ host }, `?token=${wrong}`)).status).toBe(401);
  });

  test("accepts the token as a bearer header", async () => {
    const res = await call({ host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  test(`accepts the token as ${TOKEN_HEADER}`, async () => {
    const res = await call({ host: `127.0.0.1:${PORT}`, [TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(200);
  });

  test("accepts the token as ?token=, which is what the launch URL carries", async () => {
    const res = await call({ host: `127.0.0.1:${PORT}` }, `?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  test("never accepts an empty expected token", async () => {
    const app = new Hono().use(sessionAuth(() => "")).get("/ping", (c) => c.text("pong"));
    const res = await app.fetch(new Request("http://127.0.0.1/ping?token="));
    expect(res.status).toBe(401);
  });
});
