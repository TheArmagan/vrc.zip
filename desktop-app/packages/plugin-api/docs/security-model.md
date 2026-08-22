# The security model, stated bluntly

This page is deliberately unflattering. `PLAN.md` correction 6 says not to call this a security
sandbox until it is one, and the way that commitment is kept is by writing down what does not hold
as carefully as what does.

> [!WARNING]
> **Plugins run with your account's privileges. Only install plugins you trust.**
>
> This is the accurate description of the system today, and it is what the consent screen will say.
> Everything below is the detail behind that sentence.

## What a plugin can do to you

A plugin runs as a child process of the daemon, on your machine, as you. Today it can reach the
filesystem, and through the filesystem it can reach the database that holds your VRChat session
cookies. That is not a hypothetical: it is the first thing the deliberately hostile plugin in this
repository does, and there is a passing test asserting it works.

Read that again before you install anything from someone you do not know.

## Why a child process and not a Worker

The original design assumed a Bun `Worker` was an isolation boundary. It is not one.

A worker gets its own `globalThis`, and that is where the isolation stops. It keeps `process`, `Bun`,
`fetch` and full `node:*` access. A prelude can scrub globals, and this one does, but **`import()` is
an operator rather than a global**, so no amount of scrubbing removes it:

```js
const fs = await import("no" + "de:" + "fs");   // works, today
```

Bun also has no `resourceLimits` for workers, no `--no-addons`, and no permissions flag, so a worker
cannot be memory-capped, and `terminate()` is not documented to preempt a synchronous spin loop.

A process buys four things a worker cannot: a real memory cap where the OS provides one, a `kill(9)`
that always wins, crash containment, and — the one that matters most in the long run — it is the only
granularity from which OS-level sandboxing (AppContainer on Windows, seccomp on Linux) becomes
reachable **without changing the plugin API by one character**.

## The layers, and which of them exist

| Layer | What it stops | State |
|---|---|---|
| Install-time deny-scan | Non-literal `import()`, `require`, `node:`/`bun:` imports, `eval` of non-literals | **Not built** (step 3.5) |
| Content-addressed artifact | A bundle swapped on disk after install | Path and hash column exist; the installer that writes them does not |
| Process boundary | A crash, a spin loop, a runaway allocation taking the daemon with it | **Built** |
| `env: {}` | Inheriting the daemon's environment | Built, with a Windows caveat below |
| Prelude scrubbing | The easy reach for network and filesystem globals | **Built** |
| Heartbeat and watchdog | A wedged or ballooning plugin running forever | **Built** |
| OS memory cap | A plugin eating the machine before anyone notices | Linux only |
| Scope gate | A plugin calling what it was not granted | **Not built** (step 3.4) |
| Consent | Granting anything at all | **Not built** (step 3.8) |
| OS sandbox (AppContainer, seccomp) | Filesystem and network reach at the kernel | Not built, and not scheduled |

The honest reading of that table is that the layers which contain *accidents* are built, and most of
the layers that would contain *malice* are not.

## What the prelude actually removes

Measured by running it, not by assuming. Removed or emptied: `fetch`, `WebSocket`,
`XMLHttpRequest`, `EventSource`, `navigator`, `Worker`, `eval`, `require`; the dangerous members of
`Bun` (`spawn`, `spawnSync`, `file`, `write`, `$`, `connect`, `listen`, `serve`, `udpSocket`,
`dlopen`, `FFI`, `unsafe`, `which`, `secrets`, `s3`, `redis`, `embeddedFiles`, and the std streams);
`process.binding`, `process.dlopen`, `process.getBuiltinModule`, `process.chdir`, `process.kill`; and
`process.env` is emptied. `console.*` and `process.stdout.write` are redirected to stderr so stdout
carries frames only.

What it cannot remove, each verified rather than assumed:

- **`import()`**, as above. It is syntax.
- **`globalThis.Bun` itself** is `writable: false, configurable: false`. It survives assignment,
  `delete` and `defineProperty`, so its members are scrubbed individually instead.
- **`Function`** is reachable through `(function(){}).constructor`, so `new Function(...)` is
  available even with `eval` gone.

## Platform caveats

**Windows has no memory cap.** A Job Object needs `CreateJobObject`, `OpenProcess` and
`SetInformationJobObject` through `bun:ffi` with a hand-marshalled 144-byte struct, where a mistake
crashes the daemon rather than the plugin. It is not implemented; the daemon warns once and falls
back to the RSS watchdog, which notices rather than prevents. Windows is the primary platform, so
this is the headline gap.

**Windows does not honour `env: {}`.** Bun synthesises a minimal block (`PATH`, `SYSTEMROOT`, `TEMP`,
`USERNAME`, `USERPROFILE` and similar). Nothing the daemon holds leaks, but your account name does.
The prelude empties `process.env` immediately afterwards, which closes it for anything reading the
variable rather than the OS block.

**macOS gets no cap deliberately.** Darwin accepts `RLIMIT_AS` and ignores it, and a cap that only
looks enforced is worse than none, so it is not applied.

**Linux is the only platform with a real cap**, via `ulimit -v` applied through an `exec` that
preserves the pid the watchdog needs.

## What is designed to protect *other people* from your plugins

This half is about the account rather than the machine, and more of it exists.

**Outbound social actions are dry-run by default.** `invite:send`, `moderation:write` and friend
requests are the calls other people see, and they are how a plugin gets *you* reported or banned. A
new plugin's calls under those scopes are logged and attributed but not sent, and dry-run is lifted
by an explicit gesture per plugin and per scope, with the dry-run log beside it as the evidence.
Never on a timer: "it has behaved for seven days" says nothing about the eighth. Never per action
either, because a stream of dialogs whose only rational answer is "always allow" is consent theatre.

**Grants are keyed by `(pluginId, version, grantHash)` and immutable.** An update that asks for more
produces a key that was never approved, so it re-prompts by construction rather than by a check
somebody has to remember to write. Reinstalling an older version cannot inherit a broader grant a
later version was given.

**The rate budget is per plugin.** A plugin polling too hard gets *you* rate-limited or moderated,
and you would blame vrc.zip rather than the plugin. Every plugin call is tagged with the plugin id
against the shared limiter, with a subordinate per-plugin budget and a UI naming who is spending it.

**Accounts are chosen at consent, not implied.** A plugin asking for `friends:read` does not get it
for all six of your accounts; you pick.

## Signing and trust tiers

Ed25519 detached signatures with a publisher key registered once. Without signing, "install this
plugin" means "run this executable", and the local case is exactly where that matters — signing is
not waiting on a registry to be worth having.

**There is no registry in v1**, on purpose. A registry is a service to host, moderate and take down
from. A plugin is installed from a local path or from a git URL pinned to a commit, which gives
authors distribution without asking anyone's permission while keeping what ran auditable afterwards.

A plugin does not declare its own trust tier. The tier is derived at install from whether a signature
verified, and the unsigned tier gets a hold-to-confirm on the sentence at the top of this page.

## If you are auditing this

The deliberately hostile plugin lives at `daemon/src/plugins/hostile/`. Each file is one attack with
its reasoning written down: a spin loop, a memory bomb, three routes to the filesystem, an event
flood, a lifecycle hook that never resolves, and forged host-only frames. There is also a polite
control, because a supervisor that kills everything would otherwise pass every test in the directory.

If you find a way through that is not already written down on this page, that is a finding worth
reporting rather than a curiosity.
