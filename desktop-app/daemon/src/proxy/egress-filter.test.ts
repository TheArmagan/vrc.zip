import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mintProxyToken } from "../security/proxy-tokens.ts";
import {
  containsRealCredential,
  DEFAULT_MAX_BUFFERED_BYTES,
  type EgressViolation,
  guardEgress,
  scanHeaders,
  stripResponseHeaders,
} from "./egress-filter.ts";

/**
 * PLAN.md §Phase 2 names three fixtures by hand, and all three are here: an upstream `Set-Cookie`
 * carrying a real session, a `GET /auth` body carrying a real token, and VRChat's own pipeline
 * error frame, which echoes the `authToken` it is complaining about.
 */

const REAL_TOKEN = "authcookie_2e0a5f9c-1b3d-4a77-9f0e-6c1d2b3a4e5f";
const REAL_2FA = "authcookie_9f8e7d6c-5b4a-3210-fedc-ba9876543210";

/**
 * A real Hono app behind the guard, because the guard's whole reason for wrapping the fetch handler
 * rather than being middleware is a Hono behaviour — see the module comment. Testing it against a
 * bare function would not exercise that at all.
 */
function harness(handler: () => Response, options: { max?: number } = {}) {
  const violations: Array<{ violation: EgressViolation; path: string }> = [];
  const app = new Hono().all("*", () => handler());
  const fetch = guardEgress((request) => app.fetch(request), {
    onViolation: (violation, req) => violations.push({ violation, path: req.path }),
    ...(options.max !== undefined ? { maxBufferedBytes: options.max } : {}),
  });
  return {
    request: (path: string, init?: RequestInit) =>
      Promise.resolve(fetch(new Request(`http://127.0.0.1${path}`, init))),
    violations,
  };
}

describe("credential detection", () => {
  test("tells a real cookie from one of ours by shape alone", () => {
    expect(containsRealCredential(REAL_TOKEN)).toBe(true);
    expect(containsRealCredential(mintProxyToken().token)).toBe(false);
  });

  test("finds a credential embedded in surrounding text", () => {
    // VRChat's own pipeline error frame, verbatim from PLAN.md §1.5.
    const frame = JSON.stringify({
      err: "authToken doesn't correspond with an active session",
      authToken: REAL_TOKEN,
      ip: "203.0.113.4",
    });
    expect(containsRealCredential(frame)).toBe(true);
  });

  test("a real token immediately followed by our suffix is still classified as ours", () => {
    // The greedy match matters: a lazy pattern would find `authcookie_<uuid>` inside our own token
    // and fail every response we generate.
    expect(containsRealCredential(`${REAL_TOKEN}_vrczip`)).toBe(false);
  });

  test("scanning does not skip every other hit", () => {
    // The pattern is global; using it with `test()` would carry `lastIndex` between calls, which is
    // the classic way a scanner starts missing alternate matches.
    for (let i = 0; i < 4; i += 1) expect(containsRealCredential(REAL_TOKEN)).toBe(true);
  });

  test("scanHeaders names the header and never the value", () => {
    const headers = new Headers({ "X-Debug": `session ${REAL_TOKEN}` });
    expect(scanHeaders(headers)).toBe("x-debug");
    expect(scanHeaders(new Headers({ "X-Debug": "nothing here" }))).toBeNull();
  });
});

describe("header stripping", () => {
  test("Set-Cookie is removed unconditionally, not rewritten", () => {
    const headers = stripResponseHeaders(
      new Headers({
        "Set-Cookie": `auth=${REAL_TOKEN}; Path=/`,
        "Content-Type": "application/json",
      }),
    );
    expect(headers.get("set-cookie")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("an entirely benign upstream Set-Cookie is dropped too", () => {
    // Deliberately unconditional. A filter that only drops cookies it recognises as credentials is
    // one upstream change away from passing a new one through.
    const headers = stripResponseHeaders(new Headers({ "Set-Cookie": "theme=dark; Path=/" }));
    expect(headers.get("set-cookie")).toBeNull();
  });

  test("hop-by-hop headers do not survive the proxy either", () => {
    const headers = stripResponseHeaders(
      new Headers({ Connection: "keep-alive", "Transfer-Encoding": "chunked" }),
    );
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("transfer-encoding")).toBeNull();
  });
});

describe("the guard", () => {
  test("passes a clean response through byte for byte", async () => {
    // Byte fidelity is the whole point of the proxy, so the filter must not re-encode on the way
    // out. Non-ASCII and unusual key order both survive only if the original bytes are reused.
    const body = '{"z":1,"displayName":"Ada Lovelace \\u2014 ✨","a":2}';
    const { request } = harness(
      () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const response = await request("/api/1/users/usr_x");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  test("an upstream Set-Cookie reaches the client with no Set-Cookie at all", async () => {
    const { request, violations } = harness(
      () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "Set-Cookie": `auth=${REAL_TOKEN}; Path=/; HttpOnly` },
        }),
    );

    const response = await request("/api/1/auth/user");
    // Stripped before the scan, so this is a clean 200 rather than a fail-closed 500 — the header
    // is *expected* on this path and removing it is the designed behaviour, not a violation.
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(violations).toHaveLength(0);
  });

  test("a real token in the body fails closed with an empty 500", async () => {
    // `GET /auth` returns `{ok, token}`, and returning it verbatim hands over the real session.
    const { request, violations } = harness(
      () => new Response(JSON.stringify({ ok: true, token: REAL_TOKEN }), { status: 200 }),
    );

    const response = await request("/api/1/auth");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(violations).toHaveLength(1);
    expect(violations[0]?.violation.where).toBe("body");
    expect(violations[0]?.path).toBe("/api/1/auth");
  });

  test("a real token in some other header fails closed", async () => {
    const { request, violations } = harness(
      () => new Response("{}", { status: 200, headers: { "X-Upstream-Session": REAL_2FA } }),
    );

    const response = await request("/api/1/anything");
    expect(response.status).toBe(500);
    expect(violations[0]?.violation).toEqual({ where: "header", detail: "x-upstream-session" });
  });

  test("our own token passes, which is what makes the suffix load-bearing", async () => {
    const ours = mintProxyToken().token;
    const { request, violations } = harness(
      () => new Response(JSON.stringify({ ok: true, token: ours }), { status: 200 }),
    );

    const response = await request("/api/1/auth");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(ours);
    expect(violations).toHaveLength(0);
  });

  test("a bodyless response is not turned into one", async () => {
    const { request } = harness(() => new Response(null, { status: 204 }));
    const response = await request("/api/1/users/usr_x/note", { method: "DELETE" });
    expect(response.status).toBe(204);
  });

  test("a body too large to buffer is scanned as it streams and aborted on a hit", async () => {
    const filler = "x".repeat(4096);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(filler));
        controller.enqueue(Buffer.from(REAL_TOKEN));
        controller.close();
      },
    });
    const { request, violations } = harness(
      () =>
        new Response(stream, {
          status: 200,
          headers: { "Content-Length": String(filler.length + REAL_TOKEN.length) },
        }),
      { max: 1024 },
    );

    const response = await request("/api/1/file/file_x/1");
    // Status and headers are already out by then; destroying the transfer is what failing closed
    // looks like once the response has started.
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    expect(violations[0]?.violation.where).toBe("body");
  });

  test("a large clean body streams through untouched", async () => {
    const payload = "y".repeat(8192);
    const { request, violations } = harness(
      () => new Response(payload, { status: 200, headers: { "Content-Length": "8192" } }),
      { max: 1024 },
    );

    const response = await request("/api/1/file/file_x/1");
    expect(await response.text()).toBe(payload);
    expect(violations).toHaveLength(0);
  });

  test("the default buffering cap comfortably covers VRChat's JSON responses", () => {
    expect(DEFAULT_MAX_BUFFERED_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });
});
