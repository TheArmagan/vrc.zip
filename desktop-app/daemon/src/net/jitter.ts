/**
 * Jittered scheduling. See PLAN.md §1.4.
 *
 * VRChat's guidelines explicitly ask tools not to create synchronized traffic spikes. Two things
 * follow, and only the first is obvious:
 *
 * 1. Every interval is `base + random(0, base * spread)`, so two vrc.zip instances that started at
 *    the same second drift apart instead of marching in step.
 * 2. **The phase is seeded from process start, not from the wall clock.** A poll written as "every
 *    5 minutes" against a clock fires at :00, :05, :10 — on every machine running the tool,
 *    simultaneously. Seeding from an arbitrary process-start offset spreads the whole population
 *    across the interval for free.
 */

/** Fixed at module load: the arbitrary offset every schedule is phase-shifted by. */
const PROCESS_START = Date.now();

export interface JitterOptions {
  /** Fraction of `baseMs` to add at random. 0.2 = up to +20%. */
  readonly spread?: number;
  readonly random?: () => number;
}

const DEFAULT_SPREAD = 0.2;

export function jitter(baseMs: number, options: JitterOptions = {}): number {
  const spread = options.spread ?? DEFAULT_SPREAD;
  const random = options.random ?? Math.random;
  return Math.round(baseMs + random() * baseMs * spread);
}

/**
 * The delay before a schedule's *first* tick.
 *
 * Deliberately not just `jitter(baseMs)`: on a cold start every poller would otherwise fire within
 * the same jitter window, which is a small synchronized spike of exactly the kind we are avoiding.
 * Spreading the first tick uniformly across the whole interval costs nothing — the data is no
 * staler for it — and it is what keeps a daemon with six accounts and ten pollers from opening with
 * a burst.
 */
export function initialDelay(baseMs: number, options: JitterOptions = {}): number {
  const random = options.random ?? Math.random;
  const phase = (PROCESS_START % baseMs) / baseMs;
  const offset = (phase + random()) % 1;
  return Math.round(offset * baseMs);
}

/**
 * A self-rescheduling timer with fresh jitter every tick.
 *
 * `setInterval` is wrong here twice over: it has no jitter, and it will happily queue a second run
 * while the first is still awaiting the network. This waits for the callback, then schedules again.
 */
export class JitteredInterval {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #running = false;

  constructor(
    private readonly baseMs: number,
    private readonly onTick: () => void | Promise<void>,
    private readonly options: JitterOptions = {},
  ) {}

  start(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.#schedule(initialDelay(this.baseMs, this.options));
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  get isRunning(): boolean {
    return this.#running;
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      void this.#tick();
    }, delayMs);
    // Don't hold the process open for a poller. Shutdown should not have to wait out an interval.
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    this.#timer = null;
    if (this.#stopped) return;

    this.#running = true;
    try {
      await this.onTick();
    } catch {
      // A poll that throws must not kill the schedule — the next tick may well succeed. The
      // callback owns its own error reporting; swallowing here only protects the loop.
    } finally {
      this.#running = false;
    }

    if (!this.#stopped) this.#schedule(jitter(this.baseMs, this.options));
  }
}
