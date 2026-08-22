# What actually works today

This page exists because the rest of the documentation describes a contract, and a contract is not a
running system. Everything below is checked against the code in this repository rather than against
the plan, and it is the page to distrust the others from.

Phase 3 is being built in the order `PLAN.md` §"Plugin build order" sets out. The numbering matches
the Phase 3 checklist in `PROGRESS.md`.

## The short version

You can **write** a plugin's manifest today and have it validated. You can **read** the exact
vocabulary your UI and your graph nodes will speak. You **cannot install one, and you cannot run
one**, because the pieces between "here is a bundle" and "here is a running plugin with an API" are
not built.

If you are here to ship something this week, this is not ready for you. If you are here to design
against a contract that is settled, most of it is.

## Step by step

| Step | What it is | State |
|---|---|---|
| 3.1 | `@vrcz/plugin-api` types — manifest, protocol, UI, nodes | **Done.** Published surface, 124 tests |
| 3.2 | `ProcessTransport` + supervisor | **Done.** Spawn, frame, heartbeat, watchdog, backoff, auto-disable |
| 3.3 | The deliberately hostile plugin | **Partial.** The attacks are written; they are not yet driven as a suite |
| 3.4 | Dispatcher, scope gate, rate budget | Not started |
| 3.5 | Install pipeline (`Bun.build`, deny-scan, content-addressing) | Not started |
| 3.6 | Events bridge (filters, credit windows, batching) | Not started |
| 3.7 | Storage (one SQLite file per plugin) | Not started |
| 3.8 | Consent and management UI | Not started |
| 3.9 | Declarative UI renderer | Not started |
| 3.10 | Node registration | Not started |
| 3.11 | Scaffolder and generated docs | Not started |

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

**The process.** The daemon can spawn a plugin with `Bun.spawn`, `env: {}` and `--smol`, inject a
prelude that answers heartbeats on the plugin's behalf, frame newline-delimited JSON both ways with a
byte cap enforced on arrival, cap and rate-limit logs, supervise it (missed beats, RSS, activation
deadlines), restart it with jittered backoff, auto-disable a crash loop durably, and kill it when it
will not stop. See [lifecycle.md](./lifecycle.md).

**The database.** Installed plugins, immutable grants keyed by `(pluginId, version, grantHash)`,
dry-run lift records, and crash history all have tables and queries.

## What is missing, concretely

**There is no installer.** Nothing builds your source into the content-addressed artifact the loader
expects, and nothing runs the AST deny-scan. You cannot get a bundle into `plugins/<id>/`.

**There is no `ctx`.** The API a plugin calls — `ctx.vrchat`, storage, the webhook and fetch
capabilities — does not exist. The dispatcher, the scope gate and the per-plugin rate budget are step
3.4.

**Lifecycle frames are not dispatched to your code.** The host sends `lifecycle` frames and the
prelude forwards them, but nothing turns one into a call to an exported `activate()`. What exists
instead is a raw seam: the prelude installs a non-enumerable `globalThis.__vrczHost` with `send`,
`onFrame` and `log`. That is deliberately low-level plumbing for the runtime that will sit on top of
it, not an API to write a plugin against — it will change.

**Events do not reach plugins.** The bus is not bridged, so no subscription you declare is honoured
yet.

**There is no consent screen**, so there is no way for a user to grant anything, which is the reason
none of the above can be exercised end to end even if it existed.

**There is no renderer**, so a `UINode` tree has nothing to draw it.

## Known limits of the isolation

Read [security-model.md](./security-model.md) in full before you assume anything about this. The
short form, so nobody is surprised:

- A prelude **cannot** disable the `import()` operator. `await import("node:" + "fs")` reaches the
  filesystem today. The defence that is meant to stop it is the install-time deny-scan, which is not
  built.
- The OS-level memory cap is real on Linux and **not implemented on Windows**, which is the primary
  platform. The RSS watchdog is what stands in for it, and a watchdog notices rather than prevents.
- `env: {}` is not honoured on Windows; Bun synthesises a minimal environment block.

Until process plus OS-level sandboxing lands, the honest description is the one `PLAN.md` insists
on: **plugins run with your account's privileges. Only install plugins you trust.**
