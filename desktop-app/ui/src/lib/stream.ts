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

import {
  type EventKind,
  type RateFrame,
  STREAM_RATE,
  STREAM_READY,
  type StreamEnvelope,
  type StreamFrame,
} from "@vrcz/shared";
import { streamUrl } from "./config.ts";
import { getToken } from "./session.ts";

/*
 * The frame and its envelope are `@vrcz/shared`'s, re-exported under the names this app uses.
 *
 * `StreamPayload` used to be declared here, and it was the *only* written description of the
 * daemon's own frame format - the daemon built the envelope inline through two `as` casts. It also
 * typed `sessionId` as `string`, stringifying a number on the way in that `events.ts` parsed back
 * out one function later. Both sides now read one interface and the id stays a number throughout.
 */
export type { StreamEnvelope as StreamPayload, StreamFrame };

export type StreamState = "connecting" | "open" | "reconnecting" | "closed" | "unauthorized";

export interface StreamHandlers {
  readonly onFrame: (frame: StreamFrame) => void;
  readonly onState: (state: StreamState) => void;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

function asPayload(value: unknown): StreamEnvelope {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  return {
    accountId: typeof record.accountId === "string" ? record.accountId : null,
    // Tolerant of a string on purpose. The daemon sends a number and always did, but this parser is
    // the boundary with a process that ships separately, and coercing one field is cheaper than a
    // whole screen of sessions failing to group.
    sessionId: asSessionId(record.sessionId),
    subjectId: typeof record.subjectId === "string" ? record.subjectId : null,
    location: typeof record.location === "string" ? record.location : null,
    data: (record.data ?? null) as StreamEnvelope["data"],
  };
}

function asSessionId(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * The `rate` frame's payload, or null if it is not one.
 *
 * Every field is defaulted rather than required. The daemon omits zero-valued keys from `accounts`
 * and `grants` on purpose — an idle daemon with ten series would otherwise send ten zeroes a second
 * forever — so "absent" is a normal, meaningful shape here rather than a malformed one.
 */
function asRateFrame(value: unknown): RateFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    total: typeof record.total === "number" ? record.total : 0,
    accounts: asCounts(record.accounts),
    grants: asCounts(record.grants),
    limit: typeof record.limit === "number" ? record.limit : 0,
    retryAfter: typeof record.retryAfter === "number" ? record.retryAfter : null,
  };
}

function asCounts(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === "number") out[key] = count;
  }
  return out;
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

  const ts = typeof record.ts === "number" ? record.ts : Date.now();

  if (record.type === STREAM_READY) return { type: STREAM_READY, ts, payload: null };

  if (record.type === STREAM_RATE) {
    const payload = asRateFrame(record.payload);
    // A `rate` frame with no readable payload is dropped rather than passed on as zeroes: a missed
    // sample leaves the last value on screen for a second, and inventing a zero would draw a dip
    // that never happened.
    return payload === null ? null : { type: STREAM_RATE, ts, payload };
  }

  return {
    // Widened for the same reason `EventKind` is: a kind this build has not heard of is still a
    // real frame, and the screens that do not know it simply ignore it.
    type: record.type as EventKind,
    ts,
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
