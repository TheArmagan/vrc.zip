/**
 * Blocks the event loop forever.
 *
 * The attack the heartbeat exists for, and the reason the echo lives in the host-injected prelude
 * rather than in plugin code: the pong needs a turn of the loop this file is refusing to yield, so
 * it stops being answered no matter how the plugin was written or what it intended. A missed beat
 * here is evidence about the runtime, not about the author.
 *
 * It also proves the second half — `stop()` cannot work on this process, because "please exit"
 * travels over the same loop. Only `kill()` ends it, which is why the supervisor has both.
 *
 * `Date.now()` in the condition rather than a bare `while (true)`: a constant-true loop is
 * something an optimiser may reason about, and the point is to burn a real core.
 */
function spin() {
  const started = Date.now();
  // Effectively forever. Bounded only so a leaked process cannot outlive a test run by a week.
  while (Date.now() - started < 3600000) {
    /* deliberately nothing */
  }
}

spin();

export function activate() {
  spin();
}
