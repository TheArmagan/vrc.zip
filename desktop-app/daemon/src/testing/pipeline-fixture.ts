/**
 * A stand-in VRChat pipeline socket for integration tests. PLAN.md §1.10.
 *
 * A real `Bun.serve` WebSocket rather than an injected `createSocket`, for the same reason the REST
 * fixture is a real server: the interesting failures here are handshake-level. The daemon must put
 * the account's own `auth` cookie in the query string and its User-Agent on the upgrade — a stub
 * that hands the client a socket object proves neither.
 *
 * It models only what the daemon depends on: one connection per `authToken`, the `{type, content}`
 * outer frame, and the fact that `content` is a JSON *string* rather than an object.
 */

/** One accepted upgrade. */
export interface PipelineConnection {
  readonly authToken: string;
  readonly userAgent: string;
  readonly openedAt: number;
  /** Set when the socket closes; live connections have `null`. */
  closedAt: number | null;
}

export interface PipelineFixture {
  /** `ws://127.0.0.1:PORT/` — pass straight to `startDaemon({ pipelineUrl })`. */
  readonly url: string;
  /** Every upgrade accepted, in order, including ones since closed. */
  readonly connections: readonly PipelineConnection[];
  /** Connections still open, newest last. */
  live(): PipelineConnection[];
  /** Resolves once `count` distinct tokens have live sockets, or rejects on timeout. */
  waitForConnections(count: number, timeoutMs?: number): Promise<PipelineConnection[]>;
  /**
   * Pushes one frame to the socket holding `authToken`. `content` is JSON-encoded into a string,
   * exactly as VRChat does — pass a string to send it raw, which is how the malformed-content event
   * types (`see-notification` and friends) actually arrive.
   */
  send(authToken: string, type: string, content: unknown): boolean;
  /** Drops the socket for `authToken` without a close frame, as a network failure would. */
  drop(authToken: string): boolean;
  stop(): void;
}

interface SocketData {
  authToken: string;
  connection: PipelineConnection;
}

export function startPipelineFixture(): PipelineFixture {
  const connections: PipelineConnection[] = [];
  const sockets = new Map<string, Bun.ServerWebSocket<SocketData>>();

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, self) {
      const authToken = new URL(request.url).searchParams.get("authToken") ?? "";
      const userAgent = request.headers.get("User-Agent") ?? "";

      // VRChat rejects both of these on the upgrade, not just on the REST API — a missing UA is
      // 403 + waf_code 13799 here too, and an empty token is not a session.
      if (userAgent.trim() === "") return new Response("forbidden", { status: 403 });
      if (authToken === "") return new Response("unauthorized", { status: 401 });

      const connection: PipelineConnection = {
        authToken,
        userAgent,
        openedAt: Date.now(),
        closedAt: null,
      };
      if (self.upgrade(request, { data: { authToken, connection } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        connections.push(ws.data.connection);
        sockets.set(ws.data.authToken, ws);
      },
      message() {
        // The daemon sends nothing; VRChat's pipeline is one-directional.
      },
      close(ws) {
        ws.data.connection.closedAt = Date.now();
        if (sockets.get(ws.data.authToken) === ws) sockets.delete(ws.data.authToken);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${String(server.port)}/`,
    connections,
    live: () => connections.filter((c) => c.closedAt === null),
    async waitForConnections(count, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const live = connections.filter((c) => c.closedAt === null);
        if (live.length >= count) return live;
        if (Date.now() > deadline) {
          throw new Error(
            `pipeline fixture: expected ${String(count)} live connections, saw ${String(live.length)}`,
          );
        }
        await Bun.sleep(10);
      }
    },
    send(authToken, type, content) {
      const socket = sockets.get(authToken);
      if (!socket) return false;
      const body = typeof content === "string" ? content : JSON.stringify(content);
      socket.send(JSON.stringify({ type, content: body }));
      return true;
    },
    drop(authToken) {
      const socket = sockets.get(authToken);
      if (!socket) return false;
      socket.terminate();
      return true;
    },
    stop: () => {
      server.stop(true);
    },
  };
}
