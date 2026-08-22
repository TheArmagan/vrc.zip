// A peer that starts and never says hello. Exercises `helloTimeoutMs`.
//
// Holds stdin open so the process stays alive: a process that merely exited would be indistinguishable
// from a crash, and the timeout is what has to fire.
const reader = Bun.stdin.stream().getReader();
(async () => {
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
  }
})();
