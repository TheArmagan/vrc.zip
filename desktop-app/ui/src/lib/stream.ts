/**
 * The live event socket (`GET /api/stream`), with reconnect.
 *
 * Browsers cannot set request headers on a WebSocket handshake, so this is the one place the
 * session token travels as a query parameter instead of `Authorization: Bearer`. The daemon binds
 * to loopback only, so the token never leaves the machine either way.
 *
 * The wire shape is the daemon's bus, verbatim: `{ type, ts, payload }` where `type` is the dotted
 * bus kind (`friend.online`, `gamelog.player_join`, …) and `payload` wraps the event's envelope
 * plus its kind-specific `data`. The very first frame after a successful upgrade is
 * `{ type: "ready", ts, payload: null }` — there is no version handshake.
 *
 * Reconnect is exponential with full jitter and caps at 15s. Two things deliberately do *not*
 * happen: the socket does not reconnect after an auth close (retrying a rejected token just burns
 * the daemon's rate limiter and the token cannot be refreshed from inside the page), and it does
 * not keep retrying while the tab is hidden — it retries immediately on `visibilitychange`.
 */

import { streamUrl } from "./config.ts";
import { getToken } from "./session.ts";

/** The envelope every non-`ready` frame carries in `payload`. */
export interface StreamPayload {
  readonly accountId: string | null;
  /**
   * The log watcher's *string* session id on `gamelog.*` and `session.*` frames. Note this is a
   * different identifier space from `GameSession.id`, which is the store's integer row id.
   */
  readonly sessionId: string | null;
  readonly subjectId: string | null;
  readonly location: string | null;
  /** The kind-specific body. Untyped on purpose; screens narrow what they actually read. */
  readonly data: unknown;
}

export interface StreamFrame {
  /** The bus kind, or the literal `"ready"` for the handshake frame. */
  readonly type: string;
  readonly ts: number;
  readonly payload: StreamPayload | null;
}

export type StreamState = "connecting" | "open" | "reconnecting" | "closed" | "unauthorized";

export interface StreamHandlers {
  readonly onFrame: (frame: StreamFrame) => void;
  readonly onState: (state: StreamState) => void;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

function asPayload(value: unknown): StreamPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    accountId: typeof record.accountId === "string" ? record.accountId : null,
    sessionId:
      typeof record.sessionId === "string"
        ? record.sessionId
        : typeof record.sessionId === "number"
          ? String(record.sessionId)
          : null,
    subjectId: typeof record.subjectId === "string" ? record.subjectId : null,
    location: typeof record.location === "string" ? record.location : null,
    data: record.data ?? null,
  };
}

/** Narrows an arbitrary parsed frame, dropping anything without a usable `type`. */
export function parseFrame(raw: string): StreamFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type === "") return null;
  return {
    type: record.type,
    ts: typeof record.ts === "number" ? record.ts : Date.now(),
    payload: asPayload(record.payload),
  };
}

export interface StreamConnection {
  /** Drop the socket and stop reconnecting. */
  readonly close: () => void;
  /** Reset backoff and reconnect now — used by the offline screen's retry button. */
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
      next = new WebSocket(streamUrl(getToken()));
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

    next.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      const frame = parseFrame(event.data);
      if (frame !== null) handlers.onFrame(frame);
    });

    next.addEventListener("close", (event: CloseEvent) => {
      if (disposed || socket !== next) return;
      socket = null;
      // 1008 (policy violation) and 4401 are the daemon rejecting the token. Retrying is pointless
      // and noisy; the shell asks the user to relaunch from the tray instead.
      if (event.code === 1008 || event.code === 4401) {
        handlers.onState("unauthorized");
        return;
      }
      scheduleReconnect();
    });

    // `error` always precedes `close`, which is where reconnect is decided. Swallowing it here is
    // what keeps an unreachable daemon from printing a wall of uncaught errors.
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
