import { DEFAULT_FORWARD_PROXY_PORT, DEFAULT_HOSTNAME } from "@vrcz/shared";
import type { Socket, TCPSocketListener } from "bun";
import { loadOrCreateTlsMaterial, normaliseHosts } from "./ca.ts";
import {
  HttpParseError,
  header,
  parseAbsoluteTarget,
  parseAuthority,
  RequestFramer,
  type RequestHead,
  serializeHead,
  withHeader,
  withoutHeader,
  withTarget,
} from "./http-message.ts";
import { httpResponse, Writer } from "./relay.ts";
import { helpPage } from "./welcome.ts";

/**
 * The forward proxy on `:7776`. See PLAN.md §Phase 2.
 *
 * The mirror on `:7774` asks an app to change its base URL. Plenty of apps cannot — VRCX drives its
 * HTTP through Chromium, which takes `--proxy-server=` and nothing else. This port is the answer:
 * a real HTTP proxy, the kind any proxy-aware app already knows how to talk to, which quietly turns
 * `https://api.vrchat.cloud/api/1/...` into a request against the local mirror.
 *
 * Three request shapes arrive here and each is handled differently on purpose:
 *
 *  - **`CONNECT api.vrchat.cloud:443`** — the only shape that matters in practice, because VRChat
 *    is HTTPS. For an intercepted host the tunnel is spliced into an internal TLS listener holding
 *    a certificate from the daemon's own CA (`ca.ts`), so the bytes come back out in plaintext and
 *    can be routed to `:7774`. For every other host it is a blind byte pipe to the real server:
 *    vrc.zip is not in the business of reading a user's unrelated traffic, and a proxy that refused
 *    everything else would need a bypass list maintained by hand.
 *  - **`GET http://api.vrchat.cloud/api/1/...`** — absolute-form plaintext. Rare, but it is the one
 *    path that works with no CA installed at all, so it is worth supporting.
 *  - **`GET /`** — someone pointed a browser straight at the port. Answered with the setup page and
 *    the CA download, and **never** routed to the mirror. That distinction is load-bearing: a web
 *    page can send this shape, and cannot send the other two.
 *
 * Nothing here authenticates. It does not need to — the mirror behind it runs the full consent
 * handshake, and this port adds no reach that a local process did not already have against `:7774`.
 */

/** VRChat hosts whose TLS is terminated so the traffic can be routed to the mirror. */
export const DEFAULT_INTERCEPT_HOSTS = ["api.vrchat.cloud", "pipeline.vrchat.cloud"] as const;

export interface ForwardProxyOptions {
  /** Preferred port. `0` asks for an ephemeral one outright. */
  port?: number;
  hostname?: string;
  /** Where intercepted traffic goes: the bound port of the mirror on `:7774`. */
  mirrorPort: number;
  mirrorHostname?: string;
  /**
   * Hosts to intercept. The leaf certificate carries exactly this set as its SANs, so narrowing it
   * is also what stops the client from coalescing an unlisted origin onto an open connection.
   */
  interceptHosts?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface ForwardProxy {
  /** The origin an app is configured with: `http://127.0.0.1:7776`. */
  readonly url: string;
  readonly port: number;
  /** True when the preferred port was taken and an ephemeral one was used instead. */
  readonly fellBack: boolean;
  /** Where `ca.crt` sits on disk, so the startup banner can name something the user can act on. */
  readonly caCertPath: string;
  /** True when this run minted a new CA — the user has to install it before anything works. */
  readonly caIsNew: boolean;
  readonly interceptHosts: readonly string[];
  stop(): Promise<void>;
}

export async function startForwardProxy(options: ForwardProxyOptions): Promise<ForwardProxy> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const mirror = {
    hostname: options.mirrorHostname ?? DEFAULT_HOSTNAME,
    port: options.mirrorPort,
  };
  const interceptHosts = normaliseHosts(options.interceptHosts ?? DEFAULT_INTERCEPT_HOSTS);
  const tls = await loadOrCreateTlsMaterial(interceptHosts, options.env);
  const intercepted = new Set(interceptHosts);

  // --- the internal TLS listener -------------------------------------------
  // Bound on an ephemeral port and never advertised anywhere. A `CONNECT` for an intercepted host
  // is spliced into it, so the client's TLS handshake terminates here rather than at VRChat, and
  // what falls out the other side is ordinary plaintext HTTP for `routeToMirror` to rewrite.
  const mitm = Bun.listen<Conn>({
    hostname: DEFAULT_HOSTNAME,
    port: 0,
    tls: { key: tls.leafKeyPem, cert: tls.chainPem },
    socket: clientHandlers((conn, head) => routeToMirror(conn, head, mirror, intercepted)),
  });
  const mitmPort = mitm.port;

  // --- the public listener --------------------------------------------------
  const wanted = options.port ?? DEFAULT_FORWARD_PROXY_PORT;
  const page = () =>
    helpPage({
      proxyUrl: `http://${hostname}:${bound.port}`,
      caCertPath: tls.caCertPath,
      hosts: interceptHosts,
      mirrorPort: mirror.port,
    });

  const handlers = clientHandlers((conn, head) =>
    routePublic(conn, head, {
      mirror,
      intercepted,
      mitmPort,
      caCertPem: tls.caCertPem,
      page,
    }),
  );

  let fellBack = false;
  let bound: TCPSocketListener<Conn>;
  try {
    bound = Bun.listen<Conn>({ hostname, port: wanted, socket: handlers });
  } catch (error) {
    if (wanted === 0 || !isAddressInUse(error)) {
      mitm.stop(true);
      throw error;
    }
    fellBack = true;
    bound = Bun.listen<Conn>({ hostname, port: 0, socket: handlers });
  }

  return {
    url: `http://${hostname}:${bound.port}`,
    port: bound.port,
    fellBack,
    caCertPath: tls.caCertPath,
    caIsNew: tls.caIsNew,
    interceptHosts,
    async stop(): Promise<void> {
      bound.stop(true);
      mitm.stop(true);
      await Promise.resolve();
    },
  };
}

function isAddressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EADDRINUSE" || code === "WSAEADDRINUSE";
}

// --- one client connection ---------------------------------------------------

/** Decides what to do with a request head. Differs between the public port and the TLS listener. */
type HeadRouter = (conn: Conn, head: RequestHead) => void;

/**
 * One connection from a client, and the one upstream connection it is currently attached to.
 *
 * Both directions are `Writer`s rather than raw sockets so that a head can be written before its
 * upstream socket exists — which is the normal case, since routing decides where to connect and
 * connecting is asynchronous while the client keeps sending.
 */
class Conn {
  readonly toClient = new Writer();
  readonly toUpstream = new Writer();
  readonly framer = new RequestFramer();
  readonly route: HeadRouter;

  /** Set once an upstream is chosen. A second choice on the same connection is a bug, not a retry. */
  #upstream: Socket<Conn> | null = null;
  #connecting = false;
  #done = false;

  constructor(route: HeadRouter) {
    this.route = route;
  }

  get hasUpstream(): boolean {
    return this.#connecting || this.#upstream !== null;
  }

  onData(chunk: Uint8Array): void {
    if (this.#done) return;
    let segments: ReturnType<RequestFramer["push"]>;
    try {
      // Copied rather than retained. Bun hands the same `Buffer` shape back on every read and the
      // framer keeps a partial head across reads, so aliasing it would be a corruption bug that
      // only appears when a message happens to straddle a TCP segment.
      segments = this.framer.push(new Uint8Array(chunk));
    } catch (error) {
      this.fail(error);
      return;
    }

    for (const segment of segments) {
      if (segment.kind === "raw") {
        this.toUpstream.write(segment.bytes);
      } else if (segment.kind === "head") {
        this.route(this, segment.head);
      }
      // `end` needs nothing: the body was forwarded verbatim, framing included.
    }
  }

  /** Opens the one upstream connection this client connection will use. */
  connect(target: { hostname: string; port: number }, onReady?: () => void): void {
    if (this.hasUpstream) return;
    this.#connecting = true;

    Bun.connect<Conn>({
      hostname: target.hostname,
      port: target.port,
      data: this,
      socket: {
        open: (socket) => {
          this.#connecting = false;
          this.#upstream = socket;
          // Before `attach`, so a `200 Connection Established` reaches the client ahead of the
          // first byte the upstream sends.
          onReady?.();
          this.toUpstream.attach(socket as Socket<unknown>);
        },
        data: (_socket, bytes) => {
          // Responses are never parsed. Whatever the mirror said travels back byte for byte, which
          // is the property the whole mirror exists to have.
          this.toClient.write(new Uint8Array(bytes));
        },
        drain: () => this.toUpstream.resume(),
        close: () => {
          this.#upstream = null;
          // Half-close rather than destroy: the last of the response may still be queued.
          this.toClient.end();
        },
        error: () => this.close(),
        connectError: () => {
          this.#connecting = false;
          this.respond(
            httpResponse(
              502,
              "Bad Gateway",
              `vrc.zip could not reach ${target.hostname}:${String(target.port)}.\n`,
            ),
          );
        },
      },
    }).catch(() => {
      this.#connecting = false;
      this.respond(httpResponse(502, "Bad Gateway", "vrc.zip could not open the upstream.\n"));
    });
  }

  /** Answers the client itself and closes. Used for errors and for the local setup page. */
  respond(bytes: Uint8Array): void {
    if (this.#done) return;
    this.#done = true;
    this.toClient.write(bytes);
    this.toClient.end();
    this.toUpstream.destroy();
  }

  fail(error: unknown): void {
    const status = error instanceof HttpParseError ? error.status : 400;
    const reason = error instanceof HttpParseError ? error.message : "malformed request";
    this.respond(httpResponse(status, "Bad Request", `vrc.zip proxy: ${reason}\n`));
  }

  close(): void {
    this.#done = true;
    this.toClient.destroy();
    this.toUpstream.destroy();
  }
}

function clientHandlers(route: HeadRouter) {
  return {
    open(socket: Socket<Conn>): void {
      socket.data = new Conn(route);
      socket.data.toClient.attach(socket as Socket<unknown>);
    },
    data(socket: Socket<Conn>, bytes: Uint8Array): void {
      socket.data.onData(bytes);
    },
    drain(socket: Socket<Conn>): void {
      socket.data.toClient.resume();
    },
    close(socket: Socket<Conn>): void {
      socket.data.close();
    },
    error(socket: Socket<Conn>): void {
      socket.data.close();
    },
  };
}

// --- routing -----------------------------------------------------------------

interface PublicPolicy {
  readonly mirror: { hostname: string; port: number };
  readonly intercepted: ReadonlySet<string>;
  readonly mitmPort: number;
  readonly caCertPem: string;
  readonly page: () => string;
}

function routePublic(conn: Conn, head: RequestHead, policy: PublicPolicy): void {
  if (head.method === "CONNECT") {
    const authority = parseAuthority(head.target);
    if (authority === null) {
      conn.respond(httpResponse(400, "Bad Request", `vrc.zip proxy: bad CONNECT target\n`));
      return;
    }

    // An intercepted host is spliced into the internal TLS listener; everything else goes to the
    // real server untouched. Either way the proxy writes the 200 only once the far side is up, so
    // a client never starts a handshake against a tunnel that failed to open.
    const target = policy.intercepted.has(authority.host)
      ? { hostname: DEFAULT_HOSTNAME, port: policy.mitmPort }
      : { hostname: authority.host, port: authority.port };

    conn.connect(target, () => {
      conn.toClient.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
    });
    return;
  }

  const absolute = parseAbsoluteTarget(head.target);
  if (absolute !== null) {
    // **One absolute-form request per connection, whichever way it routes.**
    //
    // A `Conn` binds to exactly one upstream, and a client is entitled to send its *next* request
    // for a completely different origin down the same proxy connection — browsers do. Without this
    // the second request would be handed to the first request's upstream, because `connect()` is a
    // no-op once an upstream exists: a silent misroute rather than an error. `Connection: close`
    // tells the client not to try, and tunnelling the framer stops us looking for a request line we
    // have already decided not to honour.
    const oneShot = withHeader(withTarget(head, absolute.path), "Connection", "close");
    conn.framer.tunnel();

    if (policy.intercepted.has(absolute.host)) {
      routeToMirror(conn, oneShot, policy.mirror, policy.intercepted, { host: absolute.host });
      return;
    }

    // A plain forward for anything else.
    const forwarded = withHeader(
      withHeader(oneShot, "Host", hostHeaderFor(absolute)),
      "Connection",
      "close",
    );
    conn.connect({ hostname: absolute.host, port: absolute.port });
    conn.toUpstream.write(serializeHead(withoutHeader(forwarded, "Proxy-Connection")));
    return;
  }

  // Origin-form: a browser pointed straight at the port rather than configured to use it. This is
  // the only shape a web page can produce, so it must never reach the mirror — it gets the setup
  // page and the CA download and nothing else.
  servePage(conn, head, policy);
}

/** The `Host` a plain forward should carry: the default port is omitted, as a client would omit it. */
function hostHeaderFor(target: { host: string; port: number; scheme: string }): string {
  const isDefault =
    (target.scheme === "http" && target.port === 80) ||
    (target.scheme === "https" && target.port === 443);
  return isDefault ? target.host : `${target.host}:${String(target.port)}`;
}

/**
 * Rewrites a VRChat request onto the mirror.
 *
 * Only three things change, and each is deliberate:
 *
 *  - **`Host` becomes the mirror's own.** `hostGuard` on `:7774` is the DNS-rebinding defense and
 *    rejects anything else. This is also why the framer has to segment the stream at all: every
 *    request on a kept-alive connection needs it, not merely the first.
 *  - **`Origin` is dropped.** It describes the *app's* page, which means nothing to the mirror, and
 *    `originGuard` would answer a spurious 403 to a request that came nowhere near a browser's
 *    cross-site path. The proxy is the client here.
 *  - **`Proxy-Connection` is dropped**, being hop-by-hop and addressed to us.
 *
 * Everything else — `Cookie`, `Authorization`, `User-Agent`, the body — passes through untouched,
 * which is what lets the mirror run its normal consent handshake against the app's real identity.
 */
function routeToMirror(
  conn: Conn,
  head: RequestHead,
  mirror: { hostname: string; port: number },
  intercepted: ReadonlySet<string>,
  known?: { host: string },
): void {
  const host = known?.host ?? hostOf(head);
  if (host === null || !intercepted.has(host)) {
    // Only reachable if a client coalesced an origin the leaf does not name, which the SAN list is
    // built to prevent. 421 is the status that tells it to open its own connection instead.
    conn.respond(
      httpResponse(
        421,
        "Misdirected Request",
        `vrc.zip proxy: ${host ?? "this request"} is not an intercepted host.\n`,
      ),
    );
    return;
  }

  const rewritten = withoutHeader(
    withoutHeader(withHeader(head, "Host", `${mirror.hostname}:${String(mirror.port)}`), "Origin"),
    "Proxy-Connection",
  );

  conn.connect(mirror);
  conn.toUpstream.write(serializeHead(withHeader(rewritten, "X-Vrcz-Forwarded-Host", host)));
}

/** The `Host` header, port stripped, or the authority out of an absolute-form target. */
function hostOf(head: RequestHead): string | null {
  const absolute = parseAbsoluteTarget(head.target);
  if (absolute !== null) return absolute.host;

  const raw = header(head, "host");
  if (raw === undefined) return null;
  const colon = raw.lastIndexOf(":");
  return (colon > 0 ? raw.slice(0, colon) : raw).trim().toLowerCase();
}

function servePage(conn: Conn, head: RequestHead, policy: PublicPolicy): void {
  const path = head.target.split("?")[0] ?? "/";
  if (head.method !== "GET" && head.method !== "HEAD") {
    conn.respond(httpResponse(405, "Method Not Allowed", "vrc.zip proxy: use GET.\n"));
    return;
  }

  if (path === "/vrczip-ca.crt" || path === "/ca.crt") {
    conn.respond(
      httpResponse(200, "OK", policy.caCertPem, "application/x-x509-ca-cert", [
        ["Content-Disposition", 'attachment; filename="vrczip-ca.crt"'],
      ]),
    );
    return;
  }

  if (path === "/") {
    conn.respond(httpResponse(200, "OK", policy.page(), "text/html; charset=utf-8"));
    return;
  }

  conn.respond(
    httpResponse(
      404,
      "Not Found",
      "vrc.zip proxy: this port is an HTTP proxy. Configure it as one, or open / for setup.\n",
    ),
  );
}
