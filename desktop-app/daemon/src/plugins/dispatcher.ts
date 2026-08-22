/**
 * The dispatcher: the one route between a plugin process and anything the host can do.
 *
 * PLAN.md §Phase 3, verbatim: "A single dispatcher does arg parsing and the scope check — never the
 * handlers." Both halves are structural here rather than conventional. Arg parsing happens inside
 * `defineMethod`, which binds `parse` to `handle` so a handler cannot see a raw parameter; the
 * scope and account checks happen in `scope-gate.ts`, which a handler is not given anything to call.
 * The order below is fixed and every step is a refusal point:
 *
 *   grant → in-flight cap → method + deadline + scope + account → budget → charge → invoke
 *
 * **Deadlines are absolute epoch-ms and the caller enforces them** (protocol `Deadline`). That has
 * two sides and both live here:
 *
 *  - *Inbound* (plugin calls the host): the host runs the work under an `AbortSignal` armed at the
 *    frame's deadline. When it fires, the plugin is answered `E_TIMEOUT` immediately and a handler
 *    that finishes afterwards has its result dropped — one reply per id, ever.
 *  - *Outbound* (host calls the plugin — `ui.intent`, and lifecycle later): the pending id is timed
 *    on the host's clock and removed when it expires. A late `res` on an id already given up on is
 *    dropped rather than resolved, so a plugin with a skewed clock can be late but can never
 *    resurrect a call the host has finished with.
 *
 * The dispatcher owns no transport. `attach` takes a {@link PluginChannel} — a plugin id and a
 * `send` — so the supervisor, a test fake, and a future in-process worker are the same thing from
 * here. Everything else is constructor-injected; `app.ts` is the only composition root.
 */

import {
  type Deadline,
  deadlineIn,
  type Envelope,
  type ErrorPayload,
  type PluginGrant,
  type ProtocolErrorCode,
  type RequestFrame,
} from "@vrcz/plugin-api";
import type { JsonValue, Scope } from "@vrcz/shared";
import type { PluginBudget } from "./budget.ts";
import type { GatedMethodTable, ScopeGate } from "./scope-gate.ts";
import { createScopeGate } from "./scope-gate.ts";

/**
 * The one way a handler reports a failure the plugin should be told about.
 *
 * Anything else a handler throws becomes `E_INTERNAL` with a fixed message. That asymmetry is the
 * point: an unexpected throw carries a stack, a path, sometimes a URL with a token in it, and none
 * of that may cross a security boundary. A handler that wants the plugin to learn something says so
 * deliberately, in a sentence it wrote.
 */
export class DispatchError extends Error {
  readonly code: ProtocolErrorCode;
  readonly retryAfterMs: number | undefined;
  readonly data: JsonValue | undefined;

  constructor(
    code: ProtocolErrorCode,
    message: string,
    options: { retryAfterMs?: number; data?: JsonValue; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DispatchError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.data = options.data;
  }
}

/** A running plugin, as the dispatcher sees it: an id and a way to hand it a frame. */
export interface PluginChannel {
  readonly pluginId: string;
  /** False when the frame could not be handed over — the peer is gone, or it exceeded the cap. */
  send(frame: Envelope): boolean;
}

/** One finished call. The hook the plugin audit log and the management page hang off. */
export interface PluginCallRecord {
  readonly pluginId: string;
  readonly method: string;
  readonly scope: Scope | null;
  readonly accountId: string | null;
  /** `null` when the call succeeded; the refusal or failure code otherwise. */
  readonly code: ProtocolErrorCode | null;
  readonly ts: number;
  readonly durationMs: number;
}

export interface DispatcherOptions {
  readonly table: GatedMethodTable;
  /**
   * The live grant for a plugin, or null when it has none.
   *
   * A function rather than a snapshot because a grant can be revoked while a plugin is running, and
   * "disable must be instant and always succeed" (PLAN.md §Manifest) is not compatible with a
   * dispatcher holding a copy of what the user approved five minutes ago.
   */
  readonly grants: (pluginId: string) => PluginGrant | null;
  readonly budget?: PluginBudget;
  readonly now?: () => number;
  /**
   * Calls one plugin may have in flight at once.
   *
   * A hostile plugin's cheapest attack on the host is not a big frame, it is a lot of small ones:
   * every `req` costs a promise, a timer and an `AbortController` until it settles. The cap answers
   * the excess with `E_RATE_LIMIT` and a short `retryAfterMs`, which is the one error a
   * well-behaved plugin already knows how to wait on.
   */
  readonly maxInFlight?: number;
  /** Default deadline for host → plugin calls. */
  readonly defaultCallTimeoutMs?: number;
  readonly onCall?: (record: PluginCallRecord) => void;
}

const DEFAULT_MAX_IN_FLIGHT = 32;
const DEFAULT_CALL_TIMEOUT_MS = 5_000;
/** How long an over-capacity plugin is told to wait. Long enough to drain, short enough to be real. */
const IN_FLIGHT_RETRY_MS = 250;

interface Pending {
  readonly resolve: (value: JsonValue | undefined) => void;
  readonly reject: (error: DispatchError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Attached {
  readonly channel: PluginChannel;
  inFlight: number;
  readonly aborts: Set<AbortController>;
  readonly pending: Map<string, Pending>;
  nextId: number;
}

export class PluginDispatcher {
  readonly #gate: ScopeGate;
  readonly #table: GatedMethodTable;
  readonly #options: DispatcherOptions;
  readonly #now: () => number;
  readonly #attached = new Map<string, Attached>();

  constructor(options: DispatcherOptions) {
    this.#options = options;
    this.#table = options.table;
    // Throws on a method declaring a scope outside the shared registry, here at composition rather
    // than on somebody's call path. See `createScopeGate`.
    this.#gate = createScopeGate(options.table);
    this.#now = options.now ?? Date.now;
  }

  /** Method names this dispatcher answers. */
  get methods(): readonly string[] {
    return this.#gate.methods;
  }

  attach(channel: PluginChannel): void {
    this.detach(channel.pluginId);
    this.#attached.set(channel.pluginId, {
      channel,
      inFlight: 0,
      aborts: new Set(),
      pending: new Map(),
      nextId: 1,
    });
  }

  /**
   * Forgets a plugin: aborts its in-flight work and fails its outstanding outbound calls.
   *
   * Called when a plugin exits, is disabled, or restarts. It must always succeed and must never
   * await, because the disable path is the one control the user is promised will work.
   */
  detach(pluginId: string): void {
    const attached = this.#attached.get(pluginId);
    if (attached === undefined) return;
    this.#attached.delete(pluginId);
    for (const abort of attached.aborts) abort.abort();
    attached.aborts.clear();
    for (const [, pending] of attached.pending) {
      clearTimeout(pending.timer);
      pending.reject(new DispatchError("E_CANCELLED", "The plugin stopped before it answered."));
    }
    attached.pending.clear();
  }

  /** Calls this plugin has in flight right now. Diagnostics and tests. */
  inFlight(pluginId: string): number {
    return this.#attached.get(pluginId)?.inFlight ?? 0;
  }

  /**
   * Routes one frame from a plugin. Returns whether the dispatcher owned it.
   *
   * `subscribe`, `unsubscribe` and `credit` are the events bridge's, and `hello`/`pong` are the
   * supervisor's. Answering false rather than throwing lets the caller chain the owners without any
   * of them having to know the others' tags.
   */
  handleFrame(pluginId: string, frame: Envelope): boolean {
    switch (frame.t) {
      case "req":
        void this.#dispatch(pluginId, frame);
        return true;
      case "res":
      case "err":
        return this.#settle(pluginId, frame.id, frame);
      default:
        return false;
    }
  }

  /**
   * Calls a method *on* the plugin, with the host as the enforcing caller.
   *
   * The deadline rides the wire absolute; the timer that decides is this process's. On expiry the
   * pending entry is removed and the promise rejects `E_TIMEOUT` — and because the entry is gone, a
   * reply that arrives afterwards finds nothing to settle and is dropped.
   */
  call(
    pluginId: string,
    method: string,
    params?: JsonValue,
    timeoutMs?: number,
  ): Promise<JsonValue | undefined> {
    const attached = this.#attached.get(pluginId);
    if (attached === undefined) {
      return Promise.reject(
        new DispatchError("E_UNAVAILABLE", `Plugin ${pluginId} is not running.`),
      );
    }

    const id = `h${String(attached.nextId++)}`;
    const now = this.#now();
    const deadline: Deadline = deadlineIn(
      timeoutMs ?? this.#options.defaultCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      now,
    );
    const frame: RequestFrame = {
      t: "req",
      id,
      method,
      deadline,
      ...(params === undefined ? {} : { params }),
    };

    if (!attached.channel.send(frame)) {
      return Promise.reject(
        new DispatchError("E_UNAVAILABLE", `Plugin ${pluginId} could not be reached.`),
      );
    }

    return new Promise<JsonValue | undefined>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          attached.pending.delete(id);
          reject(new DispatchError("E_TIMEOUT", `${method} did not answer before its deadline.`));
        },
        Math.max(0, deadline - now),
      );
      // A pending timer must not hold the process open — a plugin that never answers should not be
      // able to keep the daemon from exiting.
      timer.unref?.();
      attached.pending.set(id, { resolve, reject, timer });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Inbound: a plugin calling the host
  // -------------------------------------------------------------------------------------------

  async #dispatch(pluginId: string, frame: RequestFrame): Promise<void> {
    const attached = this.#attached.get(pluginId);
    if (attached === undefined) return;

    const started = this.#now();
    const entry = this.#table[frame.method];
    const scope = entry?.method.scope ?? null;

    const finish = (accountId: string | null, code: ProtocolErrorCode | null): void => {
      this.#options.onCall?.({
        pluginId,
        method: frame.method,
        scope,
        accountId,
        code,
        ts: started,
        durationMs: this.#now() - started,
      });
    };

    const fail = (
      code: ProtocolErrorCode,
      message: string,
      extra: { retryAfterMs?: number; data?: JsonValue } = {},
      accountId: string | null = null,
    ): void => {
      this.#error(attached, frame.id, code, message, extra);
      finish(accountId, code);
    };

    // The grant, read live rather than cached: a revoke while the plugin is running must take
    // effect on the next call, not on the next restart.
    const grant = this.#options.grants(pluginId);
    if (grant === null) {
      fail("E_SCOPE_DENIED", "This plugin has no live grant.");
      return;
    }

    const max = this.#options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    if (attached.inFlight >= max) {
      fail(
        "E_RATE_LIMIT",
        `Too many calls in flight; this plugin may have ${String(max)} at once.`,
        {
          retryAfterMs: IN_FLIGHT_RETRY_MS,
        },
      );
      return;
    }

    const authorized = this.#gate.check(frame, grant, started);
    if (!authorized.ok) {
      fail(authorized.code, authorized.message);
      return;
    }
    const { method, accountId } = authorized.value;
    const target = accountId ?? null;

    const budget = this.#options.budget;
    if (budget !== undefined) {
      const decision = budget.check(pluginId, method.scope);
      if (!decision.ok) {
        fail(
          "E_RATE_LIMIT",
          `This plugin has used its hourly allowance of ${String(decision.limit)} "${String(method.scope)}" calls.`,
          { retryAfterMs: decision.retryAfterMs },
          target,
        );
        return;
      }
      // Charged before the work, as a reservation. See `PluginBudget.charge`.
      budget.charge(pluginId, method.scope);
    }

    const abort = new AbortController();
    attached.aborts.add(abort);
    attached.inFlight += 1;
    let replied = false;
    const reply = (send: () => void): void => {
      if (replied) return;
      replied = true;
      send();
    };

    const timer = setTimeout(
      () => {
        abort.abort();
        reply(() => {
          this.#error(
            attached,
            frame.id,
            "E_TIMEOUT",
            "The call did not complete before its deadline.",
          );
        });
        finish(target, "E_TIMEOUT");
      },
      Math.max(0, frame.deadline - started),
    );
    timer.unref?.();

    try {
      const result = await method.invoke(frame.params, {
        grant,
        deadline: frame.deadline,
        signal: abort.signal,
        ...(accountId === undefined ? {} : { accountId }),
      });
      if (result.ok) {
        reply(() => {
          attached.channel.send({
            t: "res",
            id: frame.id,
            ...(result.value === undefined ? {} : { result: result.value }),
          });
          finish(target, null);
        });
      } else {
        reply(() => {
          this.#error(attached, frame.id, result.code, result.message);
          finish(target, result.code);
        });
      }
    } catch (error) {
      const failure =
        error instanceof DispatchError
          ? error
          : new DispatchError("E_INTERNAL", "The host failed while handling this call.");
      reply(() => {
        this.#error(attached, frame.id, failure.code, failure.message, {
          ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
          ...(failure.data === undefined ? {} : { data: failure.data }),
        });
        finish(target, failure.code);
      });
    } finally {
      clearTimeout(timer);
      attached.aborts.delete(abort);
      attached.inFlight -= 1;
    }
  }

  #error(
    attached: Attached,
    id: string,
    code: ProtocolErrorCode,
    message: string,
    extra: { retryAfterMs?: number; data?: JsonValue } = {},
  ): void {
    const error: ErrorPayload = {
      code,
      message,
      ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
      ...(extra.data === undefined ? {} : { data: extra.data }),
    };
    attached.channel.send({ t: "err", id, error });
  }

  // -------------------------------------------------------------------------------------------
  // Outbound: the plugin answering the host
  // -------------------------------------------------------------------------------------------

  #settle(pluginId: string, id: string, frame: Envelope): boolean {
    const attached = this.#attached.get(pluginId);
    if (attached === undefined) return false;
    const pending = attached.pending.get(id);
    // Not an error and not a log line: a reply to an id the caller already gave up on is exactly
    // what the deadline design says will happen, and dropping it is the correct handling.
    if (pending === undefined) return true;

    attached.pending.delete(id);
    clearTimeout(pending.timer);

    if (frame.t === "err") {
      pending.reject(
        new DispatchError(frame.error.code, frame.error.message, {
          ...(frame.error.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: frame.error.retryAfterMs }),
          ...(frame.error.data === undefined ? {} : { data: frame.error.data }),
        }),
      );
      return true;
    }
    pending.resolve(frame.t === "res" ? frame.result : undefined);
    return true;
  }
}
