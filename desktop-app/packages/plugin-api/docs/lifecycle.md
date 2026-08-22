# Plugin lifecycle

> [!IMPORTANT]
> **A plugin can be installed and started today, but only over the control API with the session
> token, and nobody is asked first.** There is no plugin UI and no consent screen, so the grant is
> written straight from what the manifest requested. Step 3.8 replaces that with a real consent
> gesture, and grants made this way are not something to rely on.
>
> Built and wired: the install pipeline (compile, deny-scan, content-address, verify the hash on
> every load), the supervisor (spawn, memory cap, heartbeat, watchdog, restart backoff), the
> dispatcher answering scope-checked and account-checked **read** calls against VRChat, and the
> events bridge.
>
> Not built: **lifecycle dispatch to your exported functions** (the host sends the frame; nothing
> routes it to your `activate`), the `ctx` object those docs describe, storage, outbound actions,
> the UI renderer, and nodes.
>
> These pages document what is **real today** and mark clearly what is not. Read
> [status.md](./status.md) for the line-by-line breakdown before you build anything you are relying
> on.

This page is the whole story of one plugin process: how it is started, what runs before your code
does, what the host expects from it while it lives, and every way it dies. The mechanisms here are
built and tested today — the gap, stated in full under [Activation](#activation-and-the-gap-that-matters),
is that nothing yet calls the `activate` and `deactivate` functions you export.

Source of truth:
`daemon/src/plugins/{process-transport,prelude,supervisor,limits,job-object,registry}.ts`, and
`daemon/src/plugins/install/` for the artifact the spawn path loads.

## The shape of it

```
registry.startAll()
  → supervisor.start()          state: idle → starting
    → transport factory → Bun.spawn(bun [--smol] -e <prelude> <config>)
      → prelude sends `hello`   ── 10s deadline ──
    → supervisor sends `lifecycle: activate`   state: starting → activating
      → …a reply on that id     ── 15s deadline ──
    → running                   heartbeat every 10s, RSS checked on every beat
```

Every state, edge and threshold below is enumerated in `supervisor.ts`. States are named
(`idle`, `starting`, `activating`, `running`, `stopping`, `backoff`, `disabled`) with an explicit
transition table rather than a set of booleans, because a `restarting` + `stopping` + `disabled`
triple has eight combinations, only four mean anything, and the two that bite in practice are
"restart during shutdown" and "exit during restart".

## Spawn

One plugin, one OS process. Not a `Worker` — a Worker is an isolation primitive rather than a
security one: it gets its own `globalThis` but keeps `process`, `Bun`, `fetch` and full `node:*`
access, cannot be memory-capped (Bun has no `resourceLimits`), and `terminate()` is not documented to
preempt a synchronous spin loop. A process buys real memory caps, a `kill(9)` that always wins, and crash
containment. It used to buy a fourth thing on paper — the granularity OS-level sandboxing would
attach to — but that sandbox was cut rather than deferred, so those three are the whole argument.

The spawn is:

```
<runtime bun> [--smol] -e <PRELUDE_SOURCE> <config JSON>
```

with a scrubbed environment, `cwd` set to your plugin's own data directory, all three stdio streams
piped, and an OS memory cap applied where the platform has one.

**A scrubbed environment** denies every secret and path the daemon happens to be holding:
`VRCZIP_STATE_DIR` and therefore the location of the credential store, any keychain or token
variable, proxy credentials, and the developer's whole shell. Off Windows this is literally `env: {}`,
because POSIX `execve` takes the block it is given.

**On Windows `env: {}` is a merge, not a replacement**, which is worth stating because it is the
opposite of what the API looks like it does. Bun synthesises eleven variables (`PATH`, `SYSTEMROOT`,
`WINDIR`, `SYSTEMDRIVE`, `TEMP`, `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `USERDOMAIN`, `USERNAME`,
`USERPROFILE`) and adds them to whatever you pass. The only way to get rid of one is to supply your
own value for it, and the empty string is that value: the variable still exists in the child and says
nothing. Key matching is case-insensitive, so `SystemRoot` replaces the synthesised `SYSTEMROOT`
rather than adding a second entry.

Nothing the daemon holds was ever reaching a plugin through that set, and it should not be described
as a credential leak. What it disclosed was the user's account name, home directory, domain
controller, and an inventory of installed tooling in `PATH`. The spawn now keeps four things and
blanks the other seven:

| Kept | Why |
|---|---|
| `SystemRoot`, `windir` | Mandatory. The Windows loader resolves system DLLs and CNG resolves its crypto configuration relative to them; `bun` does not get far enough to run a script without them. |
| `SystemDrive` | Consulted by parts of the CRT for a path with no drive letter. Discloses nothing. |
| `TEMP`, `TMP` | Pointed at **your own data directory**, not the user's temp folder. It is already your working directory, so you learn nothing new, your temp files stay in the one place you may write, and the user's profile path is never spelled out. |

A blank `PATH` has teeth of its own: `Bun.spawn(["git", …])` now resolves nothing. The prelude also
empties `process.env` immediately afterwards, which closes the whole set for anything reading the
variable rather than the OS block.

**`--smol`** selects JSC's small-heap configuration and is the default for every plugin. Plugin
processes are overwhelmingly idle event handlers, and the daemon's whole pitch against VRCX is a
50-80MB idle footprint that N plugin processes are the most likely way to lose. A manifest may opt out
with `"performance": "throughput"`, which spawns without the flag — and that surfaces on the consent
screen, because it spends the *user's* memory, so it is their call rather than yours to make silently.
`--smol` is a hint and not a limit: it caps nothing, and the RSS watchdog is still what stops a
runaway.

**The working directory is your data directory** (`<state>/plugin-data/<id>/`), so a plugin that
reaches the filesystem around the scrub writes *relative* paths into the one place it is entitled to.
That is a convenience, not a boundary: an absolute path goes wherever it says.

### Memory caps, honestly

Both primary platforms now have an OS-enforced cap, and the two work differently enough that the
difference is visible to you:

| Platform | Mechanism | When | What it bounds |
|---|---|---|---|
| Windows | Job Object (`job-object.ts`) | after the spawn, on the pid | `ProcessMemoryLimit`, which is **committed memory** |
| Linux | `RLIMIT_AS` via `sh -c 'ulimit -v …; exec …'` | before the spawn, in the argv | virtual address space |
| macOS | none, deliberately | — | Darwin accepts `RLIMIT_AS` and does not enforce it, and a cap that only looks applied is worse than none |

**On Windows the cap is committed memory**, which makes the number a much closer match to the one a
human has in mind. Linux's `RLIMIT_AS` counts JavaScriptCore's large untouched virtual reservations,
so a cap there has to be set at a generous multiple of the RSS actually intended. On Linux the
wrapper `exec`s, so the pid the watchdog reads is still the plugin's own.

**Crossing the Windows cap reads as a crash, not as a kill.** The allocation is refused inside your
process, JSC raises `RangeError: Out of memory`, and the process exits 1 on its own. Nothing signals
it and nothing terminates it, so it arrives as `crashed` and goes on the restart ladder like any
other crash rather than as `rss-exceeded`.

Two consequences of the ordering. A job object needs a pid and therefore cannot exist before the
process does, so `planMemoryCap` can only name the mechanism it will *attempt* on Windows and returns
`enforced: false`; the transport raises that once the assignment actually succeeds, corrected upward
and never downward. There is a genuine window of microseconds after `Bun.spawn` returns during which
the child is uncapped, before its runtime has finished starting.

Every failure path falls back to the RSS watchdog rather than refusing to start the plugin, because a
later bound is a better outcome than no plugin, and `warnIfUncapped` says so out loud once per daemon
process rather than letting anyone assume a cap they did not get.

### Where the runtime comes from

`resolvePluginRuntime` looks in exactly two places: `<state>/runtime/bun-<Bun.version>/bun[.exe]`
(the fetched, hash-pinned runtime), then `process.execPath` — but only when the daemon is not running
as a packaged build, since from a source checkout the daemon is already running under a real `bun`.
There is deliberately no third candidate: a `PATH` bun is exactly the silent substitution the pinned
runtime exists to prevent.

**The fetcher for that runtime now exists, and it will not fetch anything.** `ensurePluginRuntime`
downloads and hash-checks the pinned Bun release, unzipping it with a central-directory reader rather
than by spawning whatever answers to `tar` on `PATH` in order to install the binary it is about to
spawn. But its pin table ships empty on purpose: the hashes come from a packaging step that does not
exist yet, and an unpinned platform **refuses**, naming the URL and the hash it wanted, rather than
running an executable nobody vouched for. So the practical position is unchanged: today plugins run
from a source checkout, where the daemon is already running under a real `bun`, and inside a packaged
build the transport returns a stillborn transport whose message names the missing path rather than
failing at `Bun.spawn`.

## The prelude

Before any of your code exists, the host injects a prelude as a string via `bun -e`. It is a string
rather than a file on disk for two reasons, in order: a prelude materialised at a predictable path is
a file another local process can rewrite between the write and the spawn, which is a TOCTOU race on
the exact code that enforces the boundary and the single most valuable file on the machine to win one
against; and a string works identically from source and inside the compiled single-file `.exe`. The
cost is Windows' 32767-character command line, which is why `MAX_PRELUDE_SOURCE_BYTES` is 16384 and
asserted by a test — the prelude may not grow into that limit unnoticed.

Everything it needs is captured at module load, before your bundle is imported: `stdin`, both write
functions, `JSON.stringify`/`parse`, `Object.defineProperty`, the encoder and decoder, `process.exit`
and `process.on`. Your code may replace any of those afterwards and the heartbeat keeps working
through it.

What the prelude does:

1. **It owns the heartbeat echo.** A `ping` is answered before any plugin-supplied code runs and never
   handed on.
2. **It owns the wire.** stdout carries frames and nothing else; `console.*` and `process.stdout.write`
   are redirected to stderr.
3. It sends the single `hello` frame, and reports `rss` on each pong.
4. It scrubs globals.
5. It installs `globalThis.__vrczHost` and then `import()`s your bundle.

It also installs `uncaughtException` and `unhandledRejection` handlers that log to stderr rather than
exiting: an async throw should cost you that turn, not the process, because the supervisor decides
what a failing plugin costs and it cannot decide anything about a process that already exited.

### What the scrub is, and what it provably is not

**This is not a security sandbox, and calling it one would be a lie.** The scrubbing is hygiene: it
makes the dangerous thing awkward and obvious rather than reflexive. Removed from `globalThis`:
`fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `navigator`, `Worker`, `SharedWorker`, `eval`,
`require`. Overwritten on `Bun`: `spawn`, `spawnSync`, `file`, `write`, `$`, `connect`, `listen`,
`serve`, `udpSocket`, `dlopen`, `FFI`, `unsafe`, `which`, `openInEditor`, `secrets`, `s3`, `redis`,
`embeddedFiles`, `stdin`, `stdout`, `stderr`. Removed from `process`: `binding`, `dlopen`,
`getBuiltinModule`, `chdir`, `kill`. `process.env` is set to `{}`.

Three things it cannot do, and these are measured rather than assumed:

- **A prelude cannot disable the `import()` operator.** It is an operator, not a global, so
  `await import("node:" + "fs")` reaches the filesystem and there is no property to remove that
  changes that.
- **`globalThis.Bun` cannot be removed.** Its property descriptor is `{writable: false,
  configurable: false}`, so it survives assignment, `delete` and `defineProperty`. Its *members* are
  writable, which is why the list above overwrites them — but `Bun.env` is itself non-writable and
  stays.
- **`Function` cannot be scrubbed.** `(function(){}).constructor` reaches it from any function value,
  so removing the global would break the runtime and stop nothing.

The honest summary: a plugin that *wants* to escape the scrub can, in about one line. What the scrub
buys is that a plugin doing something dangerous had to write that line, which is a thing a reviewer
can see.

Do not read the install-time deny-scan as the thing that closes the gap. It catches syntax and only
syntax, and a `constructor.constructor` chain, a computed `globalThis["pro"+"cess"]`, and a plain
`fetch(…)` all pass it today. **None of this is confinement**: the scrub blocks the easy
reach, the environment scrub stops disclosure, and the process boundary contains crashes. There is no
future AppContainer or seccomp profile behind them either — that was cut. What the host does
guarantee is that the code running is the code that was scanned and hashed, and that it cannot
outgrow its memory cap or wedge the daemon. [security-model.md](./security-model.md) lists exactly what gets through, and it
is the page to trust over this list.

### The `__vrczHost` seam

`__vrczHost` is installed as a frozen, non-writable, non-configurable, non-enumerable property of
`globalThis`, and it is the entire plugin-side surface that exists today:

| Member | Behaviour |
|---|---|
| `pluginId` | Your id, from the spawn config. |
| `protocol` | The protocol major the prelude speaks (`PLUGIN_API_PROTOCOL_MAJOR`, currently `0`). |
| `send(frame)` | Encodes and writes one frame. Returns `false` if it could not. Refuses `pong` and `hello` locally. |
| `onFrame(fn)` | Registers the single handler for every frame that is not a `ping`. Passing a non-function clears it. |
| `log(message)` | Writes one line to stderr, where the host reads it as a log line. |

`send` refuses `pong` and `hello` locally because forging a pong would defeat the unforgeable
heartbeat this file exists to provide, and because the host is entitled to treat `hello` as arriving
exactly once. Everything else it will write — and the host still direction-checks and authorises every
frame it receives, so a `subscribe` you send is validated on arrival and an `event` frame you try to
send is rejected as a protocol error.

`onFrame` takes one handler, not many. A handler that throws costs you the frame and is logged; it
does not take the read loop down.

## The handshake

The prelude sends `hello` **first**, before importing your bundle. That ordering is the point: the
host's arrival deadline is satisfied by the prelude rather than by however long your module graph
takes to evaluate.

`hello` carries `protocol` and `pluginId`, and the supervisor checks both:

- A protocol mismatch is a **hard stop** — `disable("protocol-mismatch")`, sticky across daemon
  restarts, with a message naming the version needed. Never a restart loop, because nothing about
  respawning the same bundle changes which protocol it was compiled against, and a loop would never
  even reach the user with the one fact they need.
- A `pluginId` that does not match the one the supervisor is running is the same hard stop.

Because the prelude is host code, it always speaks the host's major, so a `hello` mismatch is not
something that happens in practice. A real mismatch is caught at install, against the manifest's
`engines.pluginApi`.

**Deadline: 10 seconds** (`helloTimeoutMs`). Booting a bundle is milliseconds; 10s covers a cold disk.
Two timers guard it — the transport's own and the supervisor's — because the supervisor cannot know
whether a given transport implements one, and its state machine needs an answer either way. Whichever
fires first ends in the same place: failure kind `hello-timeout`, and a kill. "Dead on arrival" is a
distinct failure from "stopped answering", and telling a user the second when it was the first sends
them reading the wrong log.

## Activation, and the gap that matters

On accepting `hello`, the supervisor moves to `activating` and sends:

```json
{ "t": "lifecycle", "id": "lc1-…", "deadline": 1740000015000, "phase": "activate" }
```

It then waits for a `res` or an `err` on that id, for **15 seconds** (`activateTimeoutMs`) — long
enough for a plugin that opens its SQLite file and reads settings, short enough that a user watching
the plugin list does not conclude the app has hung.

> [!WARNING]
> **Nothing dispatches that frame to an exported `activate` function today, and nothing answers it.**
>
> The prelude answers `ping` itself and forwards every other frame — `lifecycle` included — to the
> single handler registered through `globalThis.__vrczHost.onFrame`. It does not read your module's
> exports, does not construct a `ctx`, and does not know that `activate` or `deactivate` are words.
> Your bundle is loaded with a bare `import(bundleUrl)`, so its top-level code runs and its exports
> are discarded.
>
> The consequence is concrete: a plugin that does not register an `onFrame` handler and reply to the
> `activate` frame itself will log `[vrc.zip] no handler is attached for a lifecycle frame` to stderr,
> hit the 15s deadline, be recorded as `activate-hung`, be killed, and restart on the backoff ladder
> — five times in five minutes, and then auto-disable. That is the mechanism behaving correctly
> against a plugin runtime that does not exist yet.
>
> The plugin-side runtime that turns this frame into a call to your exported function is the missing
> half. Until it lands, `__vrczHost` is the only seam, and it is deliberately low-level: it exists so
> the runtime can be built on top of it without the prelude changing.

The two failure kinds here are distinct on purpose:

- **`activate-hung`** — the deadline passed with no reply. The plugin is blocking.
- **`activate-failed`** — an `err` frame arrived on that id. The plugin's own startup code threw.

They send a user to different places, so telling them the second when it was the first sends them
reading the wrong log. Both end in a kill rather than a graceful stop: the plugin never activated, so
there is no state worth flushing, and a plugin whose startup just threw is not the one to trust with a
graceful shutdown handler.

## Running: the heartbeat

The heartbeat runs only in the `running` state. The host sends `ping` with a nonce and a deadline; the
**prelude** answers `pong`, and that is the entire reason the mechanism works.

Putting the echo in host-injected code rather than in yours means you cannot forget to answer, cannot
answer wrongly, and — the property that actually matters — a plugin spinning its event loop stops
answering no matter what it intended, because the reply needs a turn of the loop it is refusing to
yield. **A missed heartbeat is therefore evidence about the runtime, not about the author.**

| Threshold | Value | Reasoning |
|---|---|---|
| `heartbeatIntervalMs` | 10000 | Cheap: your process is woken for a two-field frame. |
| `pingTimeoutMs` | 5000 | Half the interval, so at most one beat is ever outstanding and "missed beats" counts beats rather than overlapping windows. |
| `maxMissedBeats` | 3 | Then `kill()`. |

Three, not one. One missed beat is a GC pause, a `--smol` heap compaction, or the OS descheduling the
process while something else compiles, and killing on it would make the supervisor the leading cause
of plugin restarts. Three consecutive misses spanning 30 seconds is none of those — the event loop is
not turning, and the only thing that reaches a process which will not turn its loop is a kill.

Nonces are random rather than a bare counter. A predictable nonce is one a plugin could answer
*before* it was asked, letting a plugin about to wedge bank a few heartbeats; a pong only counts
against the outstanding nonce, and the outstanding nonce is unguessable. A pong for an unknown or
already-answered nonce is ignored.

## Running: the RSS watchdog

Checked on every beat, against a default cap of **256 MiB** (`rssLimitBytes`). The daemon's entire
pitch against VRCX is a 50-80MB idle footprint; a `--smol` event-handler plugin idles well under
64MB, so this is roughly 4x headroom rather than a tight collar.

**There are two RSS sources and they are not equivalent.** The preference order is not cosmetic:

- **The OS reading for a pid** is a fact about the process, supplied by `readRssBytes(pid)`.
- **`pong.rss`** is a number the *measured party* chose to send, from `process.memoryUsage.rss()`
  inside the prelude.

The OS reading wins whenever a pid and a reader are both available, because the failure mode that
matters most — a plugin whose event loop is wedged while its heap grows — is precisely the one where
the self-reported number stops updating. When the self-reported figure is the only one available (a
worker-backed transport has no pid), it is still enforced, because the common case is an honest plugin
with a leak and catching that is worth doing. What is *not* claimed is that it bounds a hostile
plugin: one that lies about its RSS, or simply stops answering, is caught by the heartbeat instead,
and the real ceiling on a process that will not cooperate is the OS-level cap that fails the
allocation rather than noticing afterwards.

Exceeding the cap is a **kill, not a stop**. A graceful stop is a request that travels over the
plugin's own event loop and is then waited on, and a process over its memory cap is either allocating
in a loop (so it will not yield) or about to be OOM-killed by the OS (so waiting spends the time we
have on a courtesy). Worse, "please exit" handlers allocate, which is the one thing that must not
happen here.

## Logging

Anything you write to stdout is redirected to stderr by the prelude, because stdout is the frame
channel. You can still reach fd 1 through `node:fs`, and the host handles that by treating a stdout
line that does not start with `{` as a log rather than a protocol violation. A line that *does* look
like a frame and fails to decode is reported as a protocol error, because that is evidence about the
peer.

Log output is capped in three ways, none of them negotiable:

| Limit | Value | Effect |
|---|---|---|
| `MAX_LOG_LINE_BYTES` | 2048 | Applied to the incoming byte stream, not an assembled string, so a megabyte with no newline never accumulates. |
| `LOG_BURST_LINES` | 200 | Token bucket, because legitimate logging is bursty — a plugin activating prints a paragraph and then nothing for an hour. |
| `LOG_REFILL_PER_SECOND` | 20 | Sustained rate once the burst is spent. More than a human reads, far less than `for(;;) console.log()` produces. |

The bucket spans both streams together, so you cannot buy budget by switching stream. Suppression is
announced once and the dropped total is reported when it ends, so a dropped log is visible rather than
silent.

## Stopping

Two paths, and the difference is the whole point.

**`stop(graceMs)` — the graceful path**, used at daemon shutdown. The supervisor sends
`lifecycle: shutdown` (best effort, nothing waits on the reply) and then closes your stdin. Closing
stdin is the shutdown signal because there is no portable "please exit" one: on Windows every signal
Bun accepts is a terminate, which would make `graceMs` a fiction on the primary platform. The
prelude's read loop ends on EOF and calls `exit(0)`. Default grace is **3000ms** (`stopGraceMs`);
after that the transport kills, with a 2000ms backstop so that "SIGKILL always works" is not
load-bearing.

**`kill()` — no grace at all**, used by the heartbeat timeout, the RSS watchdog, a failed activation,
and every disable. `SIGKILL` directly.

The exit is reported only after both output streams drain, with a 1000ms deadline. A plugin's last
words are usually on stderr immediately before it dies, and reporting the crash without them makes it
undiagnosable — but a plugin that spawned a grandchild handed it these pipe ends, and the grandchild
can outlive it, so the ordering gets a deadline rather than being held hostage.

## Restart, backoff, and the crash loop

An unexpected exit schedules a restart:

| Threshold | Value |
|---|---|
| `baseBackoffMs` | 1000 |
| `maxBackoffMs` | 60000 |
| `stableAfterMs` | 60000 |
| `crashWindowMs` | 300000 |
| `crashLoopThreshold` | 5 |

The ladder is 1s, 2s, 4s, 8s … doubling to a 60s ceiling, then jittered by the shared helper (up to
+20%) so a machine running several failing plugins does not respawn them all on the same tick. It is
the same ladder as the 429 breaker in `net/rate-limiter.ts`: one backoff policy in the codebase is one
to reason about. 60s is short enough that a plugin waiting on something that recovers — the pipeline,
a file lock — comes back on its own rather than needing a user.

**"Stable" is 60 seconds continuously `running`** — six answered heartbeats. Long enough that the
plugin is demonstrably past its own startup, which is where crash loops live, and short enough that a
plugin failing hourly is not punished with an hour-long backoff for a fault it recovered from. On
reaching it, both the backoff ladder and the crash window reset, so the *next* failure is treated as a
new incident rather than a continuation of the old one.

**Five crashes inside five minutes auto-disables**, with a notification naming the last failure. With
the ladder above, five restarts spend about 31 seconds in backoff, so reaching five inside five
minutes means the plugin genuinely cannot stay up rather than that it was unlucky. Five also tolerates
the two or three restarts a real transient produces — a VRChat outage, a machine waking from sleep —
which a threshold of two would not.

Not every exit restarts. `spawn-failed` disables for the session, and a `shutdown` exit or a `stopping`
state goes straight to `idle`.

## Disabled

`disable()` is **instant, synchronous, and always succeeds**. It awaits nothing — not
`transport.stop()`, not a lifecycle reply, not a store write — because every one of those can be
delayed by the very plugin the user is trying to be rid of. It bumps an epoch counter first, which
invalidates every armed timer and every in-flight `factory()` continuation, then cancels timers, then
`kill()`s (never `stop()`, because `stop()` returns a promise and a promise is a thing a wedged plugin
can hold open). It is safe to call twice, during a start, during a restart, and after the process has
already exited.

Which disables survive a daemon restart:

| Reason | Sticky | Why |
|---|---|---|
| `user` | yes | An unchecked box must stay unchecked. |
| `crash-loop` | yes | Otherwise it is a crash loop with extra steps: the plugin returns enabled, crashes five more times, repeats forever. |
| `protocol-mismatch` | yes | Nothing about a restart changes which protocol the bundle was compiled against. |
| `spawn-failed` | **no** | A locked file or an exhausted handle table is a condition of the moment. Persisting it would permanently disable a plugin over a transient Windows file lock. The halt still holds for this session. |

A user undoes a disable by re-enabling the plugin from its management page, whatever the reason. That
calls `enable()`, which clears the stored record, resets the restart counter and the crash window, and
returns the supervisor to `idle` — it does **not** start the plugin; the registry's `enable(pluginId)`
does both. There is no timer, no cooldown and no automatic recovery: a plugin that auto-disabled stays
off until a person says otherwise.

Automation graphs referencing a disabled plugin's node types are paused and marked unavailable, never
deleted.

## Failure kinds, in one table

`SupervisorFailureKind`, as the management page will show them:

| Kind | Means |
|---|---|
| `spawn-failed` | The transport could not be created at all — bad bundle path, no runtime, EPERM. |
| `hello-timeout` | The process started and never said `hello`. Dead on arrival, not "stopped answering". |
| `protocol-mismatch` | `hello` named a protocol major this host does not speak, or the wrong plugin id. |
| `activate-hung` | `lifecycle: activate` was never answered. The plugin is blocking, not failing. |
| `activate-failed` | `lifecycle: activate` was answered with an error. The plugin's own startup code failed. |
| `heartbeat-lost` | Three consecutive pings went unanswered. |
| `rss-exceeded` | The RSS watchdog saw the process over its cap. |
| `crashed` | It exited on its own. |

## See also

- [protocol.md](./protocol.md) — the frames these mechanisms send and expect.
- [security-model.md](./security-model.md) — what the boundary does and does not claim.
- [cheatsheet.md](./cheatsheet.md) — every threshold on this page in one table.
- [status.md](./status.md) — what exists today and what does not.
