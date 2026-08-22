// A plugin that logs both of the ways a plugin can log.
//
// `console.log` is redirected to stderr by the prelude, which is what keeps stdout a clean frame
// channel. `fs.writeSync(1, …)` goes around that redirect, and it is in this fixture on purpose: it
// is the honest demonstration that the prelude is hygiene rather than containment, and it is why
// the host still has to treat a non-frame stdout line as a log.
console.log("hello from console");
const fs = await import("node:fs");
fs.writeSync(1, "straight to fd 1\n");
