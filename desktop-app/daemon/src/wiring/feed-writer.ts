import type { BusEvent, EventBus, Subscription } from "../bus/event-bus.ts";
import type { Store } from "../store/index.ts";

/**
 * Writes bus events into the `events` table. The feed is a view over that table.
 *
 * Batched on a short timer rather than written per event. Log tailing bursts 40+ `player_join`
 * events on an instance transition, and one transaction per row would turn that into 40 fsyncs.
 * A batch also keeps `EventBus.emit()` honest — it stays synchronous and non-blocking, because all
 * this subscriber does is push onto an array.
 */

/**
 * Kinds that are UI state, not history. Writing them would bloat the feed with noise.
 *
 * Exported because the control API's filter vocabulary has to agree with it: a filter chip for a
 * kind no screen renders is a chip that turns the list blank, and a second copy of this list is a
 * second thing to forget to update.
 */
export const EPHEMERAL: ReadonlySet<string> = new Set([
  "account.state",
  "session.update",
  "pipeline.state",
  // A backfill summary, not something that happened to the user. Persisting it would put a row
  // reading "synced 250 notifications" into the feed on every poll, forever.
  "notification.synced",
  // "the friend list poll came back" — the same shape of non-event, and the loudest one there was:
  // it fires per account on every refresh cycle, so on a two-account setup it was several hundred
  // feed rows a day saying nothing had happened. Migration 007 deletes the ones already stored.
  "friend.list_refreshed",
  // "the presence map now agrees with a profile we just read" — a cache correction, not an event
  // in anybody's day. It exists to wake the friends list up, and opening a card would otherwise
  // write a feed row for every friend whose status had drifted.
  "friend.presence",
  // A live prompt and its answer. `pairing_requests` is already their durable record — what an app
  // asked for, when, and how it ended — so a feed row would be a second copy of the same fact,
  // filed under a timeline that is otherwise about what happened in VRChat.
  "consent.pending",
  "consent.resolved",
]);

export interface FeedWriterOptions {
  readonly flushIntervalMs?: number;
  /** Flush early once this many events are queued, so a burst can't grow unbounded. */
  readonly maxBatch?: number;
}

export class FeedWriter {
  #queue: BusEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #subscription: Subscription | null = null;

  constructor(
    private readonly store: Store,
    private readonly options: FeedWriterOptions = {},
  ) {}

  attach(bus: EventBus): void {
    this.#subscription = bus.subscribe((event) => {
      if (EPHEMERAL.has(event.kind)) return;

      this.#queue.push(event);
      if (this.#queue.length >= (this.options.maxBatch ?? 200)) {
        this.flush();
        return;
      }
      this.#schedule();
    });
  }

  detach(): void {
    this.#subscription?.unsubscribe();
    this.#subscription = null;
    this.flush();
  }

  /** Writes everything queued. Safe to call when empty. */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#queue.length === 0) return;

    const batch = this.#queue;
    this.#queue = [];

    try {
      this.store.insertEvents(
        batch.map((event) => ({
          account_id: event.accountId,
          ts: event.ts,
          session_id: event.sessionId ?? null,
          kind: event.kind,
          subject_id: event.subjectId ?? null,
          location: event.location ?? null,
          payload: event.payload === undefined ? null : JSON.stringify(event.payload),
        })),
      );
    } catch (error) {
      // Losing a feed row must not take the daemon down. Report and drop: retrying a batch that
      // failed to insert usually fails again, and an unbounded retry queue is worse than a gap.
      console.error("[feed] failed to write a batch of", batch.length, "events:", error);
    }
  }

  get pending(): number {
    return this.#queue.length;
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.options.flushIntervalMs ?? 250);
    this.#timer.unref?.();
  }
}
