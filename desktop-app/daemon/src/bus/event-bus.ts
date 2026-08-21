/**
 * The EventBus — the spine of the daemon. See PLAN.md §Architecture.
 *
 * Pipeline events, REST poll diffs, and log-derived events all normalize into one typed stream.
 * The feed writer, the graph runtime, plugin workers, the enriched control-API stream, and webhooks
 * are all just subscribers. Nothing gets a private side channel.
 *
 * **`emit()` never awaits.** A slow subscriber must not stall the pipeline reader — a socket that
 * stops draining is a socket VRChat eventually closes. Async subscribers are invited to return a
 * promise, which is observed only to route rejections to `onError`; the emitter does not wait for it.
 */

/** A normalized event. `kind` is a dotted path: `friend.online`, `gamelog.player_join`, `graph.run`. */
export interface BusEvent {
  /** Dotted kind. Subscribers may match a literal kind or a `prefix.*` wildcard. */
  readonly kind: string;
  /** Owning account, or null for events not attributable to one (an unlinked game session). */
  readonly accountId: string | null;
  /** Unix ms. */
  readonly ts: number;
  /** The user, world, or group this is about, when there is one. */
  readonly subjectId?: string | null;
  /**
   * The `sessions` row id, set on `gamelog.*` events — several VRChat clients can run at once.
   *
   * Deliberately the **store's** id rather than the log watcher's internal string. The watcher
   * generates its own ids, but `GET /api/sessions` returns row ids, and a consumer given one of
   * each has no way to join them: it is reduced to correlating on start time, which is a heuristic
   * that silently mis-attributes two clients started in the same second. One identifier, published
   * on both surfaces. See PLAN.md §1.7.
   */
  readonly sessionId?: number | null;
  readonly location?: string | null;
  readonly payload?: unknown;
}

export type BusSubscriber = (event: BusEvent) => void | Promise<void>;

export interface SubscribeOptions {
  /**
   * Literal kinds or `prefix.*` wildcards. Omitted means everything.
   *
   * Matching happens **before** the subscriber is woken, not inside it. Log tailing bursts 40+
   * player-join events on an instance transition and `friend.location` fires for every friend move,
   * so an irrelevant event must cost one map lookup, not a function call into every plugin.
   */
  readonly kinds?: readonly string[];
  /** Restrict to one account. A plugin granted one account must not see the other five. */
  readonly accountId?: string;
}

export interface Subscription {
  unsubscribe(): void;
}

interface Registration {
  readonly subscriber: BusSubscriber;
  readonly accountId: string | undefined;
}

/** Split into exact-kind and prefix buckets so dispatch is a lookup, not a scan. */
export class EventBus {
  readonly #exact = new Map<string, Set<Registration>>();
  readonly #prefix = new Map<string, Set<Registration>>();
  readonly #all = new Set<Registration>();
  #onError: (error: unknown, event: BusEvent) => void = () => {};

  /** Reported subscriber failures. A throwing subscriber must never break the emit loop. */
  onError(handler: (error: unknown, event: BusEvent) => void): void {
    this.#onError = handler;
  }

  subscribe(subscriber: BusSubscriber, options: SubscribeOptions = {}): Subscription {
    const registration: Registration = { subscriber, accountId: options.accountId };
    const buckets: Array<Set<Registration>> = [];

    if (!options.kinds || options.kinds.length === 0) {
      this.#all.add(registration);
      buckets.push(this.#all);
    } else {
      for (const kind of options.kinds) {
        const target = kind.endsWith(".*")
          ? bucketFor(this.#prefix, kind.slice(0, -1))
          : bucketFor(this.#exact, kind);
        target.add(registration);
        buckets.push(target);
      }
    }

    return {
      unsubscribe() {
        for (const bucket of buckets) bucket.delete(registration);
      },
    };
  }

  /**
   * Fans an event out. Synchronous, non-blocking, and never throws.
   *
   * Registrations are snapshotted before dispatch so a subscriber that unsubscribes (or subscribes)
   * during its own callback cannot mutate the set being iterated.
   */
  emit(event: BusEvent): void {
    const targets = new Set<Registration>();

    for (const registration of this.#all) targets.add(registration);
    for (const registration of this.#exact.get(event.kind) ?? []) targets.add(registration);

    // `gamelog.player_join` matches `gamelog.*`. Walk the dotted prefixes rather than scanning
    // every registered wildcard.
    let cut = event.kind.lastIndexOf(".");
    while (cut > 0) {
      for (const registration of this.#prefix.get(event.kind.slice(0, cut + 1)) ?? []) {
        targets.add(registration);
      }
      cut = event.kind.lastIndexOf(".", cut - 1);
    }

    for (const registration of targets) {
      // A subscription scoped to one account never sees another's events, including the
      // null-account (unlinked session) ones.
      if (registration.accountId !== undefined && registration.accountId !== event.accountId) {
        continue;
      }

      try {
        const result = registration.subscriber(event);
        // Observed, not awaited. Emit must stay synchronous; this only routes a rejection
        // somewhere visible instead of becoming an unhandled rejection.
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            this.#onError(error, event);
          });
        }
      } catch (error) {
        this.#onError(error, event);
      }
    }
  }

  /** Live subscriber count, for the status endpoint and for leak-hunting in tests. */
  get subscriberCount(): number {
    const unique = new Set<Registration>(this.#all);
    for (const bucket of this.#exact.values()) for (const r of bucket) unique.add(r);
    for (const bucket of this.#prefix.values()) for (const r of bucket) unique.add(r);
    return unique.size;
  }
}

function bucketFor(map: Map<string, Set<Registration>>, key: string): Set<Registration> {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Set<Registration>();
  map.set(key, created);
  return created;
}
