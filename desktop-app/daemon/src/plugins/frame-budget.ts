/**
 * The inbound frame budget: what stops a plugin flooding the *host*.
 *
 * ## Why this exists, and why PLAN.md does not mention it
 *
 * PLAN.md's three backpressure mechanisms — declarative filters, credit windows, per-tick batching —
 * are all **host → plugin**. They bound what the host pushes at a plugin that cannot keep up. None
 * of them says anything about the other direction, and PROGRESS.md decision 177 recorded the
 * consequence as a measured gap: *"The frame channel has no backpressure at all. `__vrczHost.send` →
 * `onPluginFrame`, once per frame, unbounded. The only thing making it survivable is that nothing is
 * subscribed yet."*
 *
 * Step 3.6 is exactly when that stops being true. A plugin now has `subscribe`, `unsubscribe` and
 * `credit` to send, every `credit` frame schedules a flush, and a `subscribe` compiles closures — so
 * the direction PLAN.md does not cover is the direction that just acquired teeth. This is the fourth
 * mechanism, and it is a token bucket rather than a credit window because there is nothing to credit:
 * the host does not ask a plugin for frames, so there is no outstanding count to draw down.
 *
 * ## Why a token bucket, and where it is applied
 *
 * A bucket rather than a flat cap, for the same reason the log channel next to it uses one: the
 * shape of legitimate traffic is bursty. A plugin activating asks for its subscriptions, answers a
 * lifecycle frame and credits its first batches all in the same moment, then goes quiet.
 *
 * It is applied in `ProcessTransport`, on the decoded frame, because that is where the two channels
 * are actually one pipe — the same stdio, split by whether a line parses as a frame. A bound applied
 * further in (in the dispatcher, in the bridge) would be a bound on what the host *acts on*, while
 * the decode, the direction check and the fan-out would already have been paid for.
 *
 * ## What is deliberately exempt
 *
 * `pong` and `hello` are the **prelude's** frames, not the plugin's. Budgeting a pong would mean a
 * plugin flooding the frame channel starved its own heartbeat and was killed for being wedged, which
 * is a true verdict reached by a false route: the whole point of the echo living in the prelude is
 * that it is not the plugin's to forget (PLAN.md §"Isolation: child process, not Worker"). A flood
 * should be answered with a bound on the flood, not with a misattributed kill.
 *
 * ## Two buckets, not one, and the reason was measured
 *
 * `res` and `err` get their **own** bucket. With a single bucket the first version of this had the
 * flood fixture spend its whole allowance on `req` frames at module scope and then fail to activate,
 * because the `res` answering its own `lifecycle: activate` was the frame that got dropped — the
 * same misattributed kill as the pong case, one layer up. A reply is traffic the *host asked for*,
 * bounded by the host's own outstanding calls, so it is budgeted separately rather than exempted:
 * unbounded unsolicited `res` frames stay bounded, and a plugin flooding one direction cannot starve
 * the other.
 */

/**
 * Frames a plugin may send in a burst before the host starts dropping them.
 *
 * 256 is one full `MAX_BATCH_EVENTS` batch's worth of credit frames plus room for an activation's
 * subscriptions and calls, which is the largest legitimate burst anyone has described.
 */
export const FRAME_BURST = 256;

/**
 * Sustained frames per second once the burst is spent.
 *
 * 64/s is far more than any subscription shape needs — one `credit` per delivered batch, and the
 * host only sends one batch per subscription per tick — and far less than a `setInterval(…, 0)`
 * flood produces, which is the loop this exists to survive.
 */
export const FRAME_REFILL_PER_SECOND = 64;

/**
 * How often the host is willing to say that it is still dropping frames.
 *
 * Without this the report itself is the flood: a sustained overrun frees a token roughly
 * {@link FRAME_REFILL_PER_SECOND} times a second, and announcing the backlog each time would put 64
 * lines a second on the daemon's own console. The suppression notice is announced once and the total
 * is reported at most this often, so a dropped frame is visible without being loud.
 */
export const FRAME_REPORT_INTERVAL_MS = 1000;

/** What the caller should do about this frame, and what it should say about it. */
export interface FrameVerdict {
  /** False when the frame is over budget and must not be handed on. */
  readonly accept: boolean;
  /** A line for `onProtocolError`, or null. Already rate-limited; emit it as given. */
  readonly report: string | null;
}

/**
 * A token bucket over the frames one peer sends.
 *
 * Stateful and single-owner: one per transport, never shared, because the budget is per plugin
 * process and a shared bucket would let one plugin's flood shed another plugin's frames.
 */
export class FrameBudget {
  readonly #burst: number;
  readonly #refillPerSecond: number;
  #tokens: number;
  #refilledAt: number;
  #suppressed = 0;
  #announced = false;
  #reportedAt = 0;

  constructor(
    burst: number = FRAME_BURST,
    refillPerSecond: number = FRAME_REFILL_PER_SECOND,
    now: number = Date.now(),
  ) {
    this.#burst = burst;
    this.#refillPerSecond = refillPerSecond;
    this.#tokens = burst;
    this.#refilledAt = now;
  }

  /** Frames dropped since the last report. Diagnostics and tests. */
  get suppressed(): number {
    return this.#suppressed;
  }

  /**
   * Spends one token, or refuses.
   *
   * `now` is injected so the bucket's arithmetic is testable without sleeping — the same shape as
   * the log bucket next to it, which is not.
   */
  take(now: number = Date.now()): FrameVerdict {
    const elapsed = now - this.#refilledAt;
    if (elapsed > 0) {
      this.#tokens = Math.min(this.#burst, this.#tokens + (elapsed * this.#refillPerSecond) / 1000);
      this.#refilledAt = now;
    }

    if (this.#tokens < 1) {
      this.#suppressed += 1;
      if (!this.#announced) {
        this.#announced = true;
        this.#reportedAt = now;
        return {
          accept: false,
          report: "The plugin is sending frames too fast; further frames are being dropped.",
        };
      }
      return { accept: false, report: null };
    }

    this.#tokens -= 1;

    if (this.#suppressed > 0 && now - this.#reportedAt >= FRAME_REPORT_INTERVAL_MS) {
      const dropped = this.#suppressed;
      this.#suppressed = 0;
      this.#announced = false;
      this.#reportedAt = now;
      return { accept: true, report: `${String(dropped)} frames were dropped.` };
    }

    return { accept: true, report: null };
  }
}
