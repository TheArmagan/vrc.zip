import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeStateFile } from "../security/state-file.ts";
import { forwardDeepLink } from "./deeplink.ts";

const LINK = "vrczip://selectavatar/avtr_c38a1615-5bf5-42b4-84eb-a8b6c37cbd11/1";

describe("forwardDeepLink", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vrczip-deeplink-"));
    env = { ...process.env, VRCZIP_STATE_DIR: dir };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeState(controlUrl: string): Promise<void> {
    await writeStateFile(
      {
        uiUrl: "http://127.0.0.1:7773",
        proxyUrl: "http://127.0.0.1:7774",
        controlUrl,
        sessionToken: "token-1",
        pid: process.pid,
        startedAt: Date.now(),
      },
      env,
    );
  }

  test("no state file means no daemon", async () => {
    expect(await forwardDeepLink(LINK, { env })).toBe("not-running");
  });

  test("posts the link whole to a running daemon, with its token", async () => {
    const received: { auth: string | null; body: unknown }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        received.push({ auth: request.headers.get("authorization"), body: await request.json() });
        return Response.json({ status: "ok" });
      },
    });
    try {
      await writeState(`http://127.0.0.1:${String(server.port)}`);
      expect(await forwardDeepLink(LINK, { env })).toBe("handled");
      expect(received).toEqual([{ auth: "Bearer token-1", body: { url: LINK } }]);
    } finally {
      await server.stop(true);
    }
  });

  test("a refusal from the daemon is still handled: it has already said why", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ error: "unknown_account" }, { status: 404 }),
    });
    try {
      await writeState(`http://127.0.0.1:${String(server.port)}`);
      expect(await forwardDeepLink(LINK, { env })).toBe("handled");
    } finally {
      await server.stop(true);
    }
  });

  test("a state file left by a crash, with nothing listening, means not running", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const url = `http://127.0.0.1:${String(server.port)}`;
    await server.stop(true);
    await writeState(url);
    expect(await forwardDeepLink(LINK, { env })).toBe("not-running");
  });

  test("a daemon that is slow to answer is not a reason to start a rival", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(500);
        return new Response();
      },
    });
    try {
      await writeState(`http://127.0.0.1:${String(server.port)}`);
      expect(await forwardDeepLink(LINK, { env, timeoutMs: 50 })).toBe("handled");
    } finally {
      await server.stop(true);
    }
  });
});
