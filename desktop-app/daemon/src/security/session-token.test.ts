import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateFilePath } from "../paths.ts";
import {
  generateSessionToken,
  isWellFormedSessionToken,
  resolveSessionToken,
  SESSION_TOKEN_LENGTH,
  sessionTokensMatch,
  stableSessionTokenRequested,
} from "./session-token.ts";
import { writeStateFile } from "./state-file.ts";

describe("session tokens", () => {
  test("are 32 bytes of hex and unique per call", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).toHaveLength(SESSION_TOKEN_LENGTH);
    expect(isWellFormedSessionToken(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  test("compare equal only to themselves", () => {
    const token = generateSessionToken();
    expect(sessionTokensMatch(token, token)).toBe(true);
    expect(sessionTokensMatch(token, generateSessionToken())).toBe(false);
  });

  test("compare without throwing on mismatched lengths", () => {
    // The naive `timingSafeEqual` on raw buffers throws here, which would turn a hostile token into
    // a 500 and leak the expected length.
    const token = generateSessionToken();
    expect(sessionTokensMatch("", token)).toBe(false);
    expect(sessionTokensMatch("x".repeat(4096), token)).toBe(false);
    expect(sessionTokensMatch(token.slice(0, -1), token)).toBe(false);
  });

  test("reject malformed tokens as ill-formed", () => {
    expect(isWellFormedSessionToken("")).toBe(false);
    expect(isWellFormedSessionToken("Z".repeat(SESSION_TOKEN_LENGTH))).toBe(false);
    expect(isWellFormedSessionToken(generateSessionToken().toUpperCase())).toBe(false);
  });
});

describe("dev-mode token reuse", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vrcz-token-"));
    // Keeps every read and write in this block off the real state tree.
    env = { VRCZIP_STATE_DIR: dir };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function storeToken(sessionToken: string): Promise<void> {
    await writeStateFile(
      {
        uiUrl: "http://127.0.0.1:7773",
        proxyUrl: "http://127.0.0.1:7774",
        controlUrl: "http://127.0.0.1:7775",
        sessionToken,
        pid: process.pid,
        startedAt: Date.now(),
      },
      env,
    );
  }

  test("is off unless asked for", () => {
    // `execArgv` is passed explicitly throughout so the result does not depend on how the test
    // runner itself was launched — `bun test --watch` would otherwise flip these assertions.
    expect(stableSessionTokenRequested({}, [])).toBe(false);
    expect(stableSessionTokenRequested({ VRCZIP_STABLE_TOKEN: "0" }, [])).toBe(false);
    expect(stableSessionTokenRequested({ VRCZIP_STABLE_TOKEN: "1" }, [])).toBe(true);
    expect(stableSessionTokenRequested({ VRCZIP_STABLE_TOKEN: "TRUE" }, [])).toBe(true);
    expect(stableSessionTokenRequested({}, ["--watch"])).toBe(true);
    expect(stableSessionTokenRequested({}, ["--hot"])).toBe(true);
  });

  test("mints a fresh token by default, even with a valid one stored", async () => {
    const stored = generateSessionToken();
    await storeToken(stored);

    const resolved = await resolveSessionToken({ env, execArgv: [] });
    expect(resolved.stable).toBe(false);
    expect(resolved.reused).toBe(false);
    expect(resolved.token).not.toBe(stored);
    expect(isWellFormedSessionToken(resolved.token)).toBe(true);
  });

  test("reuses the stored token when the env var is set", async () => {
    const stored = generateSessionToken();
    await storeToken(stored);

    const resolved = await resolveSessionToken({
      env: { ...env, VRCZIP_STABLE_TOKEN: "1" },
      execArgv: [],
    });
    expect(resolved).toEqual({ token: stored, reused: true, stable: true });
    // The whole point: the browser tab holding the old token still authenticates.
    expect(sessionTokensMatch(resolved.token, stored)).toBe(true);
  });

  test("mints a fresh token when there is no state.json to reuse", async () => {
    const resolved = await resolveSessionToken({
      env: { ...env, VRCZIP_STABLE_TOKEN: "1" },
      execArgv: [],
    });
    expect(resolved.stable).toBe(true);
    expect(resolved.reused).toBe(false);
    expect(isWellFormedSessionToken(resolved.token)).toBe(true);
  });

  test("refuses a malformed stored token rather than trusting it", async () => {
    for (const bad of ["", "deadbeef", generateSessionToken().toUpperCase(), "z".repeat(64)]) {
      await storeToken(bad);
      const resolved = await resolveSessionToken({
        env: { ...env, VRCZIP_STABLE_TOKEN: "1" },
        execArgv: [],
      });
      expect(resolved.reused).toBe(false);
      expect(resolved.token).not.toBe(bad);
      expect(isWellFormedSessionToken(resolved.token)).toBe(true);
    }
  });

  test("ignores a state.json that is not JSON at all", async () => {
    await writeFile(stateFilePath(env), "{ half a fi", "utf8");
    const resolved = await resolveSessionToken({
      env: { ...env, VRCZIP_STABLE_TOKEN: "1" },
      execArgv: [],
    });
    expect(resolved.reused).toBe(false);
    expect(isWellFormedSessionToken(resolved.token)).toBe(true);
  });
});
