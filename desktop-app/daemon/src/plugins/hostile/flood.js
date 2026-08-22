/**
 * Emits and requests as fast as the transport will take it.
 *
 * The shape PLAN.md calls out by name: log tailing bursts 40+ `player-join` events on an instance
 * transition and pipeline `friend-location` fires for every friend who moves, so backpressure is
 * load-bearing rather than a nicety. This file is the same burst with no upper bound and no pause.
 *
 * PLAN.md's three host-side mechanisms — credit windows, per-tick batching, the `dropped` frame —
 * are all **host → plugin**, and this file runs the other way: it is a plugin outrunning the host.
 * That direction has its own bound, an inbound token bucket in `frame-budget.ts`, and it landed with
 * 3.6 because 3.6 is when `subscribe` and `credit` gave a plugin frames worth flooding with.
 *
 * **Two channels, because they turn out not to be the same channel.** `process.stdout.write` is the
 * obvious way to outrun the host and it does not work: the prelude replaces it with a write to
 * stderr, so a raw burst becomes log lines and meets the transport's log token bucket instead of the
 * frame path. The only way a plugin actually reaches the frame channel is `__vrczHost.send`, so the
 * flood runs down both and the suite asserts what happens to each.
 *
 * `setInterval(…, 0)` rather than a loop, so the process stays responsive. A flood that also blocked
 * the loop would be caught by the heartbeat and would never reach the mechanism under test.
 */

const host = globalThis.__vrczHost;

const BURST = 500;

let sent = 0;

function burst() {
  for (let i = 0; i < BURST; i += 1) {
    sent += 1;
    const frame = {
      t: "req",
      id: `flood-${String(sent)}`,
      method: "noop",
      deadline: Date.now() + 30000,
    };
    // The channel a plugin genuinely has.
    host.send(frame);
    // And the one it would reach for first. Redirected to stderr by the prelude, so this is a log
    // flood rather than a frame flood, and the transport's token bucket is what meets it.
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  }
}

burst();

export function activate() {
  const timer = setInterval(burst, 0);
  return { timer: String(timer) };
}
