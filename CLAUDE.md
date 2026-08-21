# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**vrc.zip** — a Bun daemon that manages multiple VRChat accounts, keeps live presence, persists a
feed, tails VRChat's game logs, mirrors the VRChat REST API for other local apps, and is extensible
through sandboxed plugins and a node-graph editor. It is the anti-VRCX: cross-platform, 50–80MB
idle, multi-account as the default posture, extensible.

Two top-level directories, and they are **separate projects**:

- `desktop-app/` — this project. A Bun workspace. All work happens here.
- `backend/` — a different project (social features for vrc.zip). Not planned, not in scope. **Do
  not touch, restructure, or build into it.**

### Read these first

- `desktop-app/PLAN.md` — the architecture and the *reasoning*. Authoritative. Sections are cited
  throughout the code (`See PLAN.md §1.4`), so a comment pointing at a section is a real reference.
- `desktop-app/PROGRESS.md` — state: phase checklist, **Decision log** (why a call was made),
  **Gotchas** (where reality contradicted the plan — the highest-value section), and Open questions.

Keep both current. Append to the Decision log when you make a call not already in `PLAN.md`, and to
Gotchas when running code contradicts an assumption. A decision that only lives in a commit message
is a decision the next person re-litigates.

## Commands

All from `desktop-app/`. Bun **1.4.0** is pinned in three places that must move together:
`packageManager`, `engines.bun`, and `.bun-version` — the binary is bundled and shipped and is what
executes third-party plugin code, so it is a build input, not a developer prerequisite.

```bash
bun install
bun run typecheck            # tsc --noEmit over the whole workspace (excludes ui/)
bun test                     # all packages
bun test daemon/src/store    # one directory or file
bun test -t "rate limiter"   # one test by name
bun run lint                 # biome check
bun run format               # biome check --write
bun run daemon               # bun --watch daemon/src/index.ts — prints a launch URL with the token
bun run codegen              # regenerate packages/api from the pinned openapi.json

cd ui && bun run dev         # Vite on :5273, proxies /api to the daemon (DAEMON_PORT, default 7775)
cd ui && bun run build       # → ui/dist, which the daemon serves statically
cd ui && bun run check       # svelte-check — the gate for .svelte files; Biome cannot lint them
```

`VRCZIP_STATE_DIR` redirects the entire state tree (secrets, SQLite DB, `state.json`). Use it for
any manual run so a smoke test never touches the real credential store. `VRCZIP_STABLE_TOKEN=1`
keeps the session token across restarts (implied under `--watch`/`--hot`).

Verification is `bun test` + `bun run typecheck` + `bun run lint` + `cd ui && bun run check`. There
is no CI workflow yet (it would live in the repo root, shared ground with `backend/`).

## Git

- **Commit after every noticeable change** — a finished feature, fix, refactor, or doc update —
  without being asked. Don't batch unrelated work into one commit, and don't leave a session's work
  sitting uncommitted. A half-finished edit or a scratch file is not a noticeable change.
- **Stage only files you changed yourself.** Never `git add -A`, `git add .`, or `git commit -a` —
  the working tree usually holds the user's own in-progress edits. Name the paths you touched, and
  leave anything else alone (say so rather than sweeping it in).
- **Push once a group of commits is done** — when the task finishes or a coherent batch has landed.
  Push the group, not every individual commit.
- **Commits are authored solely by the user.** No `Co-Authored-By: Claude`, no `Claude-Session:`
  trailer, no other Claude attribution. The repo's configured user is already correct — don't pass
  `--author`.

## Architecture

Three HTTP servers on three ports, three **separate Hono instances** on `Bun.serve`, bound to
`127.0.0.1` only — never one app with path prefixes, so the byte-faithful mirror cannot accidentally
serve a control route:

| Port | Server | State |
|---|---|---|
| 7773 | UI bundle + the control API mounted **same-origin** | built |
| 7774 | byte-faithful VRChat API mirror + pipeline WS mirror | Phase 2, returns 501 |
| 7775 | control API: consent, tokens, enriched event stream, webhooks | built |

The control API is mounted on **both** 7773 and 7775. Same-origin is the fix for the packaged
bundle, not CORS — CORS would mean deciding which origins may hold a session token.

**`daemon/src/app.ts` is the composition root.** Everything is constructed there and nowhere else;
no module reaches for a singleton. `wiring/` holds the adapters that connect subsystems (feed
writer, log bridge, pipeline bridge, notification sink, control deps) so the subsystems themselves
stay unaware of each other.

**The EventBus is the spine.** Pipeline events, REST poll diffs, and log-derived events all
normalize into one typed stream; the feed writer, control stream, and (later) plugins and graphs are
all just subscribers. `emit()` never awaits — a slow subscriber must not stall the pipeline reader.

Daemon subsystems (`daemon/src/`): `accounts/` (Account, CookieJar, auth, presence, notifications),
`net/` (rate limiter, backoff, UA, request, image cache), `pipeline/` (WS client + defensive decode),
`game-logs/` (discovery, tail, parser, sessions), `store/` (schema, migrations, queries, retention),
`bus/`, `servers/`, `security/`, `wiring/`.

Packages: `shared` (event types, scope registry, wire protocol — a leaf), `api` (**generated**
VRChat client + route table; committed, never hand-edited), `plugin-api` (the one publishable
package), `tools` (codegen), `ui` (Svelte 5 + shadcn-svelte).

Cross-package imports resolve through Bun workspace symlinks and each package's `exports` field.
There is deliberately **no `paths` mapping** and no TS project references — a second resolution
mechanism is a second thing to drift.

## Invariants

These are load-bearing. Breaking one is a correctness or safety bug, not a style question.

- **Nothing touches VRChat except through an `Account`**, and nothing reaches VRChat without passing
  the rate limiter. Three buckets, three ceilings: 20 req/s per account, 100 req/s per IP, 300 req/s
  per IP for files, each defaulting to 80%. One shared 429 breaker across all three.
- **Never share a cache across accounts keyed on URL alone.** `GET /users/{id}` returns *different
  fields* depending on whether the caller is a friend. Same reason profiles are keyed by
  (user, asking account) in the UI.
- **Authentication must never be able to trigger authentication.** `Account.#baseContext()` exists
  solely to prevent the re-auth deadlock; a 401 hook inside the auth flow hangs the daemon silently.
- **A real `auth` or `twoFactorAuth` cookie value must never appear in any response on 7774 or
  7775.** Byte-faithful passthrough leaks it by default. The proxy mints `authcookie_<id>_vrczip`.
- **Session frugality.** Every Basic-auth `GET /auth/user` mints a new session against an undisclosed
  cap. Reuse cookies; **never** `PUT /logout` on shutdown.
- **Sessions, not accounts, are the unit for anything log-derived.** Several VRChat clients can run
  at once on different accounts. `sessions.account_id` and `events.account_id` are both nullable — a
  client signed into an unmanaged account is a normal state, not an error.
- **Timestamps are integer unix-ms everywhere**, including SQLite columns. Never ISO strings.
- **One schema with an `account_id` column**, not VRCX's per-account table prefixes.
- **On the proxy path, pass upstream `Response` objects through — never `c.json()`**, which
  re-encodes and destroys byte-fidelity.
- **Do not use `fs.watch` on Windows** — VRChat holds `output_log_*.txt` open. Poll a byte offset.
- **The mandatory User-Agent** (`vrc.zip/<version> (<contact>)`) — a missing one is 403 +
  `waf_code 13799`, on the WebSocket handshake too. The proxy never lets a client override it.
- **Local-only, branded UNOFFICIAL, no monetization end-runs** (favorites, invite slots and group
  limits are enforced against the account's real VRC+ entitlements). See `PLAN.md` §Guardrails.

## Conventions

- **Bun-first**: `bun:sqlite`, `Bun.serve`, `Bun.spawn`, `bun test`. No Node compat shims unless forced.
- **TypeScript strict** plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `noUnusedLocals`. Set in `tsconfig.base.json`; not negotiable per-package.
- Biome bans `any` and non-null assertions, and does lint *and* format. It cannot parse `.svelte` —
  `svelte-check` is the gate there. `packages/api/src/generated` and `ui/src/lib/components/ui`
  (vendored shadcn) are excluded from Biome.
- Cross-cutting HTTP concerns are **middleware**, never per-route code: `hostGuard`, `originGuard`,
  `auth`, `scopeGuard`, `rateBudget`, `auditLog`.
- Shared types belong in `packages/shared`. Never redeclare a scope string or an event name locally.
- Tests colocate as `*.test.ts`. CI never hits the live VRChat API — use the recorded-fixture server
  (`daemon/src/testing/vrchat-fixture.ts`), a real `Bun.serve`, because the bugs in that layer are
  HTTP-level (folded `Set-Cookie`, header casing, empty 401 bodies) and a `fetch` stub hides those.
- **For anything the API re-reads later, assert the row, not the bus event.** Several bugs shipped
  with a passing test that asserted the emit while nothing was ever written to SQLite.
- **A cookie set before `next()` does not survive a handler returning a new `Response`.** Set it after.
- Check `git check-ignore -v <path>` before assuming a new directory is tracked. A bare `logs`
  pattern once excluded the whole log watcher from git.

## UI notes

Svelte 5 runes, shadcn-svelte components vendored under `ui/src/lib/components/ui`. State modules
live in `ui/src/lib/state/*.svelte.ts`; screens in `ui/src/screens`.

- **Resolvers (`world-names`, `instance-info`, `user-profiles`) follow one contract**: `entry()`/
  `get()` are pure and safe inside `$derived`, `ensure()` is the only thing that fetches, ids batch
  within a microtask, and a miss is a **cooldown, not a verdict**. Fetch on hover, never on render.
- **The three entity modals share one shell and one back stack** (`EntityModal` +
  `EntityModalState`). They are singletons over the *set* — two singleton dialogs are still two
  dialogs, and their scrims composite into black. `close()` is the back button.
- **A duplicate key in an `{#each}` is a hard runtime error in Svelte 5**, not a warning. Dedupe
  anything keyed on wire data; key lists of plain strings by index.
- **A `SvelteMap` makes structural change reactive and says nothing about the objects inside it.**
  Entries that mutate must themselves be `$state`.
- VRChat returns `""`, not `undefined`, for unset image fields — check emptiness, don't `??`.
- User images are fetched by the daemon and served from `GET /api/image`; a browser cannot load
  VRChat image URLs directly (they need the auth cookie and UA). That route is the one place the
  daemon fetches a caller-chosen URL, so its host allowlist is exact-match, https-only, size-capped.
- `ui/` has no test runner and no tests. Several silent bugs escaped through that gap — verify UI
  changes by running the app, not only by typechecking.
