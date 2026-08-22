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

`hostile.test.ts` beside them **is** the suite. Every attack goes through the real install pipeline
(`Bun.build` with the host-builtin resolver, the deny-scan over the bundled output, the
content-addressed write), the real spawn resolver, and a real `PluginRegistry` → `PluginSupervisor`
→ `ProcessTransport`, which spawns an actual `bun` running the injected prelude. Nothing is mocked;
the failures this directory exists to catch all live at the process boundary. The two attacks the
pipeline refuses never get as far as a process, which is the assertion for those.

**Assert the stage, not the refusal.** Two spellings of the same attack are rejected by two
different layers — `import("node:" + "fs")` is constant-folded and dies at *compile*, while
`import(["no","de:","fs"].join(""))` reaches the *deny-scan* — so "it was rejected" is not an
assertion worth writing. Every test here names the layer.

| File | Attack | Stopped at |
|---|---|---|
| `spin.js` | Wedges the event loop after activating | Heartbeat, then `kill()` |
| `spin-at-load.js` | Wedges during module evaluation | Activation deadline — the heartbeat is only armed once `running` |
| `memory-bomb.js` | Allocates without bound, yielding | RSS watchdog; under an OS cap, the heartbeat |
| `memory-bomb-at-load.js` | The same, synchronously at load | The OS cap, reported as `crashed` with exit code 1 |
| `filesystem-folded.js` | `import("node:" + "fs")` | **compile** — Bun folds the concatenation before the scan sees it |
| `filesystem.js` | `import(["no","de:","fs"].join(""))` | **deny-scan** — `dynamic-import` |
| `flood.js` | Emits and requests without pause | The log token bucket. **Nothing bounds the frame channel yet** (3.6) |
| `hang.js` | A lifecycle hook that never resolves | Activation deadline |
| `liar.js` | Forges frames it is not allowed to send | The prelude for `pong`/`hello`; the stdout redirect for the rest |
| `globals.js` | Computed reaches the deny-scan cannot see | **Nothing at install** — the prelude's scrubbing, at run time |
| `network.js` | `fetch`, `WebSocket`, `eval` | **No scan rule exists** — the prelude's scrubbing is the whole defence |
| `crash.js` | Dies during module evaluation, always | Crash-loop auto-disable, durable across a restart |
| `polite.js` | Behaves perfectly | The control: none of the above may fire |

`harness-entry.js` is not an attack. It is the thinnest possible stand-in for the plugin-side runtime
step 3.6 will ship — without something answering a `lifecycle` frame, *every* plugin is reported as
`activate-hung` and the control cannot pass. See its header.

**`polite.js` is not filler.** A supervisor that kills everything passes every other test in this
directory, and the control is the only thing that notices. It runs under the same heartbeat budgets
as `spin.js` for exactly that reason.
