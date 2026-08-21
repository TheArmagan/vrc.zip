# vrc.zip — desktop-app

A Bun daemon that manages multiple VRChat accounts, keeps live presence, persists a feed, mirrors the
VRChat REST API for other local apps, and is extensible through sandboxed plugins and a node-graph
automation editor.

**[`PLAN.md`](./PLAN.md) is the architecture and the reasoning — read it first.**
**[`PROGRESS.md`](./PROGRESS.md) tracks state: what exists, what's next, what was decided.**

> `../backend/` is a **separate project** (social features) and is out of scope here.

## Layout

| Path | What |
|---|---|
| `packages/shared` | Event types, scope registry, wire protocol. A leaf — imports nothing else here. |
| `packages/api` | Generated VRChat client + route table. Codegen output, committed, never hand-edited. |
| `packages/plugin-api` | Published as `@vrcz/plugin-api`. Versioned on the plugin **protocol** major. |
| `daemon` | Accounts, pipeline, store, log watcher, the three HTTP servers. |
| `ui` | Svelte 5 + shadcn-svelte. Scaffolded in Phase 1.9. |
| `tools` | Codegen and packaging. |

## Toolchain

Bun is pinned in three places that must move together: `packageManager` and `engines.bun` in
`package.json`, and `.bun-version`. It is not merely a developer prerequisite — the pinned binary is
**bundled and shipped**, and it is what executes third-party plugin code, so it is a build input.
See PLAN.md §Phase 5.

```bash
bun install
bun run typecheck    # tsc --noEmit over the whole workspace
bun test             # all packages
bun run lint         # biome check
bun run format       # biome check --write
bun run daemon       # bun --watch daemon/src/index.ts
bun run codegen      # tools/src/codegen.ts (Phase 1.1)
```

Cross-package imports resolve through Bun's workspace symlinks and each package's `exports` field.
There is deliberately no `paths` mapping in `tsconfig.json` — a second resolution mechanism is a
second thing to drift.
