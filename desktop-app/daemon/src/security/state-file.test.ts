import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateFilePath } from "../paths.ts";
import { generateSessionToken } from "./session-token.ts";
import { type DaemonState, readStateFile, removeStateFile, writeStateFile } from "./state-file.ts";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vrcz-state-"));
  env = { VRCZIP_STATE_DIR: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sampleState(): DaemonState {
  return {
    uiUrl: "http://127.0.0.1:7773",
    proxyUrl: "http://127.0.0.1:7774",
    controlUrl: "http://127.0.0.1:7775",
    sessionToken: generateSessionToken(),
    pid: process.pid,
    startedAt: Date.now(),
  };
}

describe("state.json", () => {
  test("round-trips", async () => {
    const state = sampleState();
    const path = await writeStateFile(state, env);
    expect(path).toBe(stateFilePath(env));
    expect(await readStateFile(env)).toEqual(state);
  });

  test("is 0600", async () => {
    await writeStateFile(sampleState(), env);
    const info = await stat(stateFilePath(env));
    if (process.platform === "win32") {
      // Windows does not implement the POSIX mode bits; `chmod` there only toggles the read-only
      // attribute, so asserting 0600 would be asserting a lie. ACL inheritance under %LOCALAPPDATA%
      // is what actually protects the file on this platform.
      expect(info.isFile()).toBe(true);
      return;
    }
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("overwrites a laxer existing file, permissions included", async () => {
    // `writeFile`'s `mode` applies only at creation, which is exactly why `writeStateFile` chmods
    // afterwards. Without that, a leftover 0644 file would keep its mode forever.
    const path = stateFilePath(env);
    await writeFile(path, "{}", { mode: 0o644 });
    const state = sampleState();
    await writeStateFile(state, env);
    expect(await readStateFile(env)).toEqual(state);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("leaves no temp file behind", async () => {
    await writeStateFile(sampleState(), env);
    const leftovers = [...new Bun.Glob("*.tmp").scanSync(dir)];
    expect(leftovers).toEqual([]);
  });

  test("reads as null when absent or corrupt", async () => {
    expect(await readStateFile(env)).toBeNull();
    await writeFile(stateFilePath(env), "not json");
    expect(await readStateFile(env)).toBeNull();
    await writeFile(stateFilePath(env), JSON.stringify({ uiUrl: "http://x" }));
    expect(await readStateFile(env)).toBeNull();
  });

  test("removes cleanly, and removing twice is not an error", async () => {
    await writeStateFile(sampleState(), env);
    await removeStateFile(env);
    await removeStateFile(env);
    expect(await readStateFile(env)).toBeNull();
  });
});
