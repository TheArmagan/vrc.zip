/**
 * Blocks the event loop at module scope, before it has ever activated.
 *
 * The sibling of `spin.js`, and the distinction between them is a property of the supervisor rather
 * than a detail of the fixture: **the heartbeat runs only in the `running` state**, and `running` is
 * reached by answering `activate`. A plugin that wedges during its own module evaluation therefore
 * never reaches the heartbeat at all, and the only thing that catches it is the activation deadline.
 *
 * That makes its *observable* failure identical to `hang.js` — `activate-hung` — from two causes
 * that could not be more different: one process is idle and waiting on a promise, the other is
 * burning a core and will not read its stdin again. The suite asserts both, because a future change
 * that made the heartbeat run from `activating` would move this file's verdict and not `hang.js`'s.
 *
 * `hello` still arrives: the prelude sends it before it imports the bundle, which is why the failure
 * is `activate-hung` rather than `hello-timeout`.
 */

const FOREVER_MS = 3_600_000;

const started = Date.now();
while (Date.now() - started < FOREVER_MS) {
  /* deliberately nothing */
}

export function activate() {
  return { unreachable: true };
}
