# Getting started

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
> Not built: outbound actions, the UI renderer, and nodes. Lifecycle dispatch and the `ctx` object
> (`ctx.vrchat`, `ctx.storage`, `ctx.events`) now exist — `definePlugin` from
> `@vrcz/plugin-api/runtime`, which your bundle carries rather than the host injecting.
>
> These pages document what is **real today** and mark clearly what is not. Read
> [status.md](./status.md) for the line-by-line breakdown before you build anything you are relying
> on.

This page is the shape of a plugin: what one is, where it lives, what you write, and — stated
plainly, because it is the part that will waste your afternoon otherwise — which of those parts the
host actually does something with today.

## What a plugin is

A plugin is **a separate OS process** running your JavaScript, talking to the daemon over
newline-delimited JSON on its stdio. It is not a module loaded into the daemon, and it is not code
running in the UI page.

Four consequences worth internalising before you design anything:

- **You do not make network calls.** `fetch`, `WebSocket`, `XMLHttpRequest` and `EventSource` are
  removed from your global scope. Everything that reaches the network is executed by the host, so it
  can be rate-limited against the user's VRChat account, scope-checked, and logged. The two narrow
  replacements are the `webhook` and `fetch:allowlist` capabilities.
- **You do not touch the DOM.** Plugin UI is a JSON tree of nodes that the host renders with its own
  components. There is no escape hatch, and that is a commitment rather than an oversight — the host
  page holds the session token, so any plugin JS in that page could call the whole API with every
  scope. See [ui.md](./ui.md).
- **You do not talk to VRChat directly.** You call a semantic host API, not VRChat's REST shapes, and
  never the byte-faithful mirror on `:7774`. Routing plugins through the mirror would double
  rate-limit consumption for no benefit and weld the plugin API to VRChat's response shapes forever.
- **You do not choose which accounts you get.** Your manifest requests `one` or `many`; the user
  picks at the consent screen. There is no way to spell "all accounts".

**This is not a security sandbox, it is not going to become one, and the docs will not call it
one.** OS-level confinement was cut from the plan rather than postponed, so "yet" would be the wrong
word. A plugin runs with your user account's privileges and can reach your filesystem. What the built
layers do give you: the code is compiled, scanned and content-addressed before it runs, its hash is
re-checked on every load, the process it runs in is memory-capped and killable, and what it may ask
the daemon for is gated by scope and account. The install-time deny-scan catches syntax and only
syntax, and a determined author walks around it in one line. Together they raise the cost of
misbehaving and make it visible. They do not make it impossible. Only install plugins you trust.
[security-model.md](./security-model.md) is the blunt version, and it lists exactly what gets through.

## Where a plugin lives on disk

Everything hangs off one state directory (`daemon/src/paths.ts`):

| Platform | State directory |
|---|---|
| Windows | `%LOCALAPPDATA%\vrc.zip` |
| Linux | `$XDG_STATE_HOME/vrc.zip`, else `~/.local/state/vrc.zip` |
| macOS | `~/Library/Application Support/vrc.zip` (not a supported platform in v1) |

`VRCZIP_STATE_DIR` redirects the whole tree, which is what you want for any experiment — it keeps a
smoke test away from the real credential store.

Inside it:

```
<state>/
  plugins/<id>/<sha256>.js     the installed artifact, named by its own hash
  plugin-data/<id>/            your data directory, and your process's working directory
  plugin-data/<id>/plugin.sqlite   your own database, once storage exists
  runtime/bun-<version>/bun.exe    the pinned runtime plugin processes are spawned with
```

Two properties fall out of that layout:

- **The artifact is content-addressed and its hash is verified on every load**, so a tampered file
  cannot be loaded under the name it was installed as — the name *is* the hash. An update leaves the
  old artifact in place under its own name, which is what makes a rollback a rename rather than a
  rebuild.
- **Code and data are separate trees.** Uninstall is `rm -rf` on the code; keeping your data across
  an uninstall-reinstall is then a decision someone makes rather than an accident of layout. It is
  also what lets your quota be a `stat` on one directory.

Your *source* project lives wherever you like. v1 has no registry: a plugin is installed from a local
path or from a git URL pinned to a commit.

## The file layout of a plugin project

Nothing here is enforced except the two rules the manifest states: `main` is a relative path inside
the plugin folder, and the manifest file is `vrcz-plugin.json` at its root.

```
friend-notes/
  vrcz-plugin.json     the manifest — the only file that must exist
  package.json         your own deps and scripts
  tsconfig.json
  src/
    index.ts           `main` points here
  assets/
    icon.png           `icon` points here; a relative path, never a URL
```

`main` may point at TypeScript. The install pipeline compiles it with `Bun.build` (`target:
"browser"`, `external: []`), deny-scans the *bundled output*, writes the content-addressed artifact,
and then reads it back off disk through the same loader the spawn path uses before it will call the
install a success. You ship source; the host decides what runs.

**Importing a host builtin is a hard build error, in both spellings.** `import { readFileSync } from
"node:fs"` and `from "fs"` both fail the install, naming your own source file. Worth saying
explicitly because it is *not* what `target: "browser"` does on its own: measured on Bun 1.4.0, that
setting silently **stubs** node builtins, compiling the import away to `var { readFileSync } = (() =>
({}));`. That is the worst of both worlds, since the import is gone from the output and your plugin
gets `undefined` where it expected a function. A resolver plugin runs before the stubbing and turns
it into the refusal it should have been.

## Writing `vrcz-plugin.json`

### 1. Identity

```json
{
  "id": "acme.friend-notes",
  "name": "Friend Notes",
  "version": "1.0.0",
  "publisher": "Acme",
  "main": "src/index.ts",
  "engines": { "pluginApi": 0 }
}
```

That is a complete, legal manifest — id, name, version, publisher, entry point, protocol major, and
nothing else. Everything else has a safe default.

Pick `id` carefully. It is the key for your grants, your data directory, and your artifact path, so
changing it later is not a rename: it is a new plugin that the user has to approve again, with an
empty database.

`engines.pluginApi` is the **protocol major, as a bare integer** — in this build, `0`. Not a semver
range, not the vrc.zip version. A range is rejected outright; see
[manifest.md#engines](./manifest.md#engines) for why.

### 2. Permissions

Ask for the least that makes your plugin work, and expect to justify each line to somebody reading a
consent screen.

```json
"permissions": {
  "scopes": ["friends:read", "users:read", "sessions:read"],
  "accounts": { "mode": "many", "optional": false, "reason": "Notes are kept per account." },
  "events": ["friend.online", "friend.offline", "gamelog.player_join"],
  "capabilities": ["storage", "notify", "webhook", "fetch:allowlist"],
  "fetch": { "domains": ["api.example.com"], "reason": "Looks up world metadata for a note." }
}
```

Four things the schema will check that are easy to get wrong:

- Unknown top-level keys are **rejected**, not ignored. `"capabilties"` fails the install rather than
  quietly granting nothing.
- `permissions.network` does not exist, in either spelling. Use `webhook` or `fetch:allowlist`.
- `fetch.domains` and the `fetch:allowlist` capability are checked in both directions: one without
  the other is an error. No wildcards.
- A VRChat scope with `accounts.mode: "none"` is an error, because it would be a permission granted
  for no effect. The three native scopes (`sessions:read`, `sessions:unlinked`, `webhooks:write`) are
  exempt — they gate data vrc.zip derived from local log files, not anything belonging to an account.

### 3. Contributions

What you add to the app's surface: panels, settings, commands, node types.

```json
"contributes": {
  "panels": [{ "id": "notes", "title": "Notes", "placement": "sidebar" }],
  "settings": [
    { "key": "digest-url", "type": "url", "label": "Daily digest webhook" }
  ],
  "commands": [{ "id": "export", "title": "Export notes" }],
  "nodes": [{ "id": "note-added", "title": "Note added", "category": "Notes" }]
}
```

Contributions add surface, not authority, which is why they are not part of the grant hash: a new
panel still runs inside the scopes, events and capabilities the user already approved.

The `url` setting type is the destination half of the `webhook` capability — the user types the URL,
you only ever supply a body. A `secret` setting is stored in the OS credential store rather than in
your database.

### 4. The complete example

This manifest parses. It was checked by calling `parseManifest()` from `@vrcz/plugin-api` on exactly
these bytes.

```json
{
  "$schema": "https://vrc.zip/schema/vrcz-plugin.json",
  "id": "acme.friend-notes",
  "name": "Friend Notes",
  "version": "1.0.0",
  "description": "Private notes about the people you meet, kept on this computer.",
  "publisher": "Acme",
  "homepage": "https://example.com/friend-notes",
  "repository": "https://github.com/acme/friend-notes",
  "license": "MIT",
  "keywords": ["notes", "friends"],
  "icon": "assets/icon.png",
  "main": "src/index.ts",
  "engines": { "pluginApi": 0 },
  "permissions": {
    "scopes": ["friends:read", "users:read", "sessions:read"],
    "accounts": { "mode": "many", "optional": false, "reason": "Notes are kept per account." },
    "events": ["friend.online", "friend.offline", "gamelog.player_join"],
    "capabilities": ["storage", "notify", "webhook", "fetch:allowlist"],
    "fetch": { "domains": ["api.example.com"], "reason": "Looks up world metadata for a note." }
  },
  "contributes": {
    "panels": [
      {
        "id": "notes",
        "title": "Notes",
        "description": "Everything you wrote about the people you have met.",
        "icon": "notebook",
        "placement": "sidebar"
      }
    ],
    "settings": [
      { "key": "digest-url", "type": "url", "label": "Daily digest webhook", "required": false },
      {
        "key": "tone",
        "type": "select",
        "label": "Reminder tone",
        "default": "terse",
        "options": [
          { "value": "terse", "label": "Terse" },
          { "value": "warm", "label": "Warm" }
        ]
      }
    ],
    "commands": [{ "id": "export", "title": "Export notes" }],
    "nodes": [{ "id": "note-added", "title": "Note added", "category": "Notes" }]
  },
  "performance": "smol"
}
```

`$schema` is accepted and otherwise ignored. Nothing serves a schema at that URL yet — the generator
PLAN.md describes has not been written — so it buys you forward compatibility and no editor
completion today.

### 5. Check it

The parser is published and works right now, which makes this the one part of plugin development you
can do end-to-end today. Put it in a test:

```ts
import { expect, test } from "bun:test";
import { parseManifest } from "@vrcz/plugin-api";

test("the manifest is valid", async () => {
  const result = parseManifest(JSON.parse(await Bun.file("vrcz-plugin.json").text()));
  if (!result.ok) throw new Error(result.message);
  expect(result.manifest.id).toBe("acme.friend-notes");
});
```

`result.message` is already formatted for a person to read — the same text the install screen will
show. Do not reformat it.

## Your entry module

### What it looks like

`definePlugin` registers your lifecycle hooks and hands `activate` a `ctx` carrying exactly what the
user granted.

```ts
// src/index.ts
import { definePlugin } from "@vrcz/plugin-api/runtime";

definePlugin({
  async activate(ctx) {
    const last = await ctx.storage.kv.get("last-run");
    await ctx.storage.kv.set("last-run", Date.now());
    ctx.log(`last run: ${String(last)}`);
  },

  async deactivate() {},
});
```

> [!IMPORTANT]
> **Import from `@vrcz/plugin-api/runtime`, not from `@vrcz/plugin-api`.** The package root
> re-exports the manifest schema, which pulls in zod, which uses `eval` and `Function` internally —
> and the install pipeline's deny-scan refuses those in a bundled plugin. Importing the root makes
> your plugin fail to install, with the error pointing at your own bundle. Type-only imports from
> the root are fine, because types are erased before bundling.
>
> This is why `definePlugin` lives in the published package rather than being injected by the host:
> your bundle carries it, so it is compiled, scanned and hashed like the rest of your code.

`ctx` carries `vrchat` (reads only), `storage`, `events`, `log`, and `call` for any method the
façade does not wrap. **`ctx.vrchat` is reads only.** Behind the dispatcher there are eight methods,
and this is the whole list.

| Method | Scope | Account |
|---|---|---|
| `vrchat.accounts.list` | none | none |
| `vrchat.friends.list` | `friends:read` | required |
| `vrchat.users.get` | `users:read` | required |
| `vrchat.worlds.get` | `worlds:read` | required |
| `vrchat.worlds.search` | `worlds:read` | required |
| `vrchat.instances.get` | `instances:read` | required |
| `vrchat.groups.get` | `groups:read` | required |
| `vrchat.groups.list` | `groups:read` | required |

`vrchat.accounts.list` costs no scope deliberately: you have to be able to discover which accounts you
were given before you can name one, and charging a scope for that would make every plugin ask for one
it does not need.

Each of these returns a small hand-written projection rather than VRChat's own response shape, so the
day VRChat renames `currentAvatarThumbnailImageUrl` is a day the host changes and your plugin does
not. Outbound social actions are **not** in the surface and cannot be spelled: they arrive with 3.8,
alongside the consent gesture that lifts their dry-run.

`ctx.storage`, `ctx.ui`, `ctx.events` and `ctx.notify` have no implementation at all. And since
nothing dispatches a lifecycle frame into `activate`, nothing hands you a `ctx` to call any of this
with yet.

### What actually happens today

When the host spawns your plugin, this is the whole of it:

1. It resolves a real `bun` binary and spawns it as `bun [--smol] -e <prelude source> <config json>`,
   with **no inherited environment** and your data directory as the working directory, under an OS
   memory cap on Windows and Linux. (On Windows "no inherited environment" takes work: `env: {}`
   there is a merge rather than a replacement, so eleven variables have to be explicitly blanked. See
   [lifecycle.md](./lifecycle.md).)
2. The **prelude** — host code, injected as a string rather than read from a file, so no other local
   process can rewrite it between the write and the spawn — runs first. It captures its own
   references to `stdout`, `JSON`, `TextEncoder` and the rest before any of your code exists, sends
   the single `hello` frame, and starts reading frames from stdin.
3. It scrubs globals: `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource`, `navigator`, `Worker`,
   `SharedWorker`, `eval`, `require`; the dangerous members of `Bun`; `process.binding`,
   `process.dlopen`, `process.getBuiltinModule`, `process.chdir`, `process.kill`. `process.env` is
   emptied. `console.*` and `process.stdout.write` are redirected to stderr, because **stdout carries
   frames and nothing else**.
4. It installs `globalThis.__vrczHost`, then dynamically imports your bundle.

So your module scope runs, and `globalThis.__vrczHost` is there:

```ts
interface HostSeam {
  readonly pluginId: string;
  readonly protocol: number;
  send(frame: object): boolean;      // refuses `pong` and `hello` locally
  onFrame(fn: (frame: object) => void): void;
  log(message: unknown): void;       // goes to stderr, captured by the host as a log line
}
```

`ping` is answered by the prelude and never reaches you — deliberately, because a plugin cannot then
forget to answer, cannot answer wrongly, and a plugin spinning its event loop stops answering no
matter what it intended. A missed heartbeat is evidence about the runtime, not about you.

**Nothing calls your `activate`.** The supervisor sends a `lifecycle` frame with `phase: "activate"`,
and the only thing listening is whatever you passed to `__vrczHost.onFrame`. The plugin-side runtime
that would route that frame into your exports and hand you a `ctx` is not written. If you want to see
frames today you handle them yourself — which is what the daemon's own test fixtures in
`daemon/src/plugins/__fixtures__/` and the hostile-plugin suite in `daemon/src/plugins/hostile/` do.

**Do not build against `__vrczHost`.** It is a host implementation detail and the seam a future
runtime attaches to, not the plugin API. The API is [protocol.md](./protocol.md) and the `ctx` that
will wrap it.

## How to think about scopes and accounts before you request them

The consent screen is somebody reading a list and deciding. Design for that reader.

**Ask for what you use, at the granularity the registry offers.** 48 scopes exist so you can ask for
`users:read` rather than everything. 13 of them are `dangerous`, shown in their own block behind a
second toggle — legal to request, but each one is a reason the user might close the sheet.

**Outbound social actions are the sharp edge.** `invite:send`, `moderation:write`, friend requests —
these are visible to other people, and they are how a plugin gets a user banned or socially harmed.
The design is: dry-run by default for a new plugin, a rolling per-hour cap without an explicit user
gesture, an exportable audit log attributing every outbound action, and the dry-run lift as a
deliberate per-plugin, per-scope gesture in the management page with the dry-run log beside it as
evidence. If your plugin's core loop is outbound social actions, that is the experience you are
signing your users up for.

**Rate budget is the other sharp edge.** Every call you make goes through the shared limiter tagged
with your plugin id, with a subordinate per-plugin budget, and a UI that names whoever is eating it.
A plugin polling `friends` every second, times six accounts, gets *the user* rate-limited or
moderated, and the user will blame vrc.zip, not you. Subscribe to events instead of polling wherever
the event exists.

`E_RATE_LIMIT` carries `retryAfterMs`, and **it is a real number rather than a stock hour**: it is how
long until the oldest call in your window ages out. Waiting exactly that long is the correct
behaviour. Retrying before it elapses is a bug in your plugin, not a host quirk to work around, and it
is a bannable-behaviour bug: not in vrc.zip's opinion, in VRChat's.

**Ask for the narrowest account mode you can live with.** `one` renders a single-account picker;
`many` renders a multi-select. If your plugin is genuinely useful with nothing bound, set
`optional: true` and let the user leave the picker empty.

**Every added scope, event pattern, capability, fetch domain, or a flip to `performance:
"throughput"` changes the grant hash and forces a re-prompt on update.** Cosmetic edits do not. Get
the permission set right before your first release; adding one scope in v1.1 puts a consent sheet in
front of every existing user.

## What you cannot do yet

Checklist steps are from `PROGRESS.md` §Phase 3.

Several of these are now "built, but nothing calls it", which is a different state from "not written"
and is marked where it applies.

| You cannot | Because | Step |
|---|---|---|
| Install a plugin from the app | The pipeline is **built**: it parses the manifest, compiles, deny-scans the output, content-addresses the artifact and verifies it back off disk. Nothing calls it. There is no route and no UI, and it deliberately writes no `plugins` row, because recording that you agreed to run something is consent's job rather than the compiler's. | **3.5 built, 3.8 to reach it** |
| Install from a git URL | The pipeline takes a local directory only. The pinned git URL is a fetch step in front of an identical pipeline. | **3.5**, outstanding |
| Install something signed | Never. Signing was cut — nothing is signed and nothing is checked. | — |
| Run a plugin from the app | `daemon/src/app.ts`, the composition root, wires no plugin subsystem at all. The supervisor, transport, registry, dispatcher and installer run only under their own tests. | **3.8** |
| Have your `activate` called | No plugin-side runtime routes a `lifecycle` frame into your exports. The host sends the frame; nothing on your side receives it unless you write that yourself. | **3.4 and later** |
| Call a `ctx` API | The dispatcher, scope gate and per-plugin budget are **built and tested**, with the eight read methods listed above behind them. No transport is attached and no grant exists, so every call would be refused with `E_SCOPE_DENIED` before it reached a method. | **3.4 built, 3.8 to reach it** |
| Send an invite, moderate, or add a friend | Deliberately absent from the surface rather than merely unimplemented. They ship with the dry-run lift gesture that ungates them. | **3.8** |
| Receive events | The events bridge, meaning compiled filters, credit windows, per-tick batching and the `dropped` frame, is not built. `permissions.events` is validated and then unused. | **3.6** |
| Use `webhook` or `fetch:allowlist` | Both are validated in the manifest and neither is implemented. | later |
| Store anything | No per-plugin SQLite file, no KV, no `records`, no quota. `plugin-data/<id>/` is created as your working directory and is otherwise empty. | **3.7** |
| Be granted anything | There is no consent screen and no management page. The `plugin_grants`, `plugin_dry_run_lifted` and `plugin_crashes` tables exist; nothing populates them. | **3.8** |
| Render UI | The `UINode` vocabulary is published and validated (`validateUINode`); no renderer consumes it. | **3.9** |
| Register a node type | `NodeDefinition` and the port lattice are published; registration into the graph editor and runtime is not built. | **3.10** |
| Scaffold a project | `create-vrcz-plugin` does not exist. Neither does the `vrcz` CLI, so neither does `vrcz dev`. | **3.11** |
| Run plugins from a packaged build | The plugin host needs a real `bun` from `<state>/runtime/bun-<version>/`. The fetcher is written, but its hash pin table ships empty and an unpinned platform refuses to download rather than run an executable nobody vouched for. From a source checkout the daemon is already running under a real `bun` and uses that. | packaging |

What *is* real today, on your side: the manifest schema and `parseManifest`, `grantHash`, the wire
protocol types and codecs, the `UINode` vocabulary and `validateUINode`, and `NodeDefinition` with
`assignable()` and `nodeDefinitionHash()`.

And on the host side, under test rather than under a user: the install pipeline, the prelude, the
process transport with its OS memory cap and scrubbed environment, the supervisor with its heartbeat,
backoff and crash-loop breaker, the registry, and the dispatcher with its scope gate, account
resolution, rate budget and eight read methods.

## The honest next step

If you want to build a plugin **today**, you can do exactly three useful things, and it is worth
knowing that up front rather than after a weekend:

1. **Write and validate your manifest.** `parseManifest` is real. Getting the permission set right
   before your first release is worth more than any code you could write now, because the permission
   set is what re-prompts every user when it changes.
2. **Design your UI as a `UINode` tree and validate it.** `validateUINode` is real and enforces the
   node-count and depth caps. A tree that validates today will render when the renderer lands.
3. **Model your node types as `NodeDefinition` values.** `canonicalNodeDefinition` and `assignable`
   are real, so the port typing you design now is the port typing the editor and runtime will
   enforce.

You can also now design against a real `ctx.vrchat`: the eight read methods above are settled, with
their scopes, their account posture and their projections. What you cannot usefully do is write the
body of `activate`, because nothing calls it and nothing would hand you a `ctx` if it did. Anything
you write against `__vrczHost` directly is written against a host internal that the plugin-side
runtime is going to sit on top of.

Read [status.md](./status.md) before you rely on any of this, and
[security-model.md](./security-model.md) before you ask for a dangerous scope.
