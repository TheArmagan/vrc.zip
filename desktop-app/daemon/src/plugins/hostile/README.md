# The deliberately hostile plugin

`PLAN.md` §"Plugin build order" puts this third, immediately after the supervisor and **before** the
deny-scan, the RSS watchdog and the event-flood backpressure it is meant to defeat. That ordering is
the point. Written later, an adversary only validates a design already committed to; written here,
every claim made after it is tested against something actively trying to break it as the claim is
made. Decision 108.

Each file is one attack, kept separate so a test can name exactly which defence it is exercising and
so a failure names the attack rather than "the hostile plugin broke". Every one of them misbehaves
**both at module scope and inside `activate`**, because those are two different moments with two
different defences: module scope runs before the host has decided the plugin is healthy, and
`activate` runs while the host is waiting on a deadline.

These are **not** built by the install pipeline and must never be. They are source fixtures for the
supervisor and, later, the deny-scan — several of them exist precisely because `Bun.build` should
refuse them, and a fixture that passed the build would no longer be testing anything.

| File | Attack | What it must fail against |
|---|---|---|
| `spin.js` | Blocks the event loop forever | Heartbeat, then `kill()` |
| `memory-bomb.js` | Allocates without bound | RSS watchdog and the OS cap |
| `filesystem.js` | `import("node:" + "fs")` | Install-time deny-scan; the process boundary behind it |
| `flood.js` | Emits and requests without pause | Credit windows, batching, the `dropped` frame |
| `hang.js` | A lifecycle hook that never resolves | Activation deadline |
| `liar.js` | Forges frames it is not allowed to send | `isFrameAllowedFrom`, protocol-error counting |
| `polite.js` | Behaves perfectly | The control: none of the above may fire |

**`polite.js` is not filler.** A supervisor that kills everything passes every other test in this
directory, and the control is the only thing that notices.
