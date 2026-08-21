/**
 * One pipeline socket per account.
 *
 * `wss://pipeline.vrchat.cloud/?authToken=<auth cookie value>`, with the User-Agent header set on
 * the handshake. A missing UA is a hard 403 with `waf_code 13799` — on the WebSocket upgrade exactly
 * as on the REST API — so the constructor refuses to build a client without one rather than letting
 * a reconnect loop hammer a request that can never succeed.
 *
 * Everything this client depends on is injected. It never imports an account, a cookie jar, a store,
 * or a rate limiter: the auth token arrives through an async supplier that is called **on every
 * connection attempt**, so a token refreshed by any other part of the daemon is picked up by the very
 * next retry. A token captured once at construction is the classic way to turn one expired cookie
 * into an infinite backoff loop, and it is unrepresentable here.
 *
 * Responsibilities: connect, reconnect with exponential backoff plus jitter, detect a stale socket,
 * decode frames through `decode.ts`, and surface re-auth as a terminal state that does **not** retry.
 */

import type {
  DecodedPipelineEvent,
  PipelineMalformedMessage,
  PipelineReauthRequired,
  PipelineServerError,
  PipelineUnknownEvent,
} from "./decode.ts";
import { decodePipelineMessage } from "./decode.ts";

/** The live connection state, as reported to `onStateChange`. */
export type PipelineConnectionState =
  /** Constructed, never started. */
  | "idle"
  /** Reading the auth token and opening a socket. */
  | "connecting"
  /** Socket open; frames flowing. */
  | "connected"
  /** Waiting out a backoff delay before the next attempt. */
  | "backoff"
  /** The token is dead. Terminal until the caller re-authenticates and calls `restart()`. */
  | "reauth-required"
  /** Disposed. Terminal, always. */
  | "closed";

/** One state transition. `retryInMs` is set only when entering `backoff`. */
export interface PipelineStateChange {
  readonly state: PipelineConnectionState;
  readonly previous: PipelineConnectionState;
  /** How many consecutive failed attempts precede this state. Reset to 0 on a successful open. */
  readonly attempt: number;
  /** Integer unix ms. */
  readonly at: number;
  readonly detail?: string;
  readonly retryInMs?: number;
}

/** Exponential backoff parameters. Defaults are {@link DEFAULT_BACKOFF}. */
export interface PipelineBackoffOptions {
  /** Delay before the first retry, in ms. */
  readonly initialDelayMs: number;
  /** Ceiling for the exponential term, in ms. Jitter may push a delay slightly past it. */
  readonly maxDelayMs: number;
  /** Growth per attempt. */
  readonly factor: number;
  /** Fraction of the delay applied as symmetric random jitter — `0.3` means ±30%. */
  readonly jitterRatio: number;
}

export const DEFAULT_BACKOFF: PipelineBackoffOptions = {
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  factor: 2,
  jitterRatio: 0.3,
};

/** Default endpoint. Overridable so tests can point at a local fixture server. */
export const VRCHAT_PIPELINE_URL = "wss://pipeline.vrchat.cloud/";

/**
 * Injected dependencies. There are no non-injected ones — every collaborator arrives here, which is
 * the design rather than a testing workaround.
 */
export interface PipelineClientOptions {
  /**
   * Supplies the current `auth` cookie value. Called fresh on **every** connection attempt, so it
   * must read live state (never close over a token captured earlier). Throwing is treated as a
   * transient failure and retried; returning an empty string is treated as "no session", which is a
   * re-auth condition, not a retry.
   */
  readonly getAuthToken: () => Promise<string>;
  /** Sent as the `User-Agent` handshake header. Must be non-empty — see the module comment. */
  readonly userAgent: string;
  /** Called once per successfully decoded event. */
  readonly onEvent: (event: DecodedPipelineEvent) => void;
  /**
   * The token is dead. The client has stopped and will not retry; re-authenticate, then call
   * {@link PipelineClient.restart}.
   */
  readonly onReauthRequired: (reason: PipelineReauthRequired) => void;
  /** Connection lifecycle, for logging and for the daemon's status surface. */
  readonly onStateChange?: ((change: PipelineStateChange) => void) | undefined;
  /** An `{"err": …}` frame unrelated to auth. The socket stays up; VRChat usually recovers. */
  readonly onServerError?: ((error: PipelineServerError) => void) | undefined;
  /** Frames we could not decode, and event types we do not model. Log-and-continue material. */
  readonly onUndecodable?:
    | ((result: PipelineUnknownEvent | PipelineMalformedMessage) => void)
    | undefined;
  /** Endpoint override. Defaults to {@link VRCHAT_PIPELINE_URL}. */
  readonly url?: string | undefined;
  /** Backoff overrides, merged over {@link DEFAULT_BACKOFF}. */
  readonly backoff?: Partial<PipelineBackoffOptions> | undefined;
  /**
   * Stale-socket detection: if no frame arrives within this many ms, the socket is presumed dead
   * (a half-open TCP connection reports nothing) and is dropped and reconnected. Must comfortably
   * exceed the longest normal quiet period — VRChat sends nothing at all when nothing happens.
   * Defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}. Pass `0` to disable.
   */
  readonly idleTimeoutMs?: number | undefined;
  /**
   * Interval between outbound WebSocket ping frames, keeping NAT and proxy paths warm and forcing a
   * dead peer to surface as a close. Defaults to {@link DEFAULT_HEARTBEAT_INTERVAL_MS}; `0` disables.
   */
  readonly heartbeatIntervalMs?: number | undefined;
  /**
   * How long a socket must stay open before it counts as a genuinely working session and clears the
   * failure streak. Defaults to {@link DEFAULT_STABLE_CONNECTION_MS}.
   *
   * Resetting the streak on `open` instead looks equivalent and is not: a server that accepts the
   * upgrade and drops it a millisecond later — which is exactly what VRChat does under load, and what
   * a captive-portal or proxy does when it is unhappy — would reset the counter on every attempt and
   * turn the backoff into a tight reconnect loop.
   */
  readonly stableConnectionMs?: number | undefined;
  /** Randomness source for jitter. Injected so backoff is assertable. Defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** Clock for timestamps. Defaults to `Date.now`, and must return integer unix ms. */
  readonly now?: (() => number) | undefined;
  /** Socket factory. Defaults to Bun's `WebSocket` with the UA header applied. */
  readonly createSocket?: ((url: string, userAgent: string) => WebSocket) | undefined;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_STABLE_CONNECTION_MS = 30_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * `initialDelayMs * factor^attempt`, clamped to `maxDelayMs`, then jittered symmetrically.
 *
 * Jitter is the point: without it, every account on the machine — and every client on VRChat's side
 * of a partition — retries on the same tick and rebuilds the thundering herd that took the socket
 * down. Exported so the sequence can be asserted rather than eyeballed.
 *
 * @param attempt zero-based retry index
 */
export function computeBackoffDelay(
  attempt: number,
  options: PipelineBackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    options.maxDelayMs,
    options.initialDelayMs * options.factor ** Math.max(0, attempt),
  );
  // random() - 0.5 maps [0,1) to [-0.5,0.5), so the spread is ±jitterRatio/2 · 2 = ±jitterRatio.
  const jitter = exponential * options.jitterRatio * (random() - 0.5) * 2;
  return Math.max(0, Math.round(exponential + jitter));
}

/** Builds the connect URL. The token lives in the query string; VRChat offers no header form. */
export function buildPipelineUrl(baseUrl: string, authToken: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("authToken", authToken);
  return url.toString();
}

function toFrameText(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer as ArrayBuffer);
  }
  return undefined;
}

function defaultCreateSocket(url: string, userAgent: string): WebSocket {
  // Bun's WebSocket takes handshake headers here. A missing User-Agent is rejected by VRChat's WAF
  // during the upgrade, before any frame is exchanged, and looks identical to a network failure.
  return new WebSocket(url, { headers: { "User-Agent": userAgent } });
}

/** Sockets that expose ping/pong. Bun's client does; the DOM's does not. */
type PingableSocket = WebSocket & { ping?: (data?: string) => void };

export class PipelineClient {
  readonly #options: PipelineClientOptions;
  readonly #backoff: PipelineBackoffOptions;
  readonly #url: string;
  readonly #idleTimeoutMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #stableConnectionMs: number;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #createSocket: (url: string, userAgent: string) => WebSocket;

  #state: PipelineConnectionState = "idle";
  #attempt = 0;
  #socket: WebSocket | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Incremented whenever a socket is abandoned. Every callback checks it, so a late `onclose` from a
   * socket we already gave up on cannot schedule a second, competing reconnect.
   */
  #generation = 0;
  #lastFrameAt: number | null = null;
  /** When the current socket opened, or `null` if none is open. Feeds the streak-reset rule. */
  #openedAt: number | null = null;

  constructor(options: PipelineClientOptions) {
    if (options.userAgent.trim().length === 0) {
      throw new Error(
        "PipelineClient requires a non-empty userAgent: VRChat rejects the WebSocket handshake " +
          "with 403 waf_code 13799 when the User-Agent header is missing.",
      );
    }
    this.#options = options;
    this.#backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.#url = options.url ?? VRCHAT_PIPELINE_URL;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#stableConnectionMs = options.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#createSocket = options.createSocket ?? defaultCreateSocket;
  }

  get state(): PipelineConnectionState {
    return this.#state;
  }

  /** Consecutive failed attempts. Zero while connected. */
  get attempt(): number {
    return this.#attempt;
  }

  /** Integer unix ms of the last frame received, or `null` if none yet. */
  get lastFrameAt(): number | null {
    return this.#lastFrameAt;
  }

  /** Opens the socket. Idempotent while connecting or connected. */
  start(): void {
    if (this.#state === "connecting" || this.#state === "connected") {
      return;
    }
    if (this.#state === "closed") {
      throw new Error("PipelineClient has been disposed and cannot be restarted.");
    }
    // A pending backoff timer would otherwise open a second socket alongside this one.
    this.#clearReconnectTimer();
    this.#attempt = 0;
    void this.#connect();
  }

  /**
   * Resumes after a re-auth. The only way out of `reauth-required`, and deliberately explicit: the
   * caller must have obtained a new session before the supplier will hand out a usable token.
   */
  restart(): void {
    if (this.#state === "closed") {
      throw new Error("PipelineClient has been disposed and cannot be restarted.");
    }
    this.#dropSocket();
    this.#clearReconnectTimer();
    this.#attempt = 0;
    this.#setState("idle");
    void this.#connect();
  }

  /**
   * Closes the socket and every timer, permanently. Never reconnects afterwards, including from a
   * close event already in flight — the generation bump in `#dropSocket` sees to that.
   */
  dispose(): void {
    if (this.#state === "closed") {
      return;
    }
    this.#dropSocket();
    this.#clearReconnectTimer();
    this.#setState("closed", "disposed");
  }

  async #connect(): Promise<void> {
    if (this.#isTerminal()) {
      return;
    }
    this.#setState("connecting");
    const generation = this.#generation;

    let token: string;
    try {
      // Re-read on every attempt. Never captured, never cached.
      token = await this.#options.getAuthToken();
    } catch (error) {
      this.#scheduleReconnect(`auth token unavailable: ${describeError(error)}`);
      return;
    }
    if (generation !== this.#generation || this.#isTerminal()) {
      return;
    }
    if (token.length === 0) {
      // No session at all. Retrying cannot produce one.
      this.#handleReauth({
        kind: "reauth-required",
        message: "no auth token available for this account",
        receivedAt: this.#now(),
      });
      return;
    }

    let socket: WebSocket;
    try {
      socket = this.#createSocket(buildPipelineUrl(this.#url, token), this.#options.userAgent);
    } catch (error) {
      this.#scheduleReconnect(`socket construction failed: ${describeError(error)}`);
      return;
    }
    this.#socket = socket;

    socket.onopen = (): void => {
      if (generation !== this.#generation) {
        return;
      }
      this.#openedAt = this.#now();
      this.#lastFrameAt = this.#openedAt;
      this.#setState("connected");
      this.#armIdleTimer();
      this.#startHeartbeat();
    };

    socket.onmessage = (event: MessageEvent): void => {
      if (generation !== this.#generation) {
        return;
      }
      this.#armIdleTimer();
      this.#lastFrameAt = this.#now();
      this.#handleFrame(event.data);
    };

    socket.onerror = (): void => {
      if (generation !== this.#generation) {
        return;
      }
      // Browsers and Bun both keep the reason out of the error event; the close that follows carries
      // the code. Reconnection is driven from onclose so the two do not race.
      this.#setState(this.#state, "socket error");
    };

    socket.onclose = (event: CloseEvent): void => {
      if (generation !== this.#generation) {
        return;
      }
      if (this.#isTerminal()) {
        this.#dropSocket();
        return;
      }
      // Note the order: #scheduleReconnect drops the socket itself, after reading how long it was
      // open. Dropping first would erase that and defeat the streak-reset rule.
      this.#scheduleReconnect(
        `socket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
      );
    };
  }

  #handleFrame(data: unknown): void {
    const text = toFrameText(data);
    if (text === undefined) {
      this.#options.onUndecodable?.({
        kind: "malformed",
        reason: "frame-not-json",
        detail: `unsupported frame payload of type ${typeof data}`,
        raw: "",
        receivedAt: this.#now(),
      });
      return;
    }

    const result = decodePipelineMessage(text, this.#now());
    switch (result.kind) {
      case "event":
        this.#options.onEvent(result);
        return;
      case "reauth-required":
        this.#handleReauth(result);
        return;
      case "server-error":
        this.#options.onServerError?.(result);
        return;
      case "unknown-event":
      case "malformed":
        this.#options.onUndecodable?.(result);
        return;
    }
  }

  /** Terminal-until-restarted. Deliberately does not schedule a reconnect. */
  #handleReauth(reason: PipelineReauthRequired): void {
    this.#dropSocket();
    this.#clearReconnectTimer();
    this.#setState("reauth-required", reason.message);
    this.#options.onReauthRequired(reason);
  }

  #scheduleReconnect(detail: string): void {
    if (this.#isTerminal()) {
      return;
    }
    const openedAt = this.#openedAt;
    this.#dropSocket();
    this.#clearReconnectTimer();
    // A connection that stayed up long enough to be useful clears the streak; a flapping one does
    // not, so repeated accept-then-drop cycles still back off.
    if (openedAt !== null && this.#now() - openedAt >= this.#stableConnectionMs) {
      this.#attempt = 0;
    }
    const delay = computeBackoffDelay(this.#attempt, this.#backoff, this.#random);
    this.#attempt += 1;
    this.#setState("backoff", detail, delay);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, delay);
  }

  #armIdleTimer(): void {
    this.#clearIdleTimer();
    if (this.#idleTimeoutMs <= 0) {
      return;
    }
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      // Half-open connections stay "open" forever and deliver nothing. Silence past the timeout is
      // treated as death: drop first (so the close event is ignored), then back off as usual.
      this.#scheduleReconnect(`no frames for ${this.#idleTimeoutMs}ms; socket presumed stale`);
    }, this.#idleTimeoutMs);
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    if (this.#heartbeatIntervalMs <= 0) {
      return;
    }
    this.#heartbeatTimer = setInterval(() => {
      const socket = this.#socket as PingableSocket | null;
      if (socket === null || socket.readyState !== 1) {
        return;
      }
      // A pong resets nothing on our side by design: only real traffic counts as liveness, so the
      // idle timer still fires for a peer that answers pings but has stopped sending events.
      socket.ping?.();
    }, this.#heartbeatIntervalMs);
  }

  /** Detaches and closes the current socket, guaranteeing its callbacks can no longer act. */
  #dropSocket(): void {
    this.#generation += 1;
    this.#openedAt = null;
    this.#clearIdleTimer();
    this.#clearHeartbeat();
    const socket = this.#socket;
    this.#socket = null;
    if (socket === null) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Closing an already-closed or still-connecting socket is not an error worth propagating.
    }
  }

  /**
   * Terminal states never reconnect: `closed` is disposal, `reauth-required` needs a human-scale fix.
   * A method rather than an inline comparison so control-flow narrowing cannot make one of these
   * checks look impossible to the compiler and get quietly deleted.
   */
  #isTerminal(): boolean {
    return this.#state === "closed" || this.#state === "reauth-required";
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #setState(state: PipelineConnectionState, detail?: string, retryInMs?: number): void {
    const previous = this.#state;
    this.#state = state;
    this.#options.onStateChange?.({
      state,
      previous,
      attempt: this.#attempt,
      at: this.#now(),
      ...(detail === undefined ? {} : { detail }),
      ...(retryInMs === undefined ? {} : { retryInMs }),
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
