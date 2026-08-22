/**
 * The plugin wire protocol: the complete, enumerable set of frames that may cross the boundary
 * between the daemon and a plugin process, plus the validation that decides whether a frame is one
 * of them.
 *
 * ## Why an explicit envelope and not Comlink
 *
 * Comlink's value is making the boundary invisible. For a *security* boundary that is exactly
 * wrong: you cannot enumerate the surface, you cannot schema-validate it, and you cannot attach a
 * per-call scope check or a deadline without fighting the proxy. So the surface is written down —
 * {@link FRAME_TAGS} is the whole vocabulary, and everything reaching the host goes through
 * {@link parseEnvelope} first. See PLAN.md §Phase 3 "RPC: hand-rolled envelope protocol, not
 * Comlink".
 *
 * ## Why hand-rolled validation rather than Zod
 *
 * The manifest is validated by a Zod schema, and rightly so — it is read once at install time and
 * the schema is also the source for the published JSON Schema, the consent UI, and the docs. This
 * file is the opposite case: it runs on every frame of a burst (log tailing puts 40+ events on the
 * bus during an instance transition), and the things it must enforce are byte budgets and depth
 * caps rather than a shape a schema language describes well. It also has to stay dependency-free
 * enough to run inside the host-injected prelude.
 *
 * ## The peer is hostile
 *
 * Every function here treats its input as attacker-controlled. Nothing throws on bad input —
 * {@link parseEnvelope} returns a {@link ParseResult}, because a malformed frame must cost the
 * plugin its own call and nothing else. Where a cap is the only available defence (frame size,
 * nesting depth, batch length) the cap is a named constant below rather than a number buried in a
 * check.
 */

import type { JsonObject, JsonValue, Scope } from "@vrcz/shared";
import type { PluginCapability } from "./capabilities.ts";

// ---------------------------------------------------------------------------------------------
// Limits. Every one of these exists because it is the only thing standing between a hostile peer
// and an unbounded allocation, an unbounded recursion, or an unbounded wait.
// ---------------------------------------------------------------------------------------------

/**
 * Hard ceiling on one encoded frame, in UTF-8 bytes. Checked *before* `JSON.parse`, because
 * parsing is where the allocation happens and a 400MB frame that is rejected after parsing has
 * already cost what it was going to cost.
 */
export const MAX_FRAME_BYTES = 1_048_576;

/**
 * Nesting depth allowed inside any caller-supplied JSON (`params`, `result`, event payloads).
 *
 * Deep nesting is the cheapest denial of service available to the peer: a few hundred bytes of
 * `[[[[...]]]]` turns any recursive walk — ours, or a plugin's `structuredClone` — into a stack
 * overflow. The same 32 that caps the UI node tree, for the same reason.
 */
export const MAX_JSON_DEPTH = 32;

/** Correlation ids are host-minted or plugin-minted counters; nothing legitimate is long. */
export const MAX_ID_LENGTH = 64;

/** `vrchat.friends.list` and the like. A dotted method name, not a sentence. */
export const MAX_METHOD_LENGTH = 96;

/** Error messages are shown in the plugin log, not parsed. Long enough to be useful, capped anyway. */
export const MAX_MESSAGE_LENGTH = 1024;

/** Event kinds are dotted paths from the shared vocabulary; see {@link EventFilter.kinds}. */
export const MAX_KIND_LENGTH = 64;

/** Kind patterns per subscription. A plugin wanting more than this wants no filter at all. */
export const MAX_FILTER_KINDS = 64;

/** Values per id list in a filter. Six accounts is the realistic ceiling; 64 is generous. */
export const MAX_FILTER_VALUES = 64;

/** Events the host may put in one {@link EventFrame}. The per-tick batch cannot exceed this. */
export const MAX_BATCH_EVENTS = 256;

/** Outstanding un-acknowledged events a subscription may be granted. The credit window. */
export const MAX_CREDITS = 4096;

/** A coalesce key path: `userId`, `payload.userId`. Not a query language. */
export const MAX_KEY_PATH_SEGMENTS = 4;

/**
 * How far into the future a deadline may sit. A peer that sets a deadline of `Number.MAX_VALUE`
 * is asking the other side to hold a pending entry forever; ten minutes is longer than any
 * legitimate call and short enough that a leak drains.
 */
export const MAX_DEADLINE_HORIZON_MS = 600_000;

// ---------------------------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------------------------

/**
 * Deadlines ride the wire as an **absolute unix-ms instant**, never as a duration.
 *
 * A duration would mean "you have 5000ms", which requires both sides to agree on when the clock
 * started — and they cannot, because the two processes do not share a start: the frame sits in a
 * pipe, the callee's event loop may be busy when it arrives, and a duration silently restarts at
 * whatever moment the callee happens to look at it. An absolute instant is the same instant no
 * matter how long the frame spent in transit, which is what makes the budget real.
 *
 * **The consequence is clock skew, and it is real.** Two processes on one machine read the same OS
 * clock, so ordinary drift is not the problem; a wall-clock *step* is — an NTP correction, or the
 * user setting the system clock — and it moves both processes at once but not necessarily between
 * two reads. What the host does about it:
 *
 * - **The caller is the only enforcer.** The host times its own pending calls with its own clock
 *   and, when the deadline passes, aborts the id locally. A reply that arrives afterwards is
 *   dropped rather than resolved, so a skewed callee can be late but can never resurrect a call the
 *   caller has already finished with.
 * - **The callee treats the deadline as advisory.** The prelude surfaces it as a budget hint (and
 *   as an `AbortSignal` on {@link DispatchContext}); it must never *refuse* a call because the
 *   deadline looks expired, since under a backwards step every deadline looks expired and the
 *   plugin would answer nothing at all.
 * - **The horizon is capped** at {@link MAX_DEADLINE_HORIZON_MS}, which bounds what a forward step
 *   can do to a pending table.
 */
export type Deadline = number;

/** True when `deadline` has passed on *this* process's clock. See {@link Deadline} on who calls it. */
export function isExpired(deadline: Deadline, now: number = Date.now()): boolean {
  return deadline <= now;
}

/** Builds an absolute deadline from a duration, clamped to the wire-legal horizon. */
export function deadlineIn(timeoutMs: number, now: number = Date.now()): Deadline {
  const bounded = Math.min(Math.max(Math.trunc(timeoutMs), 0), MAX_DEADLINE_HORIZON_MS);
  return now + bounded;
}

// ---------------------------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------------------------

export interface ProtocolErrorDefinition {
  /** Addressed to the plugin author reading their log, not to the end user. */
  readonly description: string;
  /**
   * Whether the same call, unchanged, could succeed later. Advisory — `retryable` is not
   * permission to retry in a tight loop; see {@link ErrorPayload.retryAfterMs}.
   */
  readonly retryable: boolean;
}

/**
 * The closed set of error codes. A frame carrying anything else is rejected, so a plugin can
 * `switch` on this exhaustively and a new code is a protocol-major concern.
 */
export const PROTOCOL_ERRORS = {
  /** The frame was not a legal envelope: unknown tag, wrong direction, over a size cap. */
  E_PROTOCOL: {
    description: "The frame was not a valid protocol envelope.",
    retryable: false,
  },
  /** The frame was legal but the method's own parameters failed to parse. */
  E_BAD_REQUEST: {
    description: "The request parameters were missing, mistyped, or out of range.",
    retryable: false,
  },
  E_UNKNOWN_METHOD: {
    description: "No such method in this protocol major.",
    retryable: false,
  },
  /** The method needs a scope the user did not grant. Requesting it means a re-consent. */
  E_SCOPE_DENIED: {
    description: "The plugin does not hold the scope this method requires.",
    retryable: false,
  },
  /**
   * The scope is granted, but not for the account the call named. A plugin with `friends:read`
   * does not implicitly get it for all six of the user's accounts — see PLAN.md §Phase 3
   * "Manifest, lifecycle, storage".
   */
  E_ACCOUNT_DENIED: {
    description: "The plugin was not granted access to that account.",
    retryable: false,
  },
  /**
   * The plugin's share of the shared rate limiter is spent. Carries
   * {@link ErrorPayload.retryAfterMs}.
   *
   * **Wait for `retryAfterMs`. Retrying immediately is a bug in your plugin, and it is a
   * bannable-behaviour bug** — not in vrc.zip's opinion, in VRChat's. Every call a plugin makes is
   * a call against the *user's* account. A plugin that polls through a 429 gets the person running
   * it rate-limited and potentially moderated, and they will blame vrc.zip rather than you. The
   * host tags every call with the plugin id, meters a subordinate per-plugin budget, and names the
   * plugin eating it in the UI, so a hot retry loop is visible to the user by design. See PLAN.md
   * §Phase 3 correction 3.
   */
  E_RATE_LIMIT: {
    description: "The plugin's rate budget is exhausted. Wait retryAfterMs before retrying.",
    retryable: true,
  },
  /** The caller's deadline passed before a reply arrived. Synthesised by the caller, not the peer. */
  E_TIMEOUT: {
    description: "The call did not complete before its deadline.",
    retryable: true,
  },
  /** The call was abandoned: the subsystem shut down, the plugin was disabled, the panel closed. */
  E_CANCELLED: {
    description: "The call was cancelled before it completed.",
    retryable: false,
  },
  /** A frame, parameter, or result exceeded a size cap. */
  E_TOO_LARGE: {
    description: "The payload exceeded a protocol size limit.",
    retryable: false,
  },
  /**
   * The method needs a host capability the user did not grant — `storage`, `notify`, `webhook`.
   *
   * Distinct from {@link PROTOCOL_ERRORS.E_SCOPE_DENIED} because the fix is different: a scope is
   * authority over the user's VRChat account, a capability is a power of the host. Telling an
   * author "you are missing the storage capability" when they are staring at a full scope list is
   * worth a separate code.
   */
  E_CAPABILITY_DENIED: {
    description: "The plugin does not hold the capability this method requires.",
    retryable: false,
  },
  /** The plugin's per-plugin SQLite quota is full. Deleting records is the fix, not waiting. */
  E_QUOTA: {
    description: "The plugin's storage quota is exhausted.",
    retryable: false,
  },
  /**
   * An outbound social action was accepted and *not performed*, because the plugin is still in
   * dry-run for that scope. The user lifts dry-run by an explicit gesture in the plugin's
   * management page. See PLAN.md §Phase 3 correction 4.
   */
  E_DRY_RUN: {
    description: "The action was logged but not performed: this plugin is in dry-run.",
    retryable: false,
  },
  /** The host could serve the method in principle but not now: account offline, pipeline down. */
  E_UNAVAILABLE: {
    description: "The host subsystem needed for this call is not currently available.",
    retryable: true,
  },
  /** VRChat itself returned an error. `data` carries the upstream status where there was one. */
  E_UPSTREAM: {
    description: "VRChat returned an error for this request.",
    retryable: true,
  },
  /** A bug on whichever side produced it. Never carries detail from the other side's internals. */
  E_INTERNAL: {
    description: "The peer failed unexpectedly while handling this call.",
    retryable: true,
  },
} as const satisfies Record<string, ProtocolErrorDefinition>;

export type ProtocolErrorCode = keyof typeof PROTOCOL_ERRORS;

export const PROTOCOL_ERROR_CODES = Object.keys(PROTOCOL_ERRORS) as readonly ProtocolErrorCode[];

export function isProtocolErrorCode(value: string): value is ProtocolErrorCode {
  return Object.hasOwn(PROTOCOL_ERRORS, value);
}

export interface ErrorPayload {
  readonly code: ProtocolErrorCode;
  /** One line, for the plugin's log. Never contains host internals or anything cookie-shaped. */
  readonly message: string;
  /**
   * Milliseconds to wait before the call could succeed. Set on `E_RATE_LIMIT`, and optionally on
   * `E_UNAVAILABLE` and `E_UPSTREAM`.
   *
   * Treat it as a floor, not a target: it is how long until the budget *might* be there, not a
   * promise that it will be. See the note on {@link PROTOCOL_ERRORS} `E_RATE_LIMIT` about why
   * ignoring it is a bannable-behaviour bug in the plugin's own code.
   */
  readonly retryAfterMs?: number;
  readonly data?: JsonValue;
}

// ---------------------------------------------------------------------------------------------
// Events on the wire
// ---------------------------------------------------------------------------------------------

/**
 * A bus event as a plugin sees it — the daemon's `BusEvent` reduced to JSON.
 *
 * `kind` is a bare `string` rather than the narrow `BusEventKind` on purpose, matching the
 * producer/consumer split in `@vrcz/shared/events.ts`: a plugin compiled against an older protocol
 * must still receive, filter, and render a kind a newer daemon invented, rather than have the host
 * drop it on the floor. Strictness belongs at the point of emission.
 */
export interface PluginEvent {
  readonly kind: string;
  /** Owning account, or `null` for events not attributable to one (an unlinked game session). */
  readonly accountId: string | null;
  /** Unix ms, integer. Timestamps are integer unix-ms everywhere, including here. */
  readonly ts: number;
  /** The user, world, or group this is about, when there is one. */
  readonly subjectId?: string | null;
  /** The `sessions` row id on `gamelog.*` events. Sessions are not accounts. */
  readonly sessionId?: number | null;
  readonly location?: string | null;
  readonly payload?: JsonValue;
}

/**
 * A subscription filter, expressed as **data rather than a predicate function**.
 *
 * This is the first of the three backpressure mechanisms and the reason the other two are rarely
 * needed. It is data so that the host can compile it to a closure once, at subscribe time
 * ({@link compileFilter}), and then spend one `Set.has` per event deciding whether a plugin process
 * is woken at all. A predicate would have to cross the process boundary per event, which is the
 * cost the filter exists to avoid — log tailing bursts 40+ `gamelog.player_join` events on an
 * instance transition and `friend.location` fires for every friend move. See PLAN.md §Phase 3
 * "Backpressure is load-bearing".
 *
 * Fields are ANDed; values within a field are ORed. There is deliberately no negation, no
 * disjunction across fields, and no expression language: every operator here is an equality or a
 * dotted-prefix test, so the cost of a filter is bounded by construction.
 */
export interface EventFilter {
  /** Literal kinds (`friend.online`) or prefix wildcards (`gamelog.*`). Omitted means all kinds. */
  readonly kinds?: readonly string[];
  /** Omitted means every account the plugin was granted — the host narrows to the grant anyway. */
  readonly accountIds?: readonly string[];
  /** Match on the event's subject (a user, world, or group id). */
  readonly subjectIds?: readonly string[];
}

/** A filter compiled to a closure. Pure; safe to call on every event. */
export type CompiledFilter = (event: PluginEvent) => boolean;

/**
 * Compiles a filter once so matching is set lookups rather than array scans.
 *
 * Kind matching mirrors the EventBus: an entry ending in `.*` matches any kind under that dotted
 * prefix, anything else is exact.
 */
export function compileFilter(filter: EventFilter): CompiledFilter {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const kind of filter.kinds ?? []) {
    if (kind.endsWith(".*")) prefixes.push(kind.slice(0, -1));
    else exact.add(kind);
  }
  const anyKind = exact.size === 0 && prefixes.length === 0;
  const accounts = filter.accountIds ? new Set(filter.accountIds) : undefined;
  const subjects = filter.subjectIds ? new Set(filter.subjectIds) : undefined;

  return (event) => {
    if (!anyKind && !exact.has(event.kind) && !prefixes.some((p) => event.kind.startsWith(p))) {
      return false;
    }
    // A null accountId (an unlinked game session) can never match an id list: the subscription
    // asked for named accounts and this event belongs to none of them.
    if (accounts && (event.accountId === null || !accounts.has(event.accountId))) return false;
    if (subjects && (typeof event.subjectId !== "string" || !subjects.has(event.subjectId))) {
      return false;
    }
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// Delivery policy: credit windows, overflow, per-tick batching
// ---------------------------------------------------------------------------------------------

/**
 * What the host does to a subscription's pending queue when it is full — that is, when the plugin
 * has not returned credit fast enough to keep up with the bus.
 *
 * Closed set. There is deliberately **no `block` policy**: blocking is what backpressure exists to
 * prevent, and `EventBus.emit()` must never await anything plugin-related. A plugin that cannot
 * keep up loses events; it does not get to slow the daemon down.
 *
 * Given a burst of 900 `friend.location` events into a window of 100, each policy yields:
 *
 * - `drop-newest` — the plugin sees the **first** 100 and the 800 after them are shed. Right when
 *   the events are individually meaningful and order matters (an audit log), wrong for presence,
 *   where it leaves the plugin looking at a stale world forever.
 * - `drop-oldest` — a ring buffer: the plugin sees the **last** 100. Right when only recency
 *   matters and the events are not per-entity.
 * - `coalesce` — with `keyPath: "userId"`, the plugin sees **each friend's current location**,
 *   one entry per friend, however many times they moved. This is the motivating case from PLAN.md
 *   and the correct default for anything presence-shaped: a slow plugin gets the truth, late,
 *   rather than 900 events describing a path it no longer cares about.
 * - `disconnect` — the subscription is closed and the plugin is told. For a plugin whose
 *   correctness genuinely depends on seeing every event: better a loud failure than silent gaps.
 */
export const OVERFLOW_POLICIES = ["drop-newest", "drop-oldest", "coalesce", "disconnect"] as const;

export type OverflowPolicy = (typeof OVERFLOW_POLICIES)[number];

export function isOverflowPolicy(value: string): value is OverflowPolicy {
  return (OVERFLOW_POLICIES as readonly string[]).includes(value);
}

export interface DeliveryPolicy {
  /**
   * The credit window: how many events may be outstanding before the queue is considered full.
   * The plugin returns credit with a {@link CreditFrame} as it finishes processing.
   */
  readonly credits: number;
  /**
   * Per-tick batching: the most events the host will pack into one {@link EventFrame}. One frame
   * of 40 join events costs one wakeup and one parse; 40 frames cost 40 of each.
   */
  readonly maxBatch: number;
  readonly overflow: OverflowPolicy;
  /**
   * Required by, and only legal with, `overflow: "coalesce"`. A dotted path naming the entity a
   * pending event is *about*, so a newer event about the same entity can replace it.
   *
   * Resolution rule, since PLAN.md writes the friend-location case as plain `"userId"` while the
   * id in question lives in the payload: **a path whose first segment is not a field of the event
   * is resolved against `payload`.** So `"userId"` and `"payload.userId"` both work, and
   * `"subjectId"` addresses the event field. A path that resolves to anything but a string,
   * number, or boolean makes the event uncoalescable — it queues normally and is never replaced.
   */
  readonly keyPath?: string;
}

/** Why the host shed events. Reported on a {@link DroppedFrame}. */
export const DROP_REASONS = ["overflow", "coalesced", "shutdown"] as const;

export type DropReason = (typeof DROP_REASONS)[number];

/**
 * Reads a coalesce key off an event. See {@link DeliveryPolicy.keyPath} for the resolution rule.
 * Returns `undefined` when the path does not resolve to a primitive, which means "uncoalescable".
 */
export function readKeyPath(event: PluginEvent, keyPath: string): string | undefined {
  const segments = keyPath.split(".");
  const head = segments[0];
  if (head === undefined) return undefined;

  let cursor: JsonValue | undefined =
    head in event
      ? (event as unknown as JsonObject)[head]
      : // Not an event field, so the whole path is a payload path.
        isJsonRecord(event.payload)
        ? event.payload[head]
        : undefined;

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined || !isJsonRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }

  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);
  return undefined;
}

/**
 * Collapses a batch to the newest event per key, preserving the position of each key's *first*
 * appearance so a chatty key cannot repeatedly jump the queue and starve a quiet one.
 *
 * Uncoalescable events (no resolvable key) are all kept, in order.
 */
export function coalesceByKey<T extends PluginEvent>(
  events: readonly T[],
  keyPath: string,
): { readonly kept: T[]; readonly dropped: number } {
  const kept: T[] = [];
  const slotByKey = new Map<string, number>();

  for (const event of events) {
    const key = readKeyPath(event, keyPath);
    if (key === undefined) {
      kept.push(event);
      continue;
    }
    const slot = slotByKey.get(key);
    if (slot === undefined) {
      slotByKey.set(key, kept.length);
      kept.push(event);
    } else {
      kept[slot] = event;
    }
  }

  return { kept, dropped: events.length - kept.length };
}

/**
 * The reference semantics of {@link OverflowPolicy}, as executable code rather than prose: enqueue
 * one event against a subscription's pending queue.
 *
 * It lives in the protocol package because a policy name on the wire is worth nothing if the two
 * sides disagree about what it does — the host implements its queue against this, and a plugin
 * author can read it to see exactly which events they will and will not be shown.
 *
 * Note that `coalesce` supersedes whenever a key is already pending, not only when the queue is
 * full: replacement is the entire point of the policy, and delaying it until the window fills
 * would hand the plugin a backlog it explicitly asked not to have. A superseded event counts as
 * dropped and is reported with reason `"coalesced"`, because the plugin did not see it and the
 * host's job is to say so.
 */
export function applyOverflow<T extends PluginEvent>(
  queue: readonly T[],
  incoming: T,
  policy: DeliveryPolicy,
): { readonly queue: T[]; readonly dropped: number; readonly close: boolean } {
  const next = [...queue];

  if (policy.overflow === "coalesce" && policy.keyPath !== undefined) {
    const key = readKeyPath(incoming, policy.keyPath);
    if (key !== undefined) {
      const slot = next.findIndex((queued) => readKeyPath(queued, policy.keyPath ?? "") === key);
      if (slot >= 0) {
        next[slot] = incoming;
        return { queue: next, dropped: 1, close: false };
      }
    }
  }

  if (next.length < policy.credits) {
    next.push(incoming);
    return { queue: next, dropped: 0, close: false };
  }

  switch (policy.overflow) {
    case "drop-newest":
      return { queue: next, dropped: 1, close: false };
    // A coalesce subscription whose keys are all distinct has degenerated into an unbounded
    // queue, so it falls back to the ring-buffer behaviour rather than growing without bound.
    case "coalesce":
    case "drop-oldest":
      next.shift();
      next.push(incoming);
      return { queue: next, dropped: 1, close: false };
    case "disconnect":
      return { queue: next, dropped: 1, close: true };
  }
}

// ---------------------------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------------------------

/** Which side of the boundary a frame may originate from. */
export type PeerRole = "host" | "plugin";

/** Host → plugin, or plugin → host. Both sides make calls; the protocol is symmetric. */
export interface RequestFrame {
  readonly t: "req";
  readonly id: string;
  /** Dotted method name, resolved in the receiver's dispatch table. */
  readonly method: string;
  readonly params?: JsonValue;
  /** Absolute unix-ms. See {@link Deadline}. */
  readonly deadline: Deadline;
}

export interface ResponseFrame {
  readonly t: "res";
  readonly id: string;
  readonly result?: JsonValue;
}

export interface ErrorFrame {
  readonly t: "err";
  readonly id: string;
  readonly error: ErrorPayload;
}

/** Plugin → host. Answered with a {@link ResponseFrame} or an {@link ErrorFrame} on the same id. */
export interface SubscribeFrame {
  readonly t: "subscribe";
  readonly id: string;
  readonly deadline: Deadline;
  /** Plugin-chosen subscription id, carried on every event and dropped frame that follows. */
  readonly sub: string;
  readonly filter: EventFilter;
  readonly delivery: DeliveryPolicy;
}

export interface UnsubscribeFrame {
  readonly t: "unsubscribe";
  readonly id: string;
  readonly deadline: Deadline;
  readonly sub: string;
}

/** Host → plugin. A per-tick batch, never more than {@link DeliveryPolicy.maxBatch} events. */
export interface EventFrame {
  readonly t: "event";
  readonly sub: string;
  /**
   * Sequence number of the first event in this batch, monotonic per subscription. With
   * {@link DroppedFrame.count} it lets a plugin verify it has seen everything it was sent.
   */
  readonly seq: number;
  readonly events: readonly PluginEvent[];
}

/**
 * Host → plugin. **The host says when it sheds load** rather than letting the plugin believe it saw
 * everything — a plugin silently missing events writes wrong data and never finds out why.
 */
export interface DroppedFrame {
  readonly t: "dropped";
  readonly sub: string;
  readonly count: number;
  readonly reason: DropReason;
  /** Sequence number the next delivered event will carry, so the gap is locatable. */
  readonly seq: number;
}

/** Plugin → host. Returns credit for events the plugin has finished processing. */
export interface CreditFrame {
  readonly t: "credit";
  readonly sub: string;
  /** Events processed since the last credit frame. Capped at {@link MAX_CREDITS}. */
  readonly credits: number;
}

/**
 * Plugin → host, once, as the first frame after boot. Sent by the prelude, not by plugin code.
 *
 * A mismatched `protocol` is a hard stop at the supervisor: the plugin is disabled with a message
 * naming the version it needs, rather than being allowed to speak a dialect the host guesses at.
 */
export interface HelloFrame {
  readonly t: "hello";
  /** Protocol major the plugin was built against — `PLUGIN_API_PROTOCOL_MAJOR`. */
  readonly protocol: number;
  readonly pluginId: string;
}

/** Host → plugin lifecycle transitions, each answered on its id like any other request. */
export const LIFECYCLE_PHASES = ["activate", "deactivate", "shutdown"] as const;

export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export interface LifecycleFrame {
  readonly t: "lifecycle";
  readonly id: string;
  readonly deadline: Deadline;
  readonly phase: LifecyclePhase;
}

/**
 * Host → plugin heartbeat.
 *
 * **The echo lives in the host-injected prelude, not in plugin code**, which is the whole point:
 * the plugin cannot forget to answer, cannot answer wrongly, and — the property that matters — a
 * plugin that blocks its event loop in a spin loop stops answering no matter what it intended,
 * because the reply needs a turn of the loop it is refusing to yield. A missed heartbeat is
 * therefore evidence about the runtime, not about the author. See PLAN.md §Phase 3 "Isolation:
 * child process, not Worker".
 */
export interface PingFrame {
  readonly t: "ping";
  readonly nonce: string;
  /** Absolute unix-ms by which the supervisor expects the pong. See {@link Deadline}. */
  readonly deadline: Deadline;
}

export interface PongFrame {
  readonly t: "pong";
  readonly nonce: string;
  /** Resident set size in bytes, when the runtime can report it. Feeds the RSS watchdog. */
  readonly rss?: number;
}

/**
 * The complete protocol surface. If it is not in this union it does not cross the boundary.
 */
export type Envelope =
  | RequestFrame
  | ResponseFrame
  | ErrorFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | EventFrame
  | DroppedFrame
  | CreditFrame
  | HelloFrame
  | LifecycleFrame
  | PingFrame
  | PongFrame;

export type FrameTag = Envelope["t"];

/**
 * Every tag, with the side allowed to send it. Direction is part of validation, not documentation:
 * without it a plugin could send itself an `event` frame's worth of forged bus data, or answer a
 * `ping` it was never asked, and the host would have no reason to object.
 */
export const FRAME_SENDERS = {
  req: "both",
  res: "both",
  err: "both",
  subscribe: "plugin",
  unsubscribe: "plugin",
  event: "host",
  dropped: "host",
  credit: "plugin",
  hello: "plugin",
  lifecycle: "host",
  ping: "host",
  pong: "plugin",
} as const satisfies Record<FrameTag, PeerRole | "both">;

export const FRAME_TAGS = Object.keys(FRAME_SENDERS) as readonly FrameTag[];

export function isFrameTag(value: string): value is FrameTag {
  return Object.hasOwn(FRAME_SENDERS, value);
}

/** True when a peer in role `from` is allowed to send this tag. */
export function isFrameAllowedFrom(tag: FrameTag, from: PeerRole): boolean {
  const sender = FRAME_SENDERS[tag];
  return sender === "both" || sender === from;
}

// ---------------------------------------------------------------------------------------------
// The dispatcher contract
// ---------------------------------------------------------------------------------------------

/**
 * What the user actually approved for this plugin, as the dispatcher sees it.
 *
 * Deliberately **not** the manifest type. The manifest is what the author *requested*; a grant is
 * what the person at the consent screen approved, which is narrower whenever they unticked
 * something and is keyed by `(pluginId, version, grantHash)` in the store. Nothing on the call path
 * may consult the manifest — that is the seam, and this interface is where it sits. The manifest
 * module is imported by the install and consent paths only.
 */
export interface PluginGrant {
  readonly pluginId: string;
  readonly scopes: readonly Scope[];
  /** Accounts this grant covers. A plugin with `friends:read` does not get all six accounts. */
  readonly accountIds: readonly string[];
  /**
   * Host powers the user approved: a private database, notifications, the two network replacements.
   *
   * Required rather than optional, and the reason is the failure mode. Optional would mean a
   * construction site that forgot it produces a grant holding *no* capabilities, which denies
   * correctly today and reads as "this plugin asked for nothing" forever after — a silent,
   * plausible wrong answer. Required makes every site say what it means, and the compiler finds
   * them all.
   */
  readonly capabilities: readonly PluginCapability[];
  /**
   * The event patterns the user was shown and approved: `*`, `family.*`, or exact kinds.
   *
   * **Empty denies everything**, which is why this is required rather than optional. It is a second
   * gate rather than a replacement for the first: the scope decides what a plugin may *see at all*,
   * and this decides which of that it asked to be told about. A pattern naming a kind the grant has
   * no scope for grants nothing — the narrower of the two always wins.
   *
   * Strings rather than the manifest's `EventPattern` type, because this module may not import the
   * manifest. `isEventPatternString` and `anyEventPatternMatches` in `@vrcz/shared` are the shared
   * definition both sides use.
   */
  readonly events: readonly string[];
  /** Scopes still in dry-run: outbound actions are logged and not performed. Correction 4. */
  readonly dryRunScopes?: readonly Scope[];
}

export interface DispatchContext {
  readonly grant: PluginGrant;
  /** The call's absolute deadline, forwarded so a handler can bound its own work. */
  readonly deadline: Deadline;
  /** Aborted when the caller gives up. A handler that ignores it wastes work, not correctness. */
  readonly signal: AbortSignal;
  /** The account this call targets, already checked against {@link PluginGrant.accountIds}. */
  readonly accountId?: string;
}

/**
 * A method as its author writes it: a parser, a scope, a budget cost, and a handler that receives
 * *parsed* parameters.
 *
 * The shape is the enforcement. A handler cannot check a scope because it is not given anything to
 * check one with, and it cannot forget to validate its arguments because it never sees the raw
 * ones — `parse` has already run or the call has already failed. That is the single dispatcher
 * contract PLAN.md asks for: "a single dispatcher does arg parsing and the scope check — never the
 * handlers."
 */
export interface MethodDefinition<Params, Result extends JsonValue | undefined> {
  /**
   * The scope this method requires, or `null` for one that needs none (`ui.setPanel` acts only on
   * the plugin's own panel). `null` is spelled out rather than omitted so that adding a method
   * without thinking about its scope is not possible.
   */
  readonly scope: Scope | null;
  /**
   * The host capability this method requires, or `null` for one that needs none.
   *
   * Separate from {@link MethodDefinition.scope} because they are different questions: a scope is
   * authority over the user's VRChat account, a capability is a power of the host itself. A method
   * may need one, the other, both, or neither — `storage.kv.get` needs `storage` and no scope at
   * all, because a plugin's own database says nothing about VRChat.
   */
  readonly capability: PluginCapability | null;
  /**
   * Units charged against the plugin's subordinate rate budget. A method that reaches VRChat costs
   * at least 1; a purely local one costs 0. See PLAN.md §Phase 3 correction 3.
   */
  readonly cost: number;
  readonly parse: (raw: JsonValue | undefined) => ParseResult<Params>;
  readonly handle: (params: Params, ctx: DispatchContext) => Promise<Result>;
}

/**
 * A method with its parameter type erased, so one table can hold methods that parse to different
 * shapes. Produced only by {@link defineMethod}, which is what keeps parse-then-handle atomic.
 */
export interface ErasedMethod {
  readonly scope: Scope | null;
  readonly capability: PluginCapability | null;
  readonly cost: number;
  readonly invoke: (
    raw: JsonValue | undefined,
    ctx: DispatchContext,
  ) => Promise<ParseResult<JsonValue | undefined>>;
}

export type MethodTable = Readonly<Record<string, ErasedMethod>>;

/** Wraps a typed method definition into a table entry, binding `parse` to `handle`. */
export function defineMethod<Params, Result extends JsonValue | undefined>(
  definition: MethodDefinition<Params, Result>,
): ErasedMethod {
  return {
    scope: definition.scope,
    capability: definition.capability,
    cost: definition.cost,
    invoke: async (raw, ctx) => {
      const parsed = definition.parse(raw);
      if (!parsed.ok) return parsed;
      return { ok: true, value: await definition.handle(parsed.value, ctx) };
    },
  };
}

/**
 * The gate every call passes through before a handler runs: method lookup, deadline, then scope.
 *
 * Pure — it decides, it does not act — so the dispatcher that owns the transport is left with
 * "authorize, then invoke, then charge {@link ErasedMethod.cost}" and no room to grow a second
 * place where a scope is checked.
 */
export function authorizeCall(
  table: MethodTable,
  frame: RequestFrame,
  grant: PluginGrant,
  now: number = Date.now(),
): ParseResult<ErasedMethod> {
  const method = table[frame.method];
  if (method === undefined) {
    return fail("E_UNKNOWN_METHOD", `No such method: ${frame.method}`);
  }
  // Checked before the handler runs rather than after: a call whose budget is already spent must
  // not consume rate limiter or storage on its way to being discarded.
  if (isExpired(frame.deadline, now)) {
    return fail("E_TIMEOUT", `Deadline for ${frame.method} passed before dispatch`);
  }
  if (method.scope !== null && !grant.scopes.includes(method.scope)) {
    return fail("E_SCOPE_DENIED", `${frame.method} requires the ${method.scope} scope`);
  }
  // After the scope and before anything runs, for the same reason: a capability the user did not
  // approve is not a thing a handler may be asked to decline for itself.
  if (method.capability !== null && !grant.capabilities.includes(method.capability)) {
    return fail(
      "E_CAPABILITY_DENIED",
      `${frame.method} requires the ${method.capability} capability`,
    );
  }
  return { ok: true, value: method };
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ProtocolErrorCode; readonly message: string };

function fail(code: ProtocolErrorCode, message: string): ParseResult<never> {
  return { ok: false, code, message };
}

export interface ParseOptions {
  /** When given, frames the peer in that role may not send are rejected. */
  readonly from?: PeerRole;
  /** Defaults to `Date.now()`; only used for the deadline horizon check. */
  readonly now?: number;
}

/**
 * Decodes one encoded frame: size cap, then `JSON.parse`, then {@link parseEnvelope}.
 *
 * The byte cap is applied to the *text*, before parsing, because parsing is where a hostile frame
 * gets to allocate. `JSON.parse` can also throw a `RangeError` on pathological nesting, which is
 * caught here for the same reason nothing else in this file throws.
 */
export function decodeEnvelope(text: string, options: ParseOptions = {}): ParseResult<Envelope> {
  if (exceedsFrameCap(text)) {
    return fail("E_TOO_LARGE", `Frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("E_PROTOCOL", "Frame was not valid JSON");
  }
  return parseEnvelope(value, options);
}

/**
 * Encodes a frame, refusing one that is over the byte cap.
 *
 * The sender checks too, rather than leaving it to the receiver's `decodeEnvelope`: a host that
 * only discovers an oversized frame on the far side has already written it into a pipe, and a
 * plugin that only learns from an `E_TOO_LARGE` reply has lost the call it could have failed
 * locally with the payload still in hand.
 */
export function encodeEnvelope(frame: Envelope): ParseResult<string> {
  const text = JSON.stringify(frame);
  if (exceedsFrameCap(text)) {
    return fail("E_TOO_LARGE", `Frame exceeds ${MAX_FRAME_BYTES} bytes`);
  }
  return { ok: true, value: text };
}

/**
 * Validates an already-parsed value as an {@link Envelope}.
 *
 * Returns a result; never throws. The peer is untrusted and a malformed frame must cost it its own
 * call, not the host's process.
 */
export function parseEnvelope(value: unknown, options: ParseOptions = {}): ParseResult<Envelope> {
  if (!isRecord(value)) return fail("E_PROTOCOL", "Frame was not an object");

  const tag = value.t;
  if (typeof tag !== "string") return fail("E_PROTOCOL", "Frame has no tag");
  if (!isFrameTag(tag)) return fail("E_PROTOCOL", `Unknown frame tag: ${truncate(tag)}`);
  if (options.from !== undefined && !isFrameAllowedFrom(tag, options.from)) {
    return fail("E_PROTOCOL", `A ${options.from} may not send a ${tag} frame`);
  }
  const now = options.now ?? Date.now();

  switch (tag) {
    case "req": {
      const id = parseId(value.id);
      if (!id.ok) return id;
      const method = parseName(value.method, MAX_METHOD_LENGTH, "method");
      if (!method.ok) return method;
      const deadline = parseDeadline(value.deadline, now);
      if (!deadline.ok) return deadline;
      const params = parseOptionalJson(value.params, "params");
      if (!params.ok) return params;
      const frame: RequestFrame = {
        t: "req",
        id: id.value,
        method: method.value,
        deadline: deadline.value,
        ...(params.value === undefined ? {} : { params: params.value }),
      };
      return { ok: true, value: frame };
    }

    case "res": {
      const id = parseId(value.id);
      if (!id.ok) return id;
      const result = parseOptionalJson(value.result, "result");
      if (!result.ok) return result;
      const frame: ResponseFrame = {
        t: "res",
        id: id.value,
        ...(result.value === undefined ? {} : { result: result.value }),
      };
      return { ok: true, value: frame };
    }

    case "err": {
      const id = parseId(value.id);
      if (!id.ok) return id;
      const error = parseErrorPayload(value.error);
      if (!error.ok) return error;
      return { ok: true, value: { t: "err", id: id.value, error: error.value } };
    }

    case "subscribe": {
      const id = parseId(value.id);
      if (!id.ok) return id;
      const deadline = parseDeadline(value.deadline, now);
      if (!deadline.ok) return deadline;
      const sub = parseId(value.sub);
      if (!sub.ok) return sub;
      const filter = parseFilter(value.filter);
      if (!filter.ok) return filter;
      const delivery = parseDelivery(value.delivery);
      if (!delivery.ok) return delivery;
      return {
        ok: true,
        value: {
          t: "subscribe",
          id: id.value,
          deadline: deadline.value,
          sub: sub.value,
          filter: filter.value,
          delivery: delivery.value,
        },
      };
    }

    case "unsubscribe": {
      const id = parseId(value.id);
      if (!id.ok) return id;
      const deadline = parseDeadline(value.deadline, now);
      if (!deadline.ok) return deadline;
      const sub = parseId(value.sub);
      if (!sub.ok) return sub;
      return {
        ok: true,
        value: { t: "unsubscribe", id: id.value, deadline: deadline.value, sub: sub.value },
      };
    }

    case "event": {
      const sub = parseId(value.sub);
      if (!sub.ok) return sub;
      const seq = parseCount(value.seq, Number.MAX_SAFE_INTEGER, "seq");
      if (!seq.ok) return seq;
      const raw = value.events;
      if (!Array.isArray(raw)) return fail("E_PROTOCOL", "events must be an array");
      if (raw.length > MAX_BATCH_EVENTS) {
        return fail("E_TOO_LARGE", `Batch exceeds ${MAX_BATCH_EVENTS} events`);
      }
      const events: PluginEvent[] = [];
      for (const item of raw) {
        const event = parseEvent(item);
        if (!event.ok) return event;
        events.push(event.value);
      }
      return { ok: true, value: { t: "event", sub: sub.value, seq: seq.value, events } };
    }

    case "dropped": {
      const sub = parseId(value.sub);
      if (!sub.ok) return sub;
      const count = parseCount(value.count, Number.MAX_SAFE_INTEGER, "count");
      if (!count.ok) return count;
      const seq = parseCount(value.seq, Number.MAX_SAFE_INTEGER, "seq");
      if (!seq.ok) return seq;
      const reason = value.reason;
      if (typeof reason !== "string" || !(DROP_REASONS as readonly string[]).includes(reason)) {
        return fail("E_PROTOCOL", "dropped.reason is not a known reason");
      }
      return {
        ok: true,
        value: {
          t: "dropped",
          sub: sub.value,
          count: count.value,
          seq: seq.value,
          reason: reason as DropReason,
        },
      };
    }

    case "credit": {
      const sub = parseId(value.sub);
      if (!sub.ok) return sub;
      const credits = parseCount(value.credits, MAX_CREDITS, "credits");
      if (!credits.ok) return credits;
      if (credits.value === 0) return fail("E_PROTOCOL", "credits must be at least 1");
      return { ok: true, value: { t: "credit", sub: sub.value, credits: credits.value } };
    }

    case "hello": {
      const protocol = value.protocol;
      if (typeof protocol !== "number" || !Number.isInteger(protocol) || protocol < 0) {
        return fail("E_PROTOCOL", "hello.protocol must be a non-negative integer");
      }
      const pluginId = parseName(value.pluginId, MAX_ID_LENGTH, "pluginId");
      if (!pluginId.ok) return pluginId;
      return { ok: true, value: { t: "hello", protocol, pluginId: pluginId.value } };
    }

    case "lifecycle": {
      const id = parseId(value.id);
      if (!id.ok) return id;
      const deadline = parseDeadline(value.deadline, now);
      if (!deadline.ok) return deadline;
      const phase = value.phase;
      if (typeof phase !== "string" || !(LIFECYCLE_PHASES as readonly string[]).includes(phase)) {
        return fail("E_PROTOCOL", "lifecycle.phase is not a known phase");
      }
      return {
        ok: true,
        value: {
          t: "lifecycle",
          id: id.value,
          deadline: deadline.value,
          phase: phase as LifecyclePhase,
        },
      };
    }

    case "ping": {
      const nonce = parseId(value.nonce);
      if (!nonce.ok) return nonce;
      const deadline = parseDeadline(value.deadline, now);
      if (!deadline.ok) return deadline;
      return { ok: true, value: { t: "ping", nonce: nonce.value, deadline: deadline.value } };
    }

    case "pong": {
      const nonce = parseId(value.nonce);
      if (!nonce.ok) return nonce;
      const rss = value.rss;
      if (rss === undefined) return { ok: true, value: { t: "pong", nonce: nonce.value } };
      if (typeof rss !== "number" || !Number.isFinite(rss) || rss < 0) {
        return fail("E_PROTOCOL", "pong.rss must be a non-negative number");
      }
      return { ok: true, value: { t: "pong", nonce: nonce.value, rss } };
    }
  }
}

function parseId(value: unknown): ParseResult<string> {
  if (typeof value !== "string" || value.length === 0) {
    return fail("E_PROTOCOL", "Frame id must be a non-empty string");
  }
  if (value.length > MAX_ID_LENGTH) {
    return fail("E_TOO_LARGE", `Frame id exceeds ${MAX_ID_LENGTH} characters`);
  }
  return { ok: true, value };
}

function parseName(value: unknown, max: number, label: string): ParseResult<string> {
  if (typeof value !== "string" || value.length === 0) {
    return fail("E_PROTOCOL", `${label} must be a non-empty string`);
  }
  if (value.length > max) return fail("E_TOO_LARGE", `${label} exceeds ${max} characters`);
  return { ok: true, value };
}

function parseDeadline(value: unknown, now: number): ParseResult<Deadline> {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return fail("E_PROTOCOL", "deadline must be an integer unix-ms instant");
  }
  // A deadline already in the past is *legal on the wire* and is not rejected here: under a
  // backwards clock step every deadline looks expired, and refusing to parse the frame would mean
  // the peer never even learns the call timed out. Expiry is the caller's business — see
  // `isExpired` and the note on `Deadline`.
  if (value > now + MAX_DEADLINE_HORIZON_MS) {
    return fail("E_PROTOCOL", `deadline is more than ${MAX_DEADLINE_HORIZON_MS}ms in the future`);
  }
  return { ok: true, value };
}

function parseCount(value: unknown, max: number, label: string): ParseResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("E_PROTOCOL", `${label} must be a non-negative integer`);
  }
  if (value > max) return fail("E_TOO_LARGE", `${label} exceeds ${max}`);
  return { ok: true, value };
}

function parseOptionalJson(value: unknown, label: string): ParseResult<JsonValue | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isJsonValue(value)) return fail("E_PROTOCOL", `${label} is not JSON`);
  if (jsonDepth(value) > MAX_JSON_DEPTH) {
    return fail("E_TOO_LARGE", `${label} nests deeper than ${MAX_JSON_DEPTH}`);
  }
  return { ok: true, value };
}

function parseErrorPayload(value: unknown): ParseResult<ErrorPayload> {
  if (!isRecord(value)) return fail("E_PROTOCOL", "error must be an object");
  const code = value.code;
  if (typeof code !== "string" || !isProtocolErrorCode(code)) {
    return fail("E_PROTOCOL", "error.code is not a known protocol error code");
  }
  const message = value.message;
  if (typeof message !== "string") return fail("E_PROTOCOL", "error.message must be a string");
  if (message.length > MAX_MESSAGE_LENGTH) {
    return fail("E_TOO_LARGE", `error.message exceeds ${MAX_MESSAGE_LENGTH} characters`);
  }
  const data = parseOptionalJson(value.data, "error.data");
  if (!data.ok) return data;

  const retryAfterMs = value.retryAfterMs;
  if (retryAfterMs !== undefined) {
    const parsed = parseCount(retryAfterMs, MAX_DEADLINE_HORIZON_MS, "error.retryAfterMs");
    if (!parsed.ok) return parsed;
  }

  return {
    ok: true,
    value: {
      code,
      message,
      ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
      ...(data.value === undefined ? {} : { data: data.value }),
    },
  };
}

/** Kinds and ids are matched with `===`, so the character set is kept boring on purpose. */
const KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$/;

function parseFilter(value: unknown): ParseResult<EventFilter> {
  if (!isRecord(value)) return fail("E_PROTOCOL", "filter must be an object");

  const kinds = value.kinds;
  let parsedKinds: string[] | undefined;
  if (kinds !== undefined) {
    if (!Array.isArray(kinds)) return fail("E_PROTOCOL", "filter.kinds must be an array");
    if (kinds.length > MAX_FILTER_KINDS) {
      return fail("E_TOO_LARGE", `filter.kinds exceeds ${MAX_FILTER_KINDS} entries`);
    }
    parsedKinds = [];
    for (const kind of kinds) {
      if (typeof kind !== "string" || kind.length > MAX_KIND_LENGTH || !KIND_PATTERN.test(kind)) {
        return fail("E_PROTOCOL", "filter.kinds holds a value that is not an event kind pattern");
      }
      parsedKinds.push(kind);
    }
  }

  const accountIds = parseIdList(value.accountIds, "filter.accountIds");
  if (!accountIds.ok) return accountIds;
  const subjectIds = parseIdList(value.subjectIds, "filter.subjectIds");
  if (!subjectIds.ok) return subjectIds;

  return {
    ok: true,
    value: {
      ...(parsedKinds === undefined ? {} : { kinds: parsedKinds }),
      ...(accountIds.value === undefined ? {} : { accountIds: accountIds.value }),
      ...(subjectIds.value === undefined ? {} : { subjectIds: subjectIds.value }),
    },
  };
}

function parseIdList(value: unknown, label: string): ParseResult<string[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return fail("E_PROTOCOL", `${label} must be an array`);
  if (value.length > MAX_FILTER_VALUES) {
    return fail("E_TOO_LARGE", `${label} exceeds ${MAX_FILTER_VALUES} entries`);
  }
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
      return fail("E_PROTOCOL", `${label} holds a value that is not an id`);
    }
    ids.push(id);
  }
  return { ok: true, value: ids };
}

function parseDelivery(value: unknown): ParseResult<DeliveryPolicy> {
  if (!isRecord(value)) return fail("E_PROTOCOL", "delivery must be an object");

  const credits = parseCount(value.credits, MAX_CREDITS, "delivery.credits");
  if (!credits.ok) return credits;
  if (credits.value === 0) return fail("E_PROTOCOL", "delivery.credits must be at least 1");

  const maxBatch = parseCount(value.maxBatch, MAX_BATCH_EVENTS, "delivery.maxBatch");
  if (!maxBatch.ok) return maxBatch;
  if (maxBatch.value === 0) return fail("E_PROTOCOL", "delivery.maxBatch must be at least 1");

  const overflow = value.overflow;
  if (typeof overflow !== "string" || !isOverflowPolicy(overflow)) {
    return fail("E_PROTOCOL", "delivery.overflow is not a known policy");
  }

  const keyPath = value.keyPath;
  if (overflow === "coalesce") {
    if (typeof keyPath !== "string" || keyPath.length === 0) {
      return fail("E_PROTOCOL", "delivery.keyPath is required when overflow is coalesce");
    }
    const segments = keyPath.split(".");
    if (segments.length > MAX_KEY_PATH_SEGMENTS || segments.some((s) => s.length === 0)) {
      return fail("E_PROTOCOL", "delivery.keyPath is not a usable path");
    }
    return {
      ok: true,
      value: { credits: credits.value, maxBatch: maxBatch.value, overflow, keyPath },
    };
  }
  // Silently ignoring a stray keyPath would let a plugin believe it had asked for coalescing.
  if (keyPath !== undefined) {
    return fail("E_PROTOCOL", "delivery.keyPath is only legal with overflow: coalesce");
  }
  return { ok: true, value: { credits: credits.value, maxBatch: maxBatch.value, overflow } };
}

function parseEvent(value: unknown): ParseResult<PluginEvent> {
  if (!isRecord(value)) return fail("E_PROTOCOL", "event must be an object");

  const kind = parseName(value.kind, MAX_KIND_LENGTH, "event.kind");
  if (!kind.ok) return kind;

  const ts = value.ts;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts)) {
    return fail("E_PROTOCOL", "event.ts must be an integer unix-ms timestamp");
  }

  const accountId = value.accountId;
  if (accountId !== null && (typeof accountId !== "string" || accountId.length > MAX_ID_LENGTH)) {
    return fail("E_PROTOCOL", "event.accountId must be an id or null");
  }

  const subjectId = parseNullableId(value.subjectId, "event.subjectId");
  if (!subjectId.ok) return subjectId;
  const location = parseNullableId(value.location, "event.location");
  if (!location.ok) return location;

  const sessionId = value.sessionId;
  if (
    sessionId !== undefined &&
    sessionId !== null &&
    (typeof sessionId !== "number" || !Number.isSafeInteger(sessionId))
  ) {
    return fail("E_PROTOCOL", "event.sessionId must be an integer row id or null");
  }

  const payload = parseOptionalJson(value.payload, "event.payload");
  if (!payload.ok) return payload;

  return {
    ok: true,
    value: {
      kind: kind.value,
      accountId,
      ts,
      ...(subjectId.value === undefined ? {} : { subjectId: subjectId.value }),
      ...(sessionId === undefined ? {} : { sessionId: sessionId as number | null }),
      ...(location.value === undefined ? {} : { location: location.value }),
      ...(payload.value === undefined ? {} : { payload: payload.value }),
    },
  };
}

function parseNullableId(value: unknown, label: string): ParseResult<string | null | undefined> {
  if (value === undefined || value === null) {
    return { ok: true, value: value === null ? null : undefined };
  }
  if (typeof value !== "string") return fail("E_PROTOCOL", `${label} must be a string or null`);
  // Locations are longer than ids (`wrld_…:12345~region(eu)`), so the frame cap is the real bound
  // here and this is only a sanity ceiling.
  if (value.length > MAX_KIND_LENGTH * 8) {
    return fail("E_TOO_LARGE", `${label} is too long`);
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects `undefined`, functions, and anything else `JSON.parse` could not have produced. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    // NaN and Infinity serialise to `null`, so a frame carrying one did not come from JSON.
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    default:
      return false;
  }
}

/**
 * Depth of a JSON value, computed iteratively.
 *
 * Iterative rather than recursive because this runs on hostile input: a recursive depth check that
 * overflows the stack on deeply nested input is the very attack it was added to stop.
 */
function jsonDepth(value: JsonValue): number {
  let deepest = 0;
  const stack: Array<{ node: JsonValue; depth: number }> = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    if (entry.depth > deepest) deepest = entry.depth;
    // Past the cap the exact answer stops mattering, and walking a hostile structure further is
    // work done on the attacker's behalf.
    if (deepest > MAX_JSON_DEPTH) return deepest;
    const { node, depth } = entry;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    } else if (typeof node === "object" && node !== null) {
      for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return deepest;
}

/**
 * Whether an encoded frame is over {@link MAX_FRAME_BYTES}, without encoding the string when the
 * answer is already decided.
 *
 * A JS string's UTF-8 length is always at least its UTF-16 unit count and at most three times it
 * (a surrogate pair is 2 units and 4 bytes), so the two cheap comparisons settle almost every
 * frame and only a borderline one pays for an encode.
 */
export function exceedsFrameCap(text: string): boolean {
  if (text.length > MAX_FRAME_BYTES) return true;
  if (text.length * 3 <= MAX_FRAME_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES;
}

function truncate(value: string): string {
  return value.length <= 32 ? value : `${value.slice(0, 32)}…`;
}
