# Example plugins

Five plugins, each written to show one thing rather than to be useful. Read them in order — each
assumes what the one before it introduced.

| Plugin | What it shows |
|---|---|
| [`hello-panel`](./hello-panel) | The smallest real plugin: a manifest, `definePlugin`, one panel |
| [`friend-watch`](./friend-watch) | Subscribing to events, and coalescing a noisy one |
| [`note-keeper`](./note-keeper) | Per-plugin storage: KV, the append-only log, and quota |
| [`instance-table`](./instance-table) | Reading VRChat through `ctx.vrchat`, drawn as a table |
| [`graph-nodes`](./graph-nodes) | Contributing node types: a trigger that arms and an action |

## Running one

```bash
bun run daemon                  # from desktop-app/, note the launch URL it prints
```

Then, in another terminal, install from a path:

```bash
curl -X POST http://127.0.0.1:7775/api/plugins \
  -H "Authorization: Bearer <the token from the launch URL>" \
  -H "Content-Type: application/json" \
  -d '{"path":"C:/path/to/desktop-app/examples/plugins/hello-panel"}'
```

**That request parks until you approve it.** Open the app, go to Plugins, and the consent sheet is
waiting. Nothing is granted until you hold the button — see
[the security model](../../packages/plugin-api/docs/security-model.md) for why every install asks.

## Two things that will bite you

**Import from `@vrcz/plugin-api/runtime`, never from `@vrcz/plugin-api`.** The package root pulls in
the manifest schema, which pulls in zod, which uses `eval` — and the install pipeline's deny-scan
refuses that in a bundled plugin. Your plugin will fail to install with an error pointing at your own
bundle. Type-only imports from the root are fine; types are erased before bundling.

**`engines.pluginApi` is the protocol major, and it is `0` in this build.** Not the app version, and
not a semver range.

## These resolve `@vrcz/plugin-api` through the workspace

They live inside this repository, so `bun install` at the root links the package for them. A plugin
of your own, outside this repo, adds it as a dependency the ordinary way:

```bash
bun add @vrcz/plugin-api
```
