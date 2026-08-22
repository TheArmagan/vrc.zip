/**
 * The control.
 *
 * A supervisor that kills everything passes every other test in this directory, and this is the
 * only file that notices. It answers its lifecycle hooks promptly, yields the event loop, and does
 * nothing a well-written plugin would not do — so any defence that fires here is a false positive,
 * and a false positive in a kill path is how a user's working plugins start disappearing.
 */
export async function activate() {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return { ready: true };
}

export async function deactivate() {
  return { stopped: true };
}
