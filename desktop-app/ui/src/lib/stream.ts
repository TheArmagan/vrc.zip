/**
 * The live event socket (`/api/stream`), with reconnect.
 *
 * Browsers cannot set request headers on a WebSocket handshake, so this is the one place the
 * session token travels as a query parameter instead of `Authorization: Bearer`. The daemon
 * binds to loopback only, so the token never leaves the machine either way.
 *
 * Reconnect is exponential with jitter and caps at 15s. Two things deliberately do *not*
 * happen: the socket does not reconnect after an auth failure (retrying a rejected token just
 * burns the daemon's rate limiter), and it does not reconnect while the tab is hidden and has
 * already failed once — it retries immediately on `visibilitychange` instead.
 */

import type { FeedEvent, GameSession } from "./api.ts";
import { getToken } from "./session.ts";

/** A frame pushed by the daemon. `kind` is the discriminant for every message on the socket. */
export type StreamMessage =
  | { readonly type: "event"; readonly event: FeedEvent }
  | { readonly type: "sessions"; readonly sessions: readonly GameSession[] }
  | { readonly type: "accounts-changed" }
  | { readonly type: "status-changed" }
  | { readonly type: "hello"; readonly version: string };

export type StreamState = "connecting" | "open" | "reconnecting" | "closed" | "unauthorized";

export interface StreamHandlers {
  readonly onMessage: (message: StreamMessage) => void;
  readonly onState: (state: StreamState) => void;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}/api/stream`);
  const token = getToken();
  if (token !== null) url.searchParams.set("token", token);
  return url.toString();
}

/** Narrows an arbitrary parsed frame to a `StreamMessage`, dropping anything unrecognised. */
function parseMessage(raw: string): StreamMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string") return null;
  switch (record.type) {
    case "event":
      return typeof record.event === "object" && record.event !== null
        ? { type: "event", event: record.event as FeedEvent }
        : null;
    case "sessions":
      return Array.isArray(record.sessions)
        ? { type: "sessions", sessions: record.sessions as GameSession[] }
        : null;
    case "accounts-changed":
      return { type: "accounts-changed" };
    case "status-changed":
      return { type: "status-changed" };
    case "hello":
      return { type: "hello", version: String(record.version ?? "") };
    default:
      return null;
  }
}

export interface StreamConnection {
  /** Drop the socket and stop reconnecting. */
  readonly close: () => void;
  /** Reset backoff and reconnect now — used by the offline screen's "retry" button. */
  readonly reconnectNow: () => void;
}

export function connectStream(handlers: StreamHandlers): StreamConnection {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let timer: number | null = null;
  let disposed = false;
  /** True once a connection has been made, so the first failure reads as "connecting", not "lost". */
  let everOpened = false;

  function clearTimer(): void {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleReconnect(): void {
    if (disposed) return;
    handlers.onState(everOpened ? "reconnecting" : "connecting");
    // Full jitter: without it every tab on the machine retries in lockstep after a daemon restart.
    const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    attempt += 1;
    clearTimer();
    timer = window.setTimeout(open, delay);
  }

  function open(): void {
    if (disposed) return;
    clearTimer();
    handlers.onState(everOpened ? "reconnecting" : "connecting");

    let next: WebSocket;
    try {
      next = new WebSocket(socketUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = next;

    next.addEventListener("open", () => {
      if (disposed) return;
      everOpened = true;
      attempt = 0;
      handlers.onState("open");
    });

    next.addEventListener("message", (frame: MessageEvent<unknown>) => {
      if (typeof frame.data !== "string") return;
      const message = parseMessage(frame.data);
      if (message !== null) handlers.onMessage(message);
    });

    next.addEventListener("close", (frame: CloseEvent) => {
      if (disposed || socket !== next) return;
      socket = null;
      // 1008 (policy violation) / 4401 are the daemon rejecting the token. Retrying is pointless
      // and noisy; the shell asks the user to relaunch from the tray instead.
      if (frame.code === 1008 || frame.code === 4401) {
        handlers.onState("unauthorized");
        return;
      }
      scheduleReconnect();
    });

    // `error` always precedes `close`, which is where reconnect is decided. Swallowing it here
    // is what keeps an unreachable daemon from printing a wall of uncaught errors.
    next.addEventListener("error", () => {});
  }

  function onVisible(): void {
    if (disposed || document.visibilityState !== "visible") return;
    if (socket !== null && socket.readyState <= WebSocket.OPEN) return;
    attempt = 0;
    open();
  }

  document.addEventListener("visibilitychange", onVisible);
  open();

  return {
    close(): void {
      disposed = true;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisible);
      socket?.close();
      socket = null;
      handlers.onState("closed");
    },
    reconnectNow(): void {
      if (disposed) return;
      attempt = 0;
      socket?.close();
      socket = null;
      open();
    },
  };
}
