/**
 * The webhook subsystem's composition point: registration, the in-memory dispatch set, and the
 * scanner that drains the durable delivery queue.
 *
 * PLAN.md §"Control API — :7775" asks for "a real outbound-HTTP subsystem — retries, backoff,
 * dead-letter", and the three words that shape this class are *durable*, *serialised*, *bounded*:
 *
 * - **Durable.** `onEvent` writes rows and returns; it never sends. Sending happens in `tick`, off
 *   the bus's stack. That is not only about `emit()` never awaiting (see `bus/event-bus.ts`) — it is
 *   what makes a delivery survive the daemon being restarted while an endpoint is down.
 * - **Serialised per webhook, independent across webhooks.** One dead endpoint backing off for five
 *   minutes must cost a healthy one nothing, and two deliveries to the *same* endpoint must not
 *   arrive out of order. Both properties come out of `SQL.listDueWebhookDeliveries`, which returns
 *   each webhook's head of line and nothing else; `#inFlight` only stops a *second* scan from
 *   picking up a row the first is still working on.
 * - **Bounded.** Every attempt has a timeout, every retry has a ceiling, every delivery has a last
 *   attempt after which it is dead-lettered, and a webhook that dead-letters `maxDeadBeforeDisable`
 *   times in a row is disabled. A broken endpoint should stop costing anything, on its own, without
 *   the user having to notice.
 *
 * Wiring is deliberately not this file's business. `app.ts` constructs it, subscribes `onEvent` to
 * the bus, and mounts `register`/`list`/`remove` behind the control API's scope guard.
 */

import { randomUUID } from "node:crypto";
import { APP_NAME, APP_VERSION } from "@vrcz/shared";
import type { BusEvent } from "../bus/event-bus.ts";
import { initialDelay, jitter } from "../net/jitter.ts";
import type { Store } from "../store/store.ts";
import type { WebhookDeliveryRow, WebhookRow } from "../store/types.ts";
import { attemptDelivery, backoffDelay, type FetchLike } from "./delivery.ts";
import { normaliseKindPatterns, parseKindPatterns, webhookMatches } from "./filter.ts";
import { mintWebhookSecret } from "./signature.ts";
import { validateWebhookUrl, WebhookUrlError } from "./url.ts";

export interface WebhookManagerOptions {
  readonly store: Store;
  /** Injected for tests, exactly as `RateLimiter` does it. */
  readonly now?: () => number;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** How often `start()` scans for due deliveries. Jittered; see `net/jitter.ts`. */
  readonly scanIntervalMs?: number;
  /** Attempts before a delivery is dead-lettered, counting the first. */
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Consecutive dead-letters before the webhook is auto-disabled. */
  readonly maxDeadBeforeDisable?: number;
  /** Webhooks touched per scan. A ceiling on concurrent outbound sockets, not a queue depth. */
  readonly batchSize?: number;
  /** Reported failures. A throwing sender must never stop the scanner. */
  readonly onError?: (error: unknown, context: string) => void;
}

/**
 * Defaults, and the retry schedule they produce: **8 attempts over about ten minutes**, at roughly
 * 0s, 5s, 10s, 20s, 40s, 80s, 160s, 300s.
 *
 * Chosen against the failure this actually sees, which is not a permanently dead host — that case is
 * handled by the dead-letter and the auto-disable — but a receiver being restarted or redeployed.
 * Ten minutes covers a container rolling over comfortably; an hour would mean the daemon holding a
 * queue for an endpoint nobody is coming back to, and thirty seconds would fail a deploy.
 *
 * `maxDeadBeforeDisable` is five, deliberately not one: a single dead-letter is a receiver having a
 * bad ten minutes, and disabling on that would make the feature feel arbitrary. Five in a row, with
 * no success in between, is an endpoint that is gone.
 */
const DEFAULTS = {
  scanIntervalMs: 5_000,
  maxAttempts: 8,
  baseBackoffMs: 5_000,
  maxBackoffMs: 300_000,
  timeoutMs: 10_000,
  maxResponseBytes: 64 * 1024,
  maxDeadBeforeDisable: 5,
  batchSize: 16,
} as const;

/** What a caller must supply to register. Everything else is minted or defaulted. */
export interface WebhookRegistration {
  readonly url: string;
  readonly kinds: readonly string[];
  /** Null or omitted means every account. */
  readonly accountId?: string | null;
  /** The grant registering it, when an app is. Null for a webhook the user added. */
  readonly grantId?: string | null;
}

/** The registration result. `secret` is the only time the plaintext exists outside the registrant. */
export interface RegisteredWebhook {
  readonly webhook: WebhookRow;
  readonly secret: string;
}

/** A live webhook with its filter already parsed. Rebuilt whenever the set changes, never per event. */
interface LiveWebhook {
  readonly row: WebhookRow;
  readonly kinds: readonly string[];
}

export class WebhookManager {
  readonly #store: Store;
  readonly #now: () => number;
  readonly #fetch: FetchLike;
  readonly #random: () => number;
  readonly #maxAttempts: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxDeadBeforeDisable: number;
  readonly #batchSize: number;
  readonly #userAgent: string;
  readonly #onError: (error: unknown, context: string) => void;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #scanIntervalMs: number;

  /**
   * The dispatch set, cached.
   *
   * Read from the database on `start()` and on every change, never per event: the bus bursts forty
   * `gamelog.player_join` events on an instance transition, and a `SELECT` per event would put a
   * feature most users have zero of onto the spine's hot path.
   */
  #live: LiveWebhook[] = [];
  /** Webhook ids a scan is currently sending for. Guards against two overlapping scans, only. */
  readonly #inFlight = new Set<string>();
  #started = false;

  constructor(options: WebhookManagerOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#random = options.random ?? Math.random;
    this.#maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.#baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.#timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
    this.#maxDeadBeforeDisable = options.maxDeadBeforeDisable ?? DEFAULTS.maxDeadBeforeDisable;
    this.#batchSize = options.batchSize ?? DEFAULTS.batchSize;
    this.#onError = options.onError ?? (() => {});
    // Not `buildUserAgent`: that one is the mandatory VRChat identity carrying the user's contact
    // address, and the receiver of a webhook is a third party with no business being told it.
    this.#userAgent = `${APP_NAME}/${APP_VERSION} (webhook)`;
    this.#scanIntervalMs = options.scanIntervalMs ?? DEFAULTS.scanIntervalMs;
    // The default sleep is **unref'd**. A scanner parked between scans must not be the reason the
    // process refuses to exit — shutdown should not have to wait out a scan interval.
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms).unref?.();
        }));
    this.reload();
  }

  /**
   * Begins scanning. Idempotent.
   *
   * A self-rescheduling loop rather than `setInterval`, for the reason `JitteredInterval` documents:
   * an interval will happily start a second scan while the first is still waiting on a slow
   * endpoint. This one awaits its scan, then jitters the gap before the next.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.reload();
    void this.#loop();
  }

  async #loop(): Promise<void> {
    // Spread the first scan across the interval, so a machine running several vrc.zip-like tools
    // does not open every one of them with a simultaneous burst. See `net/jitter.ts`.
    await this.#sleep(initialDelay(this.#scanIntervalMs, { random: this.#random }));

    while (this.#started) {
      try {
        await this.tick();
      } catch (error) {
        // A scan that throws must not kill the loop — the next one may well succeed.
        this.#onError(error, "scan");
      }
      if (!this.#started) return;
      await this.#sleep(jitter(this.#scanIntervalMs, { spread: 0.25, random: this.#random }));
    }
  }

  /**
   * Stops scanning. In-flight attempts are left to finish — their outcome is still written, and a
   * row abandoned mid-attempt is simply pending again on the next start, which is the whole point of
   * the queue being a table.
   */
  stop(): void {
    this.#started = false;
  }

  /** True while the scan loop is running. For the status endpoint and for leak-hunting in tests. */
  get isRunning(): boolean {
    return this.#started;
  }

  /**
   * Registers a webhook and returns its plaintext secret **once**.
   *
   * The URL is validated here rather than at the HTTP layer so that no path into this subsystem can
   * skip it — see `url.ts`. Throws {@link WebhookUrlError} on a target the daemon must not send to.
   */
  register(input: WebhookRegistration): RegisteredWebhook {
    const url = validateWebhookUrl(input.url);
    const kinds = normaliseKindPatterns(input.kinds);
    if (kinds.length === 0) {
      throw new WebhookUrlError("no_kinds", "at least one valid event kind pattern is required");
    }

    const minted = mintWebhookSecret();
    const id = randomUUID();
    this.#store.insertWebhook({
      id,
      grant_id: input.grantId ?? null,
      url,
      secret_hash: minted.keyHash,
      kinds: JSON.stringify(kinds),
      account_id: input.accountId ?? null,
      created_at: this.#now(),
    });
    this.reload();

    const webhook = this.#store.getWebhook(id);
    if (webhook === null) throw new Error("webhook vanished immediately after insert");
    return { webhook, secret: minted.secret };
  }

  /** Every webhook, disabled ones included — the UI has to be able to show why one stopped. */
  list(grantId?: string): WebhookRow[] {
    return this.#store.listWebhooks(grantId);
  }

  get(id: string): WebhookRow | null {
    return this.#store.getWebhook(id);
  }

  /** Removes a webhook and everything still queued for it. False when there was nothing to remove. */
  remove(id: string): boolean {
    const removed = this.#store.deleteWebhook(id);
    if (removed) this.reload();
    return removed;
  }

  /** Turns one off without deleting it, keeping its history and the reason. */
  disable(id: string, reason: string): boolean {
    const disabled = this.#store.disableWebhook(id, this.#now(), reason);
    if (disabled) this.reload();
    return disabled;
  }

  /** Recent deliveries for one webhook, newest first. The user's debugging view. */
  deliveries(webhookId: string, limit = 100): WebhookDeliveryRow[] {
    return this.#store.listWebhookDeliveries(webhookId, limit);
  }

  /**
   * The bus subscriber. **Enqueues; never sends.**
   *
   * Synchronous and cheap on purpose: `emit()` does not await, and a subscriber that did network I/O
   * on the bus's stack would be a slow subscriber on the pipeline reader's path. One event matching
   * three webhooks writes three rows sharing one `event_id`, so a receiver subscribed twice can tell
   * a fan-out from a repeat.
   */
  onEvent(event: BusEvent): void {
    if (this.#live.length === 0) return;

    const eventId = randomUUID();
    const now = this.#now();
    const body = renderBody(eventId, event);

    for (const live of this.#live) {
      if (!webhookMatches({ kinds: live.kinds, accountId: live.row.account_id }, event)) continue;
      try {
        this.#store.enqueueWebhookDelivery({
          id: randomUUID(),
          webhook_id: live.row.id,
          event_id: eventId,
          event_kind: event.kind,
          payload: body,
          // Due immediately. The backoff only ever pushes this out, never in.
          next_attempt_at: now,
          created_at: now,
        });
      } catch (error) {
        this.#onError(error, `enqueue ${live.row.id}`);
      }
    }
  }

  /**
   * One scan: send every due delivery, at most one per webhook.
   *
   * Exposed rather than private because it is how a test drives the subsystem without timers, and
   * how the wiring can force a flush at shutdown. Returns how many deliveries it attempted.
   */
  async tick(): Promise<number> {
    const due = this.#store
      .dueWebhookDeliveries(this.#now(), this.#batchSize)
      .filter((row) => !this.#inFlight.has(row.webhook_id));
    if (due.length === 0) return 0;

    for (const row of due) this.#inFlight.add(row.webhook_id);

    // Concurrent across webhooks, and safe: the query already guaranteed one row per webhook.
    await Promise.all(
      due.map(async (row) => {
        try {
          await this.#deliver(row);
        } catch (error) {
          this.#onError(error, `deliver ${row.id}`);
        } finally {
          this.#inFlight.delete(row.webhook_id);
        }
      }),
    );

    return due.length;
  }

  /** Re-reads the dispatch set. Public so the wiring can call it after an out-of-band change. */
  reload(): void {
    this.#live = this.#store.listLiveWebhooks().map((row) => ({
      row,
      kinds: parseKindPatterns(row.kinds),
    }));
  }

  async #deliver(row: WebhookDeliveryRow): Promise<void> {
    const webhook = this.#store.getWebhook(row.webhook_id);

    // Disabled between enqueue and send. Dead-lettered rather than left pending, so the queue for a
    // disabled webhook drains instead of accumulating rows that will never be tried.
    if (webhook === null || webhook.disabled_at !== null) {
      this.#store.markWebhookDeliveryDead(row.id, this.#now(), null, "webhook disabled");
      return;
    }

    const timestamp = this.#now();
    const result = await attemptDelivery({
      url: webhook.url,
      keyHash: webhook.secret_hash,
      body: row.payload,
      deliveryId: row.id,
      eventId: row.event_id,
      eventKind: row.event_kind,
      timestamp,
      timeoutMs: this.#timeoutMs,
      maxResponseBytes: this.#maxResponseBytes,
      userAgent: this.#userAgent,
      fetch: this.#fetch,
    });

    const at = this.#now();

    if (result.ok) {
      // The health counters are only touched when the delivery row actually transitioned, so a row
      // raced by two scanners cannot be counted twice — `consecutive_dead` drives auto-disable.
      if (this.#store.markWebhookDelivered(row.id, at, result.status)) {
        this.#store.recordWebhookDelivered(webhook.id, at, result.status);
      }
      return;
    }

    const attempts = row.attempts + 1;
    const exhausted = result.permanent || attempts >= this.#maxAttempts;

    if (!exhausted) {
      this.#store.rescheduleWebhookDelivery(
        row.id,
        at +
          backoffDelay(attempts, {
            baseMs: this.#baseBackoffMs,
            maxMs: this.#maxBackoffMs,
            random: this.#random,
          }),
        result.status,
        result.error,
      );
      return;
    }

    if (!this.#store.markWebhookDeliveryDead(row.id, at, result.status, result.error)) return;

    const consecutive = this.#store.recordWebhookDead(webhook.id, at, result.status, result.error);
    if (consecutive >= this.#maxDeadBeforeDisable) {
      this.#store.disableWebhook(
        webhook.id,
        at,
        `auto-disabled after ${consecutive} failed deliveries in a row`,
      );
      this.reload();
    }
  }
}

/**
 * The delivery body.
 *
 * Rendered **once, at enqueue**, and stored — every retry re-sends these bytes. Re-rendering per
 * attempt would let a shape change between daemon versions rewrite a queued event mid-flight, and
 * would break any receiver that deduplicates on content rather than on the delivery header.
 *
 * Field names are the wire vocabulary (`accountId`), not the store's (`account_id`): this is a
 * public surface, and it should read like the rest of the control API.
 */
function renderBody(eventId: string, event: BusEvent): string {
  return JSON.stringify({
    id: eventId,
    kind: event.kind,
    ts: event.ts,
    accountId: event.accountId,
    subjectId: event.subjectId ?? null,
    sessionId: event.sessionId ?? null,
    location: event.location ?? null,
    payload: event.payload ?? null,
  });
}
