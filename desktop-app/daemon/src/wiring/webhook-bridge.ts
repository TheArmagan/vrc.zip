/**
 * Bridges the EventBus to the webhook subsystem.
 *
 * Both halves are deliberately ignorant of each other, and this file is the only thing that knows
 * both exist. `webhooks/manager.ts` takes a `BusEvent` and never learns where it came from, so it
 * can be driven directly by a test or, later, by a replay; the bus has no idea anything outbound is
 * listening, so a webhook cannot become a special case in `emit()`.
 *
 * The subscription is unfiltered. Filtering by kind belongs to the individual webhook — a `kinds`
 * pattern is per registration and changes whenever the user edits one — and a bus-level filter here
 * would have to be torn down and rebuilt on every `reload()`, which is a second, subtly different
 * copy of `webhooks/filter.ts`. The manager's `#live` set is already empty for the common case of
 * zero webhooks, and `onEvent` returns on the first line then.
 */

import type { BusEvent, EventBus, Subscription } from "../bus/event-bus.ts";
import type { WebhookManager } from "../webhooks/index.ts";

export interface WebhookBridgeOptions {
  readonly bus: EventBus;
  /**
   * Structurally typed rather than the class, so a test can drive the bridge with a stand-in. The
   * bridge genuinely needs nothing else — lifecycle is the composition root's business.
   */
  readonly manager: Pick<WebhookManager, "onEvent">;
  /** Reported failures. Defaults to a console line; the daemon must not die for a webhook. */
  readonly onError?: ((error: unknown, event: BusEvent) => void) | undefined;
}

/** Subscribes the manager to the bus. Returns a detach function. */
export function attachWebhookBridge(options: WebhookBridgeOptions): () => void {
  const onError =
    options.onError ??
    ((error: unknown, event: BusEvent) => {
      console.error(`[webhooks] enqueue failed for ${event.kind}:`, error);
    });

  const subscription: Subscription = options.bus.subscribe((event) => {
    // Nothing is awaited and nothing is returned. `emit()` is synchronous by contract (see
    // `bus/event-bus.ts`), and returning a promise from here — should a stand-in manager hand one
    // back — would still not block the emitter, but it would route this subsystem's rejections into
    // the bus's error channel instead of its own. `onEvent` only writes rows; if it ever starts
    // costing real time, that is a bug in the manager, not something to paper over here.
    try {
      options.manager.onEvent(event);
    } catch (error) {
      // The bus already isolates a throwing subscriber, so this catch is not about protecting the
      // other subscribers. It is about the message: "[bus] subscriber failed" names no subsystem,
      // and a store error out of the delivery queue is worth being able to find.
      onError(error, event);
    }
  });

  return () => {
    subscription.unsubscribe();
  };
}
