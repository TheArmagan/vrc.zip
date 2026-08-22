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
| Build-time builtin refusal | `import "node:fs"` and `import "fs"`, in the author's own source | **Built** (step 3.5) |
| Install-time deny-scan | Non-literal `import()`, `require`, builtin imports, `process.binding`, `Function(…)`, `eval` of non-literals | **Built** (step 3.5), and weaker than it sounds. See below |
| Content-addressed artifact | A bundle swapped on disk after install | **Built.** Written by the installer, hash verified on every load |
| Process boundary | A crash, a spin loop, a runaway allocation taking the daemon with it | **Built** |
| A scrubbed environment | Inheriting the daemon's environment, and what Windows adds back | **Built** |
| Prelude scrubbing | The easy reach for network and filesystem globals | **Built** |
| Heartbeat and watchdog | A wedged or ballooning plugin running forever | **Built** |
| OS memory cap | A plugin eating the machine before anyone notices | **Built** on Windows and Linux. Not on macOS, deliberately |
| Scope gate | A plugin calling what it was not granted | **Built** (step 3.4) |
| Per-plugin rate budget | A plugin spending the user's account into a moderation problem | Built, and dormant: every budgeted scope is a write, and no write is reachable yet |
| Dry-run shadow on outbound actions | A new plugin inviting or moderating on your behalf | The seam exists (`isShadowed`); the actions it guards do not exist yet (step 3.8) |
| Consent | Granting anything at all | **Not built** (step 3.8) |
| OS sandbox (AppContainer, seccomp) | Filesystem and network reach at the kernel | Not built, and not scheduled |

Two honest readings of that table, and the second matters more than the first.

The layers which contain *accidents* are built, and the one layer that decides what a plugin may ask
for at all, consent, is not. Everything below the scope gate is enforcement machinery waiting for a
grant that no screen can yet produce.

And **none of the built layers is a barrier to a determined author.** The scan is syntax, the prelude
is hygiene, and the process boundary is containment rather than confinement. What they buy is that a
plugin doing something dangerous had to go out of its way, in a form a reviewer can see. That is
worth having and it is not a sandbox.

## The deny-scan catches syntax, and only syntax

The install pipeline compiles your source with `Bun.build` and then parses the *bundled output* with
the TypeScript compiler API, refusing six constructs: a dynamic `import()` whose specifier is not a
literal, an import of a `node:`/`bun:`/bare builtin, any reference to `require`, `process.binding`,
`Function(…)` or `new Function(…)`, and `eval` of anything that is not a string literal.

**Read the next paragraph before you form an opinion of how strong that is.**

Every one of these was run against the real scanner and every one of them **passes**:

```js
({}).constructor.constructor("return globalThis")()   // Function, without naming Function
Object.getPrototypeOf(function(){}).constructor       // the same reach, spelled differently
globalThis["pro" + "cess"]["bind" + "ing"]("fs")      // process.binding, assembled at run time
const r = ["req", "uire"].join(""); globalThis[r]     // require, assembled at run time
import.meta.url                                       // where the artifact lives on disk
process.env.VRCZIP_STATE_DIR                          // a plain property read
fetch("https://evil.example/")                        // there is no rule for fetch at all
```

Two of those deserve to be said plainly rather than left in a code block.

**The `new Function` rule is a convenience, not a gate.** `constructor.constructor` reaches the
`Function` constructor from any object or function value in the language, and no scan over syntax can
close that without rejecting normal code.

**A string-literal `eval("…")` is deliberately allowed**, because it is exactly as powerful as
writing the literal out, so a scan-clean bundle can still contain an `eval`.

**There is no rule for `fetch`, `WebSocket` or `XMLHttpRequest`**, and that is correct only for
exactly as long as the prelude really removes them. If the prelude ever stops removing one, nothing
at install will notice.

So the accurate description of the scan is: **it makes cheap attacks fail loudly at install, with a
line and column and a sentence the user reads, instead of silently at 3 AM.** It is not a proof of
anything. What actually provides isolation is the process boundary, the prelude scrubbing globals,
and the scrubbed environment. The scan is the layer that makes the lazy version of an attack
embarrassing, and that is its whole claim.

One thing it genuinely does close, and worth knowing because the mechanism is not the obvious one:
`import("node:" + "fs")`, the hostile plugin's signature attack, never reaches the scan at all. Bun
constant-folds the concatenation while bundling, so it hits the build-time resolver and fails at
*compile*. The `dynamic-import` rule therefore guards a different shape, `import(name)` where `name`
is a genuine runtime value, than the one you might expect it to.

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

**Windows has an OS memory cap now.** It is a Job Object, created per plugin process through
`bun:ffi` into kernel32: `CreateJobObjectW`, `SetInformationJobObject`, `OpenProcess` on the pid Bun
returns, `AssignProcessToJobObject`. The 144-byte `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` struct is
asserted byte by byte by offset in the tests, because a wrong offset is the failure that returns
success and caps nothing.

Three properties of it are worth knowing before you rely on it:

- **The limit is `ProcessMemoryLimit`, which is committed memory** rather than resident memory or
  reserved address space. That makes it a much closer match to the number a human has in mind than
  Linux's `RLIMIT_AS`, which counts JavaScriptCore's large untouched virtual reservations and so has
  to be set at a generous multiple of the intended RSS. On Windows the figure can be roughly the
  figure.
- **Crossing it reads as a crash, not as a kill.** The allocation is refused inside the plugin, JSC
  raises `RangeError: Out of memory`, and the process exits 1 on its own. Nothing signals it and
  nothing terminates it, so the failure arrives as `crashed` and goes on the restart ladder like any
  other crash.
- **Every failure path falls back to the RSS watchdog** rather than refusing to start the plugin, and
  says so once per daemon process. A later bound is a worse outcome than no plugin at all, but it is
  not a silent one.

There is a genuine window between `Bun.spawn` returning and the job assignment during which the child
is uncapped, because a job object needs a pid and therefore cannot exist before the process does. It
is microseconds, before the runtime has finished starting.

**`env: {}` on Windows is a merge, not a replacement**, and this is the finding that most needed
correcting. Bun synthesises eleven variables (`PATH`, `SYSTEMROOT`, `WINDIR`, `SYSTEMDRIVE`, `TEMP`,
`HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`) and *adds* them to
whatever you pass. Passing an explicit minimal dictionary does not remove them; the only way to get
rid of one is to supply your own value, and the empty string is that value.

**Nothing secret was ever leaking through this, and it should not be described as a credential
leak.** `VRCZIP_STATE_DIR`, the daemon's session token and the developer's shell were all measured
absent. What leaked was disclosure: the user's account name, their home directory, their domain
controller, and in `PATH` an inventory of every tool installed on the machine.

The spawn now passes an explicit environment that keeps four things and blanks the rest:
`SystemRoot` and `windir` (the Windows loader and CNG resolve system DLLs and crypto configuration
relative to them; `bun` does not start without them), `SystemDrive`, and `TEMP`/`TMP` pointed at
**the plugin's own data directory** rather than the user's temp folder. That directory is already the
process's working directory, so the plugin learns nothing new, its temp files stay inside the one
place it may write, and the user's profile path is never spelled out. A blank `PATH` has teeth of its
own: a plugin reaching for `Bun.spawn(["git", …])` now resolves nothing.

On every other platform `env: {}` is honest, because POSIX `execve` takes the block it is given.

**macOS gets no cap deliberately.** Darwin accepts `RLIMIT_AS` and ignores it, and a cap that only
looks enforced is worse than none, so it is not applied. macOS is not a v1 platform.

**Linux caps address space** via `ulimit -v` applied through an `exec` that preserves the pid the
watchdog needs. Note that `RLIMIT_AS` bounds virtual address space rather than resident memory, so
the number set there is deliberately a multiple of the RSS actually intended.

## What is designed to protect *other people* from your plugins

This half is about the account rather than the machine, and more of it exists.

**The strongest thing protecting other people today is that a plugin cannot act on them at all.**
`ctx.vrchat` ships reads only: accounts, friends, users, worlds, instances, groups. Outbound social
actions, invites, moderation and friend requests, are not in the surface and are not reachable by any
spelling. They land with step 3.8, together with the consent gesture that ungates them, because
shipping the actions before the thing that lifts their dry-run would mean shipping them either
permanently dry-run or permanently ungated.

**Outbound social actions are dry-run by default** (designed, seam built, not yet exercised). `invite:send`, `moderation:write` and friend
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
against the shared limiter and runs at low priority, so plugin traffic can never starve presence, a
re-auth, or something you just clicked. On top of that sits a rolling hourly volume budget, which is
the same mechanism third-party app grants use, keyed by plugin id instead of grant id.

Worth knowing rather than reading a green test as evidence: **the volume budget is dormant.** It is
budgeted on three scopes, `invite:send`, `friends:write` and `groups:invite`, all of which are
writes, and no write is reachable on a reads-only surface. It is wired and tested and bites nothing
yet. The shared limiter, which is the part that matters right now, is live on every call.

**Accounts are chosen at consent, not implied.** A plugin asking for `friends:read` does not get it
for all six of your accounts; you pick. The gate enforces this on every call: naming an account
outside the grant is `E_ACCOUNT_DENIED`, naming none when the grant covers exactly one resolves to
that one, and naming none when it covers several is refused as a bad request rather than guessed.
Picking "the first of six" would mean traffic going out as whichever account happened to sort first,
which is not something anyone consented to.

**The gate reads the grant, never the manifest.** The manifest is what the author requested; the
grant is what the person at the consent screen approved, which is narrower whenever they unticked
something. `protocol.ts` is structurally unable to import `manifest.ts`, so nothing on the call path
can consult the request by accident.

## Signing and trust tiers

Ed25519 detached signatures with a publisher key registered once. Without signing, "install this
plugin" means "run this executable", and the local case is exactly where that matters — signing is
not waiting on a registry to be worth having.

**There is no registry in v1**, on purpose. A registry is a service to host, moderate and take down
from. A plugin is installed from a local path or from a git URL pinned to a commit, which gives
authors distribution without asking anyone's permission while keeping what ran auditable afterwards.

A plugin does not declare its own trust tier. The tier is derived at install from whether a signature
verified, and the unsigned tier gets a hold-to-confirm on the sentence at the top of this page.

> [!WARNING]
> **None of this paragraph is implemented.** The manifest parses a `signing` block and nothing
> verifies it. Signature checking and the trust tier both belong to step 3.8 rather than to the
> install pipeline: verification is an install-time gate, but a tier only means anything at consent,
> which is where the hold-to-confirm lives. The install pipeline deliberately decides no trust at
> all. It compiles, scans, content-addresses and verifies the artifact back off disk, and returns
> what it built. "We compiled it" and "you agreed to run it" are different facts and only the first
> is the pipeline's to assert.
>
> The pipeline also takes **a local directory only** right now. The pinned git URL is a fetch step in
> front of an otherwise identical pipeline and has not been built.

## If you are auditing this

The deliberately hostile plugin lives at `daemon/src/plugins/hostile/`. Each file is one attack with
its reasoning written down: a spin loop, a memory bomb, three routes to the filesystem, an event
flood, a lifecycle hook that never resolves, and forged host-only frames. There is also a polite
control, because a supervisor that kills everything would otherwise pass every test in the directory.

Its suite asserts **which layer** rejected each attack, not merely that something did. That
distinction was learned the hard way: `import("node:" + "fs")`, the signature attack, turns out to be
caught by the bundler constant-folding the concatenation rather than by the deny-scan it was written
to exercise. A test asserting only "rejected" would have gone green while the rule it was aimed at
was never reached. Where **nothing** stops an attack, the test says so in as many words rather than
asserting a boundary that does not exist.

If you find a way through that is not already written down on this page, that is a finding worth
reporting rather than a curiosity.
