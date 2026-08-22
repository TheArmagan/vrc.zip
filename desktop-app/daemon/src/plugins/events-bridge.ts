/**
 * The events bridge: the road from the EventBus to a plugin process, and the only one.
 *
 * PLAN.md §Phase 3 "Backpressure is load-bearing" names three host-side mechanisms and one
 * invariant, and this file is all four:
 *
 *  - **Declarative filters compiled to closures at subscribe time.** The vocabulary is data on the
 *    wire (`EventFilter`), never a callback, so the host compiles it once and spends set lookups per
 *    event. The *kind* half of the filter is handed to the EventBus itself, so an irrelevant event
 *    does not wake this bridge at all — it never reaches a bucket the subscription is in.
 *  - **Credit windows with a per-subscription overflow policy.** `coalesce` on `keyPath: "userId"`
 *    gives a slow plugin each friend's *current* location rather than a 900-event backlog.
 *  - **Per-tick batching.** One `setTimeout(0)` per bridge per tick, not one per subscription and
 *    not one per event: 40 join events on an instance transition cost the plugin one wakeup and one
 *    parse.
 *  - **A `dropped` frame whenever the host sheds load**, so the plugin is never left believing it
 *    saw everything. Superseded events are `coalesced`, shed ones are `overflow`, and a subscription
 *    the host closed is `shutdown`.
 *
 * ## `EventBus.emit()` never awaits anything plugin-related
 *
 * That is the invariant, and it is structural here rather than remembered. {@link
 * PluginEventsBridge} does all of its emit-time work in one private method that is synchronous,
 * allocates one event object, and **never writes to a channel**. Every frame this bridge sends is
 * sent from the flush, on a later turn. There is deliberately no `block` overflow policy for the
 * same reason (decision 130): a plugin that cannot keep up loses events; it does not get to slow the
 * pipeline reader down.
 *
 * ## Where the authority comes from
 *
 * Default-deny, three gates, and the mapping is decision 135's — `scopeForEventKind` is *imported*
 * from the `/app` stream rather than restated, so a plugin and a third-party app cannot drift apart
 * about what `friends:read` covers. What differs is only that a plugin's grant names a *list* of
 * accounts where an app's grant names one.
 *
 * The grant is re-read **once per flush tick**, not once per event: reading it is three SQLite
 * queries, and doing that per event on a `gamelog` burst would put the store in the emit path. The
 * consequence is stated rather than hidden — a revoke takes effect within one tick, and when it does
 * the *already queued* events are purged too, so nothing approved five minutes ago is delivered
 * after the approval ended.
 */

import {
  type CompiledFilter,
  type CreditFrame,
  compileFilter,
  type DeliveryPolicy,
  type DropReason,
  type Envelope,
  type EventFilter,
  MAX_JSON_DEPTH,
  type PluginEvent,
  type PluginGrant,
  type ProtocolErrorCode,
  readKeyPath,
  type SubscribeFrame,
  type UnsubscribeFrame,
} from "@vrcz/plugin-api";
import type { JsonValue, Scope } from "@vrcz/shared";
import type { BusEvent, Subscription as BusSubscription, EventBus } from "../bus/event-bus.ts";
import { scopeForEventKind } from "../servers/app-api.ts";
import type { PluginChannel } from "./dispatcher.ts";

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/**
 * Subscriptions one plugin may hold at once.
 *
 * Each one costs a bus registration, two compiled closures and a queue of up to `credits` events, so
 * this multiplied by `MAX_CREDITS` is a plugin's whole footprint here. Sixteen is more than any
 * plugin shape anyone has described and small enough that the product is a number rather than a
 * hope.
 */
export const MAX_SUBSCRIPTIONS_PER_PLUGIN = 16;

/**
 * Values in a bus payload the bridge will walk before giving up on it.
 *
 * A payload is `unknown` on the bus and `JsonValue` on the wire, and something has to decide which.
 * The walk is bounded because the walk is the cost: a cyclic or enormous payload — a producer bug
 * rather than an attack, since nothing hostile reaches the bus — must not turn one event into
 * unbounded work inside `emit`.
 */
const MAX_PAYLOAD_NODES = 4096;

// ---------------------------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------------------------

/** A grant compiled to a per-event predicate. Pure; safe to call on every event. */
export type EventAuthority = (event: PluginEvent) => boolean;

/**
 * Compiles a grant into the per-event visibility check.
 *
 * The three gates are decision 135's, in the same order and for the same reasons:
 *
 *  1. **The account.** A plugin sees only accounts its grant names. Cheapest, and the one whose
 *     failure is the most serious.
 *  2. **Unlinked events.** `accountId === null` is a VRChat client signed into an account vrc.zip
 *     does not manage — normal (PLAN.md §1.7), and a disclosure of accounts the user never added.
 *     Behind `sessions:unlinked`, which is deliberately **not** a bypass of gate 3.
 *  3. **The kind.** Default-deny through {@link scopeForEventKind}: an unmapped family is dropped,
 *     so a kind from a future daemon is not plugin-readable by default.
 *
 * Sets rather than `Array.includes` because this runs per event per subscription, and the arrays it
 * closes over come from a grant row rather than from a bounded literal.
 */
export function compileAuthority(grant: PluginGrant): EventAuthority {
  const accounts = new Set(grant.accountIds);
  const scopes = new Set<string>(grant.scopes);
  const unlinked = scopes.has("sessions:unlinked");

  return (event) => {
    if (event.accountId === null) {
      if (!unlinked) return false;
    } else if (!accounts.has(event.accountId)) {
      return false;
    }
    const scope = scopeForEventKind(event.kind);
    if (scope === null) return false;
    return scopes.has(scope);
  };
}

/**
 * A cheap identity for a grant's *authority*, so a flush tick can tell "unchanged" from "widened or
 * narrowed" without recompiling and re-filtering every queue every tick.
 *
 * Only the two fields {@link compileAuthority} reads. `dryRunScopes` is deliberately absent: it
 * gates outbound actions, not what may be watched.
 */
function authoritySignature(grant: PluginGrant): string {
  return `${[...grant.scopes].sort().join(",")}|${[...grant.accountIds].sort().join(",")}`;
}

/**
 * The scope a filter's kinds need but the grant does not hold, or null when the subscription is
 * serviceable.
 *
 * `null` means "at least one pattern is readable"; `undefined` means "none of them is", which is a
 * different sentence to put in front of an author. A filter with no `kinds` at all is serviceable
 * whenever the grant holds any event scope, because the per-event gate narrows it — refusing it
 * would mean refusing the ordinary "tell me everything I may see".
 */
export function missingScopeFor(filter: EventFilter, grant: PluginGrant): Scope | null | undefined {
  const kinds = filter.kinds;
  if (kinds === undefined || kinds.length === 0) return null;

  const held = new Set<string>(grant.scopes);
  let firstMissing: Scope | undefined;
  for (const pattern of kinds) {
    // `scopeForEventKind` reads the family off the first dotted segment, so `friend.*` and
    // `friend.online` resolve identically and a pattern needs no special case.
    const scope = scopeForEventKind(pattern);
    if (scope === null) continue;
    if (held.has(scope)) return null;
    firstMissing ??= scope;
  }
  return firstMissing;
}

// ---------------------------------------------------------------------------------------------
// Bus event → wire event
// ---------------------------------------------------------------------------------------------

/**
 * A bus payload as JSON, or `undefined` when it is not JSON at all.
 *
 * Validated rather than cloned: a passing payload is handed on by reference, so the common case
 * costs a walk and no allocation. It has to happen somewhere — `encodeEnvelope` calls
 * `JSON.stringify`, which **throws** on a cycle rather than returning a result, and that throw would
 * land in the flush loop and take the other subscriptions' frames with it.
 */
function asJsonPayload(value: unknown): JsonValue | undefined {
  let budget = MAX_PAYLOAD_NODES;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];

  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    if (entry.depth > MAX_JSON_DEPTH) return undefined;
    budget -= 1;
    if (budget < 0) return undefined;

    const node = entry.node;
    if (node === null) continue;
    switch (typeof node) {
      case "string":
      case "boolean":
        continue;
      case "number":
        // NaN and Infinity serialise to `null`, so a payload holding one did not come from JSON.
        if (!Number.isFinite(node)) return undefined;
        continue;
      case "object":
        if (Array.isArray(node)) {
          for (const child of node) stack.push({ node: child, depth: entry.depth + 1 });
        } else {
          for (const child of Object.values(node)) {
            stack.push({ node: child, depth: entry.depth + 1 });
          }
        }
        continue;
      default:
        return undefined;
    }
  }
  return value as JsonValue;
}

/**
 * A `BusEvent` as a plugin sees it.
 *
 * The two types are the same shape except for the payload, which is `unknown` on the bus and JSON on
 * the wire. A payload that is not JSON is **omitted rather than dropping the event**: the kind, the
 * account, the subject and the timestamp are still true and still worth delivering, and a plugin
 * that silently stops receiving a kind is the least debuggable failure this surface can produce.
 */
export function toPluginEvent(event: BusEvent): PluginEvent {
  const payload = event.payload === undefined ? undefined : asJsonPayload(event.payload);
  return {
    kind: event.kind,
    accountId: event.accountId,
    ts: event.ts,
    ...(event.subjectId === undefined ? {} : { subjectId: event.subjectId }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.location === undefined ? {} : { location: event.location }),
    ...(payload === undefined ? {} : { payload }),
  };
}

// ---------------------------------------------------------------------------------------------
// The pending queue
// ---------------------------------------------------------------------------------------------

/**
 * One subscription's pending events, with the coalesce index alongside them.
 *
 * ## Why this is not a call to `applyOverflow`
 *
 * `applyOverflow` in `@vrcz/plugin-api` is the **reference semantics** — its own doc says so — and
 * this class implements exactly them; `events-bridge.test.ts` asserts the two agree event for event
 * over randomised input, which is the property that matters and is a stronger claim than sharing the
 * code would be. What it does not share is the *representation*: `applyOverflow` copies the queue on
 * every event and finds a coalesce slot with a linear `readKeyPath` scan, so a subscription with
 * `credits: 4096` — legal on the wire — would cost 4096 path resolutions per event, inside `emit`,
 * at a rate the plugin chooses. A key index and a head offset make every operation here O(1)
 * amortised.
 */
class PendingQueue {
  /** Absolute-indexed. Entries below {@link #head} have been handed out and are dead. */
  #items: PluginEvent[] = [];
  #head = 0;
  /** Coalesce key → absolute index, or null when this subscription does not coalesce. */
  readonly #slots: Map<string, number> | null;
  readonly #keyPath: string | null;

  constructor(policy: DeliveryPolicy) {
    const keyPath = policy.overflow === "coalesce" ? policy.keyPath : undefined;
    this.#slots = keyPath === undefined ? null : new Map();
    this.#keyPath = keyPath ?? null;
  }

  get size(): number {
    return this.#items.length - this.#head;
  }

  /**
   * Replaces the pending event with the same coalesce key, if there is one.
   *
   * Supersedes whenever a key is already pending, **not** only when the window is full: replacement
   * is the entire point of the policy, and delaying it until the window fills would hand the plugin
   * the backlog it explicitly asked not to have (decision 130).
   */
  supersede(event: PluginEvent): boolean {
    if (this.#slots === null) return false;
    const key = this.#keyOf(event);
    if (key === undefined) return false;
    const slot = this.#slots.get(key);
    // A slot below the head is a key whose event has already been delivered, so it is a miss.
    if (slot === undefined || slot < this.#head) return false;
    this.#items[slot] = event;
    return true;
  }

  push(event: PluginEvent): void {
    const key = this.#keyOf(event);
    if (key !== undefined) this.#slots?.set(key, this.#items.length);
    this.#items.push(event);
  }

  /** Drops the oldest pending event. The ring-buffer half of `drop-oldest` and of `coalesce`. */
  dropOldest(): void {
    if (this.size === 0) return;
    this.#head += 1;
    this.#compact();
  }

  /** The next `count` events, without committing to having sent them. */
  peek(count: number): PluginEvent[] {
    return this.#items.slice(this.#head, this.#head + count);
  }

  /** Commits a {@link peek}: those events are on the wire and are no longer pending. */
  commit(count: number): void {
    this.#head = Math.min(this.#items.length, this.#head + count);
    this.#compact();
  }

  /** Everything still pending, emptying the queue. */
  drain(): PluginEvent[] {
    const rest = this.peek(this.size);
    this.#items = [];
    this.#head = 0;
    this.#slots?.clear();
    return rest;
  }

  /** Keeps only what `allow` still permits, and reports how many were removed. */
  purge(allow: EventAuthority): number {
    const kept = this.peek(this.size).filter((event) => allow(event));
    const removed = this.size - kept.length;
    if (removed === 0) return 0;
    this.#items = kept;
    this.#head = 0;
    this.#reindex();
    return removed;
  }

  #keyOf(event: PluginEvent): string | undefined {
    return this.#keyPath === null ? undefined : readKeyPath(event, this.#keyPath);
  }

  /**
   * Drops the dead prefix once it is half the array, which makes both `dropOldest` and `commit`
   * O(1) amortised — and prunes the key index at the same time, so a coalesce subscription whose
   * keys are all distinct cannot grow a map of every user it has ever seen.
   */
  #compact(): void {
    if (this.#head === 0 || this.#head * 2 < this.#items.length) return;
    this.#items = this.#items.slice(this.#head);
    this.#head = 0;
    this.#reindex();
  }

  #reindex(): void {
    if (this.#slots === null) return;
    this.#slots.clear();
    for (let i = 0; i < this.#items.length; i++) {
      const event = this.#items[i];
      if (event === undefined) continue;
      const key = this.#keyOf(event);
      if (key !== undefined) this.#slots.set(key, i);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

interface Registration {
  readonly sub: string;
  readonly policy: DeliveryPolicy;
  readonly match: CompiledFilter;
  readonly pending: PendingQueue;
  /** Assigned immediately after the bus registration exists. Never null once the map holds it. */
  busSubscription: BusSubscription | null;
  /** Events on the wire and not yet credited. The credit window is `credits` minus this. */
  outstanding: number;
  /** Sequence number the next delivered event will carry. Monotonic per subscription. */
  seq: number;
  /** Shed events not yet reported, by reason. Cleared by the `dropped` frame that reports them. */
  readonly dropped: Map<DropReason, number>;
  /** Set when `disconnect` fired: report what is left, then forget the subscription. */
  closing: boolean;
}

interface AttachedPlugin {
  readonly channel: PluginChannel;
  readonly subs: Map<string, Registration>;
  /** The grant compiled to a predicate, refreshed at most once per flush tick. */
  authority: EventAuthority;
  signature: string;
}

export interface EventsBridgeOptions {
  readonly bus: EventBus;
  /**
   * The live grant for a plugin, or null when it has none.
   *
   * The same function the dispatcher takes, and for the same reason: a revoke while a plugin is
   * running must take effect on its own, not on the next restart. Read once per flush tick — see
   * the file header for why not per event.
   */
  readonly grants: (pluginId: string) => PluginGrant | null;
  /**
   * Schedules the per-tick flush. Defaults to a 0ms timer, which is what "per tick" means here:
   * every event a synchronous burst puts on the bus lands in one batch.
   */
  readonly schedule?: (run: () => void) => void;
  readonly maxSubscriptions?: number;
}

// ---------------------------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------------------------

export class PluginEventsBridge {
  readonly #options: EventsBridgeOptions;
  readonly #attached = new Map<string, AttachedPlugin>();
  readonly #maxSubscriptions: number;
  #flushScheduled = false;

  constructor(options: EventsBridgeOptions) {
    this.#options = options;
    this.#maxSubscriptions = options.maxSubscriptions ?? MAX_SUBSCRIPTIONS_PER_PLUGIN;
  }

  /**
   * Starts serving a running plugin.
   *
   * Attachment follows the supervisor's state exactly as the dispatcher's does, so a plugin that
   * dies stops being a subscriber at the moment it dies rather than whenever someone next notices.
   */
  attach(channel: PluginChannel): void {
    this.detach(channel.pluginId);
    const grant = this.#options.grants(channel.pluginId);
    this.#attached.set(channel.pluginId, {
      channel,
      subs: new Map(),
      authority: grant === null ? () => false : compileAuthority(grant),
      signature: grant === null ? "" : authoritySignature(grant),
    });
  }

  /**
   * Forgets a plugin and every subscription it held.
   *
   * Subscriptions are **not** carried across a restart. A `sub` id is the plugin's own handle on its
   * own queue, and a fresh process has no memory of one; leaving the bus registration in place would
   * mean queueing events for a subscriber that will never credit them.
   */
  detach(pluginId: string): void {
    const attached = this.#attached.get(pluginId);
    if (attached === undefined) return;
    this.#attached.delete(pluginId);
    for (const registration of attached.subs.values()) {
      registration.busSubscription?.unsubscribe();
    }
    attached.subs.clear();
  }

  /** Every plugin, on daemon shutdown. Never awaits and never throws. */
  detachAll(): void {
    for (const pluginId of [...this.#attached.keys()]) this.detach(pluginId);
  }

  /** Live subscriptions for one plugin. Diagnostics and tests. */
  subscriptionCount(pluginId: string): number {
    return this.#attached.get(pluginId)?.subs.size ?? 0;
  }

  /**
   * Routes one frame from a plugin. Returns whether the bridge owned it.
   *
   * The mirror of `PluginDispatcher.handleFrame`: `subscribe`, `unsubscribe` and `credit` are this
   * file's, everything else is somebody else's, and answering `false` rather than throwing is what
   * lets the owners be chained without any of them knowing the others' tags.
   */
  handleFrame(pluginId: string, frame: Envelope): boolean {
    switch (frame.t) {
      case "subscribe":
        this.#subscribe(pluginId, frame);
        return true;
      case "unsubscribe":
        this.#unsubscribe(pluginId, frame);
        return true;
      case "credit":
        this.#credit(pluginId, frame);
        return true;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Subscribe / unsubscribe / credit
  // -------------------------------------------------------------------------------------------

  #subscribe(pluginId: string, frame: SubscribeFrame): void {
    const attached = this.#attached.get(pluginId);
    if (attached === undefined) return;

    const grant = this.#options.grants(pluginId);
    if (grant === null) {
      this.#error(attached, frame.id, "E_SCOPE_DENIED", "This plugin has no live grant.");
      return;
    }
    // Refreshed here as well as at flush, so a subscription made seconds after a re-grant is
    // filtered by what the user just approved rather than by what was true at attach.
    attached.authority = compileAuthority(grant);
    attached.signature = authoritySignature(grant);

    if (attached.subs.has(frame.sub)) {
      this.#error(
        attached,
        frame.id,
        "E_BAD_REQUEST",
        `Subscription "${frame.sub}" is already open; unsubscribe first or choose another id.`,
      );
      return;
    }
    if (attached.subs.size >= this.#maxSubscriptions) {
      this.#error(
        attached,
        frame.id,
        "E_BAD_REQUEST",
        `This plugin may hold ${String(this.#maxSubscriptions)} subscriptions at once.`,
      );
      return;
    }

    /*
     * Named-but-not-granted is a refusal, not a silent narrowing — decision 167's posture on the
     * call path, for the same reason: an author who thinks they subscribed to a second account
     * should learn that they did not, at the moment they ask, rather than from events that never
     * arrive.
     */
    const denied = frame.filter.accountIds?.find((id) => !grant.accountIds.includes(id));
    if (denied !== undefined) {
      this.#error(
        attached,
        frame.id,
        "E_ACCOUNT_DENIED",
        "This plugin was not granted access to that account.",
      );
      return;
    }

    /*
     * A filter whose every kind pattern is outside the grant is refused at subscribe time rather
     * than accepted and silently starved. `scopeForEventKind` is default-deny, so an unmapped
     * family (`consent`, `content`, `other`) counts as unreadable here exactly as it does per event.
     */
    const missing = missingScopeFor(frame.filter, grant);
    if (missing !== null) {
      this.#error(
        attached,
        frame.id,
        "E_SCOPE_DENIED",
        missing === undefined
          ? "None of those event kinds can be watched with any scope this plugin holds."
          : `Watching those events requires the ${missing} scope.`,
      );
      return;
    }

    const registration: Registration = {
      sub: frame.sub,
      policy: frame.delivery,
      match: compileFilter(frame.filter),
      pending: new PendingQueue(frame.delivery),
      busSubscription: null,
      outstanding: 0,
      seq: 0,
      dropped: new Map(),
      closing: false,
    };

    /*
     * The kind half of the filter is handed to the EventBus, which buckets on it. That is what makes
     * PLAN.md's "one `===` per event, no wakeup for irrelevant ones" literally true: a subscription
     * on `friend.location` is not in the bucket a `gamelog.player_join` dispatches to, so this
     * closure is never entered for one. The compiled filter then decides the account and subject
     * halves, which the bus has no vocabulary for.
     */
    registration.busSubscription = this.#options.bus.subscribe(
      (event) => {
        this.#deliver(pluginId, registration, event);
      },
      frame.filter.kinds === undefined || frame.filter.kinds.length === 0
        ? {}
        : { kinds: frame.filter.kinds },
    );
    attached.subs.set(frame.sub, registration);

    attached.channel.send({
      t: "res",
      id: frame.id,
      result: { sub: frame.sub, accountIds: [...grant.accountIds] },
    });
  }

  #unsubscribe(pluginId: string, frame: UnsubscribeFrame): void {
    const attached = this.#attached.get(pluginId);
    if (attached === undefined) return;
    const registration = attached.subs.get(frame.sub);
    if (registration !== undefined) {
      registration.busSubscription?.unsubscribe();
      attached.subs.delete(frame.sub);
    }
    // Idempotent on purpose: unsubscribing something already gone is not an error, and answering
    // one would make a plugin's shutdown path race its own restart.
    attached.channel.send({ t: "res", id: frame.id, result: null });
  }

  /**
   * Returns credit for events the plugin has finished with.
   *
   * A `credit` frame carries no id and gets no reply — it is the one fire-and-forget frame in the
   * protocol. Over-crediting is clamped rather than refused: it cannot buy a plugin more than its
   * window, because the window is `credits` minus outstanding and outstanding floors at zero.
   */
  #credit(pluginId: string, frame: CreditFrame): void {
    const registration = this.#attached.get(pluginId)?.subs.get(frame.sub);
    if (registration === undefined) return;
    registration.outstanding = Math.max(0, registration.outstanding - frame.credits);
    this.#schedule();
  }

  // -------------------------------------------------------------------------------------------
  // The emit path. Everything here runs inside `EventBus.emit()`.
  // -------------------------------------------------------------------------------------------

  /**
   * Queues one event for one subscription.
   *
   * **Synchronous, allocation-light, and it never touches a channel.** This is the whole of what a
   * plugin costs the pipeline reader: a compiled filter, a compiled authority, a key lookup and a
   * push. The frames go out on the next tick, from {@link #flush}.
   */
  #deliver(pluginId: string, registration: Registration, event: BusEvent): void {
    const attached = this.#attached.get(pluginId);
    if (attached === undefined) return;
    if (registration.closing) {
      // Still counted. A `disconnect` subscription is closed at the end of the tick, and the events
      // that arrive in the meantime are events the plugin did not see — saying "5 dropped" and then
      // reporting 1 because the rest arrived after the decision would be the exact dishonesty the
      // `dropped` frame exists to prevent.
      this.#note(registration, "overflow", 1);
      return;
    }

    const wire = toPluginEvent(event);
    if (!registration.match(wire)) return;
    if (!attached.authority(wire)) return;

    const policy = registration.policy;
    const pending = registration.pending;

    // Coalescing first, and at any queue depth. See `PendingQueue.supersede`.
    if (pending.supersede(wire)) {
      this.#note(registration, "coalesced", 1);
      this.#schedule();
      return;
    }

    if (pending.size < policy.credits) {
      pending.push(wire);
      this.#schedule();
      return;
    }

    switch (policy.overflow) {
      case "drop-newest":
        this.#note(registration, "overflow", 1);
        break;
      // A coalesce subscription whose keys are all distinct has degenerated into an unbounded
      // queue, so it falls back to the ring buffer at the window boundary (decision 130).
      case "coalesce":
      case "drop-oldest":
        pending.dropOldest();
        pending.push(wire);
        this.#note(registration, "overflow", 1);
        break;
      case "disconnect":
        this.#note(registration, "overflow", 1);
        registration.closing = true;
        break;
    }
    this.#schedule();
  }

  #note(registration: Registration, reason: DropReason, count: number): void {
    registration.dropped.set(reason, (registration.dropped.get(reason) ?? 0) + count);
  }

  #schedule(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    const run = (): void => {
      this.#flush();
    };
    const schedule = this.#options.schedule;
    if (schedule !== undefined) {
      schedule(run);
      return;
    }
    const timer = setTimeout(run, 0);
    // A pending flush must not hold the process open: a plugin's batch is not a reason for the
    // daemon to refuse to exit.
    timer.unref?.();
  }

  // -------------------------------------------------------------------------------------------
  // The flush. Everything here runs on a later turn, never inside `emit`.
  // -------------------------------------------------------------------------------------------

  #flush(): void {
    this.#flushScheduled = false;

    for (const [pluginId, attached] of [...this.#attached]) {
      const grant = this.#options.grants(pluginId);
      if (grant === null) {
        // The grant went away underneath a running plugin. Every subscription closes and says so,
        // rather than going quiet and leaving the author to guess.
        for (const registration of [...attached.subs.values()]) {
          this.#close(attached, registration, "shutdown");
        }
        continue;
      }

      const signature = authoritySignature(grant);
      if (signature !== attached.signature) {
        attached.authority = compileAuthority(grant);
        attached.signature = signature;
        // A narrowing and a widening both land here. Purging only matters for a narrowing, and it
        // is cheap for a widening because nothing queued fails the new predicate.
        for (const registration of attached.subs.values()) {
          const removed = registration.pending.purge(attached.authority);
          if (removed > 0) this.#note(registration, "shutdown", removed);
        }
      }

      for (const registration of [...attached.subs.values()]) {
        this.#emitFor(attached, registration);
      }
    }
  }

  #emitFor(attached: AttachedPlugin, registration: Registration): void {
    const policy = registration.policy;
    const available = policy.credits - registration.outstanding;
    let budget = Math.min(available, policy.maxBatch, registration.pending.size);

    while (budget > 0) {
      const events = registration.pending.peek(budget);
      const sent = attached.channel.send({
        t: "event",
        sub: registration.sub,
        seq: registration.seq,
        events,
      });
      if (sent) {
        registration.pending.commit(budget);
        registration.seq += budget;
        registration.outstanding += budget;
        break;
      }
      /*
       * A `send` that answers false is either a peer that is gone or a frame over the byte cap, and
       * the channel deliberately cannot tell the caller which. Halving separates them in practice:
       * an oversized batch gets through in pieces, and a dead peer fails all the way down to one
       * event, which is then shed as an overflow. Either way the loop terminates, the queue drains,
       * and nothing is lost without being counted.
       */
      if (budget === 1) {
        registration.pending.commit(1);
        registration.seq += 1;
        this.#note(registration, "overflow", 1);
        break;
      }
      budget = Math.floor(budget / 2);
    }

    for (const [reason, count] of registration.dropped) {
      if (count <= 0) continue;
      // After the batch, so `seq` is the number the next *delivered* event will carry and the gap
      // is locatable from the plugin's side.
      attached.channel.send({
        t: "dropped",
        sub: registration.sub,
        count,
        reason,
        seq: registration.seq,
      });
    }
    registration.dropped.clear();

    if (registration.closing) {
      this.#close(attached, registration, "overflow");
      return;
    }

    /*
     * A batch that hit `maxBatch` leaves a remainder, and nothing else would come along to send it:
     * the next tick is scheduled by an *event*, and a queue can outlive the burst that filled it.
     * Guarded on credit rather than on emptiness, so a subscription whose window is spent waits for
     * a `credit` frame instead of rescheduling itself once a tick forever.
     */
    if (registration.pending.size > 0 && registration.outstanding < policy.credits) {
      this.#schedule();
    }
  }

  /**
   * Closes one subscription and tells the plugin what it never saw.
   *
   * There is no `unsubscribed` frame in the protocol, so the closure is expressed as a `dropped`
   * frame covering everything still queued. That is honest — the plugin did not see those events —
   * but it does mean `disconnect` reads to a plugin as a very large drop rather than as an explicit
   * "this subscription is gone".
   */
  #close(attached: AttachedPlugin, registration: Registration, reason: DropReason): void {
    registration.busSubscription?.unsubscribe();
    attached.subs.delete(registration.sub);

    let count = registration.pending.drain().length;
    for (const [, pendingCount] of registration.dropped) count += pendingCount;
    registration.dropped.clear();
    if (count === 0) return;

    attached.channel.send({
      t: "dropped",
      sub: registration.sub,
      count,
      reason,
      seq: registration.seq,
    });
  }

  #error(attached: AttachedPlugin, id: string, code: ProtocolErrorCode, message: string): void {
    attached.channel.send({ t: "err", id, error: { code, message } });
  }
}
