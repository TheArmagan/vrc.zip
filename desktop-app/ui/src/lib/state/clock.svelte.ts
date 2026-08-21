/**
 * One ticking clock for the whole app.
 *
 * "4m ago" and a session uptime both have to re-render on their own, and a component that owns its
 * own `setInterval` is one timer per row. The friends list alone can be several hundred rows, so
 * this is a single interval and a single `visibilitychange` listener, attached when the first
 * reader arrives and dropped when the last one leaves. A background tab does not need to recompute
 * "2h 14m", so the interval stops while the tab is hidden and the value is refreshed on the way
 * back rather than caught up tick by tick.
 */

class Clock {
  #now = $state(Date.now());
  #timer: number | null = null;
  #readers = 0;

  /** Unix ms, republished once a second. Reading this in a `$derived` makes it reactive. */
  get now(): number {
    return this.#now;
  }

  /** Call from an `$effect`; the returned teardown releases this reader's claim on the interval. */
  subscribe(): () => void {
    this.#readers += 1;
    if (this.#readers === 1) {
      document.addEventListener("visibilitychange", this.#onVisibility);
      this.#now = Date.now();
      this.#start();
    }
    let released = false;
    return () => {
      // Guarded: Svelte can run a teardown more than once across a hot reload, and a double
      // decrement here would strand the interval running with a negative reader count.
      if (released) return;
      released = true;
      this.#readers -= 1;
      if (this.#readers === 0) {
        document.removeEventListener("visibilitychange", this.#onVisibility);
        this.#stop();
      }
    };
  }

  #onVisibility = (): void => {
    if (document.visibilityState === "visible") {
      this.#now = Date.now();
      this.#start();
    } else {
      this.#stop();
    }
  };

  #start(): void {
    if (this.#timer !== null || this.#readers === 0) return;
    this.#timer = window.setInterval(() => {
      this.#now = Date.now();
    }, 1000);
  }

  #stop(): void {
    if (this.#timer === null) return;
    window.clearInterval(this.#timer);
    this.#timer = null;
  }
}

export const clock = new Clock();
