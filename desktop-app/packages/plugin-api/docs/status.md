# What actually works today

This page exists because the rest of the documentation describes a contract, and a contract is not a
running system. Everything below is checked against the code in this repository rather than against
the plan, and it is the page to distrust the others from.

Phase 3 is being built in the order `PLAN.md` §"Plugin build order" sets out. The numbering matches
the Phase 3 checklist in `PROGRESS.md`.

## The short version

Most of the machine is now built and **none of it is reachable from the app.**

A plugin can be compiled, scanned, content-addressed and installed to disk by the install pipeline. A
plugin process can be spawned, supervised, memory-capped and killed. A call from a plugin can be
parsed, scope-checked, account-checked, budgeted and answered against a real read API for friends,
users, worlds, instances and groups. All of that has tests and all of it works.

What none of it has is a way in. `daemon/src/app.ts` is the composition root, and it constructs **no
plugin subsystem at all**: no registry, no dispatcher, no install route. There is also no consent
screen, so there is no grant, and the dispatcher refuses every call from a plugin without one. The
subsystems run under their own tests and nowhere else.

So: you can read this page and design against a contract that is now largely settled and largely
implemented. You cannot install a plugin from the app, and you cannot run one from the app, and the
last mile is 3.8 rather than anything on this page.

## Step by step

| Step | What it is | State |
|---|---|---|
| 3.1 | `@vrcz/plugin-api` types — manifest, protocol, UI, nodes | **Done.** Published surface |
| 3.2 | `ProcessTransport` + supervisor | **Done.** Spawn, frame, heartbeat, watchdog, backoff, auto-disable, OS memory cap on Windows and Linux, a scrubbed environment |
| 3.3 | The deliberately hostile plugin | Seven attacks and a polite control live in `daemon/src/plugins/hostile/`. The suite asserts **which layer** stopped each one, and says so plainly where nothing did |
| 3.4 | Dispatcher, scope gate, rate budget | **Done as a subsystem.** Not constructed by `app.ts`, so nothing calls it |
| 3.5 | Install pipeline (`Bun.build`, deny-scan, content-addressing) | **Done as a subsystem.** Local directory only; no signature check; no route or UI reaches it |
| 3.6 | Events bridge (filters, credit windows, batching) | Not started |
| 3.7 | Storage (one SQLite file per plugin) | Not started |
| 3.8 | Consent and management UI, signing, outbound actions | Not started. **This is the step that makes any of the above reachable** |
| 3.9 | Declarative UI renderer | Not started |
| 3.10 | Node registration | Not started |
| 3.11 | Scaffolder and generated docs | Not started |

"Done as a subsystem" is doing real work in those two rows. It means the module exists, is tested,
and would behave as documented if something called it. Nothing does.

## What is real, concretely

**The manifest.** `parseManifest` validates a `vrcz-plugin.json` against a Zod schema, rejects
unknown keys, checks every scope against the shared registry, refuses a `network` permission and
points at its two replacements, and refuses wildcards in a fetch allowlist. `grantHash` is
implemented and stable. See [manifest.md](./manifest.md).

**The wire protocol.** Twelve frame types, a sender table that makes direction a validated property
rather than a convention, absolute deadlines, a typed error taxonomy, and the backpressure model
(filters, credit windows, overflow policies, the `dropped` frame). `parseEnvelope` never throws on
hostile input. See [protocol.md](./protocol.md).

**The UI vocabulary.** The full `UINode` union with `validateUINode`, depth and count caps. The
*renderer* that would draw it does not exist. See [ui.md](./ui.md).

**The node model.** Port types, the two widening rules, `assignable`, config schemas, the body
template, trigger inversion, and the definition hash. Nothing registers them yet. See
[nodes.md](./nodes.md).

**The process.** The daemon can spawn a plugin with `Bun.spawn`, a scrubbed environment and `--smol`,
inject a prelude that answers heartbeats on the plugin's behalf, frame newline-delimited JSON both
ways with a byte cap enforced on arrival, cap and rate-limit logs, supervise it (missed beats, RSS,
activation deadlines), impose an OS memory cap on Windows and Linux, restart it with jittered
backoff, auto-disable a crash loop durably, and kill it when it will not stop. See
[lifecycle.md](./lifecycle.md).

**The install pipeline.** A local plugin directory goes in and a verified content-addressed artifact
comes out, in five steps: parse `vrcz-plugin.json` through the published schema, compile with
`Bun.build` under a resolver that refuses host builtins, deny-scan the *bundled output*, write it to
`plugins/<id>/<sha256>.js`, then read it back off disk through the same loader the spawn path uses.
Every failure is a value with a stage and a sentence, never a throw. It takes a local directory only,
verifies no signature, decides no trust, and writes nothing to the database.

**The dispatcher and the scope gate.** One route between a plugin and the host, in a fixed order:
grant, in-flight cap, method lookup, deadline, scope, account, budget, charge, invoke. Default deny
at every step. A handler is handed parsed parameters and nothing it could check a scope with, so
"never the handlers" is structural rather than a convention.

**`ctx.vrchat`, reads only.** Eight methods: `vrchat.accounts.list`, `vrchat.friends.list`,
`vrchat.users.get`, `vrchat.worlds.get`, `vrchat.worlds.search`, `vrchat.instances.get`,
`vrchat.groups.get`, `vrchat.groups.list`. Each returns a small hand-written projection rather than
VRChat's own shape, goes through the account's rate limiter tagged with the plugin id at low
priority, and caches on `(accountId, path)` and never on the path alone.

**The database.** Installed plugins, immutable grants keyed by `(pluginId, version, grantHash)`,
dry-run lift records, and crash history all have tables and queries.

## What is missing, concretely

**Nothing constructs any of it.** This is the headline. `app.ts` wires no plugin registry, no
dispatcher and no install route, so the install pipeline has no caller and the dispatcher has no
transport attached to it. Opening that seam also needs a small change on the supervisor, which
forwards unowned frames outward but keeps its transport private.

**There is no consent screen**, so no grant exists, so the dispatcher would refuse every call anyway.
This is why 3.8 rather than 3.4 or 3.5 is the step that turns the lights on.

**Lifecycle frames are not dispatched to your code.** The host sends `lifecycle` frames and the
prelude forwards them, but nothing turns one into a call to an exported `activate()`. What exists
instead is a raw seam: the prelude installs a non-enumerable `globalThis.__vrczHost` with `send`,
`onFrame` and `log`. That is deliberately low-level plumbing for the runtime that will sit on top of
it, not an API to write a plugin against, and it will change.

**There is no outbound half of `ctx.vrchat`.** Invites, moderation and friend requests are not in the
surface. They land with 3.8, because the gesture that lifts their dry-run is a consent gesture.

**There is no storage, no webhook and no fetch capability.** The manifest validates all three and
nothing implements any of them.

**Events do not reach plugins.** The bus is not bridged, so no subscription you declare is honoured
yet.

**There is no renderer**, so a `UINode` tree has nothing to draw it.

**There is no signature verification** and no trust tier, and the install source is a local directory
only.

**A packaged build cannot run plugins.** The runtime fetcher exists, but its hash pin table ships
empty on purpose, and an unpinned platform refuses to download rather than run an executable nobody
vouched for. The hashes come from a packaging step that does not exist yet. From a source checkout
the daemon is already running under a real `bun` and uses that.

## Known limits of the isolation

Read [security-model.md](./security-model.md) in full before you assume anything about this. The
short form, so nobody is surprised:

- **The deny-scan catches syntax and only syntax.** A `constructor.constructor` chain, a computed
  `globalThis["pro"+"cess"]["bind"+"ing"]`, a `require` assembled from an array join,
  `import.meta.url`, `process.env`, and a plain `fetch(…)` all pass it today. It makes cheap attacks
  fail loudly at install; it is not stronger than that, and the page above lists exactly what gets
  through.
- **A prelude cannot disable the `import()` operator.** It is syntax. What closes the obvious form is
  the build-time resolver and the install-time scan, not the prelude.
- **What actually provides isolation** is the process boundary, the prelude scrubbing globals, and
  the scrubbed environment. Not the scan.
- The OS memory cap is now real on **both** primary platforms. On Windows, crossing it surfaces as a
  crash (`RangeError: Out of memory`, exit 1) rather than as a kill.
- `env: {}` on Windows is a **merge**, not a replacement: Bun synthesises eleven variables and adds
  them to whatever you pass. The spawn now keeps four and blanks the rest. Nothing secret was ever
  reaching a plugin through this; what did was the account name, the home directory, the domain
  controller and a `PATH` inventorying installed tooling.

Until process plus OS-level sandboxing lands, the honest description is the one `PLAN.md` insists
on: **plugins run with your account's privileges. Only install plugins you trust.**
