import type { Server, WebSocketHandler } from "bun";
import type { TokenSource } from "../security/guards.ts";
import { type ControlDeps, controlWebSocketHandler, createControlApp } from "./control.ts";
import { createProxyApp } from "./proxy.ts";
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

export const DEFAULT_UI_PORT = 7773;
export const DEFAULT_PROXY_PORT = 7774;
export const DEFAULT_CONTROL_PORT = 7775;

/** Loopback by name resolves to 127.0.0.1; binding the literal keeps IPv6 out of the picture. */
export const DEFAULT_HOSTNAME = "127.0.0.1";

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

export interface BindServersOptions {
  deps: ControlDeps;
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
  const { deps, token, ports, hostname = DEFAULT_HOSTNAME, uiDistDir } = options;

  // Control first: its URL goes on the UI's placeholder page.
  const control = bindServer({
    port: ports?.control ?? DEFAULT_CONTROL_PORT,
    hostname,
    createApp: (port) => createControlApp({ port, deps, token }),
    // Hono's Bun adapter parameterises the socket on its own `BunWebSocketData`, which it sets
    // during the upgrade. Bun's own handler type is parameterised on the caller's data, and the two
    // only meet through a cast.
    websocket: controlWebSocketHandler as WebSocketHandler<unknown>,
  });

  const proxy = bindServer({
    port: ports?.proxy ?? DEFAULT_PROXY_PORT,
    hostname,
    createApp: (port) => createProxyApp({ port, token }),
  });

  const ui = bindServer({
    port: ports?.ui ?? DEFAULT_UI_PORT,
    hostname,
    createApp: (port) =>
      createUiApp({
        port,
        token,
        controlUrl: control.url,
        ...(uiDistDir === undefined ? {} : { distDir: uiDistDir }),
      }),
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
  return `${uiUrl}/?token=${encodeURIComponent(sessionToken)}`;
}
