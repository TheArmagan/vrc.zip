/**
 * A lifecycle hook that never resolves.
 *
 * Distinct from `spin.js` in the way that matters: this process is perfectly responsive. It answers
 * every heartbeat, its memory is flat, and it will sit there forever looking healthy — because by
 * every measure except the one that counts, it is. Only the activation deadline catches it.
 *
 * The distinction the supervisor has to preserve is "activate hung" versus "activate failed", which
 * are different sentences to put in front of a user: one is a plugin waiting on something that is
 * never coming, the other is a plugin that told you it could not start.
 */
export function activate() {
  // Never settles. Not a rejection, not a timeout — the promise simply has no other end.
  return new Promise(() => {});
}

export function deactivate() {
  // Hangs on the way out too, so a shutdown that waits politely forever is also exercised.
  return new Promise(() => {});
}
