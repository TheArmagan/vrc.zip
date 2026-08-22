import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOSTNAME,
  DEFAULT_PROXY_PORT,
  DEFAULT_UI_PORT,
  launchUrl as sharedLaunchUrl,
} from "@vrcz/shared";
import type { Server, WebSocketHandler } from "bun";
import { type EgressViolation, filterResponse } from "../proxy/egress-filter.ts";
import type { ProxyDeps } from "../proxy/handshake.ts";
import type { ProxyLogger } from "../proxy/request-log.ts";
import type { TokenSource } from "../security/guards.ts";
import { type ControlDeps, controlWebSocketHandler, createControlApp } from "./control.ts";
import { createProxyApp, proxyWebSocketHandler } from "./proxy.ts";
import { createUiApp } from "./ui.ts";

/**
 * Binding the three servers. See PLAN.md §1.8.
 *
 * Three `Bun.serve` calls over three separate `Hono` instances, never one app with path prefixes:
 * the mirror must be structurally unable to serve a control route.
 *
 * `http://127.0.0.1:PORT` is the runtime default — no external dependency, no cert, nothing to
 * fail. `local.vrc.zip` is opt-in and resolved by the caller; both hostnames are already in the
 * `Host` allowlist, so switching is a matter of which URL gets printed.
 *
 * Ports fall back to an ephemeral one when the preferred port is taken. A second daemon, or an
 * unrelated process squatting on 7773, must not be a startup failure — the URLs are discovered from
 * `state.json`, not assumed.
 */

/** `Bun.serve` returns a generic `Server`; the daemon never attaches per-socket data of its own. */
type BunServer = Server<unknown>;

// Defined in `@vrcz/shared` so the settings defaults and the UI agree on the same numbers, and
// re-exported here because `servers/index.ts` and the rest of the daemon import them from `bind`.
export {
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOSTNAME,
  DEFAULT_PROXY_PORT,
  DEFAULT_UI_PORT,
} from "@vrcz/shared";

/**
 * The shape `Bun.serve` needs from an app. Structural rather than `Hono`-typed, because each
 * instance's chained route type is its own and none of them is assignable to a bare `Hono`.
 */
export interface FetchApp {
  fetch(request: Request, env: BunServer): Response | Promise<Response>;
}

export interface BoundServer {
  /** The origin, with no trailing slash: `http://127.0.0.1:7773`. */
  url: string;
  port: number;
  server: BunServer;
  /** True when the preferred port was taken and an ephemeral one was used instead. */
  fellBack: boolean;
}

export interface BindServerOptions {
  /** Preferred port. `0` asks for an ephemeral one outright. */
  port: number;
  hostname?: string;
  /**
   * Built *after* the port is known, so the `Host` allowlist matches the port actually bound. Safe
   * because `Bun.serve` returns synchronously: no request can be served before this returns.
   */
  createApp: (port: number) => FetchApp;
  websocket?: WebSocketHandler<unknown>;
}

/** Binds one server, falling back to an ephemeral port if the preferred one is taken. */
export function bindServer({
  port,
  hostname = DEFAULT_HOSTNAME,
  createApp,
  websocket,
}: BindServerOptions): BoundServer {
  let app: FetchApp | undefined;
  const fetch = (request: Request, server: BunServer): Response | Promise<Response> => {
    if (app === undefined) throw new Error("server received a request before it was wired");
    return app.fetch(request, server);
  };

  // Two call sites rather than a spread: `Bun.serve`'s options are a union whose websocket-bearing
  // member requires `websocket`, and an optional property cannot satisfy a required one.
  const serve = (on: number): BunServer =>
    websocket === undefined
      ? Bun.serve({ hostname, port: on, fetch })
      : Bun.serve({ hostname, port: on, fetch, websocket });

  let server: BunServer;
  let fellBack = false;
  try {
    server = serve(port);
  } catch (error) {
    if (port === 0 || !isAddressInUse(error)) throw error;
    fellBack = true;
    server = serve(0);
  }

  // `port` is optional on `Server` only because a unix-socket server has none. These are TCP.
  const bound = server.port;
  if (bound === undefined) throw new Error("Bun.serve bound no TCP port");

  app = createApp(bound);
  return { url: `http://${hostname}:${bound}`, port: bound, server, fellBack };
}

function isAddressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  // Bun reports EADDRINUSE; Windows surfaces WSAEADDRINUSE through the same field on some paths.
  return code === "EADDRINUSE" || code === "WSAEADDRINUSE";
}

/**
 * Wraps an app so every response it produces passes the egress filter. PLAN.md §Phase 2 states the
 * invariant for **both** `:7774` and `:7775`, so both are wrapped here rather than at one of them.
 *
 * Deliberately at the binding layer rather than as Hono middleware: assigning `c.res` makes Hono
 * copy the previous response's headers onto the new one, `Set-Cookie` included by name, so a
 * middleware that strips a cookie hands back a response that still carries it. Out here nothing can
 * merge anything back, and Hono's own 404 and error responses — which never run a route's
 * middleware — are covered too.
 *
 * A successful WebSocket upgrade is passed through untouched. By then Bun has taken the socket over
 * and the returned response is a formality; rebuilding it is at best pointless and at worst breaks
 * the upgrade. Frames on that socket are filtered by the pipeline mirror itself, which has to scan
 * them anyway — VRChat's `{"err":…,"authToken":…}` frame is on PLAN.md's leak table.
 */
function egressGuarded(app: FetchApp): FetchApp {
  return {
    async fetch(request: Request, server: BunServer): Promise<Response> {
      const response = await app.fetch(request, server);
      if (response.status === 101 || request.headers.get("upgrade") !== null) return response;

      let path = request.url;
      try {
        path = new URL(request.url).pathname;
      } catch {
        // An unparseable request line still produced a response worth scanning.
      }
      return filterResponse(
        response,
        { method: request.method, path },
        { onViolation: reportEgressViolation },
      );
    },
  };
}

/**
 * The loud half of failing closed. Never receives credential material — a logger that printed the
 * offending value would recreate the leak in the log file.
 */
function reportEgressViolation(
  violation: EgressViolation,
  request: { method: string; path: string },
): void {
  console.error(
    `[vrc.zip] EGRESS FILTER BLOCKED A RESPONSE: a real VRChat credential appeared in the ` +
      `${violation.where} (${violation.detail}) of ${request.method} ${request.path}. ` +
      `The client received an empty 500. This is a bug in the proxy path. See PLAN.md §Phase 2.`,
  );
}

export interface BindServersOptions {
  deps: ControlDeps;
  /**
   * The mirror's collaborators. Omitted, `:7774` binds and answers 503 rather than half-working —
   * the port must exist either way, because the "three separate instances" property is structural.
   */
  proxyDeps?: ProxyDeps | undefined;
  /** Opt-in request logging for the mirror. See `proxy/request-log.ts`. */
  proxyLogger?: ProxyLogger | undefined;
  /** Resolves the session token every port accepts for this run. */
  token: TokenSource;
  ports?: {
    ui?: number;
    proxy?: number;
    control?: number;
  };
  hostname?: string;
  /** Where the built UI lives. Defaults to `<repo>/ui/dist`. */
  uiDistDir?: string;
}

export interface BoundServers {
  ui: BoundServer;
  proxy: BoundServer;
  control: BoundServer;
  /** URLs in the shape `state.json` wants them. */
  urls: { uiUrl: string; proxyUrl: string; controlUrl: string };
  stop(): Promise<void>;
}

export async function bindServers(options: BindServersOptions): Promise<BoundServers> {
  const {
    deps,
    proxyDeps,
    proxyLogger,
    token,
    ports,
    hostname = DEFAULT_HOSTNAME,
    uiDistDir,
  } = options;

  // Control first: its URL goes on the UI's placeholder page.
  const control = bindServer({
    port: ports?.control ?? DEFAULT_CONTROL_PORT,
    hostname,
    createApp: (port) => egressGuarded(createControlApp({ port, deps, token })),
    // Hono's Bun adapter parameterises the socket on its own `BunWebSocketData`, which it sets
    // during the upgrade. Bun's own handler type is parameterised on the caller's data, and the two
    // only meet through a cast.
    websocket: controlWebSocketHandler as WebSocketHandler<unknown>,
  });

  const proxy = bindServer({
    port: ports?.proxy ?? DEFAULT_PROXY_PORT,
    hostname,
    createApp: (port) =>
      egressGuarded(
        createProxyApp({
          port,
          ...(proxyDeps === undefined ? {} : { deps: proxyDeps }),
          ...(proxyLogger === undefined ? {} : { logger: proxyLogger }),
        }),
      ),
    // The pipeline mirror lives on this port too, so it needs its own upgrade handler. A separate
    // one from the control API's: two Hono instances, two adapters, and nothing shared between the
    // byte-faithful mirror and the private control surface.
    websocket: proxyWebSocketHandler as WebSocketHandler<unknown>,
  });

  const ui = bindServer({
    port: ports?.ui ?? DEFAULT_UI_PORT,
    hostname,
    createApp: (port) =>
      createUiApp({
        port,
        token,
        deps,
        controlUrl: control.url,
        ...(uiDistDir === undefined ? {} : { distDir: uiDistDir }),
      }),
    // The UI port serves /api/stream too, so it needs the same upgrade handler.
    websocket: controlWebSocketHandler as WebSocketHandler<unknown>,
  });

  return {
    ui,
    proxy,
    control,
    urls: { uiUrl: ui.url, proxyUrl: proxy.url, controlUrl: control.url },
    async stop(): Promise<void> {
      await Promise.all([ui.server.stop(true), proxy.server.stop(true), control.server.stop(true)]);
    },
  };
}

/** The URL to open in the browser: the UI origin with the session token attached. */
export function launchUrl(uiUrl: string, sessionToken: string): string {
  return sharedLaunchUrl(uiUrl, sessionToken);
}
