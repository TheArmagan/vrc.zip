import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { loadOrCreateTlsMaterial } from "./ca.ts";
import { type ForwardProxy, startForwardProxy } from "./server.ts";

/**
 * The forward proxy end to end, against a real socket and a real TLS handshake.
 *
 * A `fetch` stub would prove nothing here. Every interesting behaviour lives below the `Request`
 * object: the `CONNECT` splice, the TLS termination, and the `Host` rewrite on the *second* request
 * of a kept-alive connection — which is the one a naive implementation gets wrong and which no
 * single-request test can see.
 *
 * The stand-in for the mirror reports what actually reached it, so an assertion about the rewrite is
 * an assertion about bytes rather than about intent.
 */

const HOSTS = ["api.vrchat.cloud", "pipeline.vrchat.cloud"];

interface Seen {
  host: string | null;
  forwardedHost: string | null;
  origin: string | null;
  proxyConnection: string | null;
  userAgent: string | null;
  cookie: string | null;
  method: string;
  path: string;
  body: string;
}

let stateDir: string;
let env: NodeJS.ProcessEnv;
let mirror: Server<unknown>;
/**
 * The stand-in mirror's port. Initialised to a value rather than left bare so the assertions can
 * read it without a definite-assignment assertion, which Biome bans.
 */
let mirrorPort = 0;
let proxy: ForwardProxy;
let caCertPem: string;

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "vrczip-forward-"));
  env = { ...process.env, VRCZIP_STATE_DIR: stateDir };

  mirror = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const seen: Seen = {
        host: request.headers.get("host"),
        forwardedHost: request.headers.get("x-vrcz-forwarded-host"),
        origin: request.headers.get("origin"),
        proxyConnection: request.headers.get("proxy-connection"),
        userAgent: request.headers.get("user-agent"),
        cookie: request.headers.get("cookie"),
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body: await request.text(),
      };
      return Response.json(seen);
    },
  });

  // `Server.port` is optional only because a unix-socket server has none. This one is TCP.
  if (mirror.port === undefined) throw new Error("the stand-in mirror bound no TCP port");
  mirrorPort = mirror.port;

  proxy = await startForwardProxy({
    port: 0,
    mirrorPort,
    interceptHosts: HOSTS,
    env,
  });
  caCertPem = (await loadOrCreateTlsMaterial(HOSTS, env)).caCertPem;
});

afterAll(async () => {
  await proxy.stop();
  mirror.stop(true);
  await rm(stateDir, { recursive: true, force: true });
});

/** A request through the proxy, verified strictly against the daemon's own CA. */
function through(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.vrchat.cloud${path}`, {
    ...init,
    proxy: proxy.url,
    tls: { ca: caCertPem },
  });
}

describe("CONNECT interception", () => {
  test("rewrites an intercepted host onto the mirror", async () => {
    const seen = (await (
      await through("/api/1/auth/user?x=1", {
        headers: {
          "User-Agent": "MyApp/1.0 me@example.com",
          Cookie: "auth=authcookie_abc_vrczip",
          // The mirror's `originGuard` would 403 this. The proxy is the client, not the page.
          Origin: "https://vrchat.com",
        },
      })
    ).json()) as Seen;

    expect(seen.host).toBe(`127.0.0.1:${String(mirrorPort)}`);
    expect(seen.path).toBe("/api/1/auth/user?x=1");
    expect(seen.forwardedHost).toBe("api.vrchat.cloud");
    expect(seen.origin).toBeNull();
    // The two headers the handshake actually authenticates on must survive untouched.
    expect(seen.userAgent).toBe("MyApp/1.0 me@example.com");
    expect(seen.cookie).toBe("auth=authcookie_abc_vrczip");
  });

  test("forwards a request body", async () => {
    const seen = (await (
      await through("/api/1/auth/twofactorauth/totp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456" }),
      })
    ).json()) as Seen;

    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"code":"123456"}');
  });

  test("rewrites every request on one kept-alive connection, not only the first", async () => {
    // Driven over one raw TLS socket rather than through `fetch`, which is free to open a second
    // connection and would quietly make this test vacuous. Two pipelined requests, one socket.
    const responses = await pipelineOverTls([
      "GET /api/1/first HTTP/1.1\r\nHost: api.vrchat.cloud\r\n\r\n",
      "GET /api/1/second HTTP/1.1\r\nHost: api.vrchat.cloud\r\n\r\n",
    ]);

    const paths = [...responses.matchAll(/"path":"([^"]+)"/g)].map((match) => match[1]);
    expect(paths).toEqual(["/api/1/first", "/api/1/second"]);
    // If framing were skipped, the second would arrive with `Host: api.vrchat.cloud` and be a 403.
    const hosts = [...responses.matchAll(/"host":"([^"]+)"/g)].map((match) => match[1]);
    expect(hosts).toEqual([`127.0.0.1:${String(mirrorPort)}`, `127.0.0.1:${String(mirrorPort)}`]);
  });

  test("a host outside the intercept set is refused rather than decrypted by accident", async () => {
    // Reaching the TLS listener with an unlisted `Host` is only possible by coalescing, which the
    // SAN list prevents; forging it here proves the second line of defense answers 421.
    const response = await pipelineOverTls(["GET /api/1/x HTTP/1.1\r\nHost: evil.example\r\n\r\n"]);
    expect(response).toContain("421 Misdirected Request");
  });
});

describe("the port itself", () => {
  test("serves the setup page to a browser pointed straight at it", async () => {
    const response = await fetch(`${proxy.url}/`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    expect(body).toContain("--proxy-server=");
  });

  test("serves the CA certificate for download", async () => {
    const response = await fetch(`${proxy.url}/vrczip-ca.crt`);
    expect(response.headers.get("content-type")).toBe("application/x-x509-ca-cert");
    expect(await response.text()).toStartWith("-----BEGIN CERTIFICATE-----");
  });

  test("origin-form never reaches the mirror, whatever path it names", async () => {
    // The only request shape a web page can produce. If this could route, a page on any origin
    // could drive the mirror; the 404 is what makes that structurally impossible.
    const response = await fetch(`${proxy.url}/api/1/auth/user`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("HTTP proxy");
  });

  test("a malformed CONNECT target is a 400, not a crash", async () => {
    const response = await rawProxyRequest("CONNECT nonsense HTTP/1.1\r\nHost: nonsense\r\n\r\n");
    expect(response).toContain("400 Bad Request");
  });

  test("an unreachable upstream is a 502", async () => {
    // Port 1 on loopback: nothing listens, and the connect fails fast rather than hanging.
    const response = await rawProxyRequest(
      "GET http://127.0.0.1:1/x HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n",
    );
    expect(response).toContain("502 Bad Gateway");
  });
});

describe("plaintext absolute-form", () => {
  test("routes an intercepted host to the mirror with no certificate involved", async () => {
    // The one path that works before the CA is installed, which is why it is supported at all.
    const raw = await rawProxyRequest(
      "GET http://api.vrchat.cloud/api/1/plain HTTP/1.1\r\nHost: api.vrchat.cloud\r\nProxy-Connection: keep-alive\r\n\r\n",
    );
    expect(raw).toContain('"path":"/api/1/plain"');
    expect(raw).toContain(`"host":"127.0.0.1:${String(mirrorPort)}"`);
    // Hop-by-hop and addressed to us, so it must not reach the mirror.
    expect(raw).toContain('"proxyConnection":null');
  });
});

// --- raw socket helpers ------------------------------------------------------

/** Writes one message to the proxy port and reads until it closes. */
function rawProxyRequest(message: string): Promise<string> {
  const port = proxy.port;
  return new Promise((resolve, reject) => {
    let received = "";
    const timer = setTimeout(() => reject(new Error("timed out")), 5000);
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => void socket.write(message),
        data: (_socket, bytes) => {
          received += Buffer.from(bytes).toString("latin1");
        },
        close: () => {
          clearTimeout(timer);
          resolve(received);
        },
        error: (_socket, error) => {
          clearTimeout(timer);
          reject(error);
        },
      },
    }).catch(reject);
  });
}

/**
 * `CONNECT`s through the proxy, upgrades to TLS as `api.vrchat.cloud`, and pipelines the given
 * requests down that one connection.
 *
 * The two-step is the point: `Bun.connect` opens plaintext, the proxy answers
 * `200 Connection Established`, and only then does `upgradeTLS` run the handshake the daemon's leaf
 * certificate has to satisfy.
 */
function pipelineOverTls(requests: readonly string[]): Promise<string> {
  const port = proxy.port;
  return new Promise((resolve, reject) => {
    let established = false;
    let received = "";
    const timer = setTimeout(() => resolve(received), 1500);

    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (socket) => {
          void socket.write(
            "CONNECT api.vrchat.cloud:443 HTTP/1.1\r\nHost: api.vrchat.cloud:443\r\n\r\n",
          );
        },
        data: (socket, bytes) => {
          const text = Buffer.from(bytes).toString("latin1");
          if (established) {
            received += text;
            return;
          }
          if (!text.startsWith("HTTP/1.1 200")) {
            clearTimeout(timer);
            reject(new Error(`CONNECT refused: ${text.split("\r\n")[0] ?? ""}`));
            return;
          }
          established = true;
          // Returns `[rawSocket, tlsSocket]`; the handlers below are where everything happens.
          socket.upgradeTLS({
            tls: { ca: caCertPem, serverName: "api.vrchat.cloud", rejectUnauthorized: true },
            data: undefined,
            socket: {
              open: (tlsSocket) => {
                for (const request of requests) void tlsSocket.write(request);
              },
              data: (_tlsSocket, chunk) => {
                received += Buffer.from(chunk).toString("latin1");
              },
              close: () => {
                clearTimeout(timer);
                resolve(received);
              },
              error: (_tlsSocket, error) => {
                clearTimeout(timer);
                reject(error);
              },
            },
          });
        },
        close: () => {
          if (!established) {
            clearTimeout(timer);
            resolve(received);
          }
        },
        error: (_socket, error) => {
          clearTimeout(timer);
          reject(error);
        },
      },
    }).catch(reject);
  });
}
