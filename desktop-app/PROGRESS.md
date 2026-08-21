# vrc.zip — Progress & Handoff

Working log for anyone (human or agent) picking this up. **Read [`PLAN.md`](./PLAN.md) first** — it is
the architecture and the reasoning. This file tracks only *state*: what exists, what's next, and what
was decided along the way.

**Last updated:** 2026-08-21
**Current phase:** Phase 1 — Foundation
**Status:** Phase 1 built end to end — daemon + UI both run. 1.10 verification is partly done.

---

## How to use this file

- Update the **Status** line and the **Phase 1 checklist** whenever you finish a unit of work.
- Append to **Decision log** when you make a call that isn't already in `PLAN.md`. Say *why*, briefly.
  A decision that only lives in a commit message is a decision the next person will re-litigate.
- Append to **Gotchas** when reality contradicts the plan. This is the highest-value section — the plan
  was written from research, not from running code.
- Don't restate `PLAN.md` here. Link to the section instead.

---

## Repository state

```
vrc.zip/
├─ backend/         ⚠ SEPARATE PROJECT — social features for vrc.zip. Not planned, not ours.
│                     Do not touch, do not restructure, do not delete.
├─ desktop-app/     this project — a Bun workspace
│  ├─ PLAN.md            the plan (authoritative)
│  ├─ PROGRESS.md        this file
│  ├─ README.md          layout + toolchain commands
│  ├─ package.json       workspace root; pins bun 1.4.0 (also `.bun-version`, `engines.bun`)
│  ├─ bunfig.toml        exact installs, hoisted linker
│  ├─ tsconfig.base.json the strict compiler options — every package extends this
│  ├─ tsconfig.json      whole-workspace `tsc --noEmit` (excludes `ui/`)
│  ├─ biome.json         lint + format, one tool
│  ├─ packages/
│  │  ├─ shared/         @vrcz/shared     — version constants only so far
│  │  ├─ api/            @vrcz/api        — empty until 1.1
│  │  └─ plugin-api/     @vrcz/plugin-api — empty until Phase 3 (the one publishable package)
│  ├─ daemon/            @vrcz/daemon     — runnable entry point, no behaviour until 1.8
│  ├─ ui/                @vrcz/ui         — workspace member, no deps until 1.9
│  └─ tools/             @vrcz/tools      — codegen stub that exits 1
└─ LICENSE
```

`bun install`, `bun run typecheck`, `bun test` (310 tests), and `bun run lint` are all green.
`bun daemon/src/index.ts` starts the daemon, binds three ports, writes `state.json`, and serves a
working control API. Git is on `main`
with one commit (`Initial commit`); `backend/` and `desktop-app/` are still untracked.

---

## Phase 1 checklist

Build in this order — each step depends on the ones above it. See `PLAN.md` §Phase 1 for the detail
behind each line.

- [x] **1.0 Workspace** — done. Bun workspaces under `desktop-app/`: `packages/{shared,api,plugin-api}`,
      `daemon/`, `ui/`, `tools/`. `tsconfig.base.json` holds the strict options and every package
      extends it; Biome does lint *and* format; `bun test` runs with one real assertion behind it.
      Bun pinned to **1.4.0** in `packageManager`, `engines.bun`, and `.bun-version` — it is bundled
      and shipped, so it is a build input, not a developer prerequisite. See decisions 15–18 below.
- [x] **1.1 Codegen** (`packages/api`) — commit pinned `openapi.json` v1.20.8; `@hey-api/openapi-ts`
      → typed fetch client; **also emit the route table** `{method, pathTemplate, operationId, tag,
      security, scope}[]` that the Phase 2 proxy needs. Test: every operation maps to exactly one scope.
- [x] **1.2 Secrets** (`daemon/src/security/secrets.ts`) — 32-byte master key in Windows Credential
      Manager / libsecret via a CLI shim; AES-256-GCM `secrets.enc`; file-key fallback at `0600` with a
      loud UI warning when libsecret is missing.
- [x] **1.3 Account + auth** (`daemon/src/accounts/`) — per-account `CookieJar`, the exact login flow,
      explicit branching on `totp` / `emailOtp` / `otp`, re-auth mutex.
- [x] **1.4 Network** (`daemon/src/net/`) — mandatory UA, per-account token bucket, 429 backoff,
      jittered non-clock-aligned polling.
- [x] **1.5 Pipeline** (`daemon/src/pipeline/`) — one WS per account, reconnect + heartbeat, **defensive
      per-event-type decoding**, typed event map, `{"err":...}` handling.
- [x] **1.6 Store** (`daemon/src/store/`) — single SQLite DB, WAL, `account_id` column (not table
      prefixes), integer ms timestamps, numbered migrations, retention rollup job.
- [x] **1.7 Log watcher** (`daemon/src/logs/`) — offset-based tail (**never `fs.watch` on Windows**),
      cross-platform path discovery incl. Proton/Flatpak/Deck, substring-marker parser, golden tests.
      **Tails every live log file concurrently** — several VRChat clients can run at once on different
      accounts. `User Authenticated: <name> (usr_…)` attributes a file to an account; `sessions` is the
      unit, not `accounts`. Pre-auth events buffer and attribute retroactively; unmanaged accounts stay
      as unlinked sessions rather than being misattributed.
- [x] **1.8 Servers** (`daemon/src/servers/`, `security/`) — three ports, Host + Origin validation,
      session token, `state.json`. **Default URL is `http://127.0.0.1:PORT`**; `local.vrc.zip` is
      opt-in with a resolve check and silent fallback.
- [x] **1.9 UI** (`ui/`) — Svelte 5 + shadcn-svelte. Account switcher, login (all three 2FA paths),
      friend list, feed, game log, notifications, settings. **Command palette + command registry ship
      in Phase 1** even though plugins don't — retrofitting a registry is worse than building it empty.
- [ ] **1.10 Verification** — see `PLAN.md` §1.10. Recorded-fixture server for CI; two real accounts
      manually; RSS at 1h and 24h.

**Definition of done for Phase 1:** two accounts logged in simultaneously with independent pipeline
sockets and zero cookie bleed, live presence in the UI, feed and game-log rows persisting with the
right `account_id`, working on both Windows and Linux/Proton, idle RSS ≤80MB.

---

## Decision log

Decisions made in conversation that aren't obvious from `PLAN.md` alone.

1. **`backend/` is a different project — hands off.** It is the backend for vrc.zip's *social*
   features. Nothing about it is planned yet and none of it is in scope here. Do not restructure,
   delete, or build into it. This project lives entirely under `desktop-app/`.
2. **`desktop-app/` keeps its name.** An earlier draft proposed renaming it to `daemon/` on the grounds
   that there's no native shell in v1. Dropped: with `backend/` as a real sibling project,
   `desktop-app` correctly names this half, and a rename is pure churn. The daemon is
   `desktop-app/daemon/`.
3. **Generate the API client; don't depend on the `vrchat` npm package.** Reasons are enumerated in
   `PLAN.md` §"Why we generate the client instead of using `vrchat` npm". Short version: its cookie
   store is private and single-keyed, its pipeline socket has no reconnect and silently drops three
   notification event types, and its 401-replay path destroys response headers — which a byte-faithful
   proxy cannot tolerate. We still track the same upstream spec.
4. **Scopes ride in the Basic-auth password field.** `b64(urlencode(user):urlencode(scopes))`. A stock
   VRChat client library then needs *zero* modification to use the proxy. **This is the only scope
   mechanism** — an `X-VRCZip-Scopes` header was considered and dropped, because a second path means two
   precedence rules and an app that works against one build and not another.
5. **Consent uses VRChat's 2FA flow as a device-pairing channel.** Pending grant → `200
   {"requiresTwoFactorAuth":["totp"]}` → vrc.zip shows a 6-digit code → the user types it into the app.
   Typing the code *is* the consent gesture. Byte-faithful, no polling, no held socket, no custom
   client code. (Plex/Steam pairing wearing VRChat's clothes.)
6. **Issued cookies are `authcookie_<our own id>_vrczip`** — an unrelated identifier mapping to a grant
   row, *not* a wrapper or encryption of the real cookie. Real enough in shape that clients which parse
   or prefix-check keep working; suffixed so a leaked token is inert against `api.vrchat.cloud` and
   greppable in user logs. **Hard invariant: a real `auth` or `twoFactorAuth` value never appears in
   any proxy response.** Byte-faithful passthrough leaks it by default — upstream `Set-Cookie`,
   `GET /auth`'s `token` field, and VRChat's own `{"err":...,"authToken":"..."}` pipeline error frame
   all carry it. An egress filter is the last middleware and fails closed (500, empty body, loud log)
   on any `authcookie_` without the `_vrczip` suffix. See `PLAN.md` §"Hard invariant".
7. **No "default account" fallback in the proxy.** An unrecognized username is a 401 in VRChat's real
   shape. A reserved value (`*` / empty) means "let the user pick." An app silently acting as the wrong
   account is the worst failure mode this system can have, so it is designed out.
8. **Plugins run in a child process, not a Bun Worker, spawned with `--smol`.** A Worker is an isolation
   primitive, not a security one — `import("node:"+"fs")` defeats any global scrubbing, and Bun has no
   `resourceLimits`. `--smol` (JSC small-heap) is the right default because plugin processes are mostly
   idle event handlers and N of them are the likeliest way to lose the 50–80MB idle footprint. It is a
   *hint*, not a cap — the RSS watchdog and OS-level limits still do the real work. Manifest opt-out
   `"performance": "throughput"`, surfaced at consent since it spends the user's memory. Full reasoning
   in `PLAN.md` §Phase 3.
14. **The app bundles its own `bun` binary; it never uses an external or `PATH` Bun.** That is what makes
    `--smol` an ordinary spawn flag instead of a build-time bake-in, and it means the runtime executing
    third-party plugin code is the exact one we tested against on every machine. It also replaces
    `bun build --compile` as the distribution story — a self-contained executable would have to
    re-invoke itself for plugin processes and share one baked flag set between the daemon and every
    plugin, which is precisely the knob we need per-process. Cost: download grows by the Bun binary.
    **Consequence to not forget:** whoever can replace that binary owns the daemon and every credential
    in it, so it needs signature verification on update and a startup hash check that refuses to run on
    mismatch — same reasoning as plugin signing.
9. **Plugin UI is a declarative JSON tree rendered by host components, with no escape hatch.** The host
   page holds the session token, and any plugin JS in that page can read it. An iframe-on-separate-port
   mode was drafted and **cut**: an escape hatch that exists gets reached for by default, eroding the
   design system one plugin at a time, and the isolation property would only hold for plugins that
   declined to use it. The trade is that we owe authors a genuinely complete vocabulary — charts,
   virtualized tables, dialogs, context menus, forms, per-node click handlers. Charts especially: they
   were the one legitimate reason anyone would have wanted an iframe. A genuine wall is answered with a
   **new host node type contributed upstream**, available to everyone.
10. **`127.0.0.1` is the runtime default; `local.vrc.zip` is opt-in.** Safety and zero dependencies win
    for what actually runs: no cert to renew, no DNS to resolve, nothing that can fail. The README
    still presents `local.vrc.zip` as the documented experience, since it is the nicer URL and its
    loopback origin dodges Chrome's Local Network Access prompt.
11. **Retention is per-event-type, not one global window.** `gamelog.player_join` in a busy public
    instance out-produces a year of `friend.online` in a week and ages out far faster. Defaults per
    kind are in `PLAN.md` §1.6; any kind without a configured window inherits a global default so new
    event types can't grow unbounded by omission.
12. **Sessions, not accounts, are the unit for anything log-derived.** Several VRChat clients can run
    concurrently on one machine, each on a different account. A session is `(log file, account, run)`;
    the same account can legally have two. `account_id` on a session is nullable — the auth line
    arrives a few seconds into the log, and the client may be signed into an account vrc.zip doesn't
    manage at all. Both the UI and the enriched stream expose sessions concurrently. This is a
    deliberate divergence from VRCX, which assumes one client.
13. **The node graph uses the shared store.** Graph definitions, runs, and node state go in the main
    SQLite DB; runs are `events` rows with a `graph.*` kind, so they inherit per-type retention, the
    feed UI, and the enriched event stream for free. No separate graph DB or migration system.

15. **Biome is the whole lint/format toolchain.** One dependency, one config, one pass, and it
    formats JSON and the config files too. The alternative — ESLint + Prettier + a typescript-eslint
    stack — is four or five packages and a plugin graph to keep in sync for a project whose strictest
    rules are already enforced by `tsc`. Biome's Svelte support is partial, which is a real cost that
    lands in 1.9; `svelte-check` covers the gap, and it would have been needed regardless.
16. **No TS project references; one whole-workspace `tsc --noEmit`.** References require `composite`,
    which requires emit, and nothing here is compiled by `tsc` — Bun runs the TypeScript directly.
    Cross-package imports resolve through Bun's workspace symlinks and each package's `exports`
    field, so there is **no `paths` mapping** either. Two resolution mechanisms would be two things
    to drift.
17. **`ui/` is a workspace member from day one but carries no dependencies until 1.9.** It gets
    `@vrcz/shared` resolution and a slot in the layout now, so the Vite scaffold drops in rather than
    restructuring the workspace later. Its `dev`/`build` scripts fail loudly rather than no-op, and
    it is excluded from the root typecheck until `svelte-check` arrives with it. Same posture for
    `tools/src/codegen.ts`: it `exit(1)`s, because a codegen step that appears to succeed while
    emitting nothing is how a stale client ships.
18. **`APP_VERSION` is duplicated in `packages/shared`, guarded by a test.** It is *not* imported
    from `package.json` at runtime — the shipped bundle has no reliable path to one — and it feeds
    the mandatory User-Agent, so a silently stale value means traffic that misreports itself.
    `version.test.ts` asserts it against the workspace root manifest.


19. **`daemon/src/logs/` is `daemon/src/game-logs/`.** Renamed after a bare `logs` pattern in the
    repo-root `.gitignore` silently excluded the whole phase from git. The pattern is anchored now,
    but the name is also simply more accurate: these are VRChat *game* logs, not app logs.
20. **`registerUserAccount` is hard-denied on the proxy, alongside the two PLAN.md names.** Mass
    account creation through the user's own daemon and IP is the most abuse-prone operation in the
    spec and has no legitimate third-party use here.
21. **Scope mapping is rule-first with an override list, not 297 hand-written lines.** Tag decides
    the resource, method decides read/write, and an explicit override list covers every case where
    the rule under-classifies risk (credentials, outbound social, group administration, single
    destructive operations). A rule cannot go stale when the spec adds an endpoint; a hand table
    silently would. Codegen fails hard if any operation maps to no scope.
22. **The recorded-fixture VRChat server is a real `Bun.serve`, not a `fetch` stub.** The bugs most
    likely to live in that layer are HTTP-level — multiple `Set-Cookie` headers folding into one,
    header casing, an empty 401 body — and a stub papers over exactly those. It also models the
    missing-UA 403 and counts minted sessions, which is how the session-frugality guarantee is
    actually tested rather than asserted.
23. **The EventBus fans out by prefix bucket, and `emit()` never awaits.** Async subscribers are
    observed only to route rejections to `onError`. A slow subscriber must not stall the pipeline
    reader, because a socket that stops draining is a socket VRChat eventually closes.

---

## Gotchas

Empirical notes. Add to this as you hit things — especially where the plan turns out to be wrong.

Found by running code. Each of these contradicted an assumption, and most were silent failures.

- **A bare `logs` pattern in the repo-root `.gitignore` matched `daemon/src/logs/` and excluded the
  entire log watcher from git.** A bare `*.log` did the same to its fixtures. Both are fixed — the
  pattern is anchored (`/logs`) and the directory is now `daemon/src/game-logs/`, fixtures are
  `.txt` (which is also what VRChat actually writes). Check `git check-ignore -v <path>` before
  assuming a new directory is tracked.
- **Re-authentication deadlocks if the auth flow uses a context carrying the 401 hook.**
  `reauthenticate()` returns one shared in-flight promise; the calls it makes to re-authenticate
  also 401, re-enter `reauthenticate()`, get that same promise, and await it from inside itself.
  The daemon hangs silently, exactly when a session expires. `Account.#baseContext()` exists solely
  to prevent this — **authentication must never be able to trigger authentication.**
- **`secrets.rename` is the wrong primitive for the pending -> real account rekey.** A 2FA login
  persists twice: once pre-2FA under the pending id, once after verify under the real id. Renaming
  moves the *older* row over the newer one, silently discarding the `twoFactorAuth` cookie, so 2FA
  is demanded on every restart. Write the live account's own state instead.
- **`events.account_id` must be nullable.** A game client signed into an account vrc.zip does not
  manage is a normal state, and its events have no account. NOT NULL forces you to drop them or
  invent an account, and both are wrong.
- **`events` and `sessions` have foreign keys to `accounts`.** The account row must exist before
  anything references it — the composition root upserts accounts *before* attaching the feed writer,
  or the first batch of every cold start is lost.
- **VRChat's 20 req/s is per IP, not per account.** Per-account buckets alone cannot see six
  accounts each politely under their own limit adding up to 60/s. There is a global bucket at 80% of
  the ceiling, and a contended call spends neither bucket (spending one while waiting on the other
  leaks a token per contended call).
- **`Date.parse("-5")` succeeds** — it reads as a year. Falling through from a rejected numeric
  `Retry-After` to a date parse turns malformed input into a confident wrong answer.
- **Windows Credential Manager needs a P/Invoke shim.** There is no built-in cmdlet for generic
  credentials (`cmdkey` writes but cannot read the secret back), and the community module cannot be
  assumed. `Add-Type` over advapi32 works, costs ~365ms per call, and is only called at startup.
- **Biome cannot lint `.svelte`** — it reports every `$props()` binding as an unused variable. It
  needs `css.parser.tailwindDirectives` for Tailwind v4. `svelte-check` is the gate for components.
- **hey-api's generated runtime helpers do not compile under `exactOptionalPropertyTypes`.** They
  get a scoped `@ts-nocheck` from codegen; the types and SDK stay fully checked.
- The **spec facts in PLAN.md all verified**: 232 paths, 297 operations, 19 tags, no PATCH, no
  `apiKey` query param. A test asserts them so a spec bump cannot quietly change them.

- **Four bugs survived 340+ passing tests and were only found by opening a browser.** Worth
  internalising as a class: the daemon crashed on a fresh machine (`bun:sqlite`'s `create: true`
  creates the *database*, not its directory); the packaged UI could not reach the API at all
  (same-origin, not CORS, is the fix — and PLAN.md's architecture diagram had said so all along);
  the session cookie was discarded because the static handler returns `new Response(...)`, which
  replaces `c.res` and throws away headers set before it; and `new URL(...).pathname` yields
  `/C:/Users/...` on Windows. Every one of them was silent — the daemon looked healthy in each case.
- **A cookie set before `next()` does not survive a handler that returns a new `Response`.** Set it
  after. This is a general Hono footgun, not a UI-server quirk.
- **Test setup can hide a first-run bug.** The smoke tests all `mkdir`'d the state directory before
  starting, so the crash-on-fresh-install never appeared until someone ran it for real.

Carried in from research, now confirmed against the fixture server rather than just believed:

Carried in from research, not yet verified against running code:

- VRChat holds `output_log_*.txt` open on Windows; `fs.watch` will not work. Poll a byte offset.
- A missing or generic User-Agent is a hard **403 + `waf_code 13799`**, on the WebSocket handshake too.
  The literal sample UA from the community docs is explicitly blocklisted.
- Every Basic-auth `GET /auth/user` mints a **new session** against an undisclosed cap. Reuse cookies;
  never `PUT /logout` on shutdown.
- The pipeline binds the auth token to the issuing **IP** — `{"err":"authToken doesn't correspond with
  an active session","authToken":...,"ip":...}`.
- `friend-active` events use `userid` (lowercase `i`). Upstream typo, not ours.
- `see-notification` / `hide-notification` carry a bare ID string as `content`; `clear-notification`
  has no `content` at all. Unconditional `JSON.parse` drops all three.
- `GET /users/{id}` returns **different fields** depending on whether the caller is a friend. Never
  share an HTTP cache across accounts keyed on URL alone.
- `apiKey` query param does **not** exist in spec v1.20.8. Don't implement it.
- VRChat has added and removed the user id on `OnPlayerJoined` before. The parser must tolerate both.
- `User Authenticated: (.+?) \((usr_[0-9a-f-]+)\)` is the *only* link between a log file and an
  account — filenames carry a timestamp, not an identity. Everything before that line in a fresh log
  is unattributed until it appears.

---

## Conventions

- **Bun-first.** `bun:sqlite`, `Bun.serve`, `Bun.spawn`, `bun test`. No Node compat shims unless forced.
- **Hono** for HTTP, three separate app instances (one per port) so the mirror cannot accidentally
  serve a control route. Cross-cutting concerns are middleware, never per-route code: `hostGuard`,
  `originGuard`, `auth`, `scopeGuard`, `rateBudget`, `auditLog`. On the proxy path, pass upstream
  `Response` objects through — **never `c.json()`**, which re-encodes and breaks byte-fidelity.
- **TypeScript strict**, including `noUncheckedIndexedAccess`. `verbatimModuleSyntax`.
- **Shared types live in `packages/shared`** (scope registry, event types, wire protocol) and
  `packages/plugin-api` (plugin-facing). The daemon, proxy, UI, and docs all consume these — never
  redeclare a scope string or an event name locally.
- **Timestamps are integer unix-ms** everywhere, including in SQLite. Never ISO strings in a column.
- **Nothing touches VRChat except through an `Account`**, and nothing reaches VRChat without passing
  the rate limiter.
- **`EventBus.emit()` never awaits.** Slow subscribers must not stall the pipeline reader.
- Tests colocate as `*.test.ts`. CI never hits the live VRChat API — use the recorded-fixture server.

---

## Running it

```bash
cd desktop-app
bun install
bun daemon/src/index.ts      # prints a launch URL carrying the session token
```

Set `VRCZIP_STATE_DIR` to redirect the whole state tree (secrets, DB, `state.json`) somewhere
disposable — that is how the tests and any manual poking should run, so a smoke test never touches
your real credential store.

Verified live on Windows: three ports bound, `state.json` written, Credential Manager backend
active, wrong `Host` 403, wrong `Origin` 403, missing token 401, proxy 501, UI 200.

## Open questions

Unresolved; flag to the user rather than guessing.

- Whether `local.vrc.zip` DNS + the DNS-01 cert pipeline is stood up yet, and who owns the renewal
  endpoint that has to stay up for the life of the product. Not blocking — it is opt-in and
  `127.0.0.1` is the default — but the README documents it, so it should exist before release.
- **Type hoisting into `packages/shared` has not happened.** All three Phase-1 agents flagged the
  same candidates and none were moved, deliberately, to avoid concurrent edits to one file. Worth
  doing before the UI and the Phase 2 stream both grow their own copies:
  `JsonValue` (declared twice already — `pipeline/events.ts` and `servers/control.ts`), the
  `gamelog.*` / bus `kind` taxonomy, `ExitKind` / `VrMode` / `SessionSnapshot` / `ParsedLocation`,
  the control-API wire types (`ControlAccount`, `FeedEvent`, `GameSession`, `FriendPresence`,
  `StreamEvent`), the retention config/plan types the settings UI renders verbatim, and the
  token header/query-param constants plus default ports.
- **No retention control on the API.** The retention job runs and is configurable in the database,
  but nothing exposes it, so the Settings screen explains it rather than offering a control.
- **No endpoints for invite / invite-request / boop.** Those three are registered in the command
  palette as stubs that name the missing route when run.
- **`favicon.ico` 404s** on every page load. Cosmetic, but it is a console error on first
  impression.
- **`rateLimit.remaining` and `queued` are approximations.** The limiter does not expose live token
  counts. Either expose them or have the UI stop drawing a gauge that implies precision.
- **No CI workflow.** It belongs at the repo root in `.github/`, which is shared ground with
  `backend/` — a separate project. Needs a decision before it is added.
- Nothing else open. (Retention → per-type, decided. Node-graph storage → shared store, decided.)
