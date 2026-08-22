# vrc.zip — Progress & Handoff

Working log for anyone (human or agent) picking this up. **Read [`PLAN.md`](./PLAN.md) first** — it is
the architecture and the reasoning. This file tracks only *state*: what exists, what's next, and what
was decided along the way.

**Last updated:** 2026-08-23
**Current phase:** Phase 3 is **complete** — 3.0 through 3.11. Next is Phase 4, the node graph
(decision 182), which 3.10 leaves needing mostly the canvas.
**Status: Phases 1 and 2 are both built.** Phase 1 was confirmed by hand on 2026-08-22 (1.10 and the
profile card). Phase 2 closed on the same day: every numbered step is ticked, including 2.8's last
two pieces (per-app budget overrides and a rate gauge that reports measured numbers instead of
invented ones) and 2.10 in full — retention's API and screen, the enriched stream, the
grant-authenticated `/app` surface, outbound webhooks end to end, and the three social actions.

**What Phase 2 amounts to, in one paragraph.** A third-party app configures the forward proxy on
`:7776` (or points at `:7774` directly), logs in as it would to VRChat, and gets the real pre-2FA
response; a consent sheet opens in vrc.zip and the user types the six-digit code *into the app*,
which is the approval gesture. From then on the app holds a grant: it calls the byte-faithful mirror
on `:7774`, streams the pipeline over the same port, and reaches vrc.zip's own enriched stream,
sessions and webhooks at `/app` on `:7775`. Every call is scope-checked, the three risky scopes are
budgeted per app per hour with a per-app override, every mutating call and every dangerous-scope
read is audited, and the real `auth` cookie mechanically cannot leave the daemon. Verified end to
end against VRCX through the handshake.

**The app is distributable now, ahead of Phase 5:** `bun run package` produces one self-contained
`dist/vrc.zip.exe` — daemon, UI bundle and Bun runtime in a single file, with the VZ icon and the
version metadata on it, opening a browser on launch. It supersedes the `bun.exe` + `app/` layout in
PLAN.md §Phase 5 only until the plugin host needs a real runtime to spawn; decisions 91–94.

**Next: Phase 3 — the plugin system.** Decision 105 put it ahead of Phase 4 because it is the largest
remaining risk and the thing everything else was shaped around. `PLAN.md` §Phase 3 is the spec;
decision 106 settles the host process (the same `.exe` re-invoked in a plugin-host mode).

**Phase 3 status as of 2026-08-22: 3.1 through 3.6 are done and wired.** A plugin can be installed
from a local directory, is compiled and scanned at install, is content-addressed and hash-verified on
every start, spawns into a memory-capped process with a scrubbed environment, and calls a reads-only
`ctx.vrchat` through a dispatcher that gates every call against the grant. Five session-token routes
manage it, and it can subscribe to the bus through a credit-windowed, scope-filtered events bridge
that coalesces rather than backlogs. Verified against a running daemon, not only by tests. Remaining:
3.7 storage, 3.8 consent UI, 3.9 renderer, 3.10 nodes, and the scaffolder half of 3.11.

**A third planning pass on 2026-08-22 scoped the whole back half of Phase 3 and cut two things the
plan had carried since it was written.** Twenty-eight questions, four at a time; the answers are
decision 182. **OS-level plugin sandboxing is cut permanently rather than deferred**, which turns
PLAN.md correction 6 from a temporary posture into the permanent one, and **Ed25519 signing and
trust tiers are cut from v1** along with their remnants in the schema and the manifest. Everything
from 3.7 to 3.11 is scoped in the checklist below, and the docs that describe the two cut features
were rewritten *first*, as step 3.0 — **now done**, decision 183, which also found that the docs'
standing banner had been false for three decisions and that both security pages claimed an
"isolation" no built layer provides.

**Two things to read before building on it.** Decision 177 lists four attacks the hostile suite
asserts as *gaps*, the largest being that **a plugin which gets past install reaches the whole
filesystem** — the install-time stages are the entire defence today, and PLAN.md correction 6's rule
about not calling it a sandbox is a measurement now, not a caution. And decision 173: "verify the
hash on every load" held only on a cold boot until it was fixed, which is the shape of defect worth
looking for elsewhere.

**The one thing Phase 2 has left is verification, not construction:** an end-to-end pass with a real
third-party client against `/app` — grant auth, the scope-filtered stream, and a webhook actually
delivering to a receiver.

**A planning pass on 2026-08-22 settled sixteen open questions** — decisions 95–110, and the
§Open questions section is now one live item rather than eight. It scopes the rest of Phase 2 (what a
per-grant budget actually is, what earns an audit row, that 2.10 carries webhooks and the retention
route), **cuts `local.vrc.zip`** rather than owning a renewal endpoint for the life of the product,
and sets the run-up to Phase 3: plugins are next, they install from a local path or a pinned git URL
with no registry, the hostile plugin is written immediately after the supervisor, and the single
`.exe` stays and re-invokes itself as the plugin host. One sub-question is genuinely open and blocks
the supervisor: whether JSC's small heap can be selected anywhere but at process launch. **That one
closed too** — decision 111 fetches a hash-pinned `bun` from `bun.sh` on first plugin install and
spawns plugin hosts with it, so `--smol` is argv again and the `.exe` stays one file.

Before resuming 2.7, a foundations pass landed: the duplicated types and constants are hoisted into
`@vrcz/shared` and the producers are typed against them (decisions 62, 63, 65, 66), `ui/` has a test
runner for the first time (decision 64), and CI exists (decision 67). That pass was not bookkeeping
— it found four real defects, each recorded in §Gotchas: ten bus kinds the UI had never heard of, a
test asserting on a kind nothing emits, an unescaped session token in the launch URL, and a
`sessionId` round trip whose own comment admitted it was pointless.

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
│  └─ tools/             @vrcz/tools      — codegen, the app icon, and the single-exe packaging
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
      session token, `state.json`. **Default URL is `http://127.0.0.1:PORT`**; `local.vrc.zip` was
      opt-in with a resolve check and silent fallback, and is **cut** as of decision 101 — the code
      removal landed with it (see the housekeeping line under Phase 2), and `guards.test.ts` now
      asserts the hostname is *rejected* rather than merely unused.
- [x] **1.9 UI** (`ui/`) — Svelte 5 + shadcn-svelte. Account switcher, login (all three 2FA paths),
      friend list, feed, game log, notifications, settings. **Command palette + command registry ship
      in Phase 1** even though plugins don't — retrofitting a registry is worse than building it empty.
- [x] **1.10 Verification** — **complete.** See `PLAN.md` §1.10.
      **Covered:** cookie jar; rate limiter + backoff; the three malformed pipeline content types;
      log-parser golden files; retention rollup; fixture-server login, 401 re-auth and 429 backoff;
      feed rows carrying the right `account_id`; one session per log file; unmanaged accounts staying
      unlinked; pre-auth events attributed retroactively; **two independent pipeline sockets, each on
      its own account's token**; **all three 2FA verifiers** (`totp`, `emailOtp`, `otp`) through to a
      `CurrentUser`; **one client crashing while the other session stays live**; **a foreign `Origin`
      rejected on a live port**; **a pipeline frame end to end — socket → decode → bus → SQLite —
      with two accounts online and neither seeing the other's rows**.
      **Confirmed by the user (2026-08-22): the manual half of 1.10 passes, and the profile card
      with it.** Retained as the record of what was checked by hand rather than
      by CI: two *real* accounts signed in at once (only a live run proves VRChat's session cap and
      the pipeline's IP binding); launching VRChat to confirm world-join and player-join/leave rows;
      the Linux/Proton repeat; a real abrupt kill; idle RSS at 1h and at 24h.
      **Also:** `ui/` now has a runner (Vitest + jsdom) and 56 tests over the resolver contract,
      the shared modal back stack, formatting, and the paged-list primitive — the gap the four
      silent bugs in §Gotchas escaped through. Rendering is still uncovered.

**Definition of done for Phase 1:** two accounts logged in simultaneously with independent pipeline
sockets and zero cookie bleed, live presence in the UI, feed and game-log rows persisting with the
right `account_id`, working on both Windows and Linux/Proton, idle RSS ≤80MB.

---

## Phase 2 checklist

`PLAN.md` §Phase 2 for the detail. Built bottom-up: the pieces the handshake needs before the
handshake, because the alternative is a login flow that mints credentials with nowhere to put them.

- [x] **2.1 Grant store** (migration `003_proxy_grants`) — `grants` (one row per (app, account)),
      `pairing_requests` (a login waiting at the consent sheet), `audit_log` (every mutating call,
      attributed). Tokens and pairing codes are stored **hashed**; the plaintext is handed out once
      and never written. Revocation is enforced in SQL, so code that forgets to check cannot honour
      a revoked token.
- [x] **2.2 Proxy credentials** (`security/proxy-tokens.ts`) — mints `authcookie_<uuid>_vrczip`,
      hashes it for storage, and provides the shape predicates (`isProxyToken`,
      `looksLikeRealAuthCookie`) the egress filter is built on. Six-digit pairing codes come from
      the CSPRNG by rejection sampling, zero-padded.
- [x] **2.3 Egress filter** (`proxy/egress-filter.ts`) — the hard invariant, enforced mechanically.
      Strips `Set-Cookie` and the hop-by-hop headers unconditionally, scans every header and body
      for an `authcookie_` without our suffix, and fails closed with an empty 500 and a loud log.
      Mounted at the **binding layer** on both `:7774` and `:7775` — see decision 46.
- [x] **2.4 Identity + scope parsing** (`proxy/identity.ts`) — the app's `User-Agent` parsed into
      the `{name, version, contact}` triple the consent sheet names, and the scope request read out
      of the Basic-auth password field. An unknown scope is a hard failure; a wildcard never reaches
      a dangerous scope.
- [x] **2.5 The login handshake** (`proxy/handshake.ts`, `proxy/consent.ts`) — `GET /auth/user`
      with Basic auth answers *now* with `{"requiresTwoFactorAuth":["totp"]}` and a
      half-authenticated cookie, exactly as real VRChat does pre-2FA, while a consent sheet opens
      behind it. `/auth/twofactorauth/{totp,emailotp,otp}/verify` takes the six-digit code — typing
      it **is** the consent gesture — and returns the grant cookie plus a device-trust cookie.
      `GET /auth` returns **our** token, never the real one. `PUT /logout` revokes the grant and
      never reaches VRChat. Also `proxy/route-table.ts`: a request is matched to exactly one
      operation, literal segments beating parameters, so an unknown path gets VRChat's real 404
      instead of a catch-all's guess. Decisions 54–58.
- [x] **2.6 Consent UI + alerts** — `GET /api/consent`, `POST /api/consent/:id/account`, and
      `POST /api/consent/:id/deny` on the control API; `ui/src/screens/ConsentScreen.svelte` and a
      sidebar entry with a live badge. **There is no Allow button and there must never be one** —
      approval is the user typing the code into the app, and a button here would defeat the code.
      Reaching the user is two channels, picked on whether anyone is watching: a UI client connected
      means the app raises its own sheet plus a Web Notification, and nothing connected means the
      daemon raises an **OS notification** and opens the browser on the consent screen
      (`os/desktop-notification.ts`, `os/open-url.ts`, `wiring/consent-alert.ts`). Decisions 59–61.
- [x] **2.7 Mirror routes** (`proxy/passthrough.ts`) — an operation the route table knows is
      authorised against the caller's grant and then re-originated through the bound account's own
      request pipeline, with the upstream `Response` returned untouched. Hard denials refuse with any
      scope; a missing scope is a 403 naming it; an operation the spec marks unauthenticated needs no
      grant **if it is a read** (decision 76). One handler behind `matchRoute` rather than 297
      registered Hono routes — decision 74. Decisions 74–76.
- [x] **2.11 Forward proxy** (`:7776`, `daemon/src/forward-proxy/`) — a real HTTP proxy an app is
      *configured* with, for the apps that cannot be pointed at a different base URL. VRCX is the
      motivating case: it drives its HTTP through Chromium, which takes `--proxy-server=` and nothing
      else. `CONNECT` for an intercepted host is spliced into an internal TLS listener holding a leaf
      signed by a CA the daemon mints itself, so the traffic comes out in plaintext and is rewritten
      onto `:7774`; every other host is a blind byte pipe. Numbered out of order because it is a
      delivery mechanism for the mirror rather than a step toward it. Decisions 70–73.

- [x] **2.8 Rate budgets + audit + kill switch** — the **kill switch, the Connected apps page, and
      per-account/per-grant rate metering are done**: `GET /api/apps`, `POST /api/apps/:id/revoke`, `POST /api/apps/revoke-all`, and
      `ui/src/screens/ConnectedAppsScreen.svelte` behind `#/apps`. Revocation is per grant and closes
      the pipeline sockets that grant holds, since a socket authenticated once at its handshake would
      otherwise keep streaming a revoked app events. Per-grant rate budgets and the audit row per
      mutating call are still outstanding — but the *measurement* they need now exists
      (`net/request-meter.ts`), so a budget has something to enforce against. Decisions 86–90.
      **Scoped by the 2026-08-22 planning pass (decisions 95, 96, 100):** the budget is a rolling
      per-hour window per grant on `invite:send` / `friends:write` / `groups:invite` only, answering
      in VRChat's 429 shape; the audit log covers every mutating call *plus* reads behind a dangerous
      scope; and `rateLimit.remaining`/`queued` become real numbers off the limiter while the single
      gauge becomes the three ceilings that actually exist. Also here: the flaky control-deps test
      (decision 103) and the roster cap + low-priority budget (decision 102).
      **Audit rows and budgets are now built** (decisions 114–116): every mutating call and every
      read behind a dangerous scope writes an `audit_log` row attributed to the app, readable at
      `GET /api/apps/:id/audit` and shown per card on the Connected apps page; the three risky scopes
      carry a rolling hourly allowance per grant, refused with a 429 that never reaches VRChat.
      **2.8 is now complete.** The per-app *override* landed (decision 118): migration 004's
      `grant_budgets`, `PUT /api/apps/:id/budgets/:scope`, and an editable box per risky scope on
      each Connected apps card showing "n of m used this hour". So did the honest gauge from
      decision 100 (decision 117): `RateLimiter.snapshot()` reports real token counts and real
      waiter counts, `RateLimitSnapshot` became the three ceilings that actually exist, and the
      shell shows a queued badge only while something is waiting.
- [x] **2.9 Pipeline mirror** (`proxy/pipeline-mirror.ts`) — `wss://…:7774/` speaking VRChat's
      protocol, filtered per event type by the grant's scopes, fed from the daemon's single real
      socket per account. Frames are re-emitted **verbatim** and scanned before forwarding; a dead
      token gets VRChat's own `err` frame with the `authToken` and `ip` it echoes stripped. The token
      is read from `?authToken=`, `?auth=` (VRCX's spelling), or the `auth` cookie. Decisions 81–82.
- [x] **Housekeeping, before Phase 2 closes** — three items the 2026-08-22 planning pass created or
      confirmed, none of which belong to a numbered step. **`local.vrc.zip` is removed** —
      `ALLOWED_HOSTNAMES` is now `127.0.0.1` and `localhost`, and the hostname is asserted *rejected*
      by `hostGuard`, `originGuard` and `isLoopbackHttpUrl` rather than merely unused, since the
      launch URL carries the session token. The `useLocalDomain` setting, its wire fields and its
      Settings toggle go with it; see §Gotchas for what that removal turned up. The **flaky
      control-deps test** (decision 103) did not reproduce — seven consecutive full runs and
      eighteen targeted ones — and reading the path ruled out the usual mechanisms, so what landed
      is a hardening rather than a fix: it asserts on request *paths* instead of counts, so the next
      failure names the extra request instead of printing "expected 2, received 3". The
      **roster fallback is capped and budgeted** (decision 102): the eager batch stops at
      `EAGER_FILL_LIMIT` (24) and the tail hydrates on hover, and every one of those calls is
      charged at `"low"` priority, which reserves a quarter of each bucket for everything else.
      Decisions 112 and 113.
- [x] **2.10 Control API** (`:7775`) — consent status, grant list/revoke, the enriched event stream
      with `sessionId`/`accountId`/`displayName` on every `gamelog.*`, and webhook registration.
      **Scoped by the 2026-08-22 planning pass (decisions 97, 98, 99, 104):** webhooks ship *with*
      the stream rather than after it, which means this step carries a real outbound-HTTP subsystem
      (retries, backoff, dead-letter), not a route; unlinked sessions sit behind a dangerous
      `sessions:unlinked` scope; `GET`/`PUT /api/retention` and a real per-event-type Settings
      control land here, and the retention types move to `@vrcz/shared` with them; and the
      `invite-request` / `boop` palette stubs get their routes.
      **2.10 is now built.** The grant-authenticated surface is `/app/…` on the same port
      (decisions 134–136): `GET /app/sessions` behind `sessions:read` with unlinked sessions gated
      on `sessions:unlinked`, `GET /app/stream` carrying the enriched envelope through a
      default-deny per-event scope filter and closing when the grant is revoked, and
      `POST`/`GET`/`DELETE /app/webhooks`. The webhook subsystem is wired: the bus feeds it through
      `wiring/webhook-bridge.ts`, `app.ts` owns its lifecycle, and settled delivery rows are pruned
      by the retention pass after fourteen days. The three palette actions got their routes
      (decision 125). Retention is done end to end (decision 119) — `GET`/`PUT /api/retention`,
      `POST /api/retention/run`, the shared wire types, and a real Settings control that previews
      what a window would delete before anyone saves it, replacing the paragraph that used to
      apologise for its own absence. `StreamEnvelope` now carries `displayName` on every event
      (decision 121), and vrc.zip's own scopes exist (decision 120): `sessions:read`,
      `sessions:unlinked`, `webhooks:write`. **The UI half landed too** (decision 126): the three
      social actions are on every display name's menu and in the palette, and each app card on the
      Connected apps page lists the webhooks that grant has registered, with a Delete beside each.
      **Not yet done:** an end-to-end run against a real third-party client, which is verification
      rather than construction.
      **Alongside it (2026-08-22):** the command palette grew direct access — clipboard-first entry
      for any user, world, instance or group id or VRChat link, argument prompts for the same by
      hand, and the rest of the actions this build already supports (mark every notification seen,
      run the retention pass, copy a running client's location, toggle dense feed rows). Decisions
      122 to 125.

---

## Phase 3 checklist

`PLAN.md` §Phase 3 for the detail, and its §"Plugin build order" for *why this order*. The one item
worth restating here: **the deliberately hostile plugin comes third, immediately after the
supervisor.** Written later it would only validate a design already committed to; written there,
every claim after it — the deny-scan, the RSS watchdog, event-flood backpressure — is tested against
a live adversary as it is made. Decision 108.

The standing posture for the whole phase, from PLAN.md correction 6: **it is not a security sandbox,
and it is not going to become one.** Decision 182 cut OS-level sandboxing permanently rather than
deferring it, so "until it is one" is no longer the caveat — the docs and the consent UI say
"plugins run with your account's privileges; only install plugins you trust", and that stays true
for the life of the product.

- [x] **3.1 `@vrcz/plugin-api` types** — the published surface, versioned on the protocol major, with
      the daemon importing the same declarations so there is no drift. Four pieces: the manifest
      (a **Zod schema as the single source of truth**, with the JSON Schema, the consent UI and the
      docs reference generated from it), the RPC envelope protocol, the `UINode` vocabulary, and
      `NodeDefinition` plus the port-type lattice. All four landed with 124 tests; decisions 127–130.
      The dependency direction between them is one-way and load-bearing: `protocol.ts`, `ui.ts` and
      `nodes.ts` do not import `manifest.ts`, so nothing on the call path can consult what an author
      *requested* instead of what the user *approved*.
- [x] **3.2 `ProcessTransport` + supervisor** — `Bun.spawn` per plugin with `env: {}` behind a
      `PluginTransport` interface, spawned `--smol` unless the manifest opts out. Host-driven
      heartbeat whose echo lives in the injected prelude rather than in plugin code, RSS watchdog,
      activation and call deadlines, exponential restart backoff, crash-loop auto-disable.
      **Done**, plus the pieces it needed: migration 006 (installed plugins, immutable grants,
      dry-run lifts, crash history), `PluginRegistry` over the set, and a `PluginDisableStore` so an
      auto-disable survives a restart. Decisions 139–141.
      **The two Windows limitations are now closed** (decision 166): the OS memory cap is a Job
      Object assigned per plugin process through `bun:ffi`, verified to actually stop an
      over-allocating child, and the environment is an explicit four-name minimum with everything
      else blanked. `env: {}` turned out to be a *merge* on Windows rather than a replacement, which
      is why it never worked — see Gotchas.
- [x] **3.3 The hostile plugin** — spin loop, memory bomb, `import("node:"+"fs")`, event flood, and a
      lifecycle hook that never returns. The regression suite for everything above it.
      **Closed** (decisions 176–178): `hostile/hostile.test.ts` drives sixteen attacks through the
      real install pipeline, the real spawn resolver and a real supervisor, and **each test names
      the layer that stopped it** rather than only that it was stopped — two spellings of the same
      attack are caught by two different layers, so the stage is the assertion. ~8.0s, CI-safe.
      **Read decision 177 before trusting any of this**: four attacks are asserted as *gaps*,
      including that a plugin which gets past install reaches the whole filesystem. The prelude's
      global scrubbing, by contrast, measured stronger than assumed.
- [x] **3.4 Dispatcher, scope gate, rate budget** — one dispatcher doing arg parsing and the scope
      check, never the handlers. Every plugin call goes through the shared limiter tagged with the
      plugin id, with a subordinate per-plugin budget and a UI naming who is eating it.
      **Built** (decision 167): `scope-gate.ts` is the pure decision layer over the existing
      `authorizeCall`, `budget.ts` reuses the app-grant hourly window keyed by plugin id,
      `dispatcher.ts` owns arg parsing, deadlines, in-flight caps and an `onCall` audit hook, and
      `plugin-vrchat.ts` is the reads-only semantic surface — accounts, friends, users, worlds,
      instances, groups — at `"low"` priority with a `(accountId, path)` cache.
      **Wired** as of decisions 172–175: `wiring/plugin-host.ts` assembles the subsystem, `app.ts`
      owns its lifecycle, the supervisor has a public `send`, and five session-token routes on
      `:7775` install, list, enable, disable and uninstall. Verified against a running daemon — a
      plugin's own `vrchat.accounts.list` was observed going out through `send`, the dispatcher, the
      scope gate and the grant, and coming back.
      **Closed by decision 190:** the plugins page names what each plugin has spent this hour, per
      budgeted scope. The budget itself stays dormant until writes land, since all three budgeted
      scopes are writes — the readout says `0 of 60` and means it.
- [~] **3.5 Install pipeline** — `Bun.build` with `target: "browser"` and `external: []`, then an AST
      deny-scan over the *bundled output*, then content-addressing at `plugins/<id>/<sha256>.js` with
      the hash verified on every load.
      **Built** (decisions 168–170), under `daemon/src/plugins/install/`: `bundle.ts` (with the
      `onResolve` plugin that makes host-builtin imports the hard error PLAN.md claimed they already
      were), `deny-scan.ts` over the TypeScript compiler API, `artifact.ts` for content-addressing
      and the synchronous verify-on-load, `pipeline.ts`, and `spawn-resolver.ts` — which is where
      "verify the hash on every load" actually runs, since it is what `PluginRegistry` is
      constructed with. `runtime-fetch.ts` carries decision 111's hash-pinned fetch, its own zip
      reader, and the manual "use this bun instead" escape.
      **Wired** with 3.4 (decisions 172–175), and the verify-on-load claim was found to hold only
      on a cold boot until decision 173 fixed it — read that one, it is the sharpest defect of the
      round. A tampered artifact is now refused on enable, on restart and on a cold boot, verified
      by hand against a running daemon.
      **Not yet done:** the pinned-git-URL source (a fetch step in front of an identical pipeline)
      and the real SHA-256 pins. Read the deny-scan Gotcha before describing this as a boundary —
      it catches syntax, and computed access walks past it.
- [x] **3.6 Events bridge** — declarative filters compiled to closures at subscribe time, credit
      windows with a per-subscription overflow policy, per-tick batching, and a `dropped` frame when
      the host sheds load. `EventBus.emit()` must never await anything plugin-related.
      **Done** (decisions 180–181): `plugins/events-bridge.ts` plus `plugins/frame-budget.ts`, wired
      through `wiring/plugin-host.ts`, chaining after the dispatcher on the same frame hook.
      Verified against a running daemon on PLAN.md's own motivating case: **900 `friend.location`
      events in, three out** — each friend's current world — with the 897 reported as
      `dropped/coalesced` rather than hidden, while a second subscription kept flowing past the
      stalled one. `emit` of those 900 returned synchronously in 8.3ms.
      **Read decision 181 and the `permissions.events` Gotcha before 3.8**: backpressure needed a
      fourth mechanism in the plugin → host direction that PLAN.md does not name, and the event
      patterns shown on the consent sheet are not enforceable until the grant can carry them.
- [x] **3.0 The cuts, and the docs that describe them** — **done** (decision 183). OS-level
      sandboxing and Ed25519 signing are out of the plan; the `signing` manifest field is gone and a
      leftover one is refused with a message saying it was *removed* rather than mistyped; migration
      010 drops `plugins.trust` and `plugins.publisher_key`; `trust` is off the wire. All ten docs
      pages are corrected. **`GRANT_HASH_VERSION` did not bump** — `signing` was never hashed, so no
      grant's meaning changed; see decision 183. Two things the sweep turned up beyond the cuts: the
      banner on all eight pages had been false since 3.4/3.5 were wired (see §Gotchas), and both
      `security-model.md` and `status.md` claimed an "isolation" that no built layer provides.
- [~] **3.7 Storage** — one SQLite file per plugin in its own data dir. Uninstall is `rm -rf`, quota
      is a `stat`, and a plugin cannot lock or corrupt the daemon's WAL.
      **Scoped by decision 182:** capabilities become a real field on `PluginGrant` and on
      `GatedMethod` beside `scope` (the 006 column has been silently dropped by `liveGrant` all
      along); quota is a `stat` on `plugin-data/<id>/` checked **pre-write**, refusing `E_QUOTA`;
      the per-plugin DB gets its own minimal opener, not `Store`; `records` is key-prefix + time
      window + limit and the plugin does all its own pruning; a value is arbitrary JSON to 256KB;
      uninstall `rm -rf`s by default with a keep checkbox in 3.8. **Also here, and larger than the
      step's name suggests:** the prelude grows the *whole* `ctx` surface (`ctx.vrchat`,
      `ctx.storage`, `ctx.events`), which does not exist today in any form, plus 3.4's outstanding
      per-plugin budget readout.
      **Built** (decisions 184–186): capabilities are a real field on `PluginGrant` and on
      `GatedMethod`, refused with `E_CAPABILITY_DENIED`; `plugins/storage/` holds the minimal opener
      and the eight `storage.*` methods; uninstall deletes the data directory unless `?keepData=1`.
      The **`ctx` surface shipped as `@vrcz/plugin-api/runtime`** rather than in the prelude, which
      could not hold it — read decision 185 for the number that decided it, and **decision 186
      before adding any dependency to the published package**: importing the package root made a
      plugin uninstallable, because zod reaches the bundle and the deny-scan refuses it.
      **Not yet done:** 3.4's per-plugin budget readout, which needs a plugin screen to live on.
- [x] **3.8 Consent and management UI** — the account picker, the dangerous block behind a second
      toggle, hold-to-confirm, grants keyed immutably by
      `(pluginId, version, grantHash)`, and the dry-run lift as an explicit per-plugin per-scope
      gesture with the dry-run log beside it as evidence (decision 109).
      **Scoped by decision 182:** install **blocks** — `POST /api/plugins` parks until the sheet
      resolves — rather than queueing a pending row; migration 007 adds `events` to `plugin_grants`
      and `PluginGrant` so `permissions.events` finally means something (the Gotcha below);
      hold-to-confirm applies to **every** install now that signing is cut and no tier distinguishes
      anything, so `ui/` owes a press-and-hold primitive with a keyboard path; and the UI installs
      from a local path only, leaving the pinned git URL as 3.5's outstanding item.
      **Built** (decisions 187–189): migration 011 makes `permissions.events` enforceable, install
      parks on a consent broker that narrows and never widens, and `#/plugins` carries both the
      sheet and the management list with a real `HoldToConfirm`. Verified against a running daemon:
      a dangerous scope left unticked is absent from the stored grant, `ctx.storage` round-trips,
      and uninstall deletes the data directory. **Complete** as of decision 190: the dry-run lift
      is an explicit per-plugin per-scope hold, the budget readout names what each plugin has spent
      this hour (3.4's outstanding item, now closed), and an install with no UI client connected
      raises a toast and opens `#/plugins`.
- [x] **3.9 Declarative UI renderer** — forms, tables, dialogs, context menus and
      per-node click handlers. Charts follow rather than ship with it (decision 110).
      **Scoped by decision 182:** the tree rides `/api/stream` as a new frame type carrying a
      **keyed patch**, not a whole-tree replace; `table` **pages** through `PagedSection` /
      `ScrollSentinel` rather than virtualizing, so no windowing dependency and `MAX_TABLE_ROWS` is
      a ceiling and not a rendering promise; sort and filter are host-side over the rows the host
      holds; an intent marks its own node `busy` and leaves the rest of the tree live, with an
      inline error on `E_TIMEOUT` or a crash.
      **Host half built** (decision 191): `plugins/ui-panels.ts` holds every drawn tree, `ui.setPanel`
      / `ui.patchPanel` / `ui.closePanel` change it, `STREAM_PLUGIN_PANEL` carries changes to
      browsers, and `POST /api/plugins/:id/panels/:panelId/intent` sends a user action back through
      `ui.intent`. **Not yet done:** the Svelte renderer that draws a `UINode` tree, which is what
      makes any of it visible.
- [x] **3.10 Nodes** — plugin-contributed node types, registered from the same `NodeDefinition` the
      editor, the runtime and the type checker all read. **Scoped by decision 182: no editor here.**
      Registration, the runtime that arms triggers and executes actions, and `assignable()` enforced
      on save. `@xyflow/svelte` is not installed and the canvas is Phase 4's.
      **Done** (decision 194): `plugins/node-registry.ts` holds registrations, `validateNodeDefinition`
      rejects a malformed one (including a trigger with inputs), `nodes.register` / `nodes.fire` are
      the plugin's half, `onNodeArm` / `onNodeDisarm` / `onNodeExecute` are the host's, and
      `checkEdge` is the type checker Phase 4 calls on save.
- [x] **3.11 Scaffolder and docs** — `create-vrcz-plugin` with `bun run dev` wired to `vrcz dev`,
      plus the generated reference (scope table, manifest reference, event catalog, port matrix) and
      the hand-written mental model, guides, and security-model page.
      **The hand-written half landed early**, out of order, because without it nobody outside this
      repository can write a plugin at all — but see 3.0: its security-model page describes signing
      and a sandbox roadmap that decision 182 cut, so it is wrong now and gets rewritten first.
      `packages/plugin-api/docs/` carries the mental model, a
      getting-started walkthrough, the manifest, lifecycle, protocol, UI and node references, a
      cheatsheet, and the blunt security-model page PLAN.md asks for. Every page opens with the same
      banner saying plainly that a plugin cannot be installed or run yet, and `status.md` is the
      step-by-step account of what is real. Decision 142. **Still outstanding:** the scaffolder,
      `vrcz dev`, and replacing the reference pages with generated output so they cannot drift.
      **Scoped by decision 182:** `create-vrcz-plugin` and `vrcz dev` are both **modes of the
      shipped `.exe`** rather than an npm package, so there is no third artifact to version against
      the protocol major; and the reference pages are generated and committed **without** a CI drift
      check — the `packages/api` posture was declined because these are docs, not a client whose
      staleness ships wrong requests.

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
    *(**Revised by decisions 91 and 111.** The daemon ships as one compiled `.exe` and needs no Bun at
    all; only the plugin host does, and it fetches a hash-pinned one on demand rather than bundling it.
    The load-bearing half of this decision — never a `PATH` Bun, always the exact pinned runtime, and
    integrity is the whole point — is unchanged, and the content pin is now the only thing enforcing
    it.)*
9. **Plugin UI is a declarative JSON tree rendered by host components, with no escape hatch.** The host
   page holds the session token, and any plugin JS in that page can read it. An iframe-on-separate-port
   mode was drafted and **cut**: an escape hatch that exists gets reached for by default, eroding the
   design system one plugin at a time, and the isolation property would only hold for plugins that
   declined to use it. The trade is that we owe authors a genuinely complete vocabulary — charts,
   virtualized tables, dialogs, context menus, forms, per-node click handlers. Charts especially: they
   were the one legitimate reason anyone would have wanted an iframe. A genuine wall is answered with a
   **new host node type contributed upstream**, available to everyone.
10. **`127.0.0.1` is the runtime default; `local.vrc.zip` is opt-in.** *(Second half reversed by
    decision 101 — `local.vrc.zip` is cut entirely. The first half stands.)* Safety and zero dependencies win
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
24. **User icons are fetched by the daemon and served from `GET /api/image`, never loaded directly
    by the browser.** VRChat's image URLs need the account's auth cookie and the mandatory
    User-Agent, so a plain `<img src>` from the UI origin gets a 401/403 — the page cannot load them
    itself even in principle. The route is therefore the **one place the daemon fetches a URL its
    caller chose**, which makes it an SSRF boundary: the host allowlist is exact-match (no suffix
    matching, so `evil-api.vrchat.cloud.attacker.tld` fails), https-only, and size-capped. It is
    charged to the file rate tier, cached on disk by URL hash, and de-duplicated in flight. The
    upside beyond "it works at all" is that the browser never talks to VRChat directly, so no page
    load leaks the user's presence to VRChat outside the daemon's own honest traffic.
26. **Joining an instance uses a self-invite when a client is running, and `vrchat://` only when
    none is.** The deep link always launches a *new* client, which on a machine already running
    VRChat is the wrong action. `POST /invite/myself/to/{worldId}:{instanceId}` puts an invite
    inside the running game instead. When two linked clients are up and nothing indicates which
    should travel, the UI **refuses and says so** rather than falling back to the deep link — that
    fallback is the bug being fixed.
27. **The session token is stable in dev mode, and only in dev mode.** Rotating per boot is a real
    security property worth keeping shipped; under `bun --watch` it invalidates the developer's
    browser tab on every save. Reuse is gated on `process.execArgv` containing `--watch`/`--hot`,
    or an explicit `VRCZIP_STABLE_TOKEN=1`, and announces itself in the log — a stable credential
    that appears silently is how one reaches production.
32. **Users, worlds, and instances all get the same treatment: a small link with a tooltip that
    opens one shared modal.** Every display name is a `UserName`, every world a `WorldLink`, every
    instance an `InstanceLink`, and each modal is mounted exactly once at the root with a shared
    state module rather than one dialog per call site. Before this, a location outside a live game
    session rendered as `wrld_0ae3e886-52e…`, because a world name only ever arrived from the game
    log's `Entering Room:` line.
33. **World names resolve through a batching resolver, never per row.** A feed page is 100 rows over
    maybe 20 worlds; ids are coalesced within a microtask, chunked at the daemon's 50-id cap, and
    answered from one request. "Unresolvable" is a **cooldown, not a verdict** — the daemon answers
    from cache alone when no account is online and simply omits misses, so a permanent verdict would
    freeze every world name in the app for the session if the first page rendered before an account
    connected.
34. **The card banner is one shared component (`HeroBanner`) drawn unconditionally.** No-image is
    the common case for both users and worlds, so a band that only appears when an image exists puts
    the title and every row under it at two different heights and makes the common case read as the
    broken one. The image fades in *onto* the plate, and a failed load — the VRChat file host 403s
    often enough — leaves the plate exactly as it was. Nothing below ever moves.
35. **A filter over a paged list says so.** The Groups tab holds everything, so its search is
    complete; mutual friends are paged, so that search states how many are loaded. A search box that
    quietly returns "no match" while an unloaded page holds the answer is worse than no search box.
36. **Profiles are cached in a resolver and fetched on hover, never on render.** `user-profiles`
    is the sibling of `world-names` and `instance-info` and obeys their rules: `entry()`/`get()` are
    pure and safe inside a `$derived`, `ensure()` is the only thing that fetches, and a recent answer
    is reused. The split matters most on `UserName`, which a feed page mounts a hundred of in one
    frame — the hover card asks from `onOpenChange`, so a request means a person pointed at a name.
    Live sessions is the one screen allowed to `ensure()` from an `$effect`, because its set is the
    game clients running on this machine and cannot grow past a handful. Profiles are keyed by user
    **and** by the account they were read through: `isFriend` is a statement about the asking
    account, and VRChat sends a shorter body to a non-friend, so merging two accounts' answers would
    invent a third that neither gave.
37. **A tooltip and a context menu cannot share a trigger, so the menu wraps in `display: contents`.**
    Both bits-ui primitives want to own the element and their prop bags collide on `id`,
    `data-state` and three pointer handlers, so spreading one over the other silently drops whichever
    lost. bits-ui does not re-export `mergeProps` (it comes from `svelte-toolbelt`, which is not a
    declared dependency of `@vrcz/ui`). They are split by what each actually needs instead: the
    tooltip keeps the button, because hover is hit-testing and has to be a real box, and the context
    menu becomes a wrapper carrying `contents`, which generates no box and so changes no layout.
    Every event the menu listens for bubbles to it, and it opens at the pointer's coordinates rather
    than against the trigger's rectangle, so having no rectangle costs it nothing.
38. **Overlays are all one surface: `bg-popover` with `ring-1 ring-foreground/5`.** Dialog, dropdown,
    context menu, select, command and now popover and tooltip. `--popover` is a step lighter than
    `--background` in the dark theme and that is the whole point of the token — a panel floating over
    the page has to read as a different plane. The tooltip is the app's *rich* hover surface, not an
    inverted chip: `WorldLink` and `UserName` both put an image, a name and an id inside one, so
    shadcn's default `bg-primary` (near-white in this dark theme) was never going to fit.
39. **The three entity modals share one screen and a back stack.** They are separate singletons but
    they were never separate *places*: opening a group from a profile left the profile mounted
    underneath, so two dialogs stacked, two scrims doubled into near-black, and the X closed the top
    one onto a subject the reader had already navigated past. Opening anything now sets aside what
    was showing and pushes a way back to it; every close gesture pops one level, and closing the
    last one dismisses. `close()` **is** the back button — one control, because there is one thing
    it can mean — and the banner names the level below so that a close which reopens something
    reads as navigation rather than as a bug. Coming back is usually free: a modal that was
    suspended rather than re-targeted still holds its subject, so its own `open…` guard keeps what
    is loaded. Only a chain through the same modal — profile to profile through mutual friends —
    re-reads, because a singleton cannot hold two subjects. The stack is capped at 16 and drops the
    oldest, since nothing else bounds a click-driven chain.
40. **A freshness window is about age; a join is about completeness.** The instance roster reused an
    answer for fifteen seconds, which is right for "is this snapshot stale" and wrong for "does this
    snapshot describe everyone in the room" — so somebody walking in got a bare name until the
    screen was rebuilt, and the effect that fired on their arrival was declined for being too soon.
    An answer that does not describe a player the log is reporting is now treated as incomplete
    rather than recent: it skips the window, subject to a three-second floor so forty people loading
    into a fresh instance is one request and not forty. A request the floor declines is **re-armed
    for the moment it stops being declined**, because otherwise a join inside the floor is the same
    bug three seconds to the left. Only ids count toward "missing" — a log line with no user id
    could never be looked up and would hold the refetch permanently open.
41. **A live profile read writes back into presence.** `GET /users/{id}` is the freshest reading of
    a person the daemon ever has — fresher than the friends poll, which runs on an interval, and
    fresher than the last socket frame, which fires only when something changed *and* the socket was
    up to hear it. Discarding it meant the friends list could sit on a stale status while a card
    opened over it showed the true one, from the same daemon, seconds apart. `PresenceService.observe`
    takes it, under two rules that keep it from becoming a way to invent friends: it only ever
    updates a record that **already exists**, because presence *is* the friends list and
    `GET /users/{id}` answers for anybody; and it writes only fields VRChat actually filled in,
    because the body is shorter for a non-friend and `""` is how VRChat spells nothing. It reports
    whether anything changed, and only a change is announced — otherwise every hover would emit an
    event and every event would send the friends list back for a refetch. Only the live branch
    primes; a cache hit is as old as its row and would push stale status over a socket frame that
    had already corrected it. `friend.presence` is ephemeral in both the daemon's feed writer and
    the UI's mirror of that list: it is a cache reconciliation, not something that happened to
    anybody.
42. **Mutual friends take their status from presence, exactly as they take their trust rank.** The
    spec gives `MutualFriend` a `status` and VRChat sends it empty, the same way it specifies `tags`
    and sends none. Defaulting the empty one to `"offline"` rendered every mutual friend as offline,
    always. A mutual friend is by definition one of this account's own friends, so presence is
    already holding a live answer and it costs no request. VRChat's own value still wins when there
    is one — it is from this instant.
43. **The roster shows a chosen status, and never an offline one.** The instance roster had a
    platform column that printed the literal word "offline" — `platformLabel` passes an
    unrecognised value through so a platform VRChat invents next year still appears, and VRChat puts
    `"offline"` in that field. The column is gone; the status it was accidentally reporting is now a
    dot on the avatar, where it belongs. **Presence is not the question on this list**: the game log
    has these people standing in a room, which is a better answer than VRChat's and arrives sooner,
    so `chosenStatus` returns null for `offline`, for `""`, and for anything this build does not
    recognise, and the badge is simply not drawn. What a status adds here is what somebody chose to
    tell people — join me, ask me, busy — and nothing else. The friends screen deliberately does not
    use it: there, offline *is* the answer, and a grey dot is right. The daemon passes VRChat's word
    through untouched either way; it has no log to weigh it against, so it does not guess.

29. **Notifications are backfilled over REST, not sourced from the socket alone.** The pipeline is
    the reason the screen is live; it is not, and cannot be, the reason it is *correct*. Both
    generations are fetched because each carries categories the other does not — friend requests
    and invites in v1, group announcements and boops in v2 — and fetching one leaves a whole
    category permanently missing, which is indistinguishable from the bug this fixed.
30. **Roster attributes come from the instance, not from N user lookups.** `GET /instances/{id}`
    returns `users[]` with trust tags and age verification for everyone at once; forty per-user
    calls per session would be the obvious implementation and the wrong one.
31. **`hidden` age verification renders nothing, exactly like unknown.** VRChat's `hidden` means
    *verified but not published*. Collapsing it into a boolean would make a missing badge look like
    a claim that a real person is unverified — a claim we are not entitled to make.
32. **One modal shell, three cards.** `EntityModal` owns the dialog, the three-row grid, the banner
    band and the header; `UserModal`, `WorldModal` and `GroupModal` own only their bodies. The three
    had been copies of each other and had already drifted — two header offsets, two title behaviours,
    two banner heights, two scroll containers — none of it decided by anybody. `EntityModalState`
    does the same for the state side: the abort/generation pair, the phase and failure vocabulary,
    and the dedup helper. The wording of every failure stays with its own modal, because
    "no account is online" genuinely means something different in front of a profile, a world and a
    group, and collapsing those into one sentence would be the opposite of the point.
33. **The group modal exists, and `GET /api/groups/:id` is not cached.** A world is the same record
    whoever asks and changes on a release cadence, so `world_cache` is right for it. The two figures
    worth opening a *group* card for are the online member count and this account's own membership
    status; a cached answer would be neither. A 404 is `unknown_group`, never `unknown_user`, and its
    sentence names both causes — deleted, or private to this account — because VRChat answers them
    identically and guessing in front of a user who can see the group on their own screen would be a
    confident wrong answer.
34. **The header outranks the banner's scrim, and that is a z-index fact, not a colour one.** The
    display name was being sliced in half horizontally. First diagnosis was contrast, and the fix
    was a near-opaque scrim — which worked and ate most of a world's hero image in gray. The real
    cause: the scrim is an `absolute` child and the header was static, and absolutely-positioned
    elements paint over static in-flow content **whatever the DOM order**. `EntityModal` gives the
    header `relative z-10` and the scrim went back to being a gentle fade.
35. **`GET /instances/{id}` returns `users` only for instances the account *created*.** Not for
    instances it is standing in — which is what the code, its comments, and the sentence shown to
    the user all claimed. Verified against a live group-public instance the account was sitting in:
    `userCount: 16`, no `users` array, matching the spec's one-line note on `Instance.users`. That
    makes `source: "unavailable"` the answer for essentially every room anyone looks at rather than
    an edge case, so the roster's fallback below is not an optimisation — without it the chips are
    permanently empty.
36. **The roster falls back to one lookup per person, and only as a fallback.** `GET /api/users?ids=`
    reads the log's observed players individually, cache-first, sequentially, capped at 80. It runs
    only after the one-request path has said it has nothing, only for ids the log recovered, and
    only for people not already described — which is the whole of decision 30's argument still
    standing: forty per-user calls is the wrong *default*, not the wrong last resort. It never
    throws for an unreadable user and never 503s: absent from the list is the contract, as with the
    world batch. The screen says which way the chips were filled rather than implying VRChat
    answered.

28. **Sessions are the store's business, not just the watcher's.** Retroactive attribution, the
    orphan sweep, and re-adoption all write through the store, because the UI reads sessions back
    over HTTP rather than from the live watcher. Anything the API re-reads has to be persisted, not
    merely broadcast — see §Gotchas.

25. **Scope creep declined: the friends list is not virtualized yet.** bits-ui preloads avatars
    eagerly (see Gotchas), so a very large friends list front-loads its icon fetches. The file rate
    tier absorbs it and the disk cache makes it once-ever, so this is a real but bounded cost — and
    virtualizing a list is a change worth making against a measurement rather than a guess.

23. **The EventBus fans out by prefix bucket, and `emit()` never awaits.** Async subscribers are
    observed only to route rejections to `onError`. A slow subscriber must not stall the pipeline
    reader, because a socket that stops draining is a socket VRChat eventually closes.
40. **A repo-root `CLAUDE.md` orients coding agents; this file stays the source of truth.**
    It carries the `desktop-app` / `backend` split, the commands, the three-server shape, and the
    invariants and gotchas that are load-bearing — all distilled from here and `PLAN.md`, not
    restated in full, so there is one place a fact lives. It also records the working rules: commit
    every noticeable change authored solely by the user with no Claude trailers, stage only the
    files the agent itself touched, push once a group of commits is done, and **update this file in
    the same commit as the change it describes**. A `PROGRESS.md` edit deferred to a later pass is a
    `PROGRESS.md` edit that does not happen, and Gotchas is exactly the section with no failing test
    behind it.
45. **Grant tokens and pairing codes are stored hashed, not in plaintext.** The issued cookie is
    `authcookie_<uuid>_vrczip` and the uuid *is* the secret, so a readable `grants` table would be a
    table of live bearer credentials. Lookup hashes the presented value and selects on `token_hash`;
    the plaintext is handed to the app once and never written. Plain SHA-256 rather than a password
    KDF: it is a 122-bit random value, not a user-chosen secret, so there is nothing for a slow hash
    to defend against and it would put a deliberate delay on the hot path of every proxied request.
    A separate non-secret `id` is what the UI, the audit log, and revocation name.
46. **The egress filter wraps the fetch handler; it is not Hono middleware.** PLAN.md §Phase 2 calls
    it "the last middleware in the chain", and that turns out to be unimplementable in Hono — see
    Gotchas. Wrapping the handler in `bindServer` puts it outside the framework, where nothing can
    merge headers back onto its response, and it covers Hono's own 404 and error responses, which
    never run a route's middleware at all. It is mounted on **both** `:7774` and `:7775`, since the
    invariant names both ports. A successful WebSocket upgrade passes through untouched: Bun has
    taken the socket over by then and the returned response is a formality. Frames get their own
    scan in the pipeline mirror, which has to look at them anyway.
47. **Revocation is enforced in SQL, not by the caller.** `getGrantByTokenHash` carries
    `AND revoked_at IS NULL`, so a revoked token resolves to nothing rather than to a row with a
    flag some future call site forgets to read. Revoked rows are kept rather than deleted — the
    audit log references them, and "this app had access between these two times" is exactly the
    question a user asks after something goes wrong.
48. **Reads are not audited; mutations are.** Recording every proxied `GET` would bury the rows that
    matter under roster polling, and a read is not the thing anyone needs evidence of. `grant_id` on
    `audit_log` is deliberately not a foreign key: a denied call may have no grant at all, and a
    revoked grant must not take its history with it.
54. **Device trust is the only thing that skips a consent sheet — an existing grant is not.** Any
    local process can send another app's `User-Agent`, so treating "this app already has a grant" as
    proof of identity would hand a working token to whoever asked in its name. The `twoFactorAuth`
    cookie is the thing an impersonator does not have, which is what device trust means upstream
    too. It is checked against the app identity *and* the named account, and it never covers a wider
    scope than the grant it belongs to — an escalation re-prompts even on a trusted device, because
    the new ask is the entire point of the sheet.
55. **A re-login issues a new grant rather than rotating the existing one's token.** Rotation would
    kill a running instance of the app mid-request, and PLAN.md's escalation flow promises the
    existing grant keeps working throughout. Both appear in "Connected apps" and either can be
    revoked. The cost is that a long-lived app accumulates grant rows; the UI groups them by app.
56. **The proxy sets its own cookies through marker headers the egress filter converts.** `Set-Cookie`
    is stripped unconditionally on the way out, which would otherwise make the handshake unable to
    set the one cookie the whole flow depends on. Rather than weakening the strip into a judgement
    call, a route names the value in `X-Vrcz-Set-Auth` / `X-Vrcz-Set-Two-Factor` and the filter
    writes the header. The strip stays unconditional, the value is checked to be a `_vrczip` token
    before it is emitted, and the cookie attributes live in one place — so no route can forget
    `HttpOnly`.
57. **The mirror advertises exactly one 2FA method and accepts all three verify paths.** Advertising
    `["totp"]` alone: a client offered several may prompt for a choice when there is only one thing
    to type, and one offered `emailOtp` may sit waiting for an email that is never coming. Accepting
    all three verifiers anyway, because the code being typed is a vrc.zip pairing code regardless of
    which endpoint a client prefers, and refusing its preference would break it for no gain.
58. **Pairing codes live in memory; the store keeps only their hash.** A six-digit code sitting in a
    readable table is a bypass of the consent gesture. A daemon restart therefore drops every
    pending code, which is correct — they expire in five minutes and an app simply logs in again.
    The `consent.pending` / `consent.resolved` bus events are **ephemeral**: `pairing_requests` is
    already their durable record, and the feed is otherwise about what happened in VRChat.
59. **Reaching the user is two channels, and which one runs depends on whether anyone is watching.**
    A Web Notification only fires from a loaded page, which is precisely the case a consent prompt
    cannot assume — the flow exists because the user may be elsewhere. So: a UI client connected
    (`ControlDeps.streamClientCount() > 0`) means the app handles it and the daemon stays out of the
    way entirely; nothing connected means an OS notification *and* an opened browser tab. Both, not
    either: a Windows toast cannot carry a click handler without a registered AppUserModelID and a
    COM activator, which needs an installer (Phase 5), so the tab is what actually delivers the user
    and the toast is what explains why one just opened. Opening a tab on top of an app the user
    already has open is the kind of "help" that trains people to close things unread.
60. **The OS notification shims are spawned argv, never shell strings, and are best-effort.** The
    app name and contact in them come off a third-party `User-Agent`, so they are attacker-influenced
    text; a toast is not worth a command injection. On Windows the text goes through `$env:` rather
    than being interpolated into the PowerShell script, because PowerShell has its own quoting rules
    on top of the argv boundary. `openUrl` refuses anything that is not loopback HTTP — the URL it
    opens carries a session token, and without that check it is a general "launch whatever this
    string says" primitive. Every failure is silent: headless boxes, containers, and desktops with
    notifications off are all normal environments and none is a reason to fail a login.
61. **The pairing code never rides on the bus.** `consent.pending` carries the app identity and the
    scopes; the code is read from the registry by the daemon's alert path and from the control API
    by the UI. The stream fans out to every client and, later, to plugins, while the code belongs
    only behind the session token — and it is the whole proof-of-presence the flow rests on.
41. **The pipeline endpoint is injectable, and there is a fixture socket behind it.**
    `startDaemon({ pipelineUrl })` joins `baseUrl` as a test seam, and
    `daemon/src/testing/pipeline-fixture.ts` is a real `Bun.serve` WebSocket rather than an injected
    `createSocket`. Same reasoning as the REST fixture: what goes wrong on this path is
    handshake-level — the `?authToken=` query value and the mandatory UA on the upgrade — and a
    stub that hands the client a socket object proves neither. It is also the only way the Phase-1
    definition-of-done clause "two independent pipeline sockets" is testable at all; before this,
    nothing in the suite ever constructed two `PipelineClient`s.
49. **`GET /profile/{id}` supplements `GET /users/{id}`; it does not replace it.** The claim going
    around is that `/users/` is deprecated in favour of `/profile/`. It is not — spec v1.20.8 marks
    29 operations `deprecated` and `getUser` is not among them — and the two are different
    resources. `PublicProfile` carries the profile *page*: badges, languages, VRC+, banner colour,
    a thin represented group. It carries **no presence at all** — no `location`, `state`,
    `last_login`, `platform`, or `travelingTo*` — so migrating onto it would blank live presence,
    the friends screen, and the live-profile-read reconciliation in one move. So the modal reads
    both: the user record for what someone *is doing*, the profile for what they *chose to show*.
    It rides in the same `user_cache` envelope (now `v: 3`) under the same TTL as the user body,
    for the same reason the represented group does, and it is best-effort — a `null` card means
    "no answer", never "no badges", and the modal renders complete without it.
50. **The profile card pays for its own request.** `PublicProfile.representedGroup` settles whether
    the user represents a group at all, and for most people the answer is no — so a `null` there
    skips the `/users/{id}/groups/represented` call that used to run on every cold profile. Two
    upstream calls on the common path, three only for someone actually representing a group. The
    profile's group shape is used strictly as a **predicate**: it has no member count, short code,
    or privacy, so the rich value still comes from the group endpoint. When the profile call fails,
    the group is fetched unconditionally, exactly as before — a missing supplement never costs a
    field the modal already had.

62. **`JsonValue` is shared, and "the control API owns no foreign types" was the right rule aimed at
    the wrong type.** Both copies — `pipeline/events.ts` and `servers/control.ts` — carried a comment
    explaining why they were local, and the control API's read was a real principle: a wire module
    should not borrow a shape from another subsystem. JSON is not that kind of shape. It is not
    another subsystem's type, it is the shape of the wire itself, and every module that touches the
    wire needs the same one. The two declarations were structurally identical, so they type-checked
    against each other silently and the duplication cost nothing right up until one of them would
    have grown a branch the other lacked. `decode.ts` also held a private `isJsonObject` identical to
    the one now in `@vrcz/shared`, so this was a genuine dedupe rather than a move — the `null` case
    that guard exists for is the kind of thing you want written down once.

63. **The bus vocabulary is `@vrcz/shared`'s, and `BusEvent.kind` is narrow while `EventKind` stays
    wide.** Producers take `BusEventKind`; consumers take `EventKind = BusEventKind | (string & {})`.
    The asymmetry is the whole design. A daemon inventing a kind by typo is a bug that costs nothing
    to make and is nearly invisible — the event still emits, still dispatches to any `prefix.*`
    subscriber, and still writes a feed row — so emission is where the strictness belongs. Display is
    the opposite case: an event from a daemon newer than the bundle must still list in the feed and
    still match a filter rather than vanish, so `eventLabel` and `familyOf` are total over `string`
    and `familyOf` answers `other` instead of throwing. `BUS_EVENT_KINDS` is a runtime array beside
    the union with a `satisfies` in one direction and an `Exclude`-based marker
    (`EVENT_KIND_COVERAGE_NOTE`) in the other, so the two cannot drift apart in either direction.

64. **`ui/` gets Vitest, and the root `bun test` stops globbing it.** The UI had no test runner and
    no tests, and the gap was not theoretical — the duplicate-`{#each}`-key crash, the resolver
    that re-requested on render, the `SvelteMap` that froze the live roster, and the blank feed
    label for an unlabelled kind all shipped through it. Vitest rather than `bun test` because the
    modules under test are `.svelte.ts`: runes are *compiler syntax*, so they need the Vite plugin
    pipeline, which `bun test` has no way to run. Two consequences worth knowing before writing the
    next one:
    - `ui/vitest.config.ts` is a second config, not a `test` block on `vite.config.ts` — a unit run
      wants neither Tailwind nor the `/api` proxy, and it needs `resolve.conditions: ["browser"]`,
      which the dev server gets for free.
    - The root `test` script is now `bun test packages daemon tools`, and `test:ui` runs the UI
      suite. Bun's runner globs `**/*.test.ts` from the root and would otherwise try to execute
      Vitest files with no `vi`, no `describe` and no rune compilation. Naming the three
      directories is the smallest fix that keeps one command per runner.

65. **Constants that both sides need live in `@vrcz/shared/config`, and the launch URL had a real
    escaping bug behind the duplication.** `TOKEN_QUERY_PARAM` was a named constant in
    `security/guards.ts` and a bare `"token"` literal in three UI call sites; the three default ports
    were declared in `servers/bind.ts` and re-declared numerically in `settings.ts`. Hoisting them
    turned up the thing duplication usually hides: `app.ts` had reimplemented `bind.ts`'s
    `launchUrl` inline and **dropped the `encodeURIComponent`**. That string is what the daemon
    prints as "Open: …" and stores on `RunningDaemon.launchUrl`, so a session token containing `+`,
    `&`, or `#` arrived back altered, failed `sessionTokensMatch`, and dropped the user into an
    unauthenticated UI with nothing on screen explaining why. One `launchUrl()` in shared now, with
    a test that pins the escaping.

66. **The wire types are `@vrcz/shared`'s, and the daemon had been typing its *deps* rather than its
    *routes*.** That distinction is the whole finding. `ControlDeps.verifyTwoFactor` was typed as
    returning a `ControlAccount`, but the route wrapped it in `{status, account}` — so the shape that
    actually crossed the wire was written down only in `ui/src/lib/api.ts`. The stream envelope was
    worse: it had no type at all on the daemon side, built inline through two `as` casts, leaving the
    UI holding the only description of the daemon's own frame format. Both sides now build and read
    one interface. Wire types are `readonly` throughout, which forced `GET /api/events` to build its
    `EventQuery` in one expression instead of mutating an object into shape — a better route anyway,
    since `exactOptionalPropertyTypes` makes "absent" and "present and undefined" different things
    and `listEvents` branches on absence.

67. **CI is one path-filtered workflow at the repo root.** `.github/` is shared ground with
    `backend/`, a separate project, which is why this sat as an open question rather than being
    added quietly. The resolution is `.github/workflows/desktop-app.yml` gated on
    `paths: ['desktop-app/**']`: it lives on shared ground but can only ever fire for this project,
    and `backend/` can drop a sibling file beside it without either needing to know the other
    exists. Every gate runs `if: !cancelled()` so one failure does not mask the rest, and the Bun
    version comes from `.bun-version` rather than being written a fourth time. Both test runners
    run: `bun test` for daemon/packages/tools, Vitest for `ui/`.

68. **The group screen is a route; the group modal stays a card. Both, on purpose.** The modal is
    what a represented badge or a profile row opens — one glance, no navigation, and it now hands
    off rather than sending people to vrchat.com for members and posts. The screen (`#/groups/<id>`)
    is where the four paged lists live, because infinite scroll inside a dialog that shares a back
    stack with two other dialogs is a fight with the shell rather than a use of it. Navigating out of
    the modal calls `dismiss()` rather than `close()` — its first real caller — since a route change
    invalidates every level of that stack, not one.

69. **A 403 is a first-class UI state (`forbidden`), not an error.** Most VRChat groups show their
    member list and posts only to members, so a 403 is the *ordinary* answer for a group you have not
    joined. It renders as a sentence saying membership is required, **with no retry button**: no
    number of retries acquires membership, and a button that cannot work invites the reader to
    conclude the app is broken. The tab still renders either way — hiding it would read as a vrc.zip
    bug to anyone who can see that same list on vrchat.com. `classifyFailure` gained the case and
    `isForbidden` the predicate.

70. **The forward proxy terminates TLS with a CA the daemon mints itself, and there was no way
    around it.** `:7774` asks an app to change its base URL, which is fine for a library and
    impossible for VRCX — Chromium takes `--proxy-server=` and nothing else. A proxy-shaped port is
    the only delivery mechanism those apps have, and since VRChat is HTTPS, every request through it
    arrives as `CONNECT api.vrchat.cloud:443`. Rewriting that onto a plaintext mirror means being the
    TLS server for a hostname we do not own. The alternatives were both worse: blind-tunnelling
    `CONNECT` sends the traffic to real VRChat and the proxy does nothing, and refusing it leaves the
    port useful only for the plaintext absolute-form nobody sends.

71. **The X.509 issuer is ~200 lines of hand-rolled DER, not a dependency.** Neither Bun nor
    `node:crypto` can *issue* a certificate — `X509Certificate` parses, it does not sign. The choices
    were a pure-JS PKI package, shelling out to an `openssl` that is not present on a stock Windows
    box, or writing the encoder. X.509 is a fixed structure and we emit exactly one shape of it, so
    the encoder has no parser half — which is where the interesting ASN.1 bugs live. It is verified
    against a real TLS handshake under strict verification rather than only structurally, because
    "parses" and "a client accepts it" are different claims and only the second one matters.

72. **Only the hosts the mirror actually serves are decrypted; everything else is a blind pipe.**
    The leaf's SANs are exactly the intercept set, which is also what stops a client from coalescing
    an unlisted origin onto an open connection. And it is a *setting* rather than a constant, because
    the mirror does not serve all of it yet: dropping `pipeline.vrchat.cloud` leaves an app's event
    socket pointed at real VRChat while its REST calls come from vrc.zip, which is the useful posture
    until 2.9 lands. Decrypting more than we serve would be reading a user's unrelated traffic for no
    benefit.

73. **Origin-form requests are never routed to the mirror, and that is the boundary.** The proxy sees
    three request shapes and answers each differently: `CONNECT` is intercepted or tunnelled,
    absolute-form is rewritten onto the mirror, and origin-form (`GET /`) gets the setup page and the
    CA download and nothing else. Origin-form is the **only shape a web page can produce** — a page
    cannot set a proxy, cannot send `CONNECT`, and cannot write an absolute-form request line. Making
    that the non-routing case is what keeps a drive-by page off the mirror structurally, rather than
    by a header check it could satisfy.

74. **The pass-through is one handler behind `matchRoute`, not 297 registered Hono routes.**
    `PLAN.md` §1.8 asked for per-operation registration, for two properties: an unknown path must
    reach VRChat's real 404 rather than a catch-all's guess, and an operation with no scope mapping
    must fail to register. Both already hold — `matchRoute` returns null for a path the table does
    not know, and the codegen test asserts every operation maps to exactly one scope — so registering
    the table into Hono would buy nothing and cost something real: it would have to translate
    `/instances/{worldId}:{instanceId}`, two parameters and a separator inside one segment, into a
    router whose matching rules differ from the table's. Two matchers that have to agree is a worse
    position than one, and the one we have is the codegen-derived, tested one.

75. **The request is re-originated, never relayed.** The app's `Cookie`, `Authorization`,
    `User-Agent` and `Origin` are all discarded and the daemon substitutes the bound account's real
    jar and vrc.zip's own UA, so VRChat sees a vrc.zip request — which is what it is. Forwarded
    headers are an **allowlist** (`content-type`, `accept`, `accept-language`, the two conditionals,
    `range`) rather than a blocklist, because the failure directions are not symmetric: a header we
    forget to forward is a feature that does not work, and a header we forget to strip can be a
    credential reaching VRChat on the user's behalf.

76. **The spec's `security` list is not a safety judgement, so the no-grant path is reads only.**
    `GET /config` has to work without a grant — a VRChat client fetches it *before* it logs in, so
    requiring one deadlocks every real client against a handshake it has not run, and this is exactly
    where VRCX stopped. But 16 operations carry `security: []` in v1.20.8 and two of them are
    `POST /auth/register` and `POST /worlds`. Reading that field alone would let an app create a
    world through the mirror with no grant, no consent sheet, and no scope. VRChat would reject the
    sessionless request, so it is a hole in intent rather than in effect — and a hole in intent stops
    being harmless the moment the spec is regenerated. Requiring a grant for anything that is not a
    read closes it once, including for operations added later.

77. **A password in the scope field falls back to the default scopes; a typo among real scopes is
    still a hard 400.** `PLAN.md` claims a stock VRChat client library works unmodified *and* that an
    unknown scope string is a hard failure, and those two were in direct contradiction: an unmodified
    client puts a **real password** in that field, because it has never heard of vrc.zip. Reading
    `hunter2` as a typo'd scope made login impossible for exactly the clients the mechanism exists to
    support. The two cases are distinguishable — `friends:reed` names a resource the registry knows
    and a verb it does not, a password names nothing — so the typo case keeps its hard failure and
    only the "this was never a scope list" case falls back. Safe because nothing is granted without
    the consent sheet and the pairing code either way, the fallback set is minimal and read-only, and
    the password is parsed and discarded, never stored or forwarded.

78. **`files:read` is in `DEFAULT_SCOPES`.** Every avatar, icon, and banner in a VRChat client is a
    `/file/` or `/image/` fetch, so without it the default grant produces an app whose every picture
    is a 403 — technically a correct minimal grant and practically a broken client.

79. **Proxy request logging is opt-in via `VRCZIP_PROXY_LOG`, and redaction lives in the logger.**
    Three levels: `basic` (one line per request), `headers`, `body`. It exists because every bug
    reported against this proxy so far was diagnosed by reconstructing that line by hand, and because
    the facts that matter are all inside the daemon — which operation a path resolved to, whether a
    grant was found, what upstream actually said. The line that earns it is `-> 404 (no route)`,
    which distinguishes a route-table gap from VRChat's own 404; those are the same three digits and
    completely different problems, and confusing them is what hid the missing `/file/` and `/image/`
    routes.

    **Redaction is the logger's responsibility, not its callers'** — the same rule PLAN.md states for
    the egress filter, for the same reason: a call site that has to remember will eventually forget,
    and the consequence is a real VRChat session in a log the user pastes into a bug report. So it
    takes whole `Headers` and whole bodies. Cookie values are never printed, only names plus whether
    the value was ours or a real VRChat credential; `Authorization` shows its scheme only, because on
    the login path it decodes to the user's real password; every `authcookie_` run is replaced
    wherever it appears; and `password`/`code`/`secret` fields in JSON bodies are blanked, the
    pairing code being a consent credential. Startup warns when it is on, since what survives
    redaction still shows which accounts and apps are in use.

80. **The `User-Agent` rule was rejecting clients VRChat itself accepts.** `PLAN.md` read VRChat's
    *mandate* of `AppName/Version contact` as something to enforce, so anything else got VRChat's
    `waf_code 13799` 403 — "the correct behaviour to teach". It was not: VRCX sends
    `VRCX 2026.07.18`, no slash and no contact, and works fine against the real API. The proxy was
    teaching something false and locking out the client the mirror most exists to serve, at the very
    first request of a login.

    The parse is now best-effort over the shapes real clients send, and the **contact is optional**.
    That costs nothing, which is the part worth remembering: the app's UA never reaches VRChat, because
    the request pipeline always substitutes `vrc.zip/<version> (<user contact>)` so traffic is honestly
    attributed. The contact was therefore never part of VRChat compliance — it only labelled a consent
    sheet, and a name and version label one fine. A placeholder contact is dropped to empty rather than
    failing the app, the same judgement as before applied to a now-optional field.

    The half of the old rule that survives is a UA naming **no app at all**: absent, or a bare HTTP
    library (`python-requests`, `curl`, `okhttp`, …). Those name a library rather than something a
    user could recognise on a consent sheet, and VRChat's WAF really does block several — so that 403
    is both byte-faithful and true. The consent screen renders a missing contact and a missing version
    explicitly, rather than trailing off into nothing.

81. **The pipeline mirror re-emits the frame verbatim, so `DecodedPipelineEvent` carries it.**
    Rebuilding `{type, content}` from the parsed payload would be *almost* identical, and almost is
    the wrong standard for a surface whose whole contract is byte-fidelity: key order and whitespace
    would drift, and the three event types whose `content` is a bare id string or absent entirely —
    `see-notification`, `hide-notification`, `clear-notification` — are precisely where a rebuild goes
    wrong. Those are the same three the plan calls out as the bug in the `vrchat` npm package. So
    `decode.ts` keeps the original text alongside the parsed `raw`, and the mirror forwards it.

    Scopes are `Record<PipelineEventType, Scope>` rather than a map with a fallback, so a new event
    type VRChat ships fails to compile until someone decides what seeing it should cost. A default
    would have quietly forwarded whatever came next.

82. **VRCX opens the pipeline as `?auth=`, not `?authToken=`.** VRChat documents the latter and VRCX
    sends the former; both are accepted, along with the `auth` cookie, since a browser-based client
    cannot always set a query string on a socket it opens. Accepting three spellings costs nothing,
    and each of the other two is otherwise a client that fails at the handshake with no way to tell
    why — the symptom being a bare `404` on the upgrade, which says nothing at all.

83. **`**` grants every scope including the dangerous ones, by request.** `*` still excludes them, as
    PLAN.md requires. `**` is the deliberate escape hatch, spelled with two characters rather than a
    flag on `*` so the difference is visible in the one place it is typed, and it matters that it is
    **not self-service**: it decides what the consent sheet *asks for*, while the person reading a
    six-digit code out of vrc.zip decides whether it is granted, with dangerous scopes still in their
    own block behind a second toggle. It is also how an app that cannot request scopes at all asks for
    everything — typing `**` into the password field is the only lever such a client has. The two hard
    denials (`PUT /users/{id}/delete`, `DELETE /auth/twofactorauth`) are unaffected: they are route
    table flags, refused regardless of what was granted.

84. **A public read downgrades to anonymous; it is never refused.** The file and image download
    routes were marked `security: ["authCookie"]` on the guess that images need a session, and that
    made every picture in VRCX a 401 — its renderer loads avatars from `<img>` tags whose cookie jar
    never saw the login. The guess was checkable and wrong: an unauthenticated request for a
    well-formed but nonexistent id answers `404 File not found`, not `401`, so VRChat does not gate
    these on a session at all.

    The rule is now two-directional rather than a flag. A caller presenting a grant that carries the
    route's scope gets the bound account's session, because an image the account can see and the
    public cannot needs it; anyone else gets an anonymous request, which is what VRChat serves them
    anyway. Refusing would break the cookie-less case, and lending the account's session
    unconditionally would let an app without `files:read` read private content through a route that
    skips the scope check. **Measure before marking a route authenticated** — the spec's `security`
    list is a description of intent, not of behaviour.

85. **The consent notification now always fires; only the browser tab is conditional.** It used to
    skip both channels when a UI client was connected, on the reasoning that the app raises its own
    sheet. But "a UI client is connected" only means a browser tab holds the event-stream socket — it
    says nothing about whether anyone is looking at it, and the person logging into a VRChat app is
    usually in a headset. The UI's own Web Notification was meant to cover that and cannot: it fires
    only from a loaded page and only with a browser permission most people are never prompted for.
    The observed result was a VRCX login sitting there waiting for a code nobody was ever shown.
    A toast is cheap and does not steal focus, so a duplicate of a visible sheet is a far better
    failure than silence. Opening a tab on top of an app the user already has open stays conditional,
    because *that* is the intrusive half.

86. **Revocation is per grant, and it closes sockets as well as rows.** The database half alone is
    not enough: a pipeline socket is authenticated once at its handshake, so an app whose grant was
    revoked would keep receiving events until it happened to reconnect. `PipelineMirror` therefore
    tracks which grant opened each subscription and `disconnectGrant` closes exactly those — not
    `disconnectAccount`, which would take down every other app attached to the same account and is
    the opposite of what "revoke this one" means. PLAN.md says it plainly: revoking an app's access
    to one account must not touch the others.

87. **The Connected apps page shows live grants only; `store.listGrants` deliberately returns revoked
    ones too.** The store method is the audit view and history is the point of keeping those rows, so
    the filter belongs in `listConnectedApps` rather than in the SQL. Two smaller calls fell out of
    building it, both found by running it rather than by reading it: the account name has to fall
    back to the `accounts` **table** before the raw id, because a grant outlives a signed-out session
    and `AccountManager` only knows loaded accounts; and an unrecognised scope renders as *dangerous*,
    which is the safe direction to be wrong in and is visible rather than silent.

88. **The rate limiter knew the ceiling; nothing knew the load.** That is why the shell rendered
    `80/s` whether the daemon was idle or saturated — it was a constant off the configuration wearing
    a measurement's clothes. `RequestMeter` counts every request that leaves `vrcFetch`, tagged with
    its account and, on the pass-through, its grant. Same reasoning as the limiter living there: one
    path to VRChat means "everything is counted" is structural rather than a convention.

    A ring of one-second buckets, one minute deep, per series. Counters not timestamps because the
    answer is always a count over a window; a ring not a list because this runs for weeks. Series are
    **pruned when they go quiet** — apps come and go and the key set is not bounded by anything the
    daemon controls. The reading is the last *complete* second: the one in progress is a partial
    count that only reads low, and including it makes a steady 5/s flicker with sample timing.

89. **History is seeded over REST and extended over the socket.** `/api/status`, `/api/accounts` and
    `/api/apps` each carry the full window for their series; the once-a-second `rate`
    frame carries only the newest value and the UI appends. Re-sending the window every second would
    be kilobytes to say one number changed. Two consequences worth knowing: the frame omits
    zero-valued keys, so **absence means zero** and the client must advance *every* known series on
    every frame or a quiet one freezes at its last busy value; and re-seeding on refresh doubles as
    the resync after a reconnect, when the socket missed however long the daemon was away.

    `rate` is its own `StreamFrame` member rather than an `EventKind`, because it is a sample and not
    an event — as a bus kind it would have landed in the feed, the retention config and the webhook
    payloads, none of which want a heartbeat. Making `StreamFrame` a union forced every consumer to
    narrow, which is how `isEventFrame` came to exist.

90. **A sparkline that scales to the rate limit is a flat line.** The first version drew each series
    against the 80/s ceiling, so a real 3/s reading sat in the bottom 4% of the box — honest about
    headroom, useless for shape, which is the only thing a chart that size can convey. It scales to
    its own peak now, with the absolute magnitude in the number beside it. Two more things that made
    it look coarse: a fixed column count collapsed many seconds into each column, so a one-second
    spike rendered as a plateau — resolution follows the measured element width now, and the window
    is a minute rather than ten, so in practice every second gets its own column — and downsampling
    has to take the **maximum** per column, never the average, because a spike is precisely what
    gets the user rate-limited and averaging is what erases it.

91. **v1 ships one self-contained `.exe`, not the `bun.exe` + `app/` tree PLAN.md §Phase 5
    describes.** The plan's reasoning is about *plugins*: a bundled runtime lets the daemon spawn a
    plugin host with `--smol` (or without it, per manifest), pinned to the Bun we tested against.
    None of that exists yet — plugins are Phase 3 — and until it does, the bundled layout is three
    files and a hash check protecting a capability nothing uses, against the very real cost that
    "download and run this" turns into "unzip this, keep these next to each other, and do not delete
    the folder." `bun build --compile` gives one file with the icon and version metadata on it, which
    is what a person can actually be handed. The plan's layout is not wrong, it is early: when the
    plugin host lands, the runtime comes back out of the binary and §Phase 5 applies as written.

92. **The UI is embedded with `--asset`, not a generated import map, and the prefix is `dist/`.**
    The alternative was a codegen step emitting `import x from "../ui/dist/…" with { type: "file" }`
    per file — a generated module that has to exist for `tsc` and Biome, is stale the moment the UI
    rebuilds, and is a second build artifact to keep honest. `--asset=ui/dist` needs none of it:
    `Bun.embeddedFiles` hands the files back at runtime as blobs that already carry the right
    content type. One measured surprise decides the prefix — **Bun keys an embedded directory by its
    own name, not by the path you passed**, so `--asset=ui/dist` produces `dist/index.html`. Hence
    `EMBEDDED_UI_PREFIX = "dist/"` in `@vrcz/shared`, shared by the build script and the server
    because a prefix that agrees in only one of them serves a blank page from a healthy daemon.

    The packaged build serves *only* from the embedded copy — a `ui/dist` beside a shipped exe is
    someone else's directory, not our bundle. From source `Bun.embeddedFiles` is empty and the same
    handler falls through to disk, so there is one code path and no build-only branch to rot.

93. **The packaged build opens a browser; a source run does not.** Someone who double-clicked
    `vrc.zip.exe` is not reading a terminal, and the launch URL carries a session token nobody is
    going to retype. From source the daemon runs under `bun --watch`, which restarts on every edit
    and would open a tab each time. `--open` / `--no-open` override it either way
    (`shouldOpenBrowser` in `os/open-url.ts`). The console window stays: it carries the launch URL,
    the first-run notice and the forward-proxy banner, and it is how you stop the daemon.
    `--windows-hide-console` is for the day there is a tray icon to replace it.

94. **The app icon is rasterised from the same geometry as the favicon, and encoded by ffmpeg.**
    The mark is "VZ" as a single unbroken stroke — into the V, back up its right arm, straight on
    into the Z's top bar and down — so the two letters share a stroke rather than sitting side by
    side, and the only square caps are at the two real ends. Drawing it is ~50 lines of coverage
    maths in `tools/src/icon.ts`, which is cheaper than depending on an SVG rasteriser and identical
    on every machine; encoding it is ffmpeg's ICO muxer, because hand-rolling PNG framing (CRC-32,
    zlib, Adler-32) for a file that changes once a year is not a trade worth making. **ffmpeg is a
    prerequisite of `bun run icon` only** — the `.ico` is committed, so packaging needs nothing but
    Bun. Ten sizes are rendered natively (16 through 256, including the 20/24/40/96 that display
    scaling asks for): a size Windows cannot find it resamples, and that resample is exactly the
    blur that makes an icon look cheap.

95. **A per-grant rate budget is a rolling window on the risky scopes, not on everything.** The three
    scopes PLAN.md §Enforcement names — `invite:send`, `friends:write`, `groups:invite` — get a
    rolling per-hour counter per grant, defaulted in the database and editable per app on the
    Connected apps page; exceeding it answers in VRChat's own 429 shape so an app's existing backoff
    handles it. A budget over *every* mutating call was the alternative and was dropped: it punishes
    a chatty-but-harmless app for volume that costs the user nothing, and the thing actually being
    defended against is visible-to-other-people abuse, not request count. Burst is already handled —
    the per-account FIFO with its subordinate per-grant share caps *rate*; this caps *volume*, which
    a burst limiter cannot.
96. **The audit log covers mutating calls plus the reads that leak something.** Every non-GET
    operation through the proxy gets a row, and so do reads gated behind a dangerous scope —
    moderation lists, anything `account:credentials` reaches. A write-only log reads as complete
    while an app quietly enumerates the user's moderation history, which is exactly the kind of thing
    someone would want to find afterwards. Surfaced as per-app history on the Connected apps page.
    Logging *every* request was considered for debuggability and dropped: `VRCZIP_PROXY_LOG` already
    serves that case without putting the write on the hot path forever.
97. **2.10 ships webhooks alongside the enriched stream, not after it.** Deferring them would close
    Phase 2 with its stated purpose half-served — an app that isn't long-running has no way in at
    all, and that app is the reason the control API exists separately from the pipeline mirror. It
    does mean 2.10 carries a real outbound-HTTP subsystem (retries, backoff, a dead-letter policy)
    rather than a route, and that cost is accepted here rather than discovered mid-step.
98. **Unlinked sessions need `sessions:unlinked`, a dangerous scope.** A session from an account
    vrc.zip does not manage leaks *the existence of an account the user never added* — a different
    class of disclosure from anything else on the stream, and not something a `*` wildcard should
    ever reach. Deny-by-default, reachable only through `**` or an explicit request, rendered in the
    consent sheet's dangerous block. Making it a consent-sheet checkbox instead was rejected because
    a checkbox is not enumerable by the scope registry, so it could not be audited, described, or
    revoked by the same machinery as everything else.
99. **The retention route lands with 2.10, and the retention types move to `@vrcz/shared` with it.**
    The Settings screen currently renders a static alert explaining that no control exists, which is
    honest but is a screen apologising for a missing route. `GET`/`PUT /api/retention` plus a real
    per-event-type control closes it. This also settles the third item under the old type-hoisting
    question: the retention types had no second copy *because* nothing exposed them, and the moment
    the wire carries them they belong in `shared` like every other wire type.
100. **`rateLimit.remaining` and `queued` become real, and the gauge becomes three gauges.** The
     limiter will expose live token counts and queue depth, and the settings screen will draw the
     three ceilings that actually exist (per-account 20/s, per-IP 100/s, files 300/s) instead of one.
     Drawing a precise-looking gauge over an approximation was the thing worth fixing, and deleting
     the gauge would have fixed it by removing information the Connected apps page needs anyway —
     live per-app rate is 2.8's own requirement, so the plumbing is paid for twice over.
101. **`local.vrc.zip` is cut.** It buys a nicer URL and a loopback origin that dodges Chrome's Local
     Network Access prompt, and it costs a DNS record plus a DNS-01 renewal endpoint that has to stay
     up *for the life of the product* — a permanent external dependency, owned by someone, for
     cosmetics, in an app whose entire pitch is local-only. `127.0.0.1` was already the runtime
     default (decision 10) and the silent-fallback path already exists, so what goes is the opt-in
     branch, its resolve check, and the README section promising it. Reverses decision 10's second
     half.
102. **Roster hydration gets both a cap and its own budget.** The eager batch is capped to the
     visible rows and the rest hydrate on hover, matching the resolver contract's "fetch on hover,
     never on render"; what remains runs on a low-priority subordinate budget below the account
     bucket, so it can never starve presence, a pipeline re-auth, or something the user just clicked.
     Measuring first was the cheaper option and was passed over on purpose: eighty sequential
     `GET /users/{id}` against a 20/s ceiling is the traffic pattern in this app most likely to draw
     a 429, and a 429 is not a metric worth collecting on a real account to prove a point.
103. **The flaky control-deps test gets fixed before Phase 2 closes.** `the user batch is cache-first,
     sequential, and leaves the unreadable out` has passed every run since its one failure, which is
     precisely the profile of a test that will start failing for real and be waved through. The fix
     is to await the actual settle point or inject a clock, never to add a delay.
104. **`invite-request` and `boop` are implemented as part of 2.10.** They are palette stubs that name
     a missing route when run, and 2.10 is the step that owns control routes — the same slot
     `invite-self` landed in.
105. **Phase 3 is next after Phase 2, not Phase 4.** The plugin system is the largest remaining risk
     in the project and the one everything else is shaped around: the packaging story, the scope
     registry, the declarative UI, and the "don't call it a sandbox until it is one" posture all
     exist to serve it. Node graphs reuse machinery that already exists and will be easier, not
     harder, after the plugin host has defined how third-party code is hosted at all.
106. **The single `.exe` stays, and the plugin host is the same executable re-invoked.** Decision 91
     shipped one self-contained binary ahead of PLAN.md §Phase 5, and that section's argument for
     `bun.exe` + `app/` was per-process runtime flags — `--smol` above all. Re-invoking our own
     executable in a plugin-host mode keeps the one-file download, at the cost that the flag cannot
     be argv. **Sub-question to settle before the supervisor is written:** whether JSC's small-heap
     mode can be selected any way other than at process launch. If it cannot, `--smol` stops being a
     per-plugin knob and becomes a property of the host mode — a real regression against §Phase 5's
     reasoning, and the point at which shipping two artefacts gets reconsidered.
     *(**Superseded the same day by decision 111**, which sidesteps the sub-question entirely: the
     plugin host is a real `bun` fetched on demand, not this executable re-invoked, so `--smol` goes
     back to being argv. The single `.exe` — the part worth keeping — stays.)*
107. **Plugins install from a local path or a pinned git URL. No registry in v1.** A registry is a
     service to host, moderate and take down from, and `backend/` is explicitly out of scope. A git
     URL pinned to a commit lets authors distribute without asking permission while keeping what ran
     auditable after the fact — the property a registry would otherwise provide. Signing and trust
     tiers still ship (PLAN.md §Corrections, 5): they are what makes the local case safe, not what
     makes a registry possible.
108. **The hostile plugin is written immediately after `ProcessTransport` + the supervisor**, ahead of
     the dispatcher, the scope gate and the rate budget. Writing it later means validating a design
     already committed to; writing it now means every subsequent claim — the deny-scan, the RSS
     watchdog, event-flood backpressure — is tested against a live adversary as it is made. Spin
     loop, memory bomb, `import("node:"+"fs")`, event flood, and a plugin that never returns from a
     lifecycle hook.
109. **Dry-run is lifted by an explicit per-plugin, per-scope gesture, with the dry-run log as the
     evidence.** The user turns it off in the plugin's own management page after reading what the
     plugin *would* have done. Nothing time-based: "it has behaved for seven days" is not information
     about the eighth, and a timed prompt trains people to dismiss it. Per-action confirmation was the
     other candidate and is worse — a stream of dialogs whose only rational answer is "always allow"
     is consent theatre.
110. **The first cut of the declarative UI vocabulary is forms, virtualized tables, dialogs, context
     menus and per-node handlers; charts follow.** That set covers what a settings-and-list plugin
     needs, which is most of them. Charts are held back deliberately rather than dropped: they were
     the one legitimate argument for the iframe escape hatch that decision 9 cut, so shipping them
     badly would reopen a decision that is otherwise closed. The first plugin genuinely blocked on a
     chart is the signal to build them properly.

111. **The plugin runtime is fetched from `bun.sh` on first plugin install, hash-pinned, and spawned
     with `--smol`. It is neither bundled in the `.exe` nor re-invoked from it.** This supersedes the
     compromise in decision 106 and **closes the JSC sub-question by making it moot** — plugin hosts
     get a real `bun` binary, so `--smol` is ordinary argv again, exactly as PLAN.md §Phase 5 always
     wanted. The daemon itself stays the compiled single-file executable and needs no runtime at all.
     The binary lands in `<state>/runtime/bun-<version>/` at `0700`, written to a temp path and
     atomically renamed so two daemons racing a cold start cannot hand each other a half-written
     executable, and `<state>` is `daemon/src/paths.ts` — so `VRCZIP_STATE_DIR` redirects it with
     everything else and a test never touches the real one.

     **Three things this buys, and two it costs. Both halves are the decision.**

     Buys: the download stays small and lazy, so someone who never installs a plugin never fetches
     tens of MB of runtime; `--smol` stays per-process rather than becoming a property of a host mode;
     and `vrcz dev` works without the author installing Bun.

     Costs, and neither is neutral. **First, the trust anchor moves from the download onto the
     network.** An embedded copy could always be re-materialised from bytes the user already chose to
     trust when they ran the installer; a fetched one cannot. What preserves decision 14's actual
     claim — that the runtime executing third-party plugin code is *the exact one we tested against,
     on every machine* — is not HTTPS and not the version string but a **SHA-256 of the exact
     artifact, pinned at build time and committed**. A mismatch discards the download and fails hard:
     no warning, no prompt offering to run it anyway, and never a silent fallback to a `PATH` Bun. A
     downloaded executable that is not the one we pinned is the worst thing this app could execute.
     **Consequence to not forget: the Bun pin now lives in *four* places that must move together** —
     `packageManager`, `engines.bun`, `.bun-version`, and the runtime hash. CLAUDE.md says three.

     **Second, plugins now require network on first install**, and fail where an embedded copy would
     not: offline, behind a corporate proxy, on a blocked host, or after a yanked release. That is
     surfaced as a plain error naming the URL and the expected hash, with a manual "use this `bun`
     instead" path that verifies against the same pin.

     Two implementation notes for whoever writes it. The release asset is a **`.zip`**, and Bun has no
     built-in unzip — Windows 10+ ships `tar.exe` (bsdtar, which reads zip), and a central-directory
     reader over `node:zlib` is the portable alternative; pick one deliberately rather than shelling
     out to whatever is around. And **downloading an executable into `%LOCALAPPDATA%` and spawning it
     is a textbook malware shape**, so expect AV heuristics to have opinions, on first run especially.

112. **Low priority in the rate limiter is a *reserve*, not a queue.** `acquire()` takes a
     `RatePriority`, and `"low"` may only spend a token while the bucket still holds
     `lowPriorityReserve` more than it needs — a quarter of the burst by default, applied to the
     per-account bucket *and* the shared IP bucket, since eighty fetches across six accounts drain
     the latter while every account looks well-behaved. The property this buys is the one decision
     102 actually asks for: a `"normal"` call always finds a token waiting, so bulk speculative work
     cannot leave presence polling, a pipeline re-auth, or something the user just clicked queued
     behind decoration.

     Priority *ordering* was the obvious alternative and was not built. This limiter has no queue to
     order — callers race for tokens as they refill — so ordering would mean adding queueing and
     fairness to a load-bearing component for a property nothing yet needs, where headroom is
     already sufficient. The trade to know: sustained `"normal"` traffic at the full configured rate
     would starve `"low"` forever. That is the right direction to fail in and is not reachable in
     practice, since the buckets refill at 16/s per account and normal traffic is a small fraction
     of that. Two implementation notes that are load-bearing rather than incidental: a blocked
     low-priority call computes its wait against `1 + floor` rather than against one token, or it
     would wake to find the floor still unmet and spin; and the default reserve is derived from the
     burst rather than being a constant, so shrinking the burst in a test cannot produce a reserve
     larger than the bucket, which would make every low-priority call wait forever.

113. **The roster's eager fill is capped at a screenful; the rest hydrates on hover.** Nobody reads
     eighty rows of chips — people scan the top and point at whoever they recognise — so
     `EAGER_FILL_LIMIT` describes 24 on sight and `ensureUser` fetches the rest on `mouseenter`,
     batched within a microtask so a pointer dragged down the list costs one request rather than
     forty. A hover miss is a cooldown (30s), not a verdict.

     **The interaction worth writing down is the one that nearly made this worse than the problem.**
     `#missesSomeone` treats an undescribed player as grounds to refetch, and a deliberately deferred
     id is undescribed forever — so a naive cap would have refetched every `JOIN_FLOOR_MS` for as
     long as the room stayed open, converting a traffic cut into a permanent poll. The deferred ids
     are therefore carried on the entry and excluded from that check: a deferred id is a decision,
     not a gap. Anything a cap defers has to be invisible to whatever the code uses to detect
     incompleteness, and that check is rarely in the same file as the cap.

114. **The audit log covers mutations *plus* dangerous-scope reads, and skips ordinary reads.**
     PLAN.md asks for "every mutating call", which reads as complete while missing what someone
     would actually go looking for: an app quietly enumerating the user's moderation history writes
     nothing under a write-only rule, because reading is all it ever did. The line is therefore
     anything that changes something, plus anything a `dangerous` scope guards — the same set the
     consent sheet already renders in its own block, which is a good sign it is the right set.
     Ordinary reads stay out on purpose: `GET /users/{id}` at eighty a room would bury the rows that
     mean something under rows that mean nothing, on a table nothing prunes, answering a question
     `VRCZIP_PROXY_LOG` already answers while debugging. Refusals are audited too — `hard_denied`
     is forced regardless of the rule, since an attempt to delete the user's account through the
     mirror is the most interesting row the table can hold. A request carrying *no* credentials
     writes nothing: there is nothing to attribute it to beyond a User-Agent anyone can type, and
     the handshake produces them legitimately.

115. **The per-grant budget is counted from the audit log, not from a counter in memory.** An hourly
     allowance held in memory resets on every daemon restart, which makes it a limit an app outlasts
     by being installed on a machine that reboots. The audit log is already the durable record of
     exactly these calls, so a second counter would be a second thing to keep in agreement with the
     first — and nothing prunes `audit_log`, so the window cannot be silently truncated out from
     under the count. Only `outcome = 'allowed'` rows count: a call refused for want of a scope, or
     by this budget itself, never reached VRChat and nobody saw it, so counting refusals would let
     an app exhaust its own allowance by being denied and make the budget permanent once it first
     tripped. The refusal is a 429 in vrc.zip's own envelope — VRChat's shape, so existing client
     backoff reads it, with `vrczip: true` and `retryAfterMs` so an app can tell "the user's proxy is
     pacing me" from "VRChat is angry".

116. **The audit row is written *before* the upstream call, and that ordering is the budget's
     correctness rather than a detail.** Found by writing the test: the check reads a count and the
     call that follows takes time, so recording the spend afterwards let a hundred simultaneous
     invites all read the same pre-spend number and all pass. The test that exposed it allowed 40
     calls against a limit of 30. Writing the row first makes it a *reservation* — the next call,
     concurrent or not, counts one already committed — and `finishAudit` fills in what VRChat
     answered once it does. A row left with a null status is a call that went out and whose answer
     was never seen, which is a more honest record than no row at all. The general shape is worth
     keeping: **any quota checked before an awaited operation and recorded after it is not a quota**,
     and a test that awaits its calls in sequence will never notice.

117. **The rate gauge stopped guessing, and the shape of the lie is worth naming.** `RateLimitSnapshot`
     carried one `limit` when there are three ceilings, an invented `remaining` (`isBackingOff ? 0 :
     globalRatePerSecond` — a constant dressed as a reading) and a hard-coded `queued: 0`. It is
     replaced by `{api, files, accounts[], perAccountRate, queued, retryAfter, consecutive429}`,
     every field read off the limiter's own buckets: `RateLimiter.snapshot()` refills each bucket to
     now and reports its token count, and `acquire()` now counts its waiters, incrementing when a
     call first sleeps and releasing in a `finally` so a throw cannot leak the count. `queued` also
     rides the once-a-second `rate` frame, because it is the number that explains a stall *while it
     is happening*: 3/s against an 80/s ceiling looks identical whether the daemon is idle or has
     forty calls stacked behind a 429. Note that `queuedTotal` is not the sum of the per-ceiling
     counts — an API call queues against both its account bucket and the IP bucket.

118. **Per-app budget overrides are a row's presence, not a nullable column.** Migration 004's
     `grant_budgets` has one row per (grant, scope) and `hourly_limit INTEGER NOT NULL`: absence
     means "whatever this build defaults to", so raising a default in a later release reaches every
     app nobody edited, and `0` is a real setting — "this app may never send an invite" without
     revoking the grant and making the user pair again. A nullable column would have given two
     spellings of "unset" and code would eventually have disagreed about which it was reading.
     Only the three scopes in `DEFAULT_GRANT_BUDGETS` can be given one: the route 400s on anything
     else rather than storing a number the proxy would ignore, because a control that visibly saves
     and silently does nothing is worse than no control. `PUT /api/apps/:id/budgets/:scope` takes
     `{"limit": n | null}` — not a DELETE, because clearing returns the scope to the default and
     there is no "no budget" state to delete into.

119. **Retention's preview and its save are the same call.** `PUT /api/retention` with `dryRun`
     computes through `describeRetention`'s `overrides` path and writes nothing; without it, the
     same function reports what was just written. A preview computed by a different code path than
     the save is a preview that can be wrong about the one thing it exists to be right about. Two
     consequences worth knowing: a patch's *deletions* cannot be previewed (an override can replace
     a rule, not remove one), so a delete previews against the rule it replaces — which
     under-promises rather than over-deletes, the safe direction; and windows are **rejected**
     rather than clamped at the route, because a clamp stores a different number of days than the
     user typed and days are how much of their history they think they are keeping. `rules` is a
     patch: number sets, `null` deletes, absent leaves alone — replacement semantics would make the
     screen re-send rules it never rendered.

120. **vrc.zip has scopes of its own now, and `routes.test.ts` had to be taught about them.**
     `sessions:read`, `sessions:unlinked` and `webhooks:write` gate the control API on `:7775`,
     which has no VRChat operation behind it — sessions are derived from local log files and a
     webhook is a thing vrc.zip does. That broke "no scope in the registry is dead weight", which is
     a check worth keeping, so the exceptions are declared by name in `NATIVE_SCOPES` rather than
     the assertion being softened. `sessions:unlinked` is dangerous: an unlinked session leaks the
     existence of accounts the user never added to vrc.zip.

121. **`StreamEnvelope` carries `displayName`, resolved once and cached across every socket.** PLAN.md
     §"Control API" wants every `gamelog.*` to name its game client, and re-deriving it from
     `accountId` is exactly wrong for the case the field exists to serve — a client signed into an
     unmanaged account has a display name and no account id at all. A `SELECT` per event per socket
     would be a query per player join per open tab, so it is memoised by session row id and dropped
     on any `session.*` event: a session row exists before its log has revealed who is signed in, so
     the first null is provisional and must not be the last answer.

122. **The palette gained a front door: an id or a link goes in, the thing it names opens — and the
     clipboard is the primary way in.** Every other path to a user, world, instance or group in this
     app is a *path*: a friend row, a feed row, a badge. That works until the id arrives from outside
     vrc.zip — a link in Discord, a `vrchat://` copied out of the game, a `usr_…` in a bug report —
     and until now the only way to open one was to find something that happened to mention it.
     Ctrl+Shift+V reads the clipboard, recognises it, and opens it; pasting into the palette's own
     search box does the same without a permission prompt, since the paste is the user's keystroke.
     Recognition (`lib/commands/targets.ts`) is pure and tested, and it **recognises rather than
     guesses**: an id prefix or a VRChat URL is the only evidence accepted, because VRChat's legacy
     user ids have no prefix at all and offering to "open user 'friends'" for every search anybody
     types would be worse than offering nothing. Recognised is also not the same as supported — an
     `avtr_` id is unmistakable and this build has nowhere to put it, so it is listed and disabled
     with the reason, which is a real answer where matching nothing is not.

123. **A command may take an argument, and the palette becomes the prompt rather than opening one.**
     `CommandDefinition.argument` carries a placeholder, a hint, a live `validate`, and an async
     `initial` — the clipboard, in every case that has one — and Enter on such a command swaps the
     list for a single input under the command's own title. Escape and a Backspace on an empty box
     are both "back to the list", which is what keeps it one level of a palette instead of a dialog
     stacked on one. The async prefill carries a generation counter and never overwrites something
     already typed: a clipboard read can resolve after the reader has moved on, and the same
     response-outliving-its-question hazard that `entity-modal.svelte.ts` documents applies to a
     prompt too.

124. **Query-derived commands come from `registerCommandSource`, and are never registered.** A
     command for `wrld_…:12345` cannot be registered ahead of time — nobody had seen that id — so
     sources are asked on every keystroke and their results rank above the whole registry. They are
     built fresh each time, so ids may repeat between keystrokes and nothing has to be torn down.
     `execute(command)` exists alongside `runCommand(id)` for exactly this: the palette runs the
     object it is holding, since a source's command is in no map to look up.

125. **"Cut off every connected app" navigates; it does not revoke.** The Connected apps screen arms
     that button with a first click and fires it with a second, deliberately, because revoking every
     grant is irreversible. A palette entry that did it on one Enter would be the same decision made
     with less thought, not more convenience — so the command opens the screen and says where the
     confirmation is. "Run the retention pass now" *does* act, because a pass that deletes only what
     is already past its window is the schedule running early, not a new decision.

134. **The third-party surface is a separate path prefix, not a flag on the existing routes.**
     `:7775` now serves two audiences with two credentials: `/api/…` takes the session token and is
     the user's own UI, `/app/…` takes a proxy grant and is a third-party app. They are separate
     Hono instances mounted in a deliberate order — `hostGuard`, `originGuard`, then `/app`, then
     `sessionAuth` — so neither can ever accept the other's credential. The rejected alternative was
     one auth middleware accepting both plus a list of which `/api/` routes an app may reach, and it
     fails open in the worst way: the day somebody adds a route and forgets the list, an app reads
     the user's whole account. This way a new `/api/` route is app-unreachable *by construction*.
     There is a test asserting the ordering, because it is a property of registration order that
     every other test would keep passing without.

135. **The stream's per-event scope filter is default-deny and keyed on event family.** `canSeeEvent`
     applies three independent gates — the event's account must be the grant's, an event with no
     account at all needs `sessions:unlinked`, and the kind must map to a scope the grant holds — and
     an unmapped family is dropped rather than passed. Family rather than exact kind because that is
     the granularity the consent sentences already speak in, so what the user read is what the
     filter enforces. `sessions:unlinked` is deliberately *not* a bypass of the kind gate.

136. **A `/app` webhook is pinned to its grant's account twice, and deleting another grant's is a
     404.** The route 403s a registration naming a different account rather than silently rewriting
     it, and the wiring then forces the account anyway — the route refuses the lie, the wiring makes
     it unactionable even if the route ever forgets. Delete reports another grant's webhook as
     *absent* rather than forbidden, because a 403 confirms the id exists, and that is enough to
     enumerate what other apps on the machine are listening to.

137. **The palette's three action stubs are real routes now** (decision 104's slot):
     `POST /api/accounts/:id/{invite,request-invite,boop}`. They sit beside `invite-self` because
     they are the same shape — the account is in the path, since *which* account acts is the whole
     question when two are signed in, and every argument is validated before it is interpolated into
     a VRChat path. An absent message slot stays absent rather than becoming 0: slot 0 is a real slot
     holding real words, and defaulting to it would send a message the user never chose, in their
     name. 403 and 404 from VRChat keep their own codes, because "they do not accept invites from
     you" and "they are gone" are answers, not faults.

138. **The three social actions live in one module and refuse rather than guess.** Invite, ask for an
     invite, and boop are reached from the palette, the right-click menu on any display name, and
     the user modal's overflow menu, so `ui/src/lib/social-actions.ts` owns the two awkward
     questions all three share. *Which account is asking* has no safe default: these arrive in a
     stranger's inbox with a name on it, so with two accounts connected the app declines and says
     so rather than taking the first. *Where is "my instance"* comes from a running game client and
     acts as **that client's** account, not the caller's preference — inviting to a room from an
     account that is not in it is a request VRChat would refuse for a reason nobody could see from
     this side. The menu items are omitted rather than greyed out when neither question can be
     answered: a disabled "Boop" with no explanation is worse than one that is not offered, and the
     fix belongs on the Accounts screen, not in a tooltip.

127. **`permissions.network` does not exist, and the two replacements are enforced in both
     directions.** PLAN.md correction 1 replaces arbitrary HTTP with `webhook` (the plugin supplies
     only a JSON body; the *user* typed the URL) and `fetch:allowlist` (host-declared domains, shown
     individually at consent, no wildcards). The schema rejects a `network` key with a message
     naming both replacements, rejects a wildcard in a domain, and cross-refines the capability and
     the domain list *each way* — a `fetch:allowlist` capability with no domains and domains without
     the capability are both errors. Domains implying the capability was the rejected alternative,
     because it would have kept them off the consent screen's capability list, which is the one
     place the user sees them. The response size cap is host policy and is deliberately not a
     manifest field: an author must not be able to declare 1GB.

128. **`grantHash` covers authority and nothing else.** Grants are keyed by
     `(pluginId, version, grantHash)`, so the hash must change when a plugin asks for more and must
     not change otherwise. In: scopes, account mode and optionality, event patterns, capabilities,
     allowlisted domains, and `performance` (throughput spends the *user's* memory, so it is a
     consent question). Out, each for a reason: `id` and `version`, because they are the other two
     components of the key and hashing them would destroy the ability to tell "wants more" from "is
     an update"; every presentation field and every `reason` string, because a typo fix that
     re-prompts trains people to click through; `contributes`, because a new panel is surface, not
     authority, and still runs inside the granted scopes; and `signing`, because folding the
     publisher key in would make a key rotation read as a permission change.

129. **The envelope is twelve tags with a sender table, not a transparent proxy.** `FRAME_SENDERS`
     maps each tag to `host | plugin | both`, so direction is *validated* rather than documented —
     a plugin cannot forge an `event` frame or answer a `ping` it was never sent. Deadlines are
     absolute epoch-ms because the two processes do not share a clock start, and an expired deadline
     is deliberately **not** a parse error: under a backwards clock step every deadline looks
     expired, and refusing the frame would mean the peer never learns its call timed out. Expiry is
     the caller's business; the wire-level check is a 10-minute horizon cap. Validation is
     hand-rolled rather than Zod even though Zod is in this package — it is the hot path, the
     defences that matter are byte and depth caps rather than shape, and it has to be light enough
     to live in the injected prelude.

130. **`coalesce` needed two rules PLAN.md did not state, and both are the interesting half.** First,
     `keyPath: "userId"` names a field that lives in the event *payload*, not on the event, so a
     path whose first segment is not an event field resolves against `payload` — `"userId"`,
     `"payload.userId"` and `"subjectId"` all work, and a path resolving to a non-primitive makes
     the event uncoalescable rather than silently mis-keyed. Second, coalescing with all-distinct
     keys degenerates into an unbounded queue, so it falls back to `drop-oldest` at the window
     boundary. Superseded events are reported as drops with `reason: "coalesced"`, distinct from
     `"overflow"`: the plugin did not see them, and saying so is the host's job. There is
     deliberately no `block` policy — `EventBus.emit()` must never await anything plugin-related.

131. **The game log deduplicates at the source — a persisted read offset — and the unique index is
     only the guard.** `LogWatcher` adopted every log file at byte 0 and kept its position in
     memory, so every daemon start re-read every `output_log_*.txt` in the directory and re-emitted
     every line in it. Migration 007 adds `log_offsets`, keyed on the watcher's `logKey` (the file's
     filesystem identity) rather than its path, because a rotated log reuses the path and must not
     inherit the old file's offset. The partial unique index on `gamelog.%` rows plus
     `INSERT OR IGNORE` is defence in depth, not the fix: it covers exactly the rows that are
     *derived from an append-only file* and therefore reproducible by construction, which is what
     makes them safe to deduplicate at all. Pipeline events are deliberately uncovered — two
     identical VRChat messages a millisecond apart are two facts, not one fact twice.

132. **A log file already read to its end starts *dormant*: no tracker, no session, until it grows.**
     The obvious version of the resume fix — seek to the stored offset and carry on — resurrects
     every finished session on every restart, because `startSession` conflicts onto the same row and
     clears `ended_at`, and with the file already consumed there is no quit marker left to close it
     again. So a client that exited cleanly last week came back live and was reaped as a *crash*
     five minutes later. A dormant file earns its session on its first new line, and takes its
     account from a head scan at that moment. `SessionTracker.attribute()` exists for that scan
     specifically: it applies the auth line without emitting it, because re-emitting a
     `gamelog.authenticated` a previous run already recorded is the same duplication in miniature.

133. **`friend.list_refreshed` stops being persisted.** It fires per account on every friend-list
     poll and no screen has ever rendered it, so on a two-account setup it was several hundred feed
     rows a day saying nothing happened. It joins the feed writer's ephemeral set, and 007 deletes
     the rows already stored — along with the other bookkeeping kinds (`friend.presence`,
     `notification.synced`, `account.state`, `session.update`, `pipeline.state`, the two `consent.*`)
     that older builds wrote before that set grew.

139. **The plugin transport is an interface even though only one implementation is wanted.** A child
     process is the design (a `Worker` keeps `process`, `Bun`, `fetch` and `node:*`, and no prelude
     can disable the `import()` operator), so `PluginTransport` could have been skipped entirely. It
     is kept for three concrete returns rather than as hedging: the supervisor's timing logic —
     heartbeat timeouts, backoff ladders, crash-loop windows — is testable against a fake in
     milliseconds instead of by spawning processes and sleeping; a `WorkerTransport` stays available
     for development and first-party plugins where isolation is not load-bearing; and when OS-level
     sandboxing lands it lands behind an interface every caller already goes through, which is what
     makes it a change of zero characters in the plugin API.

140. **Two limitations in the process isolation are documented rather than fixed, and both are on
     the primary platform.** The OS memory cap is real on Linux (`ulimit -v` through an `exec` that
     preserves the pid the watchdog needs) and **absent on Windows**, because a Job Object needs
     `CreateJobObject`/`OpenProcess`/`SetInformationJobObject` through `bun:ffi` with a
     hand-marshalled 144-byte struct, where a mistake crashes the daemon rather than the plugin. It
     warns once and degrades to the RSS watchdog, which notices rather than prevents. macOS is
     skipped deliberately: Darwin accepts `RLIMIT_AS` and ignores it, and a cap that only looks
     enforced is worse than none. Separately, **`env: {}` is not honoured on Windows** — Bun
     synthesises a minimal block, so the account name leaks even though nothing the daemon holds
     does; the prelude empties `process.env` immediately afterwards. Neither is a reason to stop,
     but both are reasons not to use the word "sandbox".

141. **Graceful stop is stdin EOF, not a signal.** Every signal Bun accepts on Windows is a
     terminate, so a signal-based `stop(graceMs)` would make the grace period a fiction on the
     platform most people run. Closing stdin is a request the plugin can notice and act on, and the
     escalation to `kill(9)` still reports `reason: "shutdown"` — the host asked, so no restart is
     wanted regardless of how it ended.

142. **The plugin docs shipped ahead of their step, with a banner saying nothing runs yet.**
     PLAN.md's build order puts docs last (3.11), and the generated half still belongs there. The
     hand-written half moved to now for one reason: without it nobody outside this repository can
     write a plugin at all, and a settled contract that only its authors can read is not a published
     API. The risk this creates is documentation drift against code that is still moving, and it is
     managed by two rules rather than by hoping. Every page opens with the same banner stating
     plainly that a plugin cannot be installed or run, and `status.md` is a step-by-step account of
     what is real — so the failure mode is a reader who knows less than they could, never one who
     builds against something that does not exist. Every example in the reference pages was executed
     rather than eyeballed: the manifests parse, the UI trees pass `validateUINode`, the node
     definitions typecheck and hash, and the counts (48 scopes, 52 event kinds, 28 UI node types, 12
     frames, 14 error codes) were read out of the modules rather than transcribed.

143. **Every list filter narrows in SQL, and the filter *vocabulary* describes the store rather than
     the loaded page.** The feed's family tabs were counted from the rows it had just fetched and
     applied with `.filter()` over the same rows. Both halves are wrong in the same direction: a
     family only got a tab once it appeared among the newest 150 rows, and the tab then vanished as
     those rows aged out, while "load older" walked history it immediately discarded. `GET
     /api/events` gained `kinds`, `families` and `q`; `GET /api/notifications` gained `types`,
     `seen`, `q`, `limit` and `before` (it had none at all); and `GET /api/event-kinds` and
     `GET /api/notification-types` serve the vocabulary from one `GROUP BY`. Families are matched as
     a **kind prefix**, not as a list of known kinds, so a kind from a newer daemon still lands in
     its family instead of being silently dropped by a hardcoded list.

144. **Kinds and families intersect; a *list* of families is alternatives.** ORing them reads as the
     safer choice and is not. The game log scopes itself with `families=gamelog` and then offers
     per-kind checkboxes inside that scope — ORed, ticking "player joined" widens the query straight
     back to every game-log kind and the filter visibly does nothing. Caught by running it; the test
     came after.

145. **Rendering is windowed as well as paged.** A page is 200 rows and history is unbounded, so a
     minute of scrolling used to put thousands of rows in the DOM and keep them there. One scroll
     sentinel drives both halves: it grows the render window first and asks the daemon for another
     page only once the window has caught up, so the DOM holds what the reader has actually
     scrolled past. The friends list is windowed but deliberately **not** paged — it is a presence
     cache where every row is live state, and a cursor page would go stale the moment somebody
     logged in.

146. **A row shows what the payload holds, and expands to the payload itself.** `eventLabel` maps a
     dotted kind onto a noun phrase, which is the same six words whether someone walked into your
     instance or VRChat refused a join. `event-details.ts` and `notification-details.ts` read the
     fields that were there all along — the join failure's reason, the screenshot's file, the
     announcement's title, the notification's actual type — and every row expands to the ids, the
     exact timestamp and the raw JSON. The interpretation stays checkable, and a field this build
     has never heard of is still visible somewhere. The expander is a real `<button>` and the row is
     not clickable: a row already carries names, world links and a join affordance, and an `<li>`
     with a click handler either nests interactive elements or is unreachable from a keyboard.

147. **A bare `usr_…` is never left on screen.** `UserName` takes `name: string | null`, and null is
     a request rather than a blank: it means "I have an id and no name, find one". That is the one
     place the app looks a profile up on render instead of on hover, and it is narrow on purpose —
     the cost is proportional to how often a payload arrives without a name, not to rows on screen.
     When the lookup settles with nothing (no signed-in account, or VRChat does not know the id) the
     row reads "Unknown user" and the id moves to the hover card, because a raw id in a sentence is
     not a name and pretending otherwise is worse than admitting there isn't one.

148. **The friends list groups by *place*, not only by status.** "In your world" cannot be derived
     from presence — a friend standing next to you shows as `active` like every other online friend
     — so without a section of its own the fact is not on the screen anywhere. It comes from the
     game log rather than from VRChat: `sessions.current_location` is the only source that knows
     what *this machine* is doing, and it is a set because several clients can be up at once.

149. **An update event names the field it changed.** VRChat's `friend-update`, `user-update` and
     `economy-update` frames announce that something moved and carry a whole object rather than the
     part that moved, so `friend.updated` could mean an avatar, a bio, a rank or a status message
     and the feed could only render it as the same sentence every time. The daemon now holds the
     previous copy (`wiring/update-diff.ts`) and emits `friend.updated.avatar`,
     `economy.update.wallet_balance` and the rest, with the before/after list in the payload. One
     aspect names the kind; several stay generic with the list in the payload, because a frame that
     moved three things is not three events and promoting one of them would be arbitrary.

     Three consequences worth stating. **A frame that changed nothing tracked is dropped entirely**
     — VRChat re-sends these constantly on fields nobody models, and each one used to be a feed row
     describing a change that was invisible even in principle. That is only safe because the tracked
     aspects are a superset of what `sameRecord` compares, so a dropped frame cannot be one that
     would have moved the presence cache. **The generic kind now means one specific thing**: the
     first frame seen for that subject, where there was no previous copy and naming the field would
     be a guess. And **absent is not empty**: a snapshot value is null for unknown and `""` for
     known-to-be-empty, because treating an omitted `bio` as `""` reports a cleared bio on every
     partial frame, which is most of them.

150. **Occupancy is read without being asked for, and a queue is what pays for it.** The count
     beside an instance used to appear only after a hover, so a list of forty locations showed a
     number on the two rows somebody had pointed at — which reads as missing data rather than as an
     unasked question. `LocationLine` now starts the lookup itself. The resolver's old refusal to
     fetch on render was answered directly rather than kept: `ensure()` joins a queue that drains
     `MAX_CONCURRENT` (3) at a time, so a hundred rows are a hundred queued lookups and three in
     flight. A person's hover jumps the queue, because waiting behind the background sweep for the
     tooltip you just opened is the same bug in a new place.

     `observedAt` is the one guard, and it is not a nicety: `GET /api/instances` is one upstream
     call per location with no batch endpoint, and instances close. Sweeping a thousand rows of feed
     scrollback would spend a thousand requests to be told a thousand times that the instance is
     gone. Live surfaces (friends, sessions, the user modal) pass nothing and always ask; the feed
     and the inbox pass the row's timestamp and stop asking past `LIVE_MS`. Measured on a seeded
     daemon: the game log's three-hour-old rows fired zero instance requests, and the feed's one
     recent location fired exactly one, with no hover.

151. **One row shape, applied everywhere a list of people is drawn.** `FriendRow` established the
     pattern — avatar, name through `UserName`, summary columns, and a chevron whose *opening* is
     what authorises the profile read — and the accounts list and the instance roster now follow it
     (`AccountRow`, `RosterRowItem`). The point is not visual consistency for its own sake: it is
     that "expand to see more" is the only gesture that can pay for a request per person, so a list
     that has no expander has nowhere to put trust rank, age verification, bio or friendship, and
     those facts simply were not on those screens. Deliberately no search or scroll sentinel on the
     accounts list: people have a handful of accounts, and a filter over four rows is furniture.

     A roster row whose player the log gave no id for renders no chevron at all rather than a dead
     one, and takes a spacer of the same width so the column does not jitter.

152. **The world and group modals are tabbed, and the world's live half became a list.** Both were
     one column on the argument that each is "one document". That was true of the *record* and false
     of the dialog: half of the world modal described a world, which barely changes, and half
     described one live instance, which changes by the minute — and the live half was pinned to
     whichever location the dialog happened to be opened from, with no way to reach any other. A
     reader asking "where can I actually go in this world" had nowhere to look.

     So the instance being described is now a **selection** rather than a fact about how the dialog
     was opened, with a list to select from. The old behaviour survives as the default: opening from
     a location preselects that instance *and* starts on the Instances tab, because that instance is
     still why the dialog was opened. Opening from a bare world id starts on Overview, since there is
     no room to show. `EntityModal` already supported `tabs`, so neither modal needed shell changes.

     The split earns itself the first time an account is offline: the world record 503s and the
     instance list still renders, because the two halves no longer share a phase. That is visible in
     the smoke test, and it is the shape the old single column could not express.

153. **The feed can filter to one kind, not just one family.** The family tabs answered "show me
     friend things"; nothing answered "show me avatar changes". Now that `friend.updated` has been
     split into `friend.updated.avatar` and its siblings (see 149) that gap was the difference
     between the refinement being visible and being theoretical. The picker is scoped to the
     selected family and clears itself when the family moves, because `kinds` and `families`
     intersect in the daemon — leaving a stale kind selected would silently produce an empty feed
     that reads as a bug.

154. **Avatar identity comes from a third party, and that is a real change of posture.** VRChat
     exposes no avatar id on a public user — only `currentAvatarImageUrl` and friends — so
     `friend.updated.avatar` could say "switched avatar" and nothing else. `avtr.zip` maps an image
     *file* id to an `avtr_…` id, which is the only route from what the pipeline sends to what
     `GET /avatars/{id}` needs.

     This is the first request vrc.zip makes to anything that is not VRChat, and the Guardrails in
     `PLAN.md` are explicit about local-only. It is therefore a setting (`resolveAvatarIds`, default
     on, switchable), the module states plainly that exactly one image file id leaves the machine
     and no account, cookie, user id or display name goes with it, and the resolver carries its own
     10/s bucket because avtr.zip's ceiling is a different budget from VRChat's. A failed lookup is
     never cached, so an outage cannot become six hours of dead rows.

     `avatar_cache` was reused for the avatar record and a new `avatar_file_ids` table added for the
     mapping, because the two are genuinely different shapes: the mapping's key is a *file* id, its
     value is an id rather than a document, and "no avatar is known for this file" has to be
     storable — which in `avatar_cache` would be an avatar row with no avatar in it.

155. **A menu with `overflow-y-auto` and no height cap does not scroll, it grows.** The vendored
     `Select.Content` had the overflow rule and had lost upstream's
     `max-h-(--bits-select-content-available-height)`, so a long list ran off the bottom of the
     window with its last options unreachable. Restored with a literal fallback
     (`var(--bits-select-content-available-height,24rem)`) rather than the bare variable, because
     if bits-ui ever stops publishing it an uncapped list silently returns to being unscrollable,
     where a fixed 24rem is merely shorter than ideal. Fixed in the vendored component, so every
     menu in the app benefits rather than the two that happened to be reported.

     The kind pickers went further and became a `Command` combobox (`KindPicker`), because the list
     is long enough that scrolling it is not the answer — the event vocabulary grew eight
     `friend.updated.*` sub-kinds, and finding one by eye in a menu of near-identical labels is the
     actual complaint. It searches on both the human label and the dotted kind, since people arrive
     with either in mind. One component serves both screens: it always speaks in arrays, where an
     empty array means "all" in both single and multiple modes, and each screen maps that onto its
     own state.

156. **The world's instance list reads the world once per signed-in account.** `World.instances` is
     documented "always an empty list when unauthenticated", and *what* it contains depends on who
     asked: a friends-only instance is listed for an account that may enter it and withheld from one
     that may not. Reading it through a single account would present one account's view as the whole
     picture, which is the exact failure a multi-account app exists to avoid. So the list now merges
     three partial sources — the world record per account, friends' presence, and this machine's
     game clients — and each row carries `sources` and `seenByAccountIds` so the UI can say which
     vouched for it and when only some accounts were shown it.

     This stops the list being free: it is now one upstream request per signed-in account per open,
     where before it was a read of the daemon's own memory. That is the right trade for real data,
     and every comment claiming it cost nothing was corrected rather than left. **One account
     failing never fails the list** — a stale cookie or a rate-limited account is ordinary, and the
     other accounts' answers are the entire point of asking several; `failedAccountIds` names them
     so a partial view is not presented as a whole one. A 403 is an *answer*, not a failure.

     Each row then reads its own instance record for the head count and the name somebody gave the
     room, which is affordable only because of 150: `instanceInfo.ensure` queues three at a time and
     caches. `userCount` is never `friends.length` — that is a floor, and printing it as occupancy
     would say a public room with forty strangers holds one person.

157. **A control cannot contain another control, and a row that names people must open them.** The
     instance row put its friends' names inside the selecting `<button>` as text, which made them
     unclickable and was invalid markup besides. The row is now the identity line only, with the
     join affordance beside it and the friends as their own `UserName` buttons on a second line.
     Every friend is listed rather than the first few: a "+3 more" is three people the row told you
     about and then refused to open.

     Selecting a row also scrolls the detail panel into view. The panel sits above the list, so
     picking the ninth row updated something off-screen and read as nothing happening.

158. **Consent, connected apps and settings joined the row system**, and two things fell out of
     doing it: `consent.error` was being fetched and silently dropped, and a settings switch had no
     accessible name. Both are the ordinary yield of replacing four hand-written copies of a pattern
     with one component. The connected-app row also moved its audit fetch onto the expander, so the
     screen stopped maintaining a map of activity for rows nobody had opened.

159. **An avatar is identified by its picture, which is why any of this is strange.** VRChat tells
     you what an avatar looks like — `currentAvatarImageUrl` and its thumbnail — and never which
     avatar it is: there is no avatar id anywhere on a public user. avtr.zip maps the image's *file
     id* back to an `avtr_…`, and that is the only route from what the pipeline sends to what
     `GET /avatars/{id}` needs.

     Three consequences shaped the UI. **The picture and the identity are separate jobs**: the
     picture is VRChat's own and is drawn immediately and unconditionally, while the identity is
     slower, third-party and optional, and its absence is never drawn as a failure of the profile.
     **Null is an answer, not a miss** — most pictures are not avatars, so "no avatar for this file"
     is the common case and is cached exactly like an id; treating it as a cooldown the way
     `world-names` treats an unresolved world would re-ask about every profile icon in the app
     forever. And **the setting being off produces the same null as a genuine miss**, deliberately,
     because neither is a reason to show somebody an error.

     `fileIdFromImageUrl` moved to `@vrcz/shared` when the UI needed it: it decides which pictures
     are worth offering a lookup for on one side and which may be sent to a third party on the
     other, and two copies of that grammar would be two opinions about what a file id is.

     `UserDetail` gained `currentAvatarImageUrl` as a field of its own rather than being read off
     `iconUrl`. They are often the same URL and never the same claim: one is "the best picture of
     this person" and the other is "the thing they have on", and only the second may be used to look
     an avatar up.

160. **A 404 on an avatar is a statement about the asker.** VRChat serves an avatar record only to
     accounts allowed to see it, so an avatar private to its author is a 404 for everybody else —
     including your own other accounts, and very often the account that *can* see it is the one
     wearing it. `getAvatar` therefore asks each signed-in account in turn and reports which one
     answered, so the reader can tell "this avatar is gone" from "your other account can see this
     one". Sequential rather than parallel, unlike the world instance list: there the accounts each
     add information, here the first answer ends the question and N requests to use one would be
     waste. A named `accountId` is still asked alone, because naming one is the caller saying whose
     eyes to use.

     `avatar_cache` rows became an envelope to carry the answering account. The record itself is the
     same bytes for everyone VRChat answers, which is why one global row is still right; *visibility*
     is the part that is not shared. A bare body from an older build still parses, with the account
     unknown, and unknown is rendered as nothing rather than as "nobody".

161. **The group screen is gone; the modal absorbed it.** Members, posts, galleries and instances
     are tabs of the group card now, and `#/groups/<id>` no longer exists. The split it replaced was
     defensible on paper — "the modal answers what is this group in a glance, the screen is a place
     with a URL" — and did not survive contact: the modal already had tabs and a back stack, so the
     screen's only real advantage was width, and the price was that half a group's information sat
     behind a navigation that threw away wherever you had been. The screen's own reasoning was
     carried over rather than discarded, in particular that **which account is asking is part of the
     question** (a group shows its member list to members and 403s everybody else), which is why the
     modal grew an account picker rather than silently using whichever account opened it.

     Lists still load only when their tab is opened. Four eager lists is four requests through a
     20/s per-account bucket for three lists nobody looked at, and that arithmetic did not change by
     moving house.

162. **A worn avatar shows its name, not an offer to find one.** The profile section began as a
     button reading "Open this avatar", which is the app admitting it has an id and nothing else.
     `avatar-records.svelte.ts` reads the record so the row can print "Robot Kyle by Kung", with the
     name itself as the control — the same rule `WorldLink` and `UserName` follow, and the reason
     there is no separate open button beside a name the reader can already see.

     Its caching rule differs from `world-names` on purpose: **a 404 latches here**. There, an
     unresolvable world is a cooldown because the batch route omits what it cannot serve and omits
     everything when nothing is signed in. Here a 404 means the daemon already asked every signed-in
     account and none could see it, so re-asking costs a request per account per profile to hear the
     same answer. `no-account` does not latch, for the mirror-image reason: nobody was asked.

163. **`POST /api/avatars/:id/select` is the first control route that changes *you* on VRChat.**
     Everything before it asked VRChat a question or sent somebody a message; this dresses one of
     your own accounts. Three decisions follow from that being new ground.

     **`accountId` is required, and a missing one is a 400 rather than a default.** With two
     accounts signed in, "wear this" means nothing until it says who, and picking the first online
     account would silently dress the wrong person.

     **The control is an icon, and the account is chosen in a menu rather than named on the
     button.** A `DropdownMenu` rather than a `Popover` full of buttons: it is a menu of actions, so
     it should carry a menu's roles and arrow-key navigation, and it inherits the app's own menu
     padding instead of the popover's card padding, which is sized for prose and reads as loose
     around a list of names. An action this small should not spend header width on a display name, and an action
     that changes your account should not decide whose on your behalf. The list is sorted with the
     likely account first — the one the modal was opened through, or the one that could see the
     avatar — because putting the probable answer at the top is as far as a guess should go when the
     reader is the one picking. Offline accounts are listed and disabled rather than hidden: "why is
     my other account not here" is a worse question than a row saying it is not connected.

     **No confirmation step**, and the popover is why one is not needed. Wearing an avatar is undone
     by wearing another, so a yes/no prompt in front of it is friction rather than safety, but a
     list you pick a name out of makes the consequence explicit at the moment of choosing. What it
     has instead of a prompt is an honest result: a 403 comes back as its own sentence, because it
     means the account is not entitled to that avatar and that is worth reading rather than
     flattening into "it failed".

     **It is not a monetization end-run** (PLAN.md §Guardrails). VRChat decides entitlement and
     answers 403 when the account may not wear it; vrc.zip neither checks that itself nor works
     around it. The route is a POST where upstream is a PUT, and the mapping stops at the daemon.

     Selecting also drops the acting account's own `user_cache` row, because the one field the
     action exists to move lives on it. Dropped rather than patched: editing the cached JSON to say
     what we *think* VRChat now returns would be the app inventing an answer, and a deletion is
     correct whatever the body looked like.

164. **`EAGER_FILL_LIMIT` stops being an open question, and does not become a measurement.** It sat
     in §Open questions asking for what a busy public instance actually costs against the 20/s
     ceiling after the cap of 24 (decisions 112, 113), so the "roughly a screenful" number would
     have something behind it. Dropped on the user's call. The cap and the `"low"` priority are what
     actually bound the cost, and both are already in place; the eager number only decides how much
     of the tail is drawn before a hover, which is a feel question rather than a rate-limit one.
     Measuring it needs a real busy instance and a person at the keyboard, and it would have bought
     a better default for something no user has complained about. It stays as it is until one does.

165. **A second planning pass (2026-08-22) scoped the middle of Phase 3.** Twelve questions, four at
     a time. The answers, each of which is a decision the next person should not re-litigate:

     **3.4 and 3.5 are built in parallel, not in the order PLAN.md lists them.** The stated order is
     dispatcher then install pipeline, but 3.3's hostile suite is blocked on 3.5's loader — it needs
     somewhere a plugin is actually loaded from — and decision 108 is that the adversary exists as
     early as possible. Building both at once gets the loader to 3.3 without stalling the dispatcher.

     **The runtime fetcher lands with 3.5**, because first install is exactly when a runtime is first
     needed. **The install pipeline takes a local directory path only** in this pass; the pinned git
     URL of decision 107 is a fetch step in front of an otherwise identical pipeline and can follow.
     **Signing and trust tiers go to 3.8**, not here: verification is an install-time gate, but the
     tier only means anything at consent, where the hold-to-confirm already lives.

     **The deny-scan parses with the TypeScript compiler API.** Bun exposes no parser. `typescript`
     is already a workspace dependency for `typecheck` and `ts.createSourceFile` reads plain JS, so
     this is the only option of the three that adds no dependency at all — and a new native
     dependency (oxc) is a packaging risk for the single `.exe` specifically.

     **Plugins reuse the existing shared scope registry.** One registry, not a `plugin:` namespace:
     `friends:read` means the same thing whoever holds it, and the plain-English descriptions are
     already written once. Plugin-only concerns — capabilities, event subscriptions, the fetch
     allowlist — stay in the manifest beside the scopes rather than being inflated into scopes.
     **The per-plugin rate budget reuses the per-grant rolling hourly window from decision 95**,
     keyed by plugin id, for the same reason: one mechanism to understand and one UI to build.

     **`ctx.vrchat` ships reads first.** Friends, users, worlds, instances, groups. The outbound
     social actions wait for 3.8, because correction 4's dry-run lift is a consent gesture and
     shipping the actions before the thing that ungates them would mean shipping them permanently
     dry-run or ungated — and neither is the design.

     **Windows gets its OS memory cap and a real scrubbed env now, before 3.4/3.5.** Decision 140
     wrote both down as known limitations on the primary platform; leaving them there while building
     the adversary that exists to test them is the wrong order.

     **The hostile suite runs in CI with tight budgets**, not behind a local opt-in flag. It is the
     regression suite for the whole phase, so it has to run where regressions actually appear; small
     memory ceilings and short deadlines are what keep it from being slow or flaky.

     **Verification is the five-command gate plus a real daemon run** under `VRCZIP_STATE_DIR`,
     because PLAN.md's own warning is that typechecking has already let silent bugs through.

166. **Both Windows gaps in 3.2 are closed, and the memory cap is a Job Object with a byte-level
     test.** Decision 140 wrote them down as limitations on the primary platform; decision 165 said
     fix them before building the adversary that exists to test them.

     The cap is created per plugin process through `bun:ffi` into kernel32 and lives in its own
     `job-object.ts`: CreateJobObjectW, SetInformationJobObject, OpenProcess on the pid Bun returns,
     AssignProcessToJobObject. **The 144-byte `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` struct is
     asserted byte by byte, by offset**, because the struct is the part that fails *silently* rather
     than loudly — a wrong offset is a call that returns success and caps nothing, inside the
     daemon's own address space. Those assertions are pure and run on any platform, so a Linux CI
     runner still catches a bad edit to them.

     **Every failure path returns null and falls back to the RSS watchdog** rather than refusing to
     start the plugin. Trading a later bound for no plugin at all is the worse outcome; the failure
     is said out loud once per daemon process so it is not silent either. `KILL_ON_JOB_CLOSE` is
     set, so a daemon crash cannot leave orphaned plugin processes on the user's machine — which
     also means releasing the handle *is* a kill, and the transport releases it only after the
     process is already gone.

     For `env: {}`, the fix was smaller than the finding. Nothing secret was leaking: a marker
     variable set in the daemon's own environment did not reach the child, and neither did
     `VRCZIP_STATE_DIR` or the session token. What leaked was **disclosure** — the account name, the
     home directory, the domain controller, and a `PATH` amounting to an inventory of every tool
     installed on the machine. The spawn now passes an explicit environment keeping only
     `SystemRoot`, `windir`, `SystemDrive` and `TEMP`/`TMP`, with temp pointed at **the plugin's own
     data directory** rather than the user's temp folder: that is already its cwd so it learns
     nothing new, its temp files stay inside the one directory it may write, and the user's profile
     path is never spelled out. The other seven are set to the empty string, which is the only way
     to unset one at all (see Gotchas). A blank `PATH` has teeth of its own — a plugin reaching for
     `Bun.spawn(["git", …])` now resolves nothing.

167. **The plugin dispatcher reuses the app-grant machinery wholesale rather than growing a
     plugin-shaped copy of it.** Scopes are the shared registry's strings, unprefixed — one
     registry, one set of consent descriptions — and the rate budget is decision 95's rolling hourly
     window on the same three risky scopes, keyed by plugin id instead of grant id, with
     `BUDGET_WINDOW_MS` and `DEFAULT_GRANT_BUDGETS` *imported* from `proxy/passthrough.ts` rather
     than restated. A `plugin:` scope namespace and a second budget were both considered and
     dropped: each would have been a second thing to keep in agreement with the first. The one place
     `plugin:` does appear is as a `RequestMeter` key prefix, so a plugin id can never collide with
     a grant id in the meter — a namespace for accounting, not for authorization.

     **The scope gate needed an account posture the protocol type cannot carry.** `ErasedMethod`
     holds `scope` and `cost` only, so `GatedMethod` pairs it with `account: "required" | "none"`
     and the gate resolves `params.accountId` generically: named-but-not-granted is
     `E_ACCOUNT_DENIED`, absent with exactly one granted account resolves to it, absent with several
     is `E_BAD_REQUEST` rather than a guess. A handler is still handed nothing it *could* check a
     scope or an account with, which is the property PLAN.md asks for.

     **`retryAfterMs` is time-until-the-oldest-call-ages-out, not the remaining window.** The proxy
     answers an exhausted app with a flat hour, which is fine for an HTTP client that will poll
     regardless. The plugin docs promise an author that waiting `retryAfterMs` is the correct
     response and that retrying early is a bannable-behaviour bug in their plugin — and a flat hour
     quoted against a real nine-second wait is exactly how that promise stops being believed. It
     cost one optional ledger method.

     **Plugin traffic is `"low"` priority and its cache is keyed `(accountId, path)`.** Low because
     plugin reads are bulk and speculative and must never starve presence, a re-auth, or something
     the user just clicked (decision 102's reasoning). The compound key because `GET /users/{id}`
     returns different fields to a friend than to a stranger, so a URL-keyed cache would leak one of
     the user's *own* accounts' view into another's — the standing invariant, which applies just as
     much between two accounts the same person owns.

168. **The install pipeline verifies the artifact back off disk before declaring success, through
     the same `loadArtifact` the spawn path uses.** Re-reading a file we wrote a line earlier looks
     redundant and is not: it makes the install path and the load path agree *by construction*
     rather than by two people keeping them in step. `loadArtifact` is synchronous for the same
     reason — `PluginRegistry.spawnFor` is synchronous, and an async verifier would have to be
     called from somewhere else, which is how a codebase acquires a verified load path and an
     unverified one beside it.

     **The pipeline writes nothing to the store and decides no trust.** "We compiled it" and "you
     agreed to run it" are different facts, and only the first is the pipeline's to assert, so the
     `plugins` row, the grant and the trust tier all belong to 3.8. What it returns is what it
     built.

     **PLAN.md was wrong that `target: "browser"` plus `external: []` makes node builtins hard build
     errors** — see Gotchas; Bun *stubs* them, silently. The promise is now kept by an `onResolve`
     plugin refusing every bare specifier naming a host builtin, in both the `node:`-prefixed and
     bare spellings, before Bun can stub it. The deny-scan still checks the output for the same
     thing, because the two fail differently and usefully: the resolver names the author's own
     source file, the scan catches whatever reached the bundle by a route the resolver never saw.

169. **The runtime fetcher unzips with a central-directory reader over `node:zlib`, not `tar.exe`.**
     Decision 111 asked for a deliberate choice here. bsdtar reads zip on Windows and macOS, but
     Linux's `tar` is GNU tar and does not — and spawning whatever answers to `tar` on `PATH` *in
     order to install the binary we are about to spawn* puts a step of the trust chain outside the
     app. The reader only ever materialises one known entry, so archive path traversal is not
     reachable through it.

     **`BUN_RUNTIME_PINS` ships empty, on purpose**, and an unpinned platform **refuses to fetch**,
     naming the URL and the hash it wanted, rather than downloading an executable nobody vouched
     for. The hashes come from the packaging step, which does not exist yet. The practical
     consequence is that `ensurePluginRuntime` currently succeeds only from a source checkout —
     exactly the state `process-transport.ts`'s header already describes. This is the pin's fourth
     home; CLAUDE.md said three and now says four, with the note that this is the only one whose
     value cannot be checked by reading another file in the repo.

170. **`typescript` and `@vrcz/plugin-api` were undeclared runtime dependencies of the daemon.**
     The deny-scan imports `typescript` at run time, which makes the compiler a runtime dependency
     rather than a build-time one; `@vrcz/plugin-api` had been imported by daemon code since 3.1.
     Both resolved anyway through root hoisting, so every gate was green while `daemon/package.json`
     named neither. Both are declared now. **The packaging step needs checking against this** — TS
     is roughly 10 MB and `Bun.build --compile` will pull it into the single `.exe`.

171. **The plugin docs are corrected against 3.2, 3.4 and 3.5, and the security-model page now
     understates rather than overstates.** Decision 142 shipped the docs ahead of their step and
     named drift as the price; this is the first payment on it.

     The substantive correction is that **the deny-scan is described as making cheap attacks fail
     loudly at install, and explicitly not as a gate** — with the seven verified-passing bypasses
     listed in the page itself, so a reader cannot form a stronger impression than the code
     supports. Isolation is attributed where it actually lives: the process boundary, the prelude,
     the scrubbed environment. Five overclaims were found and removed, including `lifecycle.md`
     calling the scan one of "the real defences" and `manifest.md` using the word "sandbox" for a
     thing PLAN.md correction 6 forbids calling one until it is one.

     The Windows `env: {}` finding is documented as **disclosure, not a credential leak**, because
     that is what it was — writing it up as the worse thing would have been its own inaccuracy. The
     per-plugin budget is marked built-and-dormant so a green test is not misread as an exercised
     path, and `status.md` gained the phrase **"done as a subsystem"**, defined in the page as "the
     module exists, is tested, and would behave as documented if something called it. Nothing does."
     Marking 3.4 and 3.5 plain "done" would have been exactly the drift worth avoiding.

     **The banner is narrowed rather than dropped.** "You cannot install and run a plugin yet" was
     becoming false in spirit while still true in fact. It now says you cannot do it *from the app*,
     names what did land, and pins the reason to the one thing genuinely missing: no consent screen,
     and no plugin subsystem in the composition root.

     Two stale claims outside `docs/` were fixed with it. `packages/plugin-api/README.md` carried
     the old banner. And `nodes.ts` promised that a `port` body segment "renders the port's label
     with its type chip" — `evaluateNodeBody` returns a string and has no way to express a chip, so
     the source comment was wrong and the docs page describing it was right.

172. **The plugin subsystem is wired through one `wiring/plugin-host.ts`, and the supervisor gets a
     public `send`.** `PluginSupervisor` kept its transport private, which is right — a caller
     holding one across a restart writes into a dead process — but it left no way to build a
     `PluginChannel`. The seam is one method returning `false` rather than throwing, matching
     `PluginTransport.send`.

     The dispatcher is attached from the supervisor's **state**, not at construction: attached at
     `starting`, because a plugin may call the host from inside its own `activate`, and detached at
     `backoff`/`idle`/`disabled` so a dying plugin's in-flight host calls are aborted at the moment
     it dies. Attachment is tracked in a `Set` because `attach()` detaches first, and re-attaching
     on every status emit would cancel a plugin's own calls on every heartbeat. `handleFrame`'s
     `false` return is preserved and forwarded to an `onUnownedFrame` hook, which is 3.6's seam.

173. **"Verify the hash on every load" was true only on a cold boot, and is now true on every
     start.** This is the sharpest thing found this round, and it is a defect in decision 168's
     central claim rather than in its implementation. `PluginSupervisor` captured its `spawn`
     options at construction, so the resolver — and with it `loadArtifact`'s hash check — never ran
     again for the life of that supervisor. **Both paths that matter bypassed it:** a crash-loop
     restart respawns every few seconds indefinitely, and `PluginRegistry.enable()` called
     `supervisor.start()` directly, skipping `spawnFor` entirely. So a plugin whose artifact was
     modified after the daemon booted would keep running the modified file until the next cold boot.

     `SupervisorOptions.spawn` is now a resolver re-invoked on every start, a `null` resolution is a
     halt rather than a retry, and `enable` routes through `start`. **A content-addressed path does
     not verify itself; something has to re-ask.** Writing the verify and never calling it again is
     the failure mode a content-addressed store invites, precisely because the path *looks* like a
     guarantee.

174. **The install route writes the grant, and grants no accounts by default.** 3.8 replaces the
     whole block and it is marked as such in the source. Two properties survive the placeholder,
     because losing them would be a regression rather than an unfinished feature: the grant is a
     real immutable `(pluginId, version, grantHash)` row, so the gate still reads what was
     *approved* and never the manifest; and `accountIds` defaults to **nothing**, because a missing
     field is not consent and defaulting to every account is exactly the over-grant the account
     picker exists to prevent. Under-permitting is the direction a placeholder is allowed to be
     wrong in.

175. **Plugin management is five session-token routes, not a scoped surface.** `scopeGuard`,
     `rateBudget` and `auditLog` belong to `/app`, which is mounted *before* `sessionAuth` and
     answers to a different authentication model entirely. Install, list, enable, disable and
     uninstall answer to the person at the keyboard holding the session token; a *plugin's* own
     authority is its grant row, checked on every call the plugin makes rather than on these routes.
     Reaching for the third-party middleware here would have conflated two authentication models
     that PLAN.md deliberately keeps apart.

176. **The hostile suite drives the real stack, and asserts the *stage* rather than the refusal.**
     3.3 closes as `hostile/hostile.test.ts`: sixteen tests, each installed through the real
     pipeline, resolved through the real `createSpawnResolver`, and run under a real
     `PluginRegistry` / supervisor / `ProcessTransport` spawning an actual `bun` with the real
     prelude. No mocks anywhere.

     Naming the stage is the whole discipline. Two spellings of the *same* attack are refused by two
     different layers — `import("node:" + "fs")` is constant-folded and dies at **compile**, while
     `import([…].join(""))` dies at **deny-scan** — so "it was rejected" is not an assertion worth
     writing. ~8.0s wall clock, 13 consecutive clean runs, and one flake was found and fixed rather
     than tolerated.

     **A harness had to be written before the *control* could pass.** Nothing registers
     `__vrczHost.onFrame` until 3.6, so a `lifecycle` frame reaches a plugin with no way to answer
     and *every* plugin reports `activate-hung` — the polite control included. `harness-entry.js` is
     the thinnest honest bridge, and it deliberately adds no defence of its own, because anything it
     added would be a defence the suite was measuring instead of the host's.

177. **Where nothing stops an attack, the test says so.** This is the part worth reading. Asserted
     as gaps rather than papered over, because a test asserting a boundary that does not exist is
     worse than no test:

     - **A plugin that gets past install reaches the whole filesystem.** Asserted directly: a bundle
       written straight to the artifact store does `import(["no","de:","fs"].join(""))` and gets a
       working `readFileSync` — verified by hand reading `C:/Users`. **The install-time stages are
       the entire defence, and the process boundary behind them is currently a boundary in name.**
       This is PLAN.md correction 6's point restated as a measurement.
     - **`const make = Function; make("…")` defeats the `function-constructor` rule**, which matches
       on the callee identifier. A `require` reached through a string body survives too — correct
       for a rule that must not read inside strings, but the route survives.
     - **The frame channel has no backpressure at all.** `__vrczHost.send` → `onPluginFrame`, once
       per frame, unbounded. Credit windows, per-tick batching and `dropped` are 3.6. The test
       asserts frames *keep arriving* and says in place that the assertion inverts when 3.6 lands.
       The only thing making it survivable is that nothing is subscribed yet.
     - **Nothing anywhere supplies `SupervisorOptions.readRssBytes`.** Its own doc says an OS
       reading "always wins" and is the one to trust against a hostile plugin. Zero callers, so the
       branch is dead code and **the watchdog's only input is the `rss` a plugin puts on its own
       pong** — the source that same comment says not to rely on. A plugin that stops yielding stops
       feeding the watchdog, and the watchdog can then never fire.

     **The prelude's scrubbing, by contrast, holds up better than expected.** `fetch`, `WebSocket`,
     `XMLHttpRequest`, `EventSource`, `Worker`, `eval`, `require`, `Bun.file`, `Bun.spawn` and
     `process.binding` are all genuinely gone, `process.env` is `{}`, and computed spellings find
     nothing. The decisive measurement: `({}).constructor.constructor("return typeof fetch")()`
     returns `"undefined"` — the `Function` constructor is reachable and unblockable, but the realm
     it evaluates in is the scrubbed one, so it cannot conjure back a removed global. **That is what
     makes the absent `fetch`/`WebSocket` scan rules and the string-literal `eval` carve-out
     correct**, and `network.js` is the standing check keeping them so.

178. **Decision 166 overstated the environment scrub, and `import.meta.url` is why.** The claim was
     that the user's profile path is never spelled out for a plugin. It is: `import.meta.url`
     discloses the artifact's absolute path, which under the default state tree is
     `%LOCALAPPDATA%\vrc.zip\plugins\<id>\<hash>.js` — **the user's account name and home directory,
     in full**, defeating the point of blanking `USERNAME`/`USERPROFILE`/`HOMEPATH`. `Bun.env.TEMP`,
     `TMP` and `process.cwd()` disclose the same path for the same reason. No scan rule, no scrub.
     The blanking is still worth having; the claim attached to it was too strong.

179. **The plugin memory ceiling is halved to 256 MiB, the watchdog moves with it to 192 MiB, and
     Linux gets its own multiplier.** A 512 MiB ceiling let one plugin outweigh the entire daemon,
     which reads badly against a product whose pitch is a 50-80MB idle footprint.

     **The two numbers are a pair and cannot be set independently.** The watchdog is the *readable*
     policy — it kills with a sentence naming the plugin and the number — while the OS cap is an
     opaque out-of-memory the prelude swallows, leaving the plugin catatonic until the heartbeat
     notices. So the watchdog must sit below the cap or it can never fire, and above realistic use or
     it kills working plugins. 192 under 256 satisfies both.

     **Lower numbers were measured and rejected, not argued about.** 100 MiB was the first target: it
     starts a bare runtime, but a plugin holding 5,000 user objects dies 3/3 at that ceiling, and
     `bun --smol` will not start at all at 90 MiB. See §Gotchas for the table. A ceiling near the
     runtime's floor produces a plugin system that cannot start a plugin.

     **Linux multiplies by `RLIMIT_AS_HEADROOM_FACTOR` (40x), because the platforms cap different
     quantities.** A Job Object caps committed memory, so the intended figure is usable as written;
     `RLIMIT_AS` caps *virtual address space*, and JSC reserves gigabytes it never touches — a fact
     `limits.ts` already documented and which the old single constant quietly ignored.
     `memoryLimitFor(smol, platform)` is the one place that decides, and it is platform-injectable so
     a Windows machine can test what Linux would get. **Still unverified on real Linux.**

180. **The events bridge is the EventBus's own bucketing plus one compiled closure, and it never
     sends a frame from inside `emit`.** The kind half of every filter is handed to
     `EventBus.subscribe({ kinds })`, so PLAN.md's *"no wakeup for irrelevant ones"* is a property of
     the dispatch table rather than a claim in a comment — a `friend.location` subscription is not in
     the bucket `gamelog.player_join` dispatches to, so the bridge closure is never entered. The
     compiled `EventFilter` then decides accounts and subjects, which the bus has no vocabulary for.
     **No new filter vocabulary was invented**: `EventFilter` and `DeliveryPolicy` were already
     specified and tested in `protocol.ts`, and 3.6 is their host implementation.

     Everything reachable from `emit` queues and returns — **900 events in 8.3ms in the real
     daemon** — and every frame goes out on a later turn from one shared, unref'd per-tick flush.
     Proved three ways rather than asserted: 5,000 events leave `sent.length` *unchanged*, 10,000
     events across 20 rounds against a never-crediting plugin sum exactly to delivered + reported +
     pending with a 4-event footprint, and the real run timed the burst.

     **The grant is re-read per flush tick, not per call and not per event.** The dispatcher reads it
     per call because calls are rare; events are three orders of magnitude more frequent and
     `liveGrant` is three SQLite queries. It compiles to a predicate with a cheap authority
     signature, so a changed grant recompiles *and purges what is already queued* — a revoke takes
     effect within a tick, including for events approved before it.

     **`applyOverflow` is the oracle, not the implementation.** It copies the queue per event and
     scans it with `readKeyPath` per element, so a wire-legal `credits: 4096` would cost 4096 path
     resolutions per event *inside `emit`*, at a rate the plugin chooses. `PendingQueue` is a key
     index plus a head offset, O(1) amortised, and a conformance test asserts the two agree event for
     event across every policy over 200 lumpy events. Reusing decision 130's *thinking* and proving
     agreement is a stronger claim than reusing its code — and `applyOverflow`'s own doc calls itself
     reference semantics.

     **What a plugin may watch is enforced by scope, and refused at subscribe time.**
     `compileAuthority` imports decision 135's `scopeForEventKind` rather than restating it, so a
     plugin and a third-party app cannot drift about what `friends:read` covers. A filter naming an
     ungranted account is `E_ACCOUNT_DENIED`; one whose every kind is unreadable is `E_SCOPE_DENIED`
     naming the scope. Never a silently starved subscription.

181. **Backpressure needed a fourth mechanism, in the direction PLAN.md does not cover.** All three
     mechanisms PLAN.md names are host → plugin; decision 177's measured gap was **plugin → host**,
     and 3.6 is exactly when "nothing is subscribed yet" stops being what makes it survivable.
     `frame-budget.ts` is a token bucket in the transport rather than a credit window, because the
     host never asks a plugin for frames — there is nothing to draw down.

     **A single inbound bucket kills the plugin by the wrong mechanism, and this was measured, not
     predicted.** With one bucket, `flood.js` spent its whole allowance on `req` frames at module
     scope and then *failed to activate*, because the `res` answering its own `lifecycle: activate`
     was the frame that got dropped. `pong`/`hello` are exempt — they are the prelude's frames, not
     the plugin's, and budgeting a pong turns a flood into a heartbeat kill, a true verdict reached
     by a false route. `res`/`err` get a **second bucket** rather than an exemption. This is the same
     shape as the pong problem one layer up, which is why it is worth naming twice.

     The hostile suite's flood assertion is now a **bound** (`< 64` frames per half-second) instead
     of a floor, which is decision 177's promise being kept: the test that documented the gap is the
     test that now proves it closed.

182. **A third planning pass (2026-08-22) scoped the whole back half of Phase 3, and cut two things
     the plan had been carrying since it was written.** Twenty-eight questions, four at a time, over
     3.7 through 3.11 plus what follows. Grouped by what they settle:

     **Two cuts, and they are the load-bearing part of this pass.**

     - **OS-level plugin sandboxing is cut, permanently, not deferred.** Decision 177 measured the
       gap — a plugin that gets past install reaches the whole filesystem — and PLAN.md's Phase 3
       carried AppContainer/seccomp as future work. It is now *not* future work. What remains is the
       install-time pipeline (bundle, deny-scan, content-addressing, hash-verify-on-load), the
       resource limits that already exist (Job Object, RSS watchdog, frame budgets), and honest
       wording. **PLAN.md correction 6 stops being a temporary posture and becomes the permanent
       one:** it is not a security sandbox, it will not become one, and the docs and consent UI say
       plainly that a plugin runs with the user's own privileges.
     - **Ed25519 signing and trust tiers are cut from v1** (reversing the half of correction 5 that
       survived decision 165's deferral to 3.8). With no registry, install is a local path or a
       pinned git commit, and the commit pin is the provenance. Signing without a key-distribution
       story is ceremony, and a hold-to-confirm on "unsigned" is meaningless when *every* plugin is
       unsigned. **The remnants come out with it**: the `signing` field in the manifest Zod schema,
       `plugins.trust` and `plugins.publisher_key`, and the `signed` tier in the docs. That bumps
       `GRANT_HASH_VERSION` and re-prompts every existing grant, of which there are approximately
       none — which is exactly why now is the moment to do it and not later.
     - **The docs are rewritten before 3.7, not with 3.11.** `packages/plugin-api/docs/` is the only
       thing an author outside this repository reads, and its security-model page currently promises
       signature verification and a sandbox roadmap that will never arrive. A doc that overclaims a
       protection is worse than no doc.

     **3.7 storage.**

     - **Capabilities become real machinery, not a synthetic scope.** `PluginGrant` grows
       `capabilities`, `GatedMethod` grows a `capability` field beside `scope`, and the gate checks
       both. The grant row has carried a `capabilities` column since migration 006 and
       `liveGrant` has been silently dropping it. Synthetic scopes were the cheap alternative and
       were declined: `storage` is not a VRChat scope, the consent sheet has to explain the
       difference regardless, and `webhook` and `fetch:allowlist` need the same field next.
     - **Quota is a `stat` on `plugin-data/<id>/`, checked before the write**, refusing with
       `E_QUOTA`. PLAN.md already said "quota is a `stat`"; the reason to keep it over
       `page_count × page_size` is that the stat sees the WAL and every stray file, which is the
       number that actually fills the user's disk. It lags checkpointing and can refuse against
       space already reclaimed; that is the accepted cost of never overshooting.
     - **The per-plugin database gets its own minimal opener, not `Store`.** `Store` carries nine
       migrations, `prepareAll`, and a retention engine, none of which a two-table plugin file wants,
       and coupling them means a daemon migration has to reason about files the daemon does not own.
     - **Uninstall is `rm -rf` over the data dir by default, with a keep checkbox** in 3.8's UI. The
       TODO at `wiring/plugin-host.ts` naming 3.7 is answered.
     - **`records` is key-prefix + time-window + limit, and nothing more.** No tag index, no
       `json_extract` filtering. One index covers it and it cannot become a table scan a plugin
       blames the host for. **Pruning is entirely the plugin's**, which is what `E_QUOTA`'s own doc
       comment already says: deleting records is the fix, not waiting.
     - **A stored value is arbitrary JSON up to 256KB**, comfortably inside the 1MiB frame cap with
       room for the envelope, and already subject to `MAX_JSON_DEPTH`.
     - **The prelude grows the whole `ctx` surface here** — `ctx.vrchat`, `ctx.storage`, `ctx.events`
       and the request/response correlation behind them — not just `ctx.storage`. Today the prelude
       has *no* client surface at all and a plugin author writes raw envelope frames, which every
       page in `packages/plugin-api/docs/` already contradicts. Two ways to call the host inside one
       prelude would be the worse outcome of doing this by halves.
     - **3.4's outstanding budget readout lands here too**, which means a first slice of the plugin
       management screen arrives with 3.7 rather than waiting for 3.8.

     **3.8 consent and management UI.**

     - **Install blocks.** `POST /api/plugins` parks until the consent sheet resolves and then
       returns 201 or a denial. One request, one outcome, no pending table and no second poll. The
       pending-queue shape that third-party apps use exists because *VRChat's own login flow* is what
       drives it; a plugin install has a human on the other end of the same session.
     - **`permissions.events` becomes enforceable.** Migration 007 adds an `events` column to
       `plugin_grants`, `PluginGrant` carries it, and the events bridge filters on it. `grantHash`
       has covered `events` since 3.1, so the column is additive and no hash bump is needed *for this*
       (the signing removal bumps it anyway). This closes the Gotcha where a plugin that declared
       `friend.*` at consent could subscribe to `gamelog.*` on the strength of `sessions:read`.
     - **Hold-to-confirm stays, on every install.** With signing cut there is no tier to distinguish,
       and the sentence being confirmed — this plugin can do anything your computer can do — is now
       unconditionally true. The friction is the honest part of the design, so it does not get
       downgraded to the two-click arm the Connected apps page uses. `ui/` has no press-and-hold
       primitive; building one, keyboard path included, is part of 3.8.
     - **The UI installs from a local path only.** The pinned git URL stays an outstanding 3.5 item;
       a git fetch has its own failure vocabulary the sheet would have to speak.

     **3.9 renderer.**

     - **The panel tree rides `/api/stream` as a new frame type, as a keyed patch.** Reusing the
       socket gets its backoff, auth, and tab-hidden pause for free. Patching rather than whole-tree
       replacement is what keeps a table from re-sending on every intent against a 1MiB frame cap —
       and it owes a stated rule for identity when a plugin omits `key`.
     - **`table` pages; it does not virtualize.** `PagedSection` and `ScrollSentinel` already exist
       and are how every other long list in this app behaves. No windowing dependency, no
       hand-rolled fixed-row-height machinery, and `MAX_TABLE_ROWS` becomes a ceiling rather than a
       promise to render ten thousand rows at once.
     - **Sort and filter are host-side over the rows the host holds.** No round trip per click. The
       consequence a plugin author must be told: what you did not send cannot be filtered.
     - **An intent shows optimistic `busy` on the node it came from and leaves the rest of the tree
       live.** On `E_TIMEOUT` or a crash mid-intent, an inline error replaces the busy and the tree
       stays as it was. Freezing the panel was the alternative and would let a slow plugin lock its
       own UI.

     **3.10 and 3.11.**

     - **3.10 ships registration, runtime and the type checker, with no editor.** A plugin registers
       `NodeDefinition`s, the daemon holds them, arms triggers and executes actions, and
       `assignable()` is enforced on save. `@xyflow/svelte` is not installed and the canvas is Phase
       4's; pulling it forward would start Phase 4 inside Phase 3. This is testable end to end
       without a pixel.
     - **`create-vrcz-plugin` and `vrcz dev` are both modes of the shipped `.exe`**, the way the
       plugin host already is. No npm publish for the template and no third artifact to version
       against the protocol major. An author needs the app before they can write a plugin, which
       they need anyway.
     - **Reference docs are generated and committed, without a CI drift check.** Scope table,
       manifest reference, event catalog, port matrix. The `packages/api` posture (regenerate in CI,
       fail on a dirty tree) was declined here because these are docs, not a client whose staleness
       ships wrong requests.

     **What follows Phase 3 is Phase 4**, the node graph, because 3.10 leaves it needing mostly the
     canvas and the gap between them will never be smaller. **Phase 2's last item — an end-to-end
     pass against `/app` with a real third-party client — is not scheduled**: it needs a genuine
     third-party app to mean anything, so it stays open and honestly labelled rather than being
     ticked by a test that impersonates one.

183. **3.0 landed, and `GRANT_HASH_VERSION` did *not* bump.** Decision 182 said removing `signing`
     would invalidate every stored grant. It does not, and the reason is worth keeping: **`signing`
     was never one of the hashed fields.** `grantHash` covers scopes, accounts, events, capabilities,
     fetch domains and `performance`, and the version guards *the set of hashed fields*, not the
     manifest's shape. A grant made before the removal answers exactly the same question as one made
     after it, so bumping would have re-prompted every user to agree to something unchanged. The
     rule this is an instance of: a hash version is about what was asked, never about what the file
     looked like.

     What actually came out. **`packages/plugin-api`**: the `signing` schema and the `PluginManifest`
     field, replaced by a `SIGNING_NOTE` quoted at the schema in the same shape as `NETWORK_NOTE`,
     and a dedicated `unrecognized_keys` branch so a leftover `signing` block is refused with "was
     removed rather than mistyped" instead of the generic unknown-field sentence — an author meeting
     this is out of date, not typo-ing. **The store**: migration `010_drop_plugin_signing` drops
     `plugins.trust` and `plugins.publisher_key`. Every row in existence held `'unsigned'` and
     `NULL`, because nothing ever wrote anything else — there was no verifier — so a column that
     reads as a decision the host makes was documenting a decision it never made. Neither column was
     in an index, which is what makes `ALTER TABLE … DROP COLUMN` legal here rather than merely
     permitted. **The wire**: `PluginSummary.trust` and `PluginStatus.trust` are gone, so the
     management page never has a tier to draw.

     **The docs turned out to be wrong about more than signing, and in the direction that matters.**
     The banner all eight pages open with said "you cannot install or run a plugin from the app yet
     … nothing can be installed, granted anything, or started". That has been false since decisions
     172–175 wired the subsystem: five session-token routes install, list, enable, disable and
     uninstall, and `app.ts` owns the lifecycle. The banner now says what is true — a plugin can be
     installed and started over the control API, **and nobody is asked first**, because the grant is
     written straight from the manifest. It also names what is still missing and is easy to assume
     from the docs' own examples: **lifecycle dispatch to your exported functions does not exist.**
     The host sends the frame; nothing routes it to `activate`. The only thing that does is a test
     harness (`hostile/harness-entry.js`) whose header says plainly that it is standing in for a
     runtime step that has not shipped.

     Two smaller corrections found while sweeping: `security-model.md` and `status.md` both claimed
     "what actually provides isolation is the process boundary, the prelude scrubbing globals, and
     the scrubbed environment" — **none of which confines anything**, and the sentence erred
     flattering. What the built layers provide is *integrity of what runs* and *resource
     containment*, and both pages now say that instead. And `nodes.md` claimed the install pipeline
     checks that `contributes.nodes` matches the registered `NodeDefinition`s while `manifest.md`
     said it does not; the pipeline never reads `contributes` at all, so `nodes.md` was the wrong
     one.

184. **3.7's first half: capabilities became real machinery, and storage is the thing that needed
     them.** `storage` and `storage:sql` had been strings in the manifest since 3.1, persisted in
     `plugin_grants.capabilities` since migration 006, and read by *nothing* — `PluginGrant` dropped
     the column and `authorizeCall` knew only scopes. A plugin's private database is the first host
     power that no scope honestly describes, so the choice was a fake scope or a real field.

     `MethodDefinition` now declares a `capability` beside its `scope`, `authorizeCall` checks it,
     and a miss is **`E_CAPABILITY_DENIED`** rather than a scope error, because the fix is a
     different one and an author staring at a full scope list needs to be told so.
     `PluginGrant.capabilities` is **required, not optional**: a site that forgot it would produce a
     grant with no capabilities, which denies correctly today and reads as "this plugin asked for
     nothing" forever after — a silent, plausible, wrong answer. Required made the compiler name
     every construction site, which is how `liveGrant`'s dropped column was found.

     The database is a minimal opener rather than `Store`, per decision 182. Two pragma choices are
     load-bearing and neither matches the daemon's. **`auto_vacuum = FULL`**, because `E_QUOTA` tells
     a plugin that deleting records is the fix and that is only *true* if a delete shrinks the file;
     under the daemon's `INCREMENTAL` the pages go to a freelist and the error message becomes a lie.
     **No WAL**, because there is one connection and `-wal`/`-shm` files are two more things the
     quota `stat` would have to explain.

     Two smaller things worth not rediscovering. The value cap is checked in **bytes, not
     characters** — a length check passes for English and fails for anyone writing CJK or emoji, and
     an over-cap value would then not fit in a frame. And record key prefixes are **`GLOB`-escaped**:
     `GLOB` is what uses the index, its wildcards are `*`, `?` and `[…]`, and a plugin key containing
     `[` would silently turn a prefix query into a character class and return the wrong rows, which
     reads as data loss to whoever hits it.

185. **The `ctx` surface cannot live in the prelude, and the reason is a hard number.** Decision 182
     said "build the whole `ctx` now", picturing it in the injected prelude. It does not fit: the
     prelude is passed as source to `bun -e`, Windows caps a command line at 32767 characters, and
     `MAX_PRELUDE_SOURCE_BYTES` holds it to 16KB with a test asserting it. A request/response
     correlator plus a subscription registry plus a façade does not fit in what remains, and the
     alternative — materialising the prelude on disk — reintroduces precisely the TOCTOU its own
     header rejects, on the most valuable file on the machine to win a race against.

     So the runtime ships as **library code the plugin bundles** (`@vrcz/plugin-api/runtime`,
     `definePlugin` + `ctx`), and that turns out to be the better answer rather than a consolation:
     it is deny-scanned and content-addressed with the rest of the plugin's code, which
     host-injected code is not; it is pinned to the protocol major the plugin compiled against; and
     it holds no authority of its own — every frame it sends is authorised exactly as a hand-written
     one would be.

     **This also closes the gap decision 183 named**: `hostile/harness-entry.js` existed only because
     nothing turned a `lifecycle` frame into a call on an exported function. Now something does. The
     hostile suite keeps its bare bridge deliberately — a suite that measured the real runtime's
     error handling would be measuring a defence instead of the host's.

186. **Importing `@vrcz/plugin-api` made a plugin uninstallable, and a test found it rather than an
     author.** The package root re-exports `manifest.ts`, which imports **zod**, which uses `eval`,
     `Function(…)` and `require` internally. Bundled into a plugin with `external: []`, all of that
     lands in the artifact and the deny-scan refuses it — correctly, since a scan cannot tell a
     validator's `Function` from an attacker's. So **every plugin following the getting-started guide
     would have failed to install**, with an error naming the author's own bundle.

     The fix is a `./runtime` subpath export that pulls only the runtime, the protocol and the
     storage types. Two tests hold it: one bundles a plugin through the real `Bun.build` + `denyScan`
     path and asserts it passes, and one asserts the **root entry still fails**, so the reason the
     subpath exists is pinned rather than remembered. Type-only imports from the root stay fine —
     types are erased before bundling — and the docs now say all of this where an author will hit it.

     The general shape, which is the part worth carrying forward: **the deny-scan applies to
     dependencies, not just to the author's code.** Any dependency a plugin bundles must itself be
     scan-clean, and that is a real constraint on what the published package may import.

187. **`permissions.events` is enforceable, and the Gotcha that named it is closed.** Migration 011
     adds `events` to `plugin_grants`, `PluginGrant` carries it, and `compileAuthority` gained a
     fourth gate. A plugin that declared `friend.*` at consent can no longer subscribe to
     `gamelog.*` on the strength of `sessions:read`.

     Three details worth keeping. The gate is **narrowing only** — a pattern naming a kind the grant
     holds no scope for grants nothing, so the two gates compose as an intersection and a pattern
     can never widen a scope. **An empty list denies everything**, which is what a pre-011 row
     decays to: those grants were written before anyone was asked about events, so there is no
     approval to infer and the safe reading is none. And matching is on the **family**, never on the
     string: `friend.*` matches by `familyOf`, so a future `friend.online_but_different` is not
     silently covered by an exact `friend.online`.

     The pattern predicate moved to `@vrcz/shared` on the way, because both sides need it — the
     manifest schema refuses a mistyped pattern at install, and the bridge asks the same question
     per event. Two copies would have let the set a user approved and the set the host enforces
     drift apart, which is the shape of this Gotcha in the first place.

     `authoritySignature` now includes the patterns, or a re-consent that narrowed only the events
     would have been invisible to the per-tick "has this grant changed" check.

188. **Consent is a blocking rendezvous, and nothing above it is authority.** `POST /api/plugins`
     now parks between "the bundle is compiled and stored" and "a grant exists", which is the seam
     that makes a denial coherent: the plugin row records a fact about disk, the grant records that
     somebody agreed, and a denied install leaves an installed-but-ungranted plugin that starts
     nothing. It is not rolled back, because a user who denied by accident or let it expire should
     not have to rebuild it to be asked again.

     **In memory, and it dies with the daemon.** The third-party app flow persists a pending row
     because *VRChat's login* drives it — the app is a separate process holding a half-authenticated
     session and nobody may be at the keyboard. A plugin install has a human on the other end of the
     same session, one they started deliberately. A half-answered consent question surviving a
     restart, answered later by someone who has forgotten what they were installing, is worse than
     asking again. Shutdown therefore **denies** every waiting request: an unanswered question is
     not a yes.

     **An approval narrows and can never widen**, enforced in one function (`narrowToRequest`) so
     the installer cannot express a widening grant even by mistake. A UI bug that sent a scope the
     plugin never asked for would otherwise mint authority nobody requested, and it would look
     exactly like consent in the grant row. The same rule at the HTTP edge has a subtler half:
     **absent and empty mean different things** — an omitted `scopes` is "everything asked for", `[]`
     is "none of it" — so the parser returns a spread rather than an array, and both readings are
     asserted.

     The grant hash still covers what the *manifest* asked, not what was approved. The hash is the
     identity of the question; a narrower answer to the same question must not read as a different
     question the next time it is asked.

     **Not yet done:** the consent *screen*. `app.ts` logs a line naming the plugin and saying it
     expires in five minutes, which is the minimum honest thing while the sheet does not exist —
     decision 61's two-channel treatment (a Web Notification when a UI client is connected, an OS
     notification and a browser when none is) belongs with the screen it would open.

189. **3.8's UI, and a race only a live run could find.** The consent sheet and the plugin
     management page are one screen (`#/plugins`), unlike the app world's split between `#/consent`
     and `#/apps`. That split exists because an app's consent arrives unprompted from a separate
     process; a plugin install is something the user started on this page seconds ago, so sending
     them elsewhere to answer it would be navigation for its own sake.

     **`HoldToConfirm` is the new primitive**, and it guards both installing and uninstalling. A
     hold rather than the Connected apps page's two-click arm, because an arm is undone by a second
     click in the same place, which a person clicking through a flow produces without reading. Its
     keyboard path is Space/Enter with `event.repeat` ignored — without that, key repeat restarts
     the countdown on every repeat and the button reads as broken.

     **Dangerous scopes start unticked**, and the sheet always sends its lists explicitly. Omitting
     them would mean "everything asked for" at the daemon, which would silently grant exactly what
     the sheet had left off. Verified against a running daemon: a plugin requesting `friends:read`
     *and* `invite:send` was approved with the dangerous one unticked, and the stored grant carries
     `["friends:read"]`.

     **The race.** `lifecycle: activate` is sent as soon as the host sees `hello`, and `hello` goes
     out *before* the bundle is imported — so a plugin registering its handler during module
     evaluation, which is what `definePlugin` does and what every plugin will do, could miss its own
     activation frame. The observed result was "no handler is attached for a lifecycle frame", a
     15-second activation timeout, a restart, and a plugin that worked on the *second* attempt. The
     prelude now buffers host frames until a handler attaches (capped at 16, oldest dropped with a
     note). After the fix: `restarts: 0`, no failure, activated first try.

     **This is the third time in Phase 3 that running the thing found what tests did not** — after
     the verify-on-load defect (173) and the zod-in-the-bundle defect (186). All three were invisible
     to a green suite because the suite drove the pieces rather than the sequence.

     Also verified end to end on the same run: `ctx.storage` round-tripped a value through the real
     dispatcher, gate and per-plugin SQLite file; uninstall deleted `plugin-data/<id>/`.

190. **The dry-run lift, the budget readout, and the second alert channel — 3.8 is done.**

     **The lift is per plugin and per scope, and lifting is the only half that is hard.** Lifting
     lets a plugin act on other people, so it gets the hold; restoring is a plain click, because
     making it harder to close a door than to open one is exactly backwards. The route refuses a
     request with no explicit boolean rather than defaulting either way: defaulting to `false`
     would silently re-shadow a scope the user had lifted, and defaulting to `true` would lift one
     on a malformed request.

     **The budget readout answers correction 3's "a UI naming who is eating it."** All three
     budgeted scopes are returned including ones the plugin does not hold — `granted` says which —
     because a row that vanished would hide the control exactly when someone wants to confirm it is
     closed. Only granted scopes are drawn expanded on the card, so a plugin holding none of the
     three does not train people to skip the section on the cards where it matters. No per-plugin
     budget *override* was built: the app-grant version stores one in `grant_budgets`, and the
     plugin ledger is in memory until the outbound-action step gives it an audit table to count
     from. The readout is honest about what it reads.

     **The alert channels are weighted the opposite way to the app flow, deliberately.**
     `consent-alert.ts` fires an OS notification unconditionally for an app pairing because that
     flow's premise is that the user is elsewhere. A plugin install's ordinary case is a person who
     clicked Install one second ago, so toasting them about a sheet already on their screen is
     noise: with a UI client connected this only logs. The case that still needs reaching is an
     install started from a script or `curl` with no UI at all, where the request would park for
     five minutes and expire in silence — there both channels fire, a toast and a browser on
     `#/plugins`.

     Verified against a running daemon: a plugin granted `invite:send` shows `0 of 60 used this
     hour` with `dryRun: true`; lifting flips only that scope; restoring flips it back.

191. **3.9's host half: the panel registry, and why the host holds the tree.** A browser that opens
     the plugins screen ten minutes after a plugin drew its panel has to get *something*. Asking the
     plugin to redraw on demand would make every page load a round trip into a process that might be
     wedged, and would make a panel's contents depend on whether anyone happened to be looking when
     it was pushed. So the host keeps the current tree per (plugin, panel), answers
     `GET /api/plugins/:id/panels` from it, and forwards changes.

     **A patch is refused rather than upgraded when its target is gone.** `ui.patchPanel` names a
     `key`; if the panel is not open, or the key is not in it, the call fails. Silently treating
     that as a whole-tree `set` would hide the plugin's stale idea of what is drawn *and* discard
     whatever the user had in the rest of the panel. Same posture one level down: an invalid tree is
     refused with the validator's own issues and **leaves the previously drawn panel exactly as it
     was** — losing a working panel because its next update was malformed punishes the user for the
     author's bug.

     **`ui.*` carries no scope and no capability**, which is a deliberate hole in an otherwise
     default-deny table. A panel is the plugin's own surface, drawn from data it already holds;
     nothing there reads an account or reaches VRChat. Requiring a scope would mean a consent sheet
     asking permission for a plugin to draw its own settings page, which teaches people that the
     scope list is noise. What bounds it instead is size: the validator, the node cap, a 32-panel
     cap per plugin, and the transport's frame budget.

     **Panels die with the process.** A tree that outlived the plugin that drew it is a screen whose
     every button reaches nobody, so `syncAttachment` closes them wherever it detaches.

     Two smaller notes. `STREAM_PLUGIN_PANEL` is its own frame type rather than a bus kind, for the
     same reason `rate` is — nothing *happened*, and a bus kind would put panel trees in the feed,
     the retention config and every webhook payload. And `isEventFrame`'s own comment predicted
     this: it narrowed by excluding the two non-event types, so adding a fourth member meant
     updating it or every screen reading `payload.accountId` would treat a panel frame as an event.

192. **The renderer draws, and two defects only the browser could show.** `UiNode.svelte` is one
     recursive component with a `{#if}` chain over `node.type` rather than a component per type:
     twenty-odd two-line wrappers would be twenty-odd files whose only content is a wrapper, and the
     recursion passes the panel, the form scope and the node path down through every one of them,
     which is where drift starts. Node identity is the **path** (`notes.0.2`), or the plugin's own
     `key` when it has one — that identity is what `busy` and per-node errors are keyed on, so
     pressing one button marks that button and not the panel.

     **Defect one: the runtime never handled inbound `req` frames.** `req` is bidirectional in the
     protocol and `ui.intent` is the host calling the *plugin*, but `Runtime#handle` only knew
     `res`/`err`/`event`/`dropped`/`lifecycle`. Every intent would have sat unanswered until its
     deadline, which the host reads as a plugin that has stopped responding rather than one that
     never learned to listen. `PluginHooks.onIntent` and a `#hostCall` branch close it; an unknown
     method and a missing hook are both answered as errors, because silence and refusal are the same
     observation to a caller with a deadline and only one of them is diagnosable.

     **Defect two, and it is the same trap twice.** `parseFrame` in `ui/src/lib/stream.ts` handled
     `ready` and `rate` and funnelled *everything else* into `asPayload`, which shapes a value into a
     `StreamEnvelope`. A panel frame survived that with its `type` intact and its payload replaced by
     an envelope of nulls — so the state module saw a frame it recognised carrying nothing it could
     use, and the panel silently never updated. **`isEventFrame` on the daemon side carries a comment
     warning about exactly this fourth-member problem**, and the client's parser had it too. One
     warning, two implementations, and only one of them had been fixed.

     Verified in a browser, which is the only place either defect was visible: the panel renders,
     clicking a button dispatches an intent, the plugin answers with a keyed patch, and the text node
     updates live while the table beside it keeps its rows and its sort.

     One process note worth keeping: navigating to a URL that differs only in its hash does **not**
     reload the page, so the first "the fix did not work" reading was a stale bundle running against
     a fixed daemon. A cache-busting query is the difference between testing the build and testing
     what the browser happened to still have.

193. **Plugins reach the shell: sidebar, palette, modals and toasts.** Four surfaces the user asked
     for, and each one is a place where "a plugin is not vrc.zip" has to stay visible.

     **The sidebar groups per plugin, under a `Plugins` label.** One flat list would be a list where
     nobody can tell whose entry is whose once two plugins are installed; the label above them all is
     what stops a panel called "Notes" from reading as a feature of the app. **A stopped plugin keeps
     its entries, greyed and marked** — an entry that vanished would hide the one fact that explains
     why the thing they installed stopped working. The sidebar also scrolls and filters now, because
     this list has no bound: the filter matches a plugin's *name* as well as its panels' titles, so
     typing a plugin shows everything it contributes, and **↑/↓ walk the visible entries with Enter
     to go**. Nothing is pre-selected — Enter on a freshly focused box must not navigate.

     **The palette gives each plugin its own group, named `<Plugin name> (Plugin)`.** `CommandGroup`
     became a template-literal type to allow it, which keeps a typo in *built-in* code a compile
     error while letting a plugin's name be anything. Commands are their own host→plugin call
     (`ui.command`, `onCommand`) rather than an intent, because a command belongs to the plugin and
     not to a surface — it is reachable whether the plugin is drawing anything or not. The daemon
     checks the id against what the manifest *declared*, so the palette cannot be talked into
     invoking a command a plugin never offered.

     **Toasts are their own frame kind**, not an op on the panel frame: a plugin with no panel open
     can still have something to say, and a toast arriving as a panel operation would have to name a
     panel that need not exist. The toast is titled with the **plugin's name** and carries its words
     as the description, so an interruption says who is interrupting in one glance rather than
     speaking in the host's voice.

     Three defects found by clicking, all invisible to the suite:

     - **`#ingest` routed panel frames but not toast frames.** `isEventFrame` excludes both, so a
       frame the plugin branch does not name falls off the end of the function entirely. The daemon
       was emitting toasts correctly for a whole build while nothing showed. **Both members have to
       be named in that branch**, and that is now written where the branch is.
     - **Registering plugin commands in a plain `$effect` looped forever.** `registerCommands` reads
       the registry state it writes, so the effect depended on its own write:
       `effect_update_depth_exceeded`, a blank screen, one exception. The dependency that should
       re-run it is the contribution list, so that is the only read outside `untrack`.
     - **A one-way `open` prop on `Dialog.Root` made the modal flicker.** bits-ui emits
       `onOpenChange(false)` while it settles, before the dialog has ever been shown; forwarding that
       fired the plugin's close intent, the plugin re-drew it closed, and the modal opened and shut
       with nothing in the console. It is `bind:open` now, plus a non-reactive `shown` flag that
       tells a real dismissal from that settling.

     Verified in a browser: the sidebar group and filter, the panel page behind a sidebar entry, a
     plugin's modal opening and closing, a toast titled with the plugin's name, and the palette
     running a contributed command that answers with a toast.

194. **3.10: node types register, arm and execute — with no editor, per decision 182.** A plugin
     declares node *ids* in `contributes.nodes` and registers the real definition when it activates.
     Both halves are load-bearing and they answer different questions: the manifest is what the host
     knows **while the plugin is stopped**, which is what lets a saved graph say "this node is
     paused" instead of showing a hole, and the registration carries ports, config and the body
     template, none of which can live in a manifest without duplicating the source of truth.

     **A registration whose id is not declared is refused, and this is where that check finally
     lives.** `manifest.md` says checking the two lists agree is the install pipeline's job and that
     the pipeline does not do it — the pipeline *cannot*, because definitions only exist once the
     plugin runs. Here both halves are in hand.

     `validateNodeDefinition` is new in `@vrcz/plugin-api`, the same contract as `validateUINode`: a
     result rather than a throw, every message carrying a path, because the author is the only person
     who can fix it. It makes the trigger inversion structural rather than documented — **a trigger
     with `inputs` is rejected outright**, so the thing a graph starts with cannot be handed a value.

     Definitions die with the process; declarations do not. That split is exactly what PLAN.md's
     "paused and marked unavailable, never deleted" needs to be expressible.

     `checkEdge` is the type checker's daemon-side face, and it answers with a *sentence* rather than
     a boolean: every refusal here is one a user reads while wiring a graph, and "incompatible"
     without naming both types is a dead end. Phase 4 calls it on save and at each execution
     boundary — twice on purpose, because the editor is a client and clients lie.

     **`nodes.*` carries no scope and no capability**, for the same reason `ui.*` does not:
     registering a node type is a plugin describing what it can do. Authority is checked when the
     node *runs*, because whatever its handler calls goes through the same gate as any other call.

195. **Five example plugins, and a test that installs every one of them.** `examples/plugins/`
     holds `hello-panel`, `friend-watch`, `note-keeper`, `instance-table` and `graph-nodes` — one
     idea each, in an order where each assumes the one before it. They are written as documentation
     that runs: the comments explain *why* the API has the shape it does (why a trigger arms, why
     `coalesce` needs a `keyPath`, why the records query is deliberately narrow, why omitting
     `accountId` with several accounts is an error rather than a guess).

     **The test is the point.** `install/examples.test.ts` runs each one through the real pipeline —
     manifest parse, `Bun.build`, deny-scan, content-addressing, verify-on-load. An example that does
     not compile is worse than no example, because it is the first thing an author copies and it
     fails in *their* project where they cannot tell whose bug it is. It is also the standing guard
     on decision 186: if anyone "simplifies" an example's import from `@vrcz/plugin-api/runtime` to
     the package root, zod reaches the bundle, the deny-scan refuses it, and this test says so.

196. **3.11 closes Phase 3: the scaffolder, `vrcz dev`, and the generated reference.**

     **Both CLI modes are sub-commands of the shipped `.exe`** (decision 182). `create-plugin`
     writes the smallest thing that runs rather than a showcase — `examples/plugins/` is the
     showcase, and a scaffold full of commented-out features is one an author deletes before
     reading. It asks for **no permissions**: a template that pre-asks for `friends:read` teaches
     that scopes are boilerplate.

     **`dev` talks to a *running* daemon rather than starting one**, because an author testing
     against a vrc.zip with none of their accounts, friends or game logs is testing against nothing
     their plugin is for. It reads `state.json` exactly as the UI does. It **polls** rather than
     using `fs.watch`, the same invariant as the log watcher and for a related reason: an editor
     writing a file is precisely the case Windows handles badly.

     **An identical re-install no longer asks.** The grant key is `(plugin, version, grantHash)`
     precisely so "the same question" is recognisable: a live row under that key *is* this user's
     answer to exactly this request, and asking again is noise rather than care. A version bump or
     any change to what is *asked for* changes the hash and re-prompts, by construction.

     **The bug that fix hid, found by hand.** `enable()` on an already-running plugin is a no-op, so
     a reinstall returned 201 while the process kept executing the bundle from *before* the build —
     `vrcz dev` reported success on every save and changed nothing, which is the entire point of a
     dev loop failing silently. It is `disable` then `enable` now. Verified by changing a panel
     title, reinstalling, and watching the title change; before the fix it did not.

     **The reference is generated and committed** (`bun run codegen:plugin-docs`): scopes,
     capabilities, the event catalog, the port matrix, limits and error codes — every one a
     projection of a value that already exists in code. The prose is deliberately *not* generated:
     `security-model.md` and the mental model are arguments, and a generator emitting them would be
     a template with the reasoning removed.

     **The manifest's JSON Schema is generated too**, and needed one accommodation: `Scope` and
     `EventPattern` are `z.custom` predicates, which JSON Schema cannot express, so zod refuses to
     emit anything without `unrepresentable: "any"`. The three lists that matter for completion are
     written back as real enums from the same registries the validator uses. A scaffolded manifest
     points `$schema` at that file on **raw GitHub, pinned to `main`** rather than a `vrc.zip` URL:
     there is no web service to host one, and a schema URL that 404s is worse than none — an editor
     silently stops offering completion and nobody learns why.

     **The plugins page grew an Add button.** A path, not a file picker: a browser cannot hand a page
     a folder *path* — `webkitdirectory` gives contents and a relative name, and a drop gives a name
     without a location — and the daemon needs an absolute directory it can compile. The path is
     also the honest control, because it keeps saying where a plugin comes from: a folder on this
     machine, with no registry behind it.

     **One thing left open, deliberately:** a killed `dev` client leaves its parked consent request
     behind until the five-minute timeout, because the broker has no way to notice the socket went
     away. Harmless — an unanswered request denies — but a request nobody can answer sitting on the
     sheet is untidy, and aborting on client disconnect is the fix when someone wants it.

197. **`@vrcz/plugin-api` is publishable, and the interesting part is what it does with
     `@vrcz/shared`.** `workspace:*` cannot be published, so the choice was to publish a second
     package or to inline the one. **Inlined**, because `@vrcz/shared` is deliberately an internal
     leaf carrying the daemon's wire types — publishing it would make its release cadence a public
     contract nobody asked for, and a plugin author should install one package whose version means
     the protocol major and nothing else.

     The JS half is a bundler flag. The **declarations** are the part that needed work: `tsc` emits
     `.d.ts` files that still say `from "@vrcz/shared"`, which resolves to nothing on a consumer's
     machine, so shared's declarations travel too (into `_shared/`, underscored to say it is not
     API) and every specifier is rewritten — including the relative `./manifest.ts` ones, legal here
     under `allowImportingTsExtensions` and nonsense in a published package.

     **It builds into `dist/` and publishes from there** rather than mutating the package in place.
     The repo's own `exports` point at TypeScript source and must keep doing so: every consumer
     inside this workspace is Bun, and a build step between an edit and a run is the thing that
     makes people stop running things.

     Two checks run before it writes: that all four entry points produced both a `.js` and a
     `.d.ts`, and that **no declaration still imports a workspace package** — the failure that
     otherwise ships is a package which installs, imports, and silently types as `any`.

     That second check found a real bug on its first run, in the shape it was written for: the
     `definePlugin` docstring's own example imported from `@vrcz/plugin-api` rather than
     `@vrcz/plugin-api/runtime`, which is precisely the mistake decision 186 exists to prevent, in
     the published package's own documentation. It also needed refining twice — a naive `@vrcz/`
     search matches the prose, which *should* name the package constantly, so the check looks at
     specifiers on non-comment lines.

     Verified by installing the built output into a scratch project: subpath imports resolve, `tsc
     --noEmit` passes, and Node loads both entry points.

198. **The console is an interface, and it is now treated as one.** For anyone who double-clicked
     the executable, the startup output *is* the app until they open the link — so it got the same
     attention as a screen.

     **Every URL in one block, including the forward proxy's.** It used to announce itself from
     inside its own startup path: several lines earlier, in a different format, before the summary
     listing everything else — so the one screen a user reads had the addresses in two places and
     neither list was complete. `startDaemon` now *returns* its startup notes instead of printing
     them, and the entry point orders what a reader sees by what it **means** — addresses, then the
     things to do about them — rather than by which subsystem constructed itself first.

     **The CA note points at the page, not at a command.** Installing a certificate is the one setup
     step here somebody can get wrong in a way that matters, and the page at the proxy explains what
     it is and why a local one is needed before asking anyone to trust it. A bare `certutil` line
     teaches pasting commands without understanding, which is not a habit for a tool holding
     someone's credentials to encourage.

     **`--help` and `--version` answer before anything touches disk.** Asking what a program is
     should not create a state directory as a side effect.

     **Colour is chalk, and the accent is the brand `#f5c454` as truecolor** rather than
     `chalk.yellow`. The terminal's own "yellow" is whatever the user's theme says, which is a muddy
     olive on many and orange on a few — the app would be a different colour on every machine. Chalk
     degrades the hex itself, and it already knows about `NO_COLOR`, dumb terminals and redirected
     output, each of which is a rule that gets subtly wrong when hand-rolled.

     **What the console *cannot* be told, and why there is FFI here anyway.** The icon was already
     handled at build time — `--windows-icon` puts it on the exe and the console host draws the icon
     of what it hosts — so a double-click already shows it. What was missing is the **title**:
     without `SetConsoleTitleW` the window is named with the full path to the executable, which puts
     somebody's home directory in every screenshot. `SetConsoleMode` is there for the older
     `conhost` a double-click can still land in, which shows escape sequences as literal characters
     unless asked not to — a program that looks broken rather than plain. Both are best-effort and
     neither can fail a startup.

     A console *of our own* — our chrome, not Windows' — would mean shipping a GUI, which is a
     Phase 5 question rather than a formatting one. Running from PowerShell borrows PowerShell's
     window by definition, and detaching to spawn a new one would be hostile to whoever typed the
     command.

199. **The executable gets a console of its own, and every step of that was measured rather than
     assumed.** "It opens with PowerShell" was accurate: a console-subsystem binary is handed a
     window by the user's *default terminal application*, which on Windows 11 is Windows Terminal
     painting it with its default profile — PowerShell's icon, PowerShell's title.

     The fix is `--windows-hide-console` (a GUI-subsystem binary Windows gives no console at all)
     plus `AllocConsole` at startup. **Measured: a console allocated that way comes back as class
     `ConsoleWindowClass`** — the classic `conhost`, which takes its icon from the process that owns
     it. Four things had to be found by probing, each of which would have shipped broken:

     - **`GetFileType` is not "do I have output".** A GUI process launched from Explorer arrives
       with a non-null stdout of type `FILE_TYPE_CHAR` — the NUL device. The first version treated
       that as usable, skipped allocating, and ran headless with its output going nowhere.
       `GetConsoleMode` is the honest question: it succeeds only for a real console.
     - **Output does not follow the console.** Bun binds `process.stdout` at startup and
       `SetStdHandle` afterwards does not rebuild it. Verified by reading the console screen buffer
       back: after `AllocConsole`, `console.log` left the screen empty while `WriteConsoleW` on the
       same handle painted. So `console.*` is rerouted through `WriteConsoleW`.
     - **Chalk turns itself off.** It reads `process.stdout.isTTY`, which is `undefined` here, and
       settles on level 0 — every style a no-op. The window handles truecolor perfectly well, so the
       level is set by hand on that path only, never as a blanket `FORCE_COLOR` that would also
       paint a pipe.
     - **The icon was already right; the *selection* was not.** The `.ico` carries ten natively
       rendered sizes including a real 256, and pulling the resources back out of the built `.exe`
       confirmed all ten ship. But an `.ico` is a directory, and code paths that take the *first*
       entry were getting the 16 and scaling it. It is ordered largest-first now, and the console
       window's `ICON_SMALL`/`ICON_BIG` are set explicitly at the sizes `GetSystemMetrics` reports,
       so Windows picks a matching entry instead of resampling one.

     Also here: the VZ mark as a banner, `O` and `F` to open the app and the proxy setup page
     (the decoder for `INPUT_RECORD` is a pure function with tests, because a console cannot be
     typed into from a test but a buffer of bytes can be built by hand), and `--help`/`--version`
     answered before anything touches disk.

     **What is still not ours:** a console the app was *launched into*. Running from PowerShell
     borrows PowerShell's window by definition, and detaching to spawn a new one would be hostile to
     whoever typed the command. A window with our own chrome means shipping a GUI, which is a Phase
     5 question rather than a formatting one.

200. **The Bun pin table is filled in, and it now fails a test rather than a user when it is not.**
     `BUN_RUNTIME_PINS` had been left empty on purpose back when packaging did not exist — an
     unpinned platform refuses to fetch, which is the right refusal — but once the executable
     shipped, that refusal became total: a packaged build has no `bun` on `PATH` to fall back to, so
     *no plugin could be installed at all*. Reported from a real build, with exactly the message the
     code was written to print.

     The five 1.4.0 hashes were taken two ways, because a pin transcribed wrong is worse than no pin
     (it fails at install time on someone else's machine): each `.zip` was downloaded and hashed,
     and those digests were then checked against the release's own `SHASUMS256.txt`. Both agree. The
     two are not independent — same origin, same TLS — but the realistic failure here is a truncated
     download, not a compromised release, and this catches that.

     **Why every test passed while the table was empty.** They all supply their own pins, which is
     correct for exercising the download path and is precisely why none of them looked at the real
     table. So the table now has tests of its own: it covers every platform `runtimeAssetName` can
     produce (derived, not listed), every value is a lowercase 64-character digest, and
     `BUN_RUNTIME_PINS_VERSION` equals `.bun-version`. That last one is the new guard — the table is
     keyed by asset name, which carries no version, so bumping Bun without re-hashing would
     otherwise compare 1.4.0's hashes against a different release's bytes and tell the user their
     download "is not the one this build expects" when nobody had re-hashed anything. It is a red CI
     run instead, and `fetchPluginRuntime` refuses the mismatch outright with a message that says
     packaging mistake rather than blaming the download.

     This is the same lesson as decision 199's, in a different costume: a green suite says nothing
     about the values a *build* is shipped with. Anything that is a build input needs a test that
     reads the build input.

---

## Gotchas

Empirical notes. Add to this as you hit things — especially where the plan turns out to be wrong.

Found by running code. Each of these contradicted an assumption, and most were silent failures.

- **A docs banner written to *understate* still rots, and it rots into a lie in both directions.**
  Every page in `packages/plugin-api/docs/` opened with a warning that nothing could be installed,
  granted anything, or started. It was scrupulously honest when written and was false by the time
  3.4 and 3.5 were wired, three decisions later — five routes install and start plugins now. The
  same paragraph *also* still listed events as "not built at all" after 3.6 shipped, while omitting
  the thing an author would actually trip over: lifecycle dispatch to their exported `activate`
  genuinely does not exist. The lesson is not "update the docs". It is that **a hand-maintained
  claim about what is built is the single most rot-prone sentence in a repository**, because
  nothing fails when it goes stale — no test, no typecheck, no lint. `status.md` and the layer table
  in `security-model.md` are the two other places carrying that kind of claim, and 3.11's generated
  reference cannot cover any of them, because they are judgement rather than code.
- **~~`PluginGrant` cannot carry `permissions.events`~~ — closed by decision 187** (migration 011
  adds the column, `compileAuthority` gained a fourth gate). Kept because the *shape* is worth
  recognising again: a field that is validated, hashed and displayed, but that no code path reads,
  looks exactly like an enforced one from the outside. **The consent-approved event patterns were
  unenforceable.** The manifest has them and `grantHash` covers them, but `plugin_grants` has columns
  for `scopes`, `account_ids`, `capabilities` and `domains` and **not** events, and the protocol's
  `PluginGrant` has no field for them either. So a plugin that declared `friend.*` at consent can
  subscribe to `gamelog.*` if it also holds `sessions:read`. Never *more* than its scopes allow, but
  **more than the consent sheet said** — which is the half that matters, because the sheet is what
  the user actually read. 3.8 owns adding the column and the field.
- **The protocol has no `unsubscribed` frame**, so `overflow: "disconnect"` and a revoked grant are
  both expressed as a `dropped` frame (`overflow` / `shutdown`) covering what is left. Honest, but a
  closure reads to a plugin as a very large drop rather than as "this subscription is gone".
- **`PluginChannel.send` returning `false` conflates "peer gone" with "frame over the byte cap"**,
  and a `maxBatch: 256` batch of fat payloads can genuinely exceed `MAX_FRAME_BYTES`. The bridge
  halves the batch until it fits and sheds a single oversized event as `overflow`, which terminates
  either way — but neither the channel nor the bridge can tell the two causes apart.
- **`BusEvent.payload` is `unknown`, `PluginEvent.payload` is `JsonValue`, and nothing bridged
  them.** `encodeEnvelope` calls `JSON.stringify`, which **throws** on a cycle rather than returning
  a result, and that throw would land in the flush loop and take *other subscriptions'* frames with
  it. The bridge validates (does not clone) with depth and node caps, and omits an unencodable
  payload rather than dropping the event.
- **A smoke test that appends to a log file right after startup will see no `gamelog.*` events, and
  that is the watcher working as designed.** `LogWatcher.adopt` sets `startOffset = size` for a
  newly discovered file with no stored offset — tail-from-EOF — and a file already at its end starts
  *dormant*, earning a session on its first new line (decision 132). So the events are not lost, they
  are waiting for the next poll. Worth knowing before reading an empty `gamelog` stream as a bridge
  or bus defect, which is what it looks like.
- **JSC cannot be told to want less memory from inside Bun, so the OS cap is the only mechanism.**
  Asked directly, and measured on Bun 1.4.0 rather than taken on trust. `BUN_JSC_gcMaxHeapSize` and
  `BUN_JSC_forceRAMSize` are both *accepted* — an invalid option name errors, these do not — and both
  change nothing: the same workload measures 116.5 MiB RSS with `gcMaxHeapSize=64MB`, 113.7 MiB with
  `forceRAMSize=64MB`, and 116.4 MiB with neither. `--max-old-space-size` is likewise accepted and
  silently ignored. This matches open upstream issue oven-sh/bun#34917, unresolved as of July 2026,
  whose reporter shows the same non-determinism in a memory-limited container. **The practical
  consequence: `--smol` is a hint, the Job Object / `RLIMIT_AS` cap is the only enforcement, and any
  future "just cap the heap" suggestion should be re-measured before it is believed.**
- **A memory ceiling near the runtime's floor produces a plugin that cannot start, not a frugal
  one.** Measured on Windows, where the Job Object caps *committed* memory: `bun --smol` running
  nothing but one `setInterval` starts at 100 MiB and **fails at 90 MiB and below**, exiting 9 before
  any plugin code runs. A plugin holding 5,000 user objects with per-tick string churn measures
  ~116 MiB RSS, dies 3/3 at 100 MiB, and runs 2/2 at 128 MiB. The runtime is most of a 100 MiB
  budget, so the interesting range is much narrower than it looks — and JSC grows to fill what it is
  given (~45 MiB idle under a 100 MiB cap, ~106 MiB under a 128 MiB one), which means the ceiling
  shapes the resident set rather than merely bounding it.
- **`SupervisorOptions.readRssBytes` has no callers, so the RSS watchdog trusts the measured
  party.** The option's own comment says the OS reading "wins whenever a pid and a reader are both
  available" and is the one to trust against a hostile plugin. Nothing in the codebase supplies one,
  so the branch is dead and the watchdog's only input is the `rss` the plugin reports on its own
  pong. A plugin that stops yielding stops feeding it, and it can never fire.
- **A Linux risk, now mitigated but still unverified:** `createSpawnResolver` used to hand out one
  constant for every platform, which on Linux becomes `ulimit -v` — a cap on *virtual address
  space*, which JSC reserves gigabytes of without ever touching. Whether `bun --smol` can start
  under a realistic figure there is unproven, and the tighter the ceiling got the more certainly it
  would have broken. Decision 179 splits it: `memoryLimitFor()` multiplies by
  `RLIMIT_AS_HEADROOM_FACTOR` on Linux only. **The factor is reasoned, not measured — this machine
  is Windows — so it still wants a check on a real Linux box**, and it is the first thing to suspect
  if plugins do not start there.
- **The Job Object assertion does not run in CI.** It is win32-gated and CI is `ubuntu-latest`, so
  the memory-cap test — the one decision 166 exists for — skips there. A Linux `RLIMIT_AS`
  equivalent could not be made both honest and fast: a cap low enough to bite quickly stops `bun`
  starting, and one high enough needs the bomb to touch multiple GB on a shared runner.
- **A content-addressed path does not verify itself, and "on every load" quietly meant "on every
  cold boot".** `PluginSupervisor` captured its spawn options once, so the hash check ran the first
  time and never again — through a crash-loop restart respawning every few seconds, and through
  `PluginRegistry.enable()`, which skipped the resolver altogether. The install-time test passed,
  the load-time test passed, and the property still did not hold at run time. Fixed by making the
  bundle a resolver re-invoked on every start (decision 173). Worth generalising: whenever a
  guarantee is "checked on every X", find the code path that repeats X and confirm the check is
  inside it rather than beside it.
- **The polite control cannot activate under the real prelude.** `hostile/polite.js` exports
  `activate`/`deactivate`, and the prelude's only seam is `globalThis.__vrczHost.onFrame` — it does
  not read a module's exports, which `docs/lifecycle.md` states outright. A real install of it
  therefore reaches `activating`, misses the 15s deadline and restart-loops. The plugin-side runtime
  that would bridge exports to the seam is 3.11. It means the "control" fixture would fail an
  end-to-end suite **for a reason that is not a defence firing**, which is the worst kind of red.
- **The install pipeline and migration 006 disagree on the source word.** `InstallSuccess.sourceKind`
  is `"local"`; the `plugins.source_kind` column documents `'path' | 'git'`. `plugin-host.ts` maps
  between them, which is the sort of mapping that should not need to exist.
- **A refused bundle reads as `idle` carrying the registry's wrong sentence.** `PluginRegistry`'s
  `#unstartable` says the files could not be found and reinstalling should fix it, which is right
  for a missing file and wrong for a *modified* one — the second is a tamper report and reads as a
  filing error. That is why `onRefused` is captured separately and surfaced as
  `PluginSummary.refusal`.
- **`Bun.build` with `target: "browser"` and `external: []` does NOT make node builtins hard build
  errors.** PLAN.md §"Install-time compilation" states it parenthetically and it is the load-bearing
  half of that section's argument. Measured on Bun 1.4.0, it *stubs* them:
  `import { readFileSync } from "node:fs"` compiles silently to
  `var { readFileSync } = (() => ({}));`. That is worse than either alternative — the import is gone
  from the output, so the deny-scan has nothing left to find, and the plugin gets `undefined` where
  it expected a function and fails at run time with a `TypeError` naming neither the cause nor the
  culprit. The bare spelling (`from "fs"`) behaves identically. Only `import { sql } from "bun"` is a
  native build error. An `onResolve` plugin now makes the documented behaviour real.
- **`import("node:" + "fs")` — the hostile plugin's own signature attack — never reaches the
  deny-scan.** Bun constant-folds the concatenation before resolving, so it hits the resolver plugin
  and fails at *compile*, not at *scan*. That is the better failure, but it means the
  `dynamic-import` rule guards a different shape (`import(name)` where `name` is a genuine runtime
  value) than the one decision 108 describes, and **the hostile suite should assert which stage
  rejected it** rather than only that it was rejected.
- **The deny-scan catches syntax, and that is the whole of what it catches.** Verified *passing*
  against the real scanner: `({}).constructor.constructor("return globalThis")()`,
  `globalThis["pro"+"cess"]["bind"+"ing"]`, a computed `require` assembled from an array join,
  `import.meta.url`, plain `process.env` access, and `fetch("https://evil.example/")`. The
  `constructor.constructor` chain in particular means the `new Function` rule is a convenience, not
  a gate. What actually closes these is the prelude scrubbing globals, the environment, and the
  process boundary. **The security-model page must describe the scan as making cheap attacks fail
  loudly at install, and must not describe it as stronger than that.** Two more for the hostile
  suite: a string-literal `eval("…")` is deliberately allowed, so a scan-clean bundle can still
  contain an `eval`; and there is no rule for `fetch`/`WebSocket`/`XMLHttpRequest` at all, which is
  correct only for exactly as long as the prelude really removes them.
- **`authorizeCall` does not check the account, though its neighbouring doc comment implies someone
  does.** `DispatchContext.accountId` is documented as "already checked against
  `PluginGrant.accountIds`", and nothing in `protocol.ts` performs that check — it validates method,
  deadline and scope only. The daemon has to do it, and now does, in `scope-gate.ts`. A comment
  asserting a check that lives in nobody's code is the shape of bug worth naming.
- **`ErasedMethod` cannot carry "which account does this speak for".** `MethodDefinition` has
  `scope` and `cost` and nothing else, and `defineMethod` erases anything extra, so the account
  posture has to travel beside the method rather than on it. Putting it in the handler was the
  alternative, and it would have made a handler decide an authorization question.
- **`PluginSupervisor` has no public `send`.** It forwards unowned frames outward through
  `onPluginFrame` but keeps the transport private, so a dispatcher cannot be attached from the
  supervisor's public surface as it stands. Wiring 3.4 into `app.ts` needs that seam opened.
- **On a reads-only surface the per-plugin budget has nothing to bite.** All three budgeted scopes
  are writes, so the machinery is wired, tested and entirely dormant until outbound actions land
  with 3.8. Worth knowing before reading a green budget test as evidence the path is exercised.
- **`env: {}` on Windows is a merge, not a replacement.** Bun synthesises eleven system variables —
  `PATH`, `SYSTEMROOT`, `WINDIR`, `SYSTEMDRIVE`, `TEMP`, `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`,
  `USERDOMAIN`, `USERNAME`, `USERPROFILE` — and adds them to whatever you pass. Passing an explicit
  minimal dictionary does **not** remove them. The only way to get rid of a synthesised variable is
  to supply your own value for it, and the empty string is that value: the variable still exists in
  the child and says nothing. Key matching is case-insensitive, so passing `SystemRoot` replaces the
  synthesised `SYSTEMROOT` rather than adding a second entry. A child starts fine with a blank
  `PATH`. Note also there is no `TMP` in the eleven, only `TEMP`.
- **The Windows memory cap is `ProcessMemoryLimit` — committed memory, not RSS and not reserved
  address space.** This makes it a far closer match to the number a human has in mind than Linux's
  `RLIMIT_AS`, which counts JavaScriptCore's huge *untouched* virtual reservations and therefore has
  to be set at a generous multiple of the intended RSS. On Windows the figure can be roughly the
  figure.
- **Crossing that cap reads as a crash, not a kill — but only during module evaluation.** The
  allocation is refused inside the plugin, JSC raises `RangeError: Out of memory`, and the process
  exits 1 on its own, so `ExitInfo.reason` is `"crashed"`. **That holds only when the refusal lands
  on the prelude's own `import()`.** From a timer callback it is an uncaught exception the prelude
  deliberately swallows: the process does not exit, and it goes *catatonic* at the ceiling — at the
  commit limit it cannot allocate even the string its pong would need, so it stops logging and stops
  answering. The **heartbeat** is then what kills it, `reason` is `"killed"`, and `rssBytes` stays
  `null` throughout. A good outcome by accident rather than by design, and worth fixing deliberately. Conversely, a `KILL_ON_JOB_CLOSE`
  termination reports **exit code 0** through Bun — not a signal, not a non-zero code. That does not
  matter today because the job is only closed after the process is already gone, but a future caller
  that closes a job *to stop* a plugin would read the kill as a clean voluntary exit.
- **`planMemoryCap` can no longer answer "is it capped" on Windows, and that asymmetry is real.**
  `RLIMIT_AS` is a property of the argv and is settled *before* the spawn; a Job Object needs a pid
  and is therefore settled *after* it. The plan now names the mechanism it will attempt and returns
  `enforced: false`, which the transport raises once the assignment actually succeeds — corrected
  upward, never downward. There is a genuine if uninteresting window between `Bun.spawn` returning
  and the assignment during which the child is uncapped.
- **`bun:ffi` types a pointer return as `Pointer | bigint | null`**, so a handle has to be narrowed
  at the boundary; and its pointer *parameters* reject a plain `number`, so handles must be carried
  as the branded `Pointer` type rather than as numbers.

- **`imageUrl()` is not idempotent, and double-applying it fails silently as a blank grey plate.**
  `HeroBanner` proxies its `url` itself, so a caller that proxies first produces
  `/api/image?url=/api/image?url=…`, which resolves to nothing. Nothing throws: the band is a
  deliberate surface that draws whether or not an image lands on it, and a failed load is a
  first-class state there — so the bug looks exactly like "this avatar has no picture". The rule is
  that **`bannerUrl` takes VRChat's raw URL**, as the world, user and group modals all do; only a
  bare `<img src>` calls `imageUrl` itself. Worth remembering as the general shape: a component that
  handles absence gracefully cannot also report a malformed input, so the two look the same.

- **A world's hero band is the wrong frame for an avatar.** `HeroBanner` centre-crops to a fixed
  160px, which suits a letterbox world image and shows a horizontal slice of a portrait avatar. The
  avatar modal draws the full image in its Overview tab at `object-contain` as well, because the
  picture *is* the record for most readers.

- **`economy-update` is documented as `balance` and arrives as `walletBalance`.** `PipelineEconomyUpdate`
  models `balance`, and the frames that actually land spell it `walletBalance` — the type's own
  comment warns the shape is unstable, and this is what that meant. Reading only the modelled name
  would leave the kind this event almost always *is* (the credit balance ticking) permanently
  unnameable, so `economySnapshot` reads both, newest spelling first. Worth remembering as the
  general shape of the risk: a field name in `pipeline/events.ts` is a guess until a real frame has
  been seen, and a differ keyed on the wrong name silently reports "nothing changed" forever rather
  than failing.

- **A subscription on an exact kind stops matching the moment that kind grows sub-kinds.**
  `PresenceService` subscribed to `["friend.*", "user.updated", …]`. The wildcard matches at any
  depth, so `friend.updated.avatar` kept reaching it; the exact `user.updated` did not, and
  `user.updated.avatar` would have silently stopped updating the presence cache with no error
  anywhere. Refining a kind is therefore never a local change: every exact-kind subscriber to that
  kind has to be found and widened. Grepping for the literal string is the check.

- **Reading source through the shell collapsed doubled backslashes, and produced a confident,
  wrong bug report.** `queries.ts` briefly did contain a real escaping bug (`` `\${char}` `` emits
  the literal text `${char}`, and `ESCAPE '\'` in a double-quoted JS string is an empty escape
  character). It was fixed, and every subsequent read of the *fixed* file through `sed`/`grep` still
  rendered `\\` as `\`, so the fix looked like the bug and got reported as still broken. The tell
  that settled it was `tsc`: TS6133 `'char' is declared but its value is never read` is only possible
  with the broken form, and its disappearance proved the file had changed rather than the display.
  Two rules fall out. **Never judge escaping from shell-rendered output** — read the bytes
  (`JSON.stringify` on the file text, or `Read`), or better, *run the code and assert on what it
  produces*. And a compiler diagnostic is a more trustworthy witness than any amount of eyeballing,
  because it does not go through the display layer at all. This is the same class as the NUL-byte
  entry below, in the reading direction rather than the writing one, and it is why CLAUDE.md now has
  a Tooling section saying to use `Read`/`Grep`/`Write`/`Edit` rather than shell equivalents.

- **Six identical "Client quit" rows for one VRChat shutdown was six daemon starts, not six quits.**
  The log watcher had no persisted read position, so every start replayed every log file it could
  find and the feed writer appended all of it again. The session row was *stable* across those
  replays — `sessions` conflicts on `(log_path, started_at)` — so the copies all landed on the same
  session and were indistinguishable from the real thing. Under `bun --watch` it is one full replay
  of the user's entire log history per code edit, which is why a development database accumulated
  them so fast. Decisions 131 and 132.

- **`overflow-x-auto` alone gives you a vertical scrollbar too.** CSS computes the other axis to
  `auto` as soon as one axis is not `visible`, so a horizontally scrolling tab strip a couple of
  pixels taller than its box grows a stub vertical scrollbar beside the tabs. `overflow-y-hidden` is
  not redundant next to it.

- **An `$effect` that calls `ensure()` on a cached loader re-runs when the cache lands, and its
  cleanup runs first.** Both new list screens started as one effect doing `eventKinds.ensure()` and
  returning `() => feed.dispose()`. `ensure` reads `loaded`, so the effect re-ran the moment the
  catalogue arrived — and re-running an effect runs its cleanup first, which aborted the feed's
  in-flight first page. The abort landed *after* the response headers, so it surfaced not as an
  abort but as a half-read body: "The daemon sent a response this build cannot read", on every
  single load. Teardown belongs in its own effect that reads nothing reactive.

- **A `$derived` class field that reads a constructor argument is a TypeScript error, not just a
  smell.** Class field initialisers run before the constructor body, so `x = $derived(this.#options…)`
  reads a field that has not been assigned yet. It *works*, because a derived is lazy and nothing
  reads it until long after construction — and `svelte-check` rejects it as "used before its
  initialization", correctly. Declare the field and assign the `$derived` in the constructor.

- **Collapsing a run of identical rows must be bounded against the whole run, not against the
  previous row.** Comparing each event to its immediate predecessor lets a run *chain*: forty world
  entries two minutes apart folded into one row claiming eighty minutes. Found by looking at the
  screen with a real filter applied, not by a test.

- **A gamelog payload cannot be compared whole to detect a replay.** It carries the *watcher's*
  per-run session UUID, so two reads of one line never produce identical payload text. The dedupe
  index keys on the fields that actually identify a line — `json_extract`'s multi-path form pulls
  the display name, world, path, reason and location out as one JSON array — with `json_valid` in
  front of it, because `json_extract` raises on non-JSON rather than returning null.

- **The NUL byte got back into `instance-roster.svelte.ts`, in the comment explaining the NUL byte.**
  `keyFor` uses ` ` as a key separator, and the file already carries a note saying the *raw* byte
  was once in this source and made every tool treat it as binary — `grep -r` skipping it silently.
  Writing the new hover-miss key through a script put three real NUL bytes back, and the tell was
  immediate and identical: `grep` answering "Binary file ... matches" instead of a line. Two things
  worth keeping. First, `grep` reporting a source file as binary is never a curiosity — it means the
  file has quietly left every text search in the repo. Second, the byte arrived through a *tooling*
  layer rather than through a typo: a ` ` written into a heredoc survives one round of escaping and
  not two, and the same script then reported a successful replacement while changing nothing,
  because the repair string was mangled the same way the original was. Byte-level checks
  (`count(b" ")`) are the only honest confirmation; a re-`grep` of the escaped form cannot
  distinguish the two.

- **`useLocalDomain` was a toggle wired to nothing.** Removing `local.vrc.zip` (decision 101) turned
  up that the setting was persisted, merged field-by-field on load, accepted by `PUT /api/settings`,
  round-tripped to the UI and rendered as a Switch — and *never read by anything that chooses a
  hostname*. `DEFAULT_HOSTNAME` was unconditional in `bind.ts`, `app.ts` and the forward proxy, so
  flipping the toggle changed a byte in `settings.json` and nothing else. The comment in `bind.ts`
  said "opt-in and resolved by the caller"; no caller resolved it. Worth remembering as a shape: a
  setting that is plumbed end to end *looks* implemented from every layer, because each layer is
  correct on its own — the missing piece is the one place that would consume it, and nothing fails
  when it is absent. `grep` for the reads, not the writes.

- **Inside a compiled binary there is no filesystem to be relative to.** `import.meta.dir` is
  `B:\~BUN\root`, a path that exists nowhere, so every `resolve(import.meta.dir, "..", …)` silently
  points at nothing and every `Bun.file()` built from one reports "does not exist". The daemon does
  not fail on that — it serves the "UI not built" placeholder, which is a healthy-looking daemon
  with no app in it, and it looked exactly like a broken build. Embedded assets are the only way
  in: `Bun.embeddedFiles`, keyed by name, never by path.

- **`bun build --asset=<dir>` names files after the directory's own basename, not the path given.**
  `--asset=ui/dist` embeds `dist/index.html`, not `ui/dist/index.html`; the leading directories are
  gone. Nothing errors — the lookup just misses every file and falls back to the placeholder. Verify
  the names by printing `Bun.embeddedFiles` from a throwaway compiled binary before trusting a
  prefix; that is how `EMBEDDED_UI_PREFIX` ended up being `dist/`.

- **A blob-backed `Response` loses its `Content-Type` once the body is consumed.** The header is
  derived from the blob rather than stored, so under `bun test`, `await res.text()` first and then
  `res.headers.get("content-type")` reads `null` — while the same two lines in the other order pass.
  It costs a confusing half hour, because the assertion that fails is not the one that is wrong.
  **Assert headers before reading the body.**

- **`fetch` decompresses the body and keeps the headers describing the compressed form.** VRChat
  gzips nearly everything, so a passed-through response reached the app announcing
  `Content-Encoding: gzip` over plain JSON, with a `Content-Length` counting the *compressed* bytes.
  A client is broken twice by that: its decompressor fails on data that was never compressed, and its
  reader truncates the body at the shorter length. VRCX reports it as "the archive entry was
  compressed an unsupported compression method", which names neither HTTP nor gzip and sends you
  looking in the wrong place entirely. Both headers are now dropped whenever one is present, in
  `proxy/passthrough.ts`. Re-compressing would be the wrong repair and asking VRChat for `identity`
  worse than both — the egress filter has to *scan* every body for a leaked credential and cannot see
  inside a gzip stream, so decoded bodies are what make that check mean anything.

- **The pinned spec does not describe the URLs VRChat puts in its own responses.** Every image a
  client shows is `/file/{fileId}/{versionId}/{variant}` or `/image/{fileId}/{versionId}/{resolution}`
  — four segments — and `openapi.json` v1.20.8 has neither. It documents the five-segment
  `/file/{id}/{version}/{type}/status` and stops one short of the route that actually serves bytes.
  So the mirror answered VRChat's real 404 for every avatar and icon: correct behaviour applied to an
  incomplete table. They live in `SUPPLEMENTAL_ROUTES` in `proxy/route-table.ts` rather than in
  `packages/api/src/generated`, which is codegen output — a supplement a regeneration silently
  discards is worse than no supplement. **Assume the spec is incomplete rather than authoritative
  about what VRChat serves.**

- **`sessionId` was the same identifier in two shapes, and the seam between them was a round trip.**
  The bus and the store both call it an integer `sessions` row id, and `event-bus.ts` has a comment
  explaining at length why it must be the store's id and not the watcher's internal string. The UI
  nonetheless typed the stream's `sessionId` as `string`, stringified it on arrival in `stream.ts`,
  and parsed it back to a number one function later in `events.ts` — whose own comment admitted the
  round trip was pointless. Downstream, `LiveSessions` keyed its map by string and correlated with
  `get(String(session.id))`, and `LiveEvent` carried a second `streamSessionId` field described as a
  "deprecated alias kept only so nothing reads a missing field during a refactor". Nothing read it.
  One type on both sides deleted the conversion, the alias, the string-keyed map, and a dead
  `streamIdFor()` with no callers. Duplication does not just risk drift; it accretes machinery whose
  only job is reconciling the copies.

- **The event-kind taxonomy had drifted in four directions at once, and nothing could see it.** The
  two `wiring/*` bridges typed their kind maps as `Record<string, string>`, `ui/src/lib/api.ts` held
  a hand-copied `KnownEventKind` union, and `ui/src/lib/format.ts` held a label table that was a
  *superset* of that union. Typing the producers against one shared list found: the UI union was
  missing **ten** kinds the pipeline bridge emits every day (`group.joined`, `group.left`,
  `group.member_updated`, `group.role_updated`, `instance.queue_joined`, `instance.queue_ready`,
  `user.badge_assigned`, `user.badge_unassigned`, `content.refresh`, `content.image_updated`); the
  whole `consent.*` family from Phase 2.6 was in no list at all, and `EventRow` consequently had no
  left-rule colour for it; and `presence.test.ts` asserted on **`friend.update`** — no `d` — a kind
  nothing has ever emitted. That last one passed for months because `PresenceTracker` subscribes to
  `friend.*` and its handler branches only on `friend.removed` and `friend.offline`, so the typo
  took the generic path and the assertion held. A test can be green, exercise real behaviour, and
  still be testing a string that does not exist.

- **`clock.now` is frozen unless something calls `clock.subscribe()`.** The shared clock only runs
  its interval while a reader has claimed it, so a screen that reads `clock.now` inside a `$derived`
  without subscribing renders the time it mounted at and then never moves. Nothing errors and
  nothing logs. On the consent screen that meant a five-minute countdown stuck at 4:27 and an
  expired code still offered as though it worked — caught by watching the real screen for ten
  seconds, and invisible to `svelte-check`, which is exactly the gap §UI notes warns about.
- **A path segment in VRChat's spec can hold more than one parameter.**
  `/instances/{worldId}:{instanceId}` is one segment, two parameters and a separator, and the
  obvious `startsWith("{") && endsWith("}")` test reads it as a single parameter named
  `worldId}:{instanceId` — matching, capturing the whole segment, and naming it nonsense. Nothing
  fails loudly: the route resolves to the right operation and the right scope, and only the extracted
  parameters are wrong, which is exactly what the pass-through path will later rebuild a URL from.
  Segments are compiled to a regex each now.
- **`pairing_requests.grant_id` is a foreign key, so a pairing can only be approved after its grant
  row exists.** The handshake already does it in that order; a test that approved against an invented
  id is what surfaced the constraint. Worth knowing before anyone reorders those two lines for
  tidiness.
- **Assigning `c.res` in Hono copies the previous response's headers onto the new one — including
  `Set-Cookie`, by name.** So an egress filter written the obvious way, as the last middleware,
  strips the upstream cookie and then hands back a response that still carries it. The test that
  caught this asserted the client-visible header rather than the middleware's return value, which
  is the only reason it was caught at all: every intermediate value was correct. Anything whose job
  is to *remove* something from a response cannot live in a Hono middleware; it has to wrap the
  fetch handler. See decision 46.

- **`platform` is another field VRChat answers `offline` in.** Not a platform, and not a rare edge:
  it comes back that way for somebody the game log has standing in an instance, because the roster
  answer and the log are two sources at two moments. A pass-through fallback meant to future-proof
  the column against new device names printed it verbatim under a heading of device names. The
  pattern is now three deep — `status`, `state`, `platform` — so treat *any* VRChat string field as
  capable of returning a presence word instead of its own kind of value.
- **`??` is the wrong operator against every optional string VRChat sends.** It writes `""` rather
  than omitting a field, and the empty string sails through `??` as if it were an answer. It was
  known for image URLs and written down as such; it is the same for `status` and
  `statusDescription`, where presence stored `""` and the UI — which maps an unrecognised status to
  "Unknown" and an unrecognised colour to grey — drew a grey dot for a friend who was plainly
  online. The rule is not about images. It is about the whole API.
- **`status` is what a user chose, not whether they are here.** VRChat leaves `status` at `active`
  while somebody is offline; `state` (`online` / `active` / `offline`) is the online-ness. Reading
  presence off `status` leaves an offline friend online forever, which is why `observe` uses `state`
  and falls back to what it already knew rather than guessing from `status`.
- **An `$effect` that fires correctly still does nothing if the thing it calls declines.** The
  roster's refetch-on-join was wired up and working — the effect ran on every arrival — and the
  rate limit inside `ensure` swallowed it, so the feature looked implemented and never once ran.
  Nothing pointed at the gap: no error, no log, and the data appeared a moment later if you left
  the screen and came back. When a guard and a trigger disagree, the guard wins silently.
- **Two singleton dialogs are two dialogs.** Each of the three entity modals was independently
  correct — one instance, mounted once, re-targeted by callers — and the bug was in the space
  between them: nothing said only one may be on screen. Opening a group from a profile mounted a
  second `Dialog.Root` over the first, and the scrims *composited*, which is how it presented: not
  "two dialogs" but "the background went black". A set of singletons is not the same thing as a
  singleton over the set.
- **A design token used for both a background and its text is invisible, and neither theme reveals
  it.** The vendored tooltip shipped as `bg-foreground text-foreground` — the same token twice. In
  dark that is near-white on near-white; in light it is near-black on near-black. It only became
  visible as a bug once `WorldLink` put a *card* in a tooltip, because a blank white slab under a
  world thumbnail looks like a broken image while a blank one-line chip looks like nothing at all.
  Grep for a `bg-*` and `text-*` naming the same token before trusting a vendored class string.
- **`bg-background` is not the dark theme's panel colour.** It is the *page*. A popover moved onto
  it is not visibly broken — it is dark, it has a shadow — it has just quietly become the same plane
  as everything behind it. `--popover` exists to be one step lighter (`0.205` against `0.145`), so
  the fix for "this floating thing looks flat" is almost always the token, not the shadow.

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
- **VRChat enforces three rate limits, not one: 20 req/s per account, 100 req/s per IP, and 300
  req/s per IP for file requests.** An earlier draft of this file recorded a single 20/s figure and
  called it per-IP, which was wrong in both directions at once — it throttled the whole machine to
  a fifth of the real API budget while leaving the actual per-account ceiling unrecorded, and it
  had no concept of the file tier at all. Per-account buckets alone still cannot see six accounts
  each politely under their own 20/s adding up to 120/s, so all three buckets stay. Each defaults
  to 80% of its own ceiling (16/s, 80/s, 240/s).
  - A contended API call spends **neither** the account nor the global bucket — spending one while
    waiting on the other leaks a token per contended call.
  - The **file bucket has no per-account partner**, deliberately. The per-account bucket exists to
    stop one account starving the others under a *shared* ceiling; the file tier's ceiling is three
    times the API one, so that problem barely exists, while charging icons to a 16/s per-account
    bucket would make a 200-friend screen take twelve seconds to paint.
  - The **429 breaker is shared across all three**. VRChat may throttle the tiers independently,
    but pausing more than strictly necessary is the safe direction to be wrong in.
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

Found while fixing the avatar and status-dot bugs (1.9 follow-up):

- **An inline `<span>` with padding is not a circle.** The status badge was a `rounded-full`,
  `p-0.5` *inline* span wrapping an `inline-block` dot; line-height leading inflated it into a tall
  dark rectangle sitting behind the dot. The fix is the vendored shadcn `AvatarBadge` (an
  `inline-flex` with `ring-2` instead of a padded fill) with the dot at `size-full`. Note the
  surface token was **not** the bug — both lists sit directly on `AppShell`'s `bg-background`, so
  `ring-background` was right all along. Worth recording because "wrong colour token" was the
  obvious-looking diagnosis and it was wrong.
- **`AvatarBadge` needs `bg-transparent` when its child paints the fill**, or the preset's default
  `bg-primary` shows as a sliver at the rounded edge.
- **`loading="lazy"` does almost nothing on a bits-ui `AvatarImage`.** bits-ui preloads through
  `new Image()` before the rendered `<img>` ever exists, so a 200-friend list fires 200 proxy
  fetches on first paint rather than on scroll. The disk cache makes that a one-time cost per icon,
  and the file rate tier (above) is what keeps it from starving presence polling — but virtualizing
  the friends list is the real fix if it ever bites.
- **VRChat returns `""`, not `undefined`, for unset image fields.** `userIcon ?? profilePicOverride`
  therefore picks the empty string and renders nothing. Every one of these needs an emptiness check,
  not a nullish coalesce — `pickUserImageUrl` is the single place that does it.
- **A cached image has no upstream `Content-Type`.** Sniffing magic bytes has to *win* over the
  upstream header rather than the reverse, or the same URL answers differently depending on whether
  it was a cache hit.
- **The image cache evicts by mtime, not LRU**, on purpose: touching a file on read turns every
  cache hit into a disk write. The cost is that a long-cached, still-displayed icon is occasionally
  re-fetched. **404s are not negatively cached** — a deleted image is re-requested on every page
  load. Cheap to add; it currently spends file budget.
Found by debugging the *running* daemon against a real VRChat client — none of these had a failing
test, and three of them had a passing one asserting the wrong layer:

- **Every session row ever written was unattributed, because the write did not exist.**
  `sessionUpdate` in `wiring/log-bridge.ts` emitted a correct `session.update` bus event and wrote
  nothing to SQLite; there was no `updateSessionIdentity` on the store at all. The UI reacted
  correctly to the stream, so it looked right until a reload, and `GET /api/sessions` served
  `accountId: null` forever. **The existing test asserted the bus event.** That is the lesson: for
  anything the API re-reads later, assert the row, not the event.
- **`current_world_id` was hardcoded `null`** at that same call site while `current_location` held a
  real `wrld_…`. Two columns disagreeing in the live database is what exposed it.
- **A session's `started_at` came from the log file's mtime.** A live log is appended to constantly,
  so its mtime is "a moment ago" for as long as the client runs — every daemon restart therefore
  computed a *different* start for the same session. Sessions are keyed `(log_path, started_at)`,
  so each restart forked a row and orphaned the previous one with `ended_at` never set. Birth time
  is the stable answer, and it must **not** be clamped to `now`: `Math.min(birth, now)` reintroduces
  exactly the moving value being fixed.
- **Staleness was measured from adoption, and then reset by reading history.** A dead client's log
  got a fresh `staleAfterMs` lease on every restart, and the initial catch-up read counted as
  "growth" and restarted the clock again. Under `bun --watch` that is a dead client showing as live
  forever. The first read of a newly adopted file is history, not growth.
- **Tailing from EOF skips the `User Authenticated:` line.** A client already running when the
  daemon starts stays unlinked for the rest of its life. The head of the file is now scanned for
  that one line — and only that line, since replaying the rest would duplicate every row the
  previous run already wrote.
- **Sessions open in the database at startup belong to a dead process.** Nothing ever closed them.
  They are swept at open and ended at `MAX(ts)` of their own events, never at `now` — the daemon may
  have been down for hours and stretching a session over that gap fabricates a fact. `startSession`'s
  upsert clears `ended_at`, so the watcher immediately reopens whichever clients are genuinely live.
- **`bindServer` computed `fellBack` and nothing ever read it.** A taken port silently became an
  ephemeral one, so a bookmarked URL, a saved token, and an open tab all broke with no explanation.
  The usual cause is an orphaned daemon from an earlier `bun --watch` run still holding the port —
  which the warning now names by pid, conservatively: only when the previous `state.json` recorded
  that pid on *that* port and `process.kill(pid, 0)` says it is alive.
- **`bun --watch` reloads with SIGTERM and lets the handler finish.** Not a hard kill. The outgoing
  process was deleting `state.json` moments before the incoming one read it, so token reuse would
  have looked like a flaky race rather than a broken design. `stop()` skips the delete in dev mode.
- **`process.execArgv` is how you detect watch mode** (`["--watch"]` / `["--hot"]`), and it survives
  every reload despite the new pid. `Bun.argv` and `process.argv` carry nothing, and Bun sets no
  `BUN_*` variable for it — anything keyed off argv would be wrong.
Found by using the app against a real account with real data:

- **A socket carries deltas; it cannot tell you state.** Notifications were sourced *only* from the
  pipeline, so vrc.zip knew about exactly those that arrived while it happened to be connected. An
  account with 300 pending notifications showed an empty screen, and the database had zero
  notification rows — ever. `accounts/notifications.ts` backfills over REST and reconciles on a
  jittered poll, the same shape as `PresenceService` and for the same reason.
- **VRChat's two notification generations do not page the same way.** v1
  (`/auth/user/notifications`) takes `n` + `offset`. v2 (`/notifications`) takes **`limit` only —
  there is no offset**. Sending one is accepted and silently ignored, so a paging loop re-reads the
  same first page, the short-page check never fires, and it runs to the cap rewriting identical
  rows on every poll. v2 is one request.
- **`details` is a JSON-encoded *string* over REST and a real object over the socket.** The
  generated types say so explicitly. One shared mapper (`toNotificationRow`) owns the difference;
  two mappings would drift into two different sets of bugs.
- **A backlog must not be replayed as live events.** Emitting 300 `notification.received` events
  would raise 300 desktop notifications and bury the feed with years-old friend requests presented
  as new. The backfill writes to the store and emits one summary event.
- **`senderUsername` is deprecated and VRChat no longer returns it**, so a backfilled notification
  usually has a null display name. The sender *id* is always there; the UI resolves the name.
- **A `SvelteMap` makes structural change reactive and says nothing about the objects inside it.**
  The live-sessions roster was plain objects in a `SvelteMap`: a client *appearing* re-rendered,
  while every player join and leave inside it was invisible, so an instance's roster froze at
  whatever it held when the session row appeared. The entries are `$state` now. Anything added to
  them must stay inside that object or it silently stops updating.
- **Two comments in the UI asserted the opposite of the truth, and both cost a feature.**
  `GameLogScreen` said the feed writer stores `session_id` as null on every row, and therefore
  discarded all stored lines when a client was selected — the column has *always* been populated
  (9,288 player-join rows in a real database, zero nulls). What was actually null was `sessionId`
  on live frames, hardcoded in `frameToEvent`. Separately, `live-sessions` said the daemon does not
  publish the watcher-id → row-id mapping and correlated on start time within a tolerance;
  `log-bridge` has always translated to the row id *before* emitting. A confident comment is not
  evidence — check the column.
- **`kind` was applied as a JS filter after `LIMIT`.** A filtered feed returned short pages and
  then an empty one, which an infinite scroll reads as the end of history. It is a SQL predicate
  now, in every statement.
- **The unfiltered feed fanned out per account, so `account_id IS NULL` rows were unreachable** no
  matter how far you scrolled — and an unmanaged game client's events are exactly those rows.
- **`GET /instances/{id}` answers a bare `null` with a 200 for an invalid instance id.** VRChat's
  own doc comment says so. Unchecked, that is a `TypeError` in the roster mapper rather than an
  empty list — the failure lands nowhere near the cause.
- **An instance roster is absent far more often than it is an error.** VRChat fills `users[]` only
  for an account that is *in* that instance, and a closed instance 404s — both are the ordinary
  course of events, not faults. They answer `200 source:"unavailable"` so the screen falls back to
  the log-derived names, while a genuine upstream 5xx stays a `502`. Collapsing the two would hide
  a real outage behind a screen that looks like it is working.
- **`isFriend` is already on `LimitedUserInstance`**, riding along in a response we were paying for
  anyway. It is still OR'd with local presence, which is the only answer available in the seconds
  before an account's first friends poll lands.
Found by clicking around the built UI against a real account:

- **A duplicate key in a Svelte 5 `{#each}` is a hard runtime error, not a warning.** The component
  stops rendering. So "the server would never send the same id twice" is not a safe assumption to
  render on, and three lists here were making it: the Groups tab (VRChat can return the same group
  twice when a user holds more than one membership row in it, and the represented group is merged
  in from a *second* endpoint), the first page of mutual friends, and bio links — which were keyed
  on the link text itself, so a user pasting the same URL twice would have taken down the whole
  Overview tab. Anything keyed on wire data now dedupes; lists of plain strings are keyed by index.
- **A wire contract that only the type system believes is not a contract.** The daemon sent a group
  as `id`; `ui/src/lib/api.ts` declared `groupId`; the Groups tab keyed on `group.groupId`. Every
  key was `undefined` and the tab died, while the network tab showed a perfectly good 200 with 85
  groups in it. The tell was that Mutual friends worked — it used `id` on both sides. Note VRChat's
  own payload is a trap here: `LimitedUserGroups` has `groupId` **and** a separate `id` meaning the
  *membership row*.
- **An aborted request must not leave a lazy tab's phase at `"loading"`.** Closing the modal aborts
  in flight; the catch returned early without resetting, so `ensureGroups` short-circuited on
  `phase !== "idle"` forever after and `retryGroups()` refused to run while it read `"loading"`.
  Only the two lazy, tab-triggered loads wedged: nothing else ever re-runs them, so there was no
  second chance to recover. Abandoned work is not failed work — it is work that has not started.
  Note the order of the two guards: a **superseded generation** must still return without writing,
  because `#reset()` already owns the new target's phase.
- **`GET /notifications` (v2) takes `limit` and has no `offset`.** Covered above, and it is the same
  class of bug as the two below: an endpoint that accepts a parameter it ignores.
- **The generated API client is locale-contaminated.** `packages/api/src/generated/` holds 47
  identifiers like `İnviteMyselfToData` and `İnstanceId` — U+0130, capital I with a dot. Codegen ran
  under a Turkish locale, so `toUpperCase` on a leading `i` produced `İ` rather than `I`. It
  compiles, but regenerating on any other machine produces a large spurious diff. The codegen step
  needs a fixed locale. **Not yet fixed.**

- **`Number.MAX_SAFE_INTEGER + 1` is a silent no-op as a sentinel.** It equals
  `Number.MAX_SAFE_INTEGER`. The cache's sweep-on-first-write counter initialises to `evictEvery`
  instead — and that behaviour is load-bearing, since a daemon restarted more often than it writes
  32 images would otherwise never evict and the size cap would be decorative.

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
- `/users/{id}` is **not deprecated**, and `/profile/{id}` is not its successor — see decision 49.
  The profile endpoint holds no presence field of any kind, so anything reading `location`, `state`,
  `last_login`, `platform`, or `travelingTo*` off it reads `undefined`. Check `deprecated` in the
  pinned `openapi.json` before believing any "endpoint X is gone" report; 29 operations carry the
  flag and it is the only authority we have.
- `apiKey` query param does **not** exist in spec v1.20.8. Don't implement it.
- VRChat has added and removed the user id on `OnPlayerJoined` before. The parser must tolerate both.
- `User Authenticated: (.+?) \((usr_[0-9a-f-]+)\)` is the *only* link between a log file and an
  account — filenames carry a timestamp, not an identity. Everything before that line in a fresh log
  is unattributed until it appears.

### Testing the UI under Vitest

- **Runes only exist in `.svelte.ts` (and `.svelte`) files.** `$state` in a plain `*.test.ts` is a
  `ReferenceError: $state is not defined` at runtime — the Vite Svelte plugin compiles runes by
  filename, and a test file is not on that list. So a test that needs reactive scaffolding puts it
  in a `*.svelte.ts` helper beside the test and imports it. Driving an existing state class from a
  plain test file is fine: its `$state` fields were compiled where they were *declared*.
- **`$state` and `$derived` work outside any effect root.** Constructing a state class, mutating a
  field and reading a `$derived` all behave, so the state modules are directly unit-testable — no
  component, no `mount`, no root.
- **`$effect` is the exception and needs both `$effect.root()` and `flushSync()` from `svelte`.**
  Effects do not run on assignment; `flushSync()` is what makes them fire, and the disposer returned
  by `$effect.root` must be called or the effect outlives the test.
- **Without `resolve.conditions: ["browser"]`, `$effect` silently never runs.** Vitest resolves
  Svelte's *server* build by default, whose effects are no-ops — it does not throw, it does not warn,
  the assertion just observes nothing. Measured, not assumed. This is the single most expensive
  thing to get wrong here, because the failure mode is a test that passes for the wrong reason.
- The state modules are **module-level singletons** (`worldNames`, the `suspended` back stack).
  Reset them in `beforeEach`/`afterEach` or one test reads another's leftovers as history.
- Fake only `Date` (`vi.useFakeTimers({ toFake: ["Date"] })`) when testing the resolvers: their
  flush is a `queueMicrotask`, which no timer mock intercepts, and faking `setTimeout` deadlocks any
  helper that awaits one.

---

## Conventions

- **No em-dashes in user-facing text.** UI copy, notification titles and bodies, daemon console
  output, and API error `message` fields use a full stop or a colon instead. Comments, JSDoc, and
  these documents are unaffected: the rule is about product copy. A few pre-existing instances are
  still around (the startup banner, the setup-required message, the game-log empty state) and are
  worth sweeping when those lines are next touched.

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

bun run test                 # daemon + packages + tools, under bun test
bun run test:ui              # the ui workspace, under vitest (cd ui && bun run test:watch to iterate)

bun run package              # → dist/vrc.zip.exe, one self-contained Windows binary
bun run icon                 # regenerate tools/assets/vrczip.ico (needs ffmpeg; the .ico is committed)
```

`bun run package` builds the UI, then compiles the daemon, the bundle and the Bun runtime into a
single `.exe` with the app icon and version metadata on it. `--skip-ui` reuses whatever is in
`ui/dist` while iterating on the packaging itself; `--outfile=` and `--target=` are there too.
Smoke-test the result the same way as anything else — `VRCZIP_STATE_DIR=… ./dist/vrc.zip.exe
--no-open` — and check that `/` returns the real bundle rather than the placeholder page, which is
what a build with no UI embedded serves.

Set `VRCZIP_STATE_DIR` to redirect the whole state tree (secrets, DB, `state.json`) somewhere
disposable — that is how the tests and any manual poking should run, so a smoke test never touches
your real credential store.

Verified live on Windows: three ports bound, `state.json` written, Credential Manager backend
active, wrong `Host` 403, wrong `Origin` 403, missing token 401, proxy 501, UI 200.

## Open questions

Unresolved; flag to the user rather than guessing.

**A planning pass on 2026-08-22 closed most of what used to live here.** Sixteen questions were put
to the user in batches and answered; the answers are decisions 95–110. What each one *was* is kept
below in one line, because a question closed without a trace is a question that gets reopened.

**A second pass the same day scoped the middle of Phase 3** — twelve more questions, four at a time,
all of them answered in decision 165: the build order for 3.4 and 3.5, where the runtime fetcher and
signing land, what parses the deny-scan, whether plugins get their own scope namespace, the shape of
the per-plugin budget, how much of `ctx.vrchat` ships first, the two Windows limitations, how the
hostile suite runs in CI, and what counts as verification. It also **dropped the `EAGER_FILL_LIMIT`
measurement** outright rather than leaving it open (decision 164).

**A third pass the same day scoped the back half of Phase 3** — twenty-eight questions, four at a
time, all of them answered in decision 182 and listed at the bottom of this section. Two of them are
**cuts rather than answers**, which is why this pass closed more work than it opened: OS-level
plugin sandboxing and Ed25519 signing are both out of the plan entirely, and the docs that describe
them are wrong until step 3.0 rewrites them.

- **~~Can JSC's small-heap mode be selected any way other than at process launch?~~ Closed by
  decision 111**, which removes the need to know: the plugin host is a real `bun` fetched on demand,
  so `--smol` is ordinary argv again. What replaced it is smaller and concrete — **verify the Bun
  release asset's SHA-256 by hand when the pin is bumped**, since it is now a build input and the pin
  lives in four places rather than three (`packageManager`, `engines.bun`, `.bun-version`, the runtime
  hash). CLAUDE.md still says three and will need updating when the fetcher lands.
- **The control-deps flake was not reproduced, and its mechanism is still unknown.** `the user
  batch is cache-first, sequential, and leaves the unreadable out` failed once in a full run and has
  now survived seven consecutive full runs plus eighteen targeted ones. Reading the path rules out
  what usually explains that shape: every request both calls make is awaited, so no late supplement
  can inflate a count; the fixture, store and limiter are per-harness; `control-deps.ts` holds no
  module-level state and starts no timer; and `USER_CACHE_TTL_MS` is ten minutes, so load cannot
  expire the warm between the two calls. Decision 103 asked for a fix and there is nothing yet to
  fix — the assertions now compare whole path arrays instead of counts, so **the next occurrence
  identifies itself**. A test timeout under a loaded full run remains the leading hypothesis and is
  the first thing to check if it fires again.
- **Type hoisting: done, except for two candidates that turned out not to be duplicates.** The third,
  the retention types, is now a *pending* move rather than a non-duplicate — decision 99 puts them on
  the wire with 2.10, and everything on the wire lives in `@vrcz/shared`. The two that stay put:
  - **`ParsedLocation` is a name collision, not a duplicate.** `game-logs/parser.ts` has
    `{location, worldId, instanceId, region, groupId}` with a non-nullable `worldId`, returning
    `null` for `private`/`offline`. `ui/src/lib/format.ts` has
    `{worldId, instanceId, access, region, opaque, label}`, is **total**, and never returns null.
    Only `instanceId` and `region` are shape-compatible. One parses a log line, the other decides
    what to draw. They want different *names*, not a shared definition.
  - **`VrMode` should not be hoisted as-is.** The parser's `"vr" | "desktop"` is accurate at the
    parser — only two markers produce it — but the store, the wire, and the UI all widen it to
    `string`, and `ui`'s `isVrMode()` explicitly handles `Standalone`/`Oculus`/`OpenVR`/`None`. The
    wire keeps `string` deliberately (it crosses a version boundary; see the note on
    `GameSession.vrMode`), so the union is a parser-internal type and belongs where it is.

### Closed by the 2026-08-22 planning pass

- Shape of a per-grant rate budget → rolling per-hour window on the risky scopes only (95).
- What earns an `audit_log` row → mutating calls plus dangerous-scope reads (96).
- Whether 2.10 defers webhooks → no, they ship with the stream (97).
- How unlinked sessions are gated on the stream → a dangerous `sessions:unlinked` scope (98).
- When retention gets an API and a control → with 2.10 (99).
- Whether `rateLimit.remaining`/`queued` become real or stop being drawn → become real, and the
  single gauge becomes the three ceilings that exist (100).
- Whether `local.vrc.zip` DNS + the DNS-01 cert pipeline gets stood up, and who owns the renewal
  endpoint → **cut**, so nobody owns it (101).
- Whether the roster fallback needs its own budget → cap *and* budget (102).
- The one flaky control-deps test → fix it before Phase 2 closes, don't wait for it to recur (103).
- Where `invite-request` and `boop` land → with 2.10 (104).
- What follows Phase 2 → Phase 3, the plugin system (105).
- Single `.exe` vs `bun.exe` + `app/` once plugins need a runtime → single `.exe` (106), and the
  plugin runtime is **fetched hash-pinned from `bun.sh` on first plugin install** rather than bundled
  or re-invoked (111), which closed the JSC sub-question by making it moot.
- Where plugins come from in v1 → local path or pinned git URL, no registry (107).
- How early the hostile plugin gets written → immediately after the supervisor (108).
- What lifts dry-run on outbound social actions → an explicit per-scope gesture, never a timer (109).
- How much declarative UI vocabulary ships first → forms, tables, dialogs, menus, handlers; charts
  when a plugin is genuinely blocked on one (110).

### Closed by the third 2026-08-22 planning pass

All of these are decision 182; one line each so a closed question leaves a trace.

- Whether OS-level plugin sandboxing gets built → **cut permanently**, not deferred; correction 6
  becomes the standing posture rather than a temporary one.
- Whether Ed25519 signing and trust tiers ship in v1 → **cut**, and their remnants (`signing` in the
  manifest, `plugins.trust`, `plugins.publisher_key`, the `signed` tier) come out with them.
- When the docs describing those two get rewritten → **before 3.7**, as step 3.0.
- What is built next → 3.7 storage, in the plan's own order.
- How a capability is enforced → a real `capability` field on `GatedMethod` and `capabilities` on
  `PluginGrant`, not a synthetic scope.
- How quota is measured → a `stat` on the data dir, checked pre-write, refusing `E_QUOTA`.
- Whether the per-plugin DB reuses `Store` → no, its own minimal opener.
- What uninstall does with plugin data → `rm -rf` by default, with a keep checkbox in 3.8.
- How rich the `records` query is → key prefix + time window + limit, nothing more.
- Who prunes `records` → the plugin, entirely.
- Whether the prelude grows a client surface → yes, the whole `ctx`, with 3.7.
- How big a stored value may be → arbitrary JSON to 256KB.
- Where the plugin consent gesture lives → a **blocking** install, no pending table.
- Whether `permissions.events` becomes enforceable → yes, migration 007 adds the column and the
  grant field.
- What hold-to-confirm guards now that every plugin is unsigned → every install.
- Whether 3.8's UI installs from git → local path only; git stays 3.5's outstanding item.
- How a plugin UI tree reaches the browser → a new `/api/stream` frame type carrying a keyed patch.
- How `table` handles ten thousand rows → it pages, reusing `PagedSection`/`ScrollSentinel`.
- Who sorts and filters a table → the host, over the rows it holds.
- What a panel does mid-intent → optimistic `busy` on the node, the rest of the tree stays live.
- What 3.10 delivers → registration, runtime and the type checker; no editor, that is Phase 4.
- What `create-vrcz-plugin` and `vrcz dev` are → modes of the shipped `.exe`.
- How hard the generated-docs gate is → generated and committed, no CI drift check.
- Where 3.4's budget readout lands → with 3.7.
- When Phase 2's end-to-end pass happens → **not scheduled**; it needs a real third-party client to
  mean anything, so it stays open rather than being ticked by a test impersonating one.
- What follows Phase 3 → Phase 4, the node graph.
