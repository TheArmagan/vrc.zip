/**
 * Emits and requests as fast as the transport will take it.
 *
 * The shape PLAN.md calls out by name: log tailing bursts 40+ `player-join` events on an instance
 * transition and pipeline `friend-location` fires for every friend who moves, so backpressure is
 * load-bearing rather than a nicety. This file is the same burst with no upper bound and no pause.
 *
 * It is aimed at all three host-side mechanisms at once, and each fails differently if it is
 * missing: without credit windows the host buffers without limit, without batching it wakes per
 * event, and without the `dropped` frame the plugin is quietly told it saw everything when it did
 * not — which is the worst of the three, because it is the one nobody notices.
 *
 * `setInterval(…, 0)` rather than a loop, so the process stays responsive. A flood that also blocked
 * the loop would be caught by the heartbeat and would never reach the mechanism under test.
 */
let sent = 0;

function burst() {
  for (let i = 0; i < 1000; i += 1) {
    sent += 1;
    // Written straight to stdout rather than through any helper, because the point is to outrun
    // whatever the host is doing with it.
    const frame = {
      t: "req",
      id: `flood-${String(sent)}`,
      method: "noop",
      deadline: Date.now() + 30000,
    };
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  }
}

setInterval(burst, 0);

export function activate() {
  burst();
}
