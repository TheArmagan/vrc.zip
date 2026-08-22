/**
 * Blocks the event loop forever, **after** it has activated.
 *
 * The attack the heartbeat exists for, and the reason the echo lives in the host-injected prelude
 * rather than in plugin code: the pong needs a turn of the loop this file is refusing to yield, so
 * it stops being answered no matter how the plugin was written or what it intended. A missed beat
 * here is evidence about the runtime, not about the author.
 *
 * It also proves the second half — `stop()` cannot work on this process, because "please exit"
 * travels over the same loop. Only `kill()` ends it, which is why the supervisor has both.
 *
 * **Why the wedge is scheduled rather than run inline, and why `spin-at-load.js` is a separate
 * file.** The supervisor arms the heartbeat only in the `running` state, which it reaches when
 * `activate` is answered. A plugin that wedges before then is caught by the *activation deadline*
 * and never gets as far as a heartbeat — a real failure, and a different one, so it has its own
 * file. This file answers `activate` promptly and only then stops turning its loop, which is the
 * only shape that actually reaches the mechanism under test.
 *
 * `Date.now()` in the condition rather than a bare `while (true)`: a constant-true loop is
 * something an optimiser may reason about, and the point is to burn a real core.
 */

/** Bounded only so a leaked process cannot outlive a test run by a week. */
const FOREVER_MS = 3_600_000;

export function spin() {
  const started = Date.now();
  while (Date.now() - started < FOREVER_MS) {
    /* deliberately nothing */
  }
}

export function activate() {
  // Answered first, wedged immediately afterwards. The timer never fires as a timer — the loop is
  // gone by the time it would — which is exactly the situation the heartbeat is meant to notice.
  setTimeout(spin, 1);
  return { spinningShortly: true };
}

export function deactivate() {
  spin();
}
