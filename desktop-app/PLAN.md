# vrc.zip — VRChat Account Manager

## Context

VRCX is the incumbent VRChat companion app, and it has four structural problems this project exists to fix:

1. **Windows-first.** Linux is a Wine/Proton workaround page on a wiki, with a known memory leak.
2. **Heavy.** It embeds Chromium in a .NET host. Users report >7GB RSS after 48h ([#1660](https://github.com/vrcx-team/VRCX/issues/1660)) and ~8GB VRAM accumulation ([#1426](https://github.com/vrcx-team/VRCX/issues/1426)). The standing community advice is "restart it periodically."
3. **Multi-account is second-class.** You cannot switch accounts without logging out ([#1170](https://github.com/vrcx-team/VRCX/issues/1170)); concurrent accounts require launching separate processes against separate DB files. Its schema encodes this — ~13 tables per account, prefixed with the sanitized user id.
4. **Not extensible.** No plugin API. Every feature must land in the monolith.

Additionally, every VRChat tool on a user's machine logs in independently, each burning one of the undisclosed number of concurrent sessions VRChat allows and each hammering the API on its own schedule.

**vrc.zip** is a Bun daemon that: runs on Windows and Linux equally; idles at 50–80MB; treats multiple accounts as the normal case; exposes a scoped, byte-faithful mirror of the VRChat REST API so other local apps stop logging in separately; and is extensible through a sandboxed plugin system and a node-graph automation editor.

### Guardrails (non-negotiable, they shape the design)

- **Local-only.** Binds `127.0.0.1`. Credentials never leave the machine. All VRChat traffic originates from the user's own IP — VRChat's guidelines assume "the interaction comes from the user's device and IP," and the pipeline WebSocket enforces this (`{"err":"authToken doesn't correspond with an active session","authToken":...,"ip":...}`).
- **Branded UNOFFICIAL.** Persistent, non-dismissible marker in the UI and in the User-Agent. `vrc.zip` reads as semi-official and this thing holds credentials.
- **No monetization end-runs.** Favorites, invite message slots, and group limits are enforced client-side against the account's real VRC+ entitlements (`GET /auth/user/favoritelimits`). We do not build "unlimited local favorites."
- **Session frugality.** Every Basic-auth `GET /auth/user` mints a new session against an undisclosed cap. Persist and reuse the `auth` cookie; never call `PUT /logout` on shutdown.
- **Backoff is mandatory.** Exponential from 1s on 429. No fixed-clock polling — jittered intervals seeded from process start, per VRChat's explicit instruction not to create synchronized traffic spikes.

### Known tension to accept knowingly

VRChat's Creator Guidelines say *"Do not request log-in information from users in any situation"* and *"Do not act on behalf of another user."* VRCX and every other tool in this space are in the same position. Our defensible reading: the daemon runs on the user's machine, holds only that user's own accounts, and issues requests from that user's IP — no server-side custody, no third party. The proxy is the part that most resembles "acting on behalf of another user," so it gets an audit log of every mutating call, per-token rate budgets on the abuse-adjacent scopes, and a global kill switch. This should be stated plainly in the README rather than glossed.

---

## Decisions already locked

| Area | Decision |
|---|---|
| Runtime | Bun + TypeScript. `bun:sqlite`. **Ships its own pinned `bun` binary** — never an external or `PATH` Bun. Runs the daemon and every plugin process. |
| UI | Svelte 5 + shadcn-svelte, served over HTTP by the daemon. No native shell in v1. |
| API client | **Generate our own** from a pinned `openapi.json` (v1.20.8) via `@hey-api/openapi-ts`. Not the `vrchat` npm package. |
| Local URL | **Default `http://127.0.0.1:PORT`.** `local.vrc.zip` (DNS → 127.0.0.1, real DNS-01 cert) is supported and is what the README documents, but is opt-in at runtime. |
| HTTP | **Hono** on `Bun.serve`, three separate app instances (one per port). Thin over `Request`/`Response`, which the byte-faithful mirror depends on. |
| Ports | Four: UI, proxy mirror, control API, and a **forward proxy** an app is configured with rather than pointed at. |
| Proxy | Byte-faithful passthrough. Apps log in per-account through the proxy; one grant per (app, account). |
| Credentials | Encrypted local store; the key lives in the OS keychain. |
| Plugins | Isolated child process + capability RPC (Worker is not a security boundary). Contributes event handlers, UI panels, node types, settings, commands, notifications. |
| Node graph | IFTTT-style automation on Svelte Flow (`@xyflow/svelte`). |
| Retention | **Per-event-type windows, all configurable.** Friend log, notes, and avatar history are never auto-deleted. |
| Notifications | Web Notifications API + VR overlay (XSOverlay / OVR Toolkit / OSC) + push-out (Discord webhook, ntfy) as node-graph actions. |

### Why we generate the client instead of using `vrchat` npm

The package is well-built but wrong-shaped for us:
- Cookie persistence uses the hardcoded key `"cookies"`; `getCookies`/`saveCookies` are private, so there is no supported way to read the `auth` token we need for our own pipeline socket.
- Its pipeline WebSocket has no reconnect, no backoff, no heartbeat — a dropped socket stays dropped.
- Its message handler does an unconditional `JSON.parse(content)`, which **silently swallows `see-notification`, `hide-notification`, and `clear-notification`** (their content is a bare ID string, or absent).
- It registers 3 un-removable `process` listeners per instance (`beforeExit`×2, `SIGINT`), so ~10 accounts trips `MaxListenersExceededWarning`.
- No 429 handling anywhere.
- Its 401-replay path rebuilds the response via `Response.json()`, losing original headers — fatal for a byte-faithful proxy.

We keep the same *upstream*: pin `vrchatapi/specification` `openapi.json`, run `@hey-api/openapi-ts` in a codegen step, commit the output. We get identical type coverage plus a generated route table the proxy needs anyway.

---

## Architecture

```
                        ┌─────────────────────────────────────────────┐
   browser ────────────►│  :7773  UI + session API   (token in URL)    │
   (127.0.0.1)          └─────────────────────────────────────────────┘
                        ┌─────────────────────────────────────────────┐
   3rd-party apps ─────►│  :7774  VRChat API mirror  (byte-faithful)   │
                        │         + wss pipeline mirror                │
                        └─────────────────────────────────────────────┘
                        ┌─────────────────────────────────────────────┐
   3rd-party apps ─────►│  :7775  control API                          │
                        │   consent · token mgmt · enriched event      │
                        │   stream · webhook registration              │
                        └─────────────────────────────────────────────┘
                        ┌─────────────────────────────────────────────┐
   apps that can only ─►│  :7776  forward proxy (HTTP CONNECT)         │
   be *configured*      │         terminates TLS with a local CA and   │
   with a proxy         │         rewrites VRChat hosts onto :7774     │
                        └─────────────────────────────────────────────┘
                                        │
   ┌────────────────────────────────────┴──────────────────────────────┐
   │                          daemon core                              │
   │                                                                   │
   │  AccountManager   ──┬── Account(usr_a) ── CookieJar ── Pipeline WS │
   │                     └── Account(usr_b) ── CookieJar ── Pipeline WS │
   │                                                                   │
   │  RateLimiter (per-account token bucket + global 429 backoff)       │
   │  LogWatcher  (offset-based tail of output_log_*.txt)               │
   │  EventBus    (typed, in-process, fan-out to all consumers)         │
   │  Store       (bun:sqlite, single DB, account_id column)            │
   │  GraphRuntime (node-graph automations)                            │
   │  PluginHost  (N child processes, capability RPC)                   │
   └───────────────────────────────────────────────────────────────────┘
```

**EventBus is the spine.** Pipeline events, REST poll diffs, and log-derived events all normalize into one typed event stream. The feed writer, the graph runtime, plugin workers, the enriched control-API stream, and webhooks are all just subscribers. Nothing in the system should reach into the VRChat client directly except through an Account.

---

## Repository layout

```
vrc.zip/
├─ packages/
│  ├─ api/            generated VRChat client + route table (codegen output, committed)
│  ├─ shared/         event types, scope definitions, wire protocol types
│  └─ plugin-api/     published as @vrcz/plugin-api — types + worker-side runtime
├─ daemon/
│  └─ src/
│     ├─ index.ts            bootstrap, port binding, state file
│     ├─ accounts/           Account, CookieJar, auth flow, 2FA
│     ├─ net/                rate limiter, backoff, UA, request pipeline
│     ├─ pipeline/           WebSocket client w/ reconnect + heartbeat
│     ├─ logs/               VRChat log discovery + tail + parse
│     ├─ store/              schema, migrations, queries, retention
│     ├─ bus/                EventBus
│     ├─ servers/            ui.ts, proxy.ts, control.ts
│     ├─ security/           session token, origin/host validation, secrets
│     ├─ graph/              node registry, graph runtime
│     └─ plugins/            host, worker bootstrap, capability RPC
├─ ui/                 Svelte 5 + shadcn-svelte
├─ docs/               plugin API docs site
└─ tools/              codegen, packaging
```

Existing `desktop-app/` scaffold gets absorbed into `daemon/` — it is `bun init` output plus a `console.log`, nothing to preserve.

---

## Phase 1 — Foundation (executable detail)

Goal: a daemon that logs into multiple accounts, keeps live presence, persists a feed, and shows it in a working UI. No proxy, no plugins, no graphs.

### 1.1 Codegen — `packages/api`

`tools/codegen.ts`:
- Download `openapi.json` from the pinned release (`v1.20.8`) into `packages/api/spec/`, commit it. Never fetch at build time.
- Run `@hey-api/openapi-ts` with the fetch client, `asClass: false` (plain functions — we don't want a god-class).
- **Additionally emit a route table** the proxy consumes: `{ method, pathTemplate, operationId, tag, security, scope }[]`. This is derived from the spec, so proxy scope coverage can't silently drift when the spec updates. A test asserts every operation maps to exactly one scope.

Spec facts to encode: base URL `https://api.vrchat.cloud/api/1`; 232 paths / 297 operations / 19 tags; **no `apiKey` query param exists in v1.20.8** — do not implement it; no `PATCH` verbs anywhere.

### 1.2 Secrets — `daemon/src/security/secrets.ts`

Chosen model: one master key in the OS keychain unlocks an encrypted local store.

- Key: 32 random bytes, stored as **Windows Credential Manager** generic credential / **libsecret** item. Access via a small platform shim shelling out (`powershell` CredentialManager / `secret-tool`) to avoid a native dependency; if libsecret is absent (headless Linux, minimal WM), fall back to a file-backed key with `0600` and warn loudly in the UI.
- Store: `secrets.enc` — AES-256-GCM, holding per-account `{ username, password?, totpSecret?, cookies: Cookie[] }`.
- **Both cookies must persist**: `auth` (session) and `twoFactorAuth` (long-lived device trust). Losing the latter means re-prompting 2FA on every restart.

Paths: `%LOCALAPPDATA%\vrc.zip\` / `$XDG_STATE_HOME/vrc.zip` (fallback `~/.local/state/vrc.zip`).

### 1.3 Account + auth — `daemon/src/accounts/`

Per-account isolated `CookieJar` (a small class: parse `Set-Cookie` via `Headers.getSetCookie()`, honor max-age over expires, serialize to a `Cookie:` header). No shared fetch defaults, no shared HTTP cache — `GET /users/{id}` returns *different fields* depending on whether the authenticated caller is a friend, so any cross-account cache keyed on URL alone is a correctness bug.

Login flow, exactly:
1. `GET /auth/user` with `Authorization: Basic base64(urlencode(user):urlencode(pass))` and no stored cookies sent.
2. Response 200 is a `oneOf` — narrow with `"requiresTwoFactorAuth" in data`. An `auth` cookie **is already issued here**, pre-2FA; keep it.
3. Branch explicitly on the returned method rather than firing all verifiers in parallel (the npm package does the latter; it makes email-OTP vs TOTP indistinguishable in the UI):
   - `totp` → `POST /auth/twofactorauth/totp/verify`
   - `emailOtp` → `POST /auth/twofactorauth/emailotp/verify`
   - `otp` (recovery code) → `POST /auth/twofactorauth/otp/verify`
4. Persist the returned `twoFactorAuth` cookie.
5. Re-`GET /auth/user` → `CurrentUser`.

On startup, prefer stored cookies and validate with `GET /auth` rather than re-authenticating. On 401, re-auth behind a per-account mutex so concurrent requests queue behind one login.

### 1.4 Network layer — `daemon/src/net/`

- **User-Agent** (mandatory; 403 + `waf_code 13799` without it): `vrc.zip/<version> (<user-configured contact>)`. Contact is collected during first-run setup and validated non-empty, no `@example.com`, no newlines. The proxy **never** lets a downstream client override this header.
- **Three ceilings, three buckets.** VRChat enforces **20 req/s per account**, **100 req/s per IP**
  across all accounts, and **300 req/s per IP for file requests** (images, icons, avatars). Each
  bucket defaults to 80% of its own ceiling. The per-IP API bucket is the load-bearing one: six
  accounts each politely under 20/s is 120/s from one IP, which per-account limiting is structurally
  unable to see. The file bucket has no per-account partner — files have their own generous ceiling,
  and metering icons per-account would make a large friends screen take seconds to paint.
- Global circuit breaker on 429 with exponential backoff from 1s, capped, jittered. **One breaker
  across all three tiers**: if VRChat is telling us to slow down, pausing more than strictly
  necessary is the safe direction to be wrong in.
- All polling intervals are `base + random(0, base*0.2)` with the phase seeded from process start time. No top-of-minute schedules.
- Conservative defaults: friends list refresh ~2–5 min (pipeline carries the deltas); user/world detail fetched on demand and cached with a TTL.

### 1.5 Pipeline WebSocket — `daemon/src/pipeline/`

One socket per account, `wss://pipeline.vrchat.cloud/?authToken=<auth cookie value>`, UA header set (a missing UA is a hard reject on the handshake too).

What we must implement ourselves:
- Reconnect with exponential backoff + jitter; re-read the auth token on each attempt.
- Heartbeat / stale-socket detection.
- **Correct message decoding.** The outer frame is `{type, content}` where `content` is *usually* a JSON string. It is **not** for `see-notification` / `hide-notification` (bare ID string) and `clear-notification` (absent). Decode defensively per event type.
- Handle the error frame `{"err": "..."}` — notably `"authToken doesn't correspond with an active session"`, which means re-auth, not retry.

Typed event map covering: `notification`, `notification-v2`, `notification-v2-update`, `notification-v2-delete`, `response-notification`, `see-notification`, `hide-notification`, `clear-notification`, `friend-add`, `friend-delete`, `friend-online`, `friend-active`, `friend-offline`, `friend-update`, `friend-location`, `user-update`, `user-location`, `user-badge-assigned`, `user-badge-unassigned`, `content-refresh`, `economy-update`, `modified-image-update`, `instance-queue-joined`, `instance-queue-ready`, `group-joined`, `group-left`, `group-member-updated`, `group-role-updated`.

Quirks to encode in the types: `friend-active` uses `userid` (lowercase i) — a real upstream typo. `location` may be `""`, `"offline"`, `"traveling"`, `"traveling:traveling"`, `"private"`, or a real instance string. `friend-location.worldId` is literally `"private"` when hidden. `friend-online.world` is `{}` for ask-me/DND.

### 1.6 Storage — `daemon/src/store/`

Single SQLite DB, WAL mode. **One schema, `account_id` as a column** — explicitly rejecting VRCX's `{usr_prefix}_table` scheme, which creates ~13 tables per account and forces dynamic SQL for any cross-account query.

Core tables (sketch):

```sql
accounts(id TEXT PK, display_name, added_at, enabled, last_seen_at)

-- one row per running (or historical) VRChat game client; see §1.7
sessions(id INTEGER PK, account_id TEXT NULL, display_name, log_path, log_inode,
         started_at INTEGER, ended_at INTEGER NULL, exit_kind TEXT NULL,
         vr_mode TEXT NULL, current_location TEXT, current_world_id TEXT)

-- append-only event log; the feed is a view over this
events(
  id INTEGER PK, account_id TEXT, ts INTEGER,       -- unix ms, INTEGER not TEXT
  session_id INTEGER,                               -- NULL for non-gamelog events; see §1.7 sessions
  kind TEXT,                                        -- 'friend.online' | 'gamelog.player_join' | ...
  subject_id TEXT,                                  -- user/world/group id this is about
  location TEXT, payload TEXT                       -- JSON
)
CREATE INDEX ix_events_acct_ts ON events(account_id, ts DESC);
CREATE INDEX ix_events_subject ON events(subject_id, ts DESC);
CREATE INDEX ix_events_kind_ts ON events(kind, ts DESC);

friend_log(account_id, user_id, display_name, trust_level, friended_at, unfriended_at, ...)
friend_log_history(id, account_id, ts, type, user_id, previous_display_name, ...)
user_cache(user_id, fetched_at, data JSON)
world_cache(world_id, fetched_at, data JSON)
avatar_cache(avatar_id, fetched_at, data JSON)
notes(account_id, user_id, note, updated_at)
notifications(id TEXT PK, account_id, ...)
avatar_history(account_id, avatar_id, first_seen, last_seen, seen_count)
events_daily(account_id, day, kind, subject_id, count, total_ms)   -- rollup target
```

Timestamps are **INTEGER unix-ms**, not ISO TEXT (VRCX stores TEXT, making range queries string comparisons). Migrations are numbered SQL files applied in order at startup.

Retention job (nightly, jittered): **per-event-type windows, all configurable.** Each `kind` has its own
`retain_days`, because their volume and their value differ by orders of magnitude — `gamelog.player_join`
in a busy public instance produces more rows in a week than `friend.online` does in a year, and it ages
out of usefulness far faster. Defaults are a starting point, not a policy:

| kind group | default | rationale |
|---|---|---|
| `gamelog.player_join` / `player_leave` | 30d | highest volume by far; value decays fast |
| `gamelog.*` (world join, portal, screenshot) | 90d | moderate volume, useful history |
| `friend.online` / `offline` / `active` | 90d | the feed people actually scroll |
| `friend.location` | 30d | very chatty, low individual value |
| `friend.status` / `bio` / `avatar` | 180d | low volume, high "when did that change" value |
| `notification.*` | 365d | low volume, occasionally needed as evidence |

Expiring rows roll into `events_daily` first, then delete. `friend_log*`, `notes`, `avatar_history`,
and `user_cache` are **never** auto-deleted regardless of configuration. `PRAGMA incremental_vacuum`
afterwards. Settings shows current DB size, a per-type row count, and the projected effect of a change
before applying it — so a user shortening a window sees what they're about to lose.

Any `kind` with no configured window inherits a global default, so new event types added later can't
grow unbounded by omission.

### 1.7 Log watcher — `daemon/src/logs/`

**Do not use `fs.watch` on Windows** — VRChat holds `output_log_*.txt` open. Keep a byte offset per file and re-read the tail on a jittered ~1s timer; handle rotation (new file appears) and truncation (size < offset).

Discovery:
- Windows: `%APPDATA%\..\LocalLow\VRChat\VRChat\`
- Linux/Proton: probe `~/.steam/steam/steamapps/compatdata/438100/pfx/drive_c/users/steamuser/AppData/LocalLow/VRChat/VRChat/`, plus Flatpak (`~/.var/app/com.valvesoftware.Steam/...`), plus every library root parsed out of `libraryfolders.vdf`, plus the Steam Deck path. Always overridable in settings, with the detected path shown.

Parse by literal-substring match (`String.includes` + offset slicing), not regex — this is why VRCX's parser is fast. Validate the line header first (`yyyy.MM.dd HH:mm:ss` + level + optional `[Component]`), then route. Regex is used only where a line genuinely needs capture groups, notably the `User Authenticated:` line below; substring-match first to decide *whether* to run it, so the regex never touches the other 99.9% of lines.

v1 markers (the high-value subset; more later):

| Marker | Yields |
|---|---|
| `[Behaviour] Entering Room: ` | world name |
| `[Behaviour] Joining ` | full location `wrld_…:12345~region(us)~group(grp_…)` |
| `[Behaviour] OnPlayerJoined` / `OnPlayerLeft` | display name + user id |
| `[Behaviour] Instantiated a (Clone [` | portal drop: spawner + target |
| `[Behaviour] Destination fetching: ` / `OnLeftRoom` | travel destination |
| `[Behaviour] Failed to join instance ` | failure reason |
| `[VRC Camera] Took screenshot to: ` | screenshot path |
| `VRCApplication: OnApplicationQuit at ` / `HandleApplicationQuit at ` | **clean exit vs crash** |
| `Initializing VRSDK.` / `VR Disabled` | VR vs desktop mode |
| `User Authenticated: ` | **which account owns this log file** — display name + `usr_…`. See sessions below. |

Player join/leave is the single thing the API cannot give you — it's the core reason this class of app exists. It's also fragile: VRChat has added and removed the user id on `OnPlayerJoined` before, so the parser must tolerate both shapes and the parser suite needs golden-file tests with real log samples.

### Multiple concurrent game clients — sessions

VRChat can run several clients on one machine at once, each signed into a different account, each
writing its own `output_log_*.txt`. VRCX assumes one; **we do not.** The watcher tails *every* live log
file concurrently and attributes each one to an account.

The attribution key is a line VRChat writes shortly after startup:

```
User Authenticated: SomeDisplayName (usr_01234567-89ab-cdef-0123-456789abcdef)
```

matched with `/User Authenticated: (.+?) \((usr_[0-9a-f-]+)\)/`. This is the **only** reliable link
between a log file and an account — filenames carry a timestamp, not an identity.

A **session** is the unit, not the account:

```sql
sessions(
  id INTEGER PK,
  account_id TEXT,          -- NULL until the auth line is seen; may stay NULL (see below)
  display_name TEXT,
  log_path TEXT, log_inode TEXT,
  started_at INTEGER, ended_at INTEGER,   -- ended_at NULL while live
  exit_kind TEXT,           -- 'clean' | 'crash' | NULL while live
  vr_mode TEXT,             -- 'vr' | 'desktop' | NULL until known
  current_location TEXT, current_world_id TEXT
)
```

`sessionId` is a column on every `gamelog.*` event alongside `account_id`. Session, not account, is the
identity, because:

- **The same account can have two clients open.** Rare, but legal, and attributing both to one account
  with no discriminator would interleave two instances' player lists into nonsense.
- **A log file's account is unknown until the auth line appears** — typically a few seconds in, and
  after some parseable lines. Buffer events emitted before authentication and **attribute them
  retroactively** when the line lands. Do not drop them, and do not guess.
- **The client may be signed into an account vrc.zip doesn't manage.** That is a normal state, not an
  error: keep the session with `account_id = NULL`, show it in the UI as unlinked with its display
  name, and offer a one-click "add this account." Never silently bind it to the wrong account, and
  never refuse to parse it.

Lifecycle rules:

- **New file appears** → new session, `account_id` pending.
- **Rotation** (same account, new file) → the old session ends, a new one begins. Never continue a
  session across files.
- **`OnApplicationQuit` / `HandleApplicationQuit`** → `ended_at`, `exit_kind = 'clean'`. A live session
  whose file stops growing and whose process is gone without those markers → `exit_kind = 'crash'`.
  This is the distinction that drives auto-rejoin, and it comes only from the log.
- **Backfill on first run** reconstructs historical sessions the same way, so old logs land under the
  right account instead of a single undifferentiated pile.

Watcher cost stays flat: one offset + one timer per *live* file, and files with no growth back off to a
slow poll rather than being read every tick.

### Surfacing sessions

- **UI** shows concurrent sessions side by side — one card per live session with its account, world,
  instance, VR/desktop mode, and current player list. The account switcher and the session list are
  deliberately separate concepts: you can be logged into six accounts in vrc.zip while two game clients
  are running, and conflating them makes both unreadable.
- **Enriched event stream** (`:7775`) carries `sessionId`, `accountId` (nullable), and `displayName` on
  every `gamelog.*` event, plus `session.start` / `session.end` events, so a third-party app can track
  several clients without re-deriving any of this. A grant scoped to one account sees only that
  account's sessions; unlinked sessions are visible only to a grant that asks for them explicitly.
- **Webhooks** carry the same fields.
### 1.8 Servers — `daemon/src/servers/` + `security/`

**Hono** for all three servers, on `Bun.serve`. It is a thin layer over `Request`/`Response` rather
than a framework with its own object model, which is the property the byte-faithful mirror depends on —
nothing gets re-serialized or normalized on the way out. Its middleware chain also maps 1:1 onto the
cross-cutting concerns here, so they live in one place instead of being re-implemented per route:

```ts
app.use(hostGuard)        // Host allowlist — the actual DNS-rebinding defense
app.use(originGuard)      // Origin where present
app.use(auth)             // session token (UI) | grant token (proxy/control)
app.use(scopeGuard)       // proxy only: route table lookup → required scope
app.use(rateBudget)       // per-grant, per-plugin budgets
app.use(auditLog)         // every mutating call, attributed
```

Three separate `Hono` instances on three ports, not one app with path prefixes — the mirror must not
be able to accidentally serve a control route, and separate instances make that structural rather
than a matter of careful ordering.

Notes for the implementation:

- **The proxy registers routes from the generated route table**, one per operation, rather than a
  single `app.all("/api/1/*")`. An unknown path then falls through to VRChat's real 404 shape instead
  of being handled by a catch-all that has to guess. It also means scope coverage is enforced at
  registration: a route with no scope mapping fails to register, so the test in §1.1 has teeth.
- **`hono/bun`'s `upgradeWebSocket`** covers the pipeline mirror on `:7774`, so the WS and HTTP halves
  share the same middleware and the same grant lookup.
- **Hono RPC (`hc`) types the UI ↔ daemon control API** end to end, which the Svelte frontend gets for
  free. Deliberately *not* used for the mirror: vrc.zip-shaped types must never leak into something
  whose contract is "byte-identical to VRChat."
- Keep responses as `Response` objects on the proxy path — do not use `c.json()` for upstream-derived
  bodies, since it re-encodes. Pass the upstream body through and copy the status and headers, minus
  the hop-by-hop ones.

Every request on every port:
1. `Host` header ∈ `{local.vrc.zip:PORT, 127.0.0.1:PORT, localhost:PORT}` — this is what actually stops DNS rebinding.
2. `Origin` validated where present.
3. Session token required (UI port: header or the launch-URL token; proxy/control ports: bearer token from the token store).

Startup writes `state.json` (tight perms) with `{ uiUrl, proxyUrl, controlUrl, sessionToken }`. Ports are configurable and fall back to ephemeral if taken; the CLI prints the URL and optionally opens the browser.

**`http://127.0.0.1:PORT` is the runtime default.** It has no external dependency, no cert to renew, and no way to fail. `local.vrc.zip` is opt-in in settings and is what the README shows, because it is the nicer URL and its loopback origin avoids Chrome's Local Network Access prompt (shipped Chrome 142; covers WebSocket since 147) and mixed content. When enabled, resolve it at boot and fall back to `127.0.0.1` silently on NXDOMAIN — rebinding protection is common (Pi-hole, `stop-dns-rebind`, many routers, corporate DNS) — noting the fallback in settings. Never a hosts-file edit: needs admin, AV flags it, messy uninstall.

### 1.9 UI — `ui/`

Svelte 5 + shadcn-svelte. Vite build, output served statically by the daemon. Dev mode proxies to the daemon.

Phase 1 screens: account switcher (multi-account is the default posture, not a mode), login incl. distinct TOTP / email-OTP / recovery-code flows, friend list with live presence, feed timeline with filters, game log, notifications + invites, settings.

**Live sessions are their own surface**, separate from the account switcher: a card per running game client showing account (or "unlinked" with an add button), world, instance, VR/desktop, and current player list, all visible at once. Two clients running means two cards side by side. The game log is filterable by session. Logged-in accounts and running clients are different sets and the UI never implies otherwise.

Ctrl+Shift+P command palette is built **in Phase 1**, even though plugins arrive later — retrofitting a command registry is worse than building it empty. Instant actions (invite, invite-request, boop, jump-to-instance) register as commands from day one.

Web Notifications API for alerts while a tab is open.

### 1.10 Phase 1 verification

- `bun test` — unit: cookie jar, 2FA branching, rate limiter/backoff, pipeline frame decoding (**explicitly the three malformed-content event types**), log parser golden files, retention rollup.
- Integration against a **recorded-fixture VRChat server** (a `Bun.serve` replaying captured responses) — the login flow, a 401 re-auth, a 429 backoff, and a full pipeline event sequence. No live API in CI.
- Manual: log in two real accounts simultaneously; confirm two independent pipeline sockets, no cookie bleed (assert account B's requests carry only B's cookie), presence updates in both, feed rows written with correct `account_id`.
- Launch VRChat, join a world, confirm world-join + player-join/leave rows appear. Repeat on Linux/Proton.
- **Two game clients on two different accounts, simultaneously**: both sessions appear as separate cards, each with its own world and player list, and every `gamelog.*` row carries the correct `session_id` and `account_id`. Then sign one client into an account vrc.zip doesn't manage and confirm it shows as unlinked rather than being misattributed. Then kill one client without a clean quit and confirm `exit_kind = 'crash'` while the other session stays live.
- Events written before the `User Authenticated:` line are retroactively attributed, not dropped.
- `curl` the UI port with a wrong `Host` and a wrong `Origin` — both must be rejected.
- Idle RSS measured after 1h with 2 accounts; target ≤80MB. Re-measure at 24h to catch leaks.

---

## Phase 2 — Proxy + control plane

Byte-faithful mirror on `:7774`. Same paths, bodies, status codes, and error shapes as
`api.vrchat.cloud/api/1`, so an existing VRChat client library works by changing only its base URL.

### The login handshake — this is the core mechanism

A third-party app does not register a token out of band. **It performs a normal VRChat login against
the proxy**, and vrc.zip turns that into a consent flow. An app therefore ends up bound to as many
accounts as it logs into — one proxy session per `(app, account)` pair, exactly mirroring how it would
hold multiple real VRChat sessions.

```
app                          proxy :7774                     vrc.zip UI
 │                                │                                │
 │ GET /auth/user                 │                                │
 │   Authorization: Basic         │                                │
 │     b64(user : scopes)         │                                │
 │   User-Agent: MyApp/1.0 me@… ──►                                │
 │                                │                                │
 │                                │ resolve username → account     │
 │                                │                                │
 │                                ├─ account not in vrc.zip? ──────►  "MyApp wants to use
 │                                │                                │   account <username>.
 │                                │                                │   Log in to add it."
 │                                │                                │
 │                                ├─ account known, no grant? ─────►  consent sheet:
 │                                │                                │   app identity + scopes
 │                                │                                │
 │◄─ 200 CurrentUser              │◄─ user approves ───────────────┤
 │   Set-Cookie:                  │                                │
 │     auth=authcookie_…_vrczip   │                                │
```

- **The password field carries the scope request — there is no password.** VRChat's own login is
  `base64(urlencode(username):urlencode(password))`. We keep that shape exactly and put the requested
  scopes where the password goes:

  ```
  Authorization: Basic base64( urlencode(username) : urlencode("friends:read,users:read,invite:send") )
  ```

  The upshot is that **a stock VRChat client library needs zero modification** — no custom header, no
  custom transport. It fills in its normal username and "password" fields and the handshake works.
  vrc.zip never receives, forwards, or stores a third-party app's copy of a real VRChat password;
  the credential slot is repurposed, not merely ignored.

  **This is the only way to request scopes.** There is no `X-VRCZip-Scopes` header — a second mechanism
  would mean two code paths, two precedence rules, and an app that works against one vrc.zip build and
  not another. The password field is universally supported by every HTTP client on earth; a custom
  header is not. An empty scope field ⇒ a minimal read-only default set. Unknown scope strings are a
  hard 400, never silently dropped.
- **The app's identity is its `User-Agent`,** parsed into `{name, version, contact}` — the consent
  subject shown to the user. VRChat *mandates* `AppName/Version contact`, but **it does not enforce
  it, and the proxy must not either**: VRCX sends `VRCX 2026.07.18` and works fine against the real
  API, so refusing that shape taught something false and locked out the client the mirror most needed
  to serve. The parse is best-effort, and the **contact is optional** — the app's UA never reaches
  VRChat (the pipeline always substitutes ours, see §Enforcement), so it was never part of VRChat
  compliance and only ever labelled a consent sheet, which a name and version label perfectly well.
  What still earns VRChat's own 403 + `waf_code 13799` is a UA that names no app at all: absent, or a
  bare HTTP library like `python-requests/2.31.0`. Those VRChat really does block, so the answer is
  both byte-faithful and true.
- **The issued cookie looks real but is unmistakably ours.** Real VRChat issues
  `auth=authcookie_<uuid>`; we issue `auth=authcookie_<uuid>_vrczip`. The shape keeps clients that
  sanity-check the prefix or parse the UUID working unchanged, while the suffix means a vrc.zip token
  accidentally sent to `api.vrchat.cloud` is obviously invalid rather than a real session — and it
  makes the token trivially greppable in a user's logs when they're debugging. The real VRChat cookie
  never leaves the daemon. The issued value maps to `(app identity, account, granted scopes)`.
  Revoking it in the UI kills that app's access to that one account without touching the others.
  Same treatment for `twoFactorAuth`, so device-trust round-trips look normal too.
- **Everything downstream of login is a no-op or a pass-through.** `PUT /logout` revokes only the proxy
  grant. The 2FA verify endpoints return `{verified: true}`. `GET /auth` validates the proxy token.
  The app's existing login code path runs unmodified end to end.
- **One real VRChat session per account**, no matter how many apps are connected. This is the whole
  reason the proxy exists.

### Hard invariant — the real VRChat credentials never leave the daemon

**A real `auth` or `twoFactorAuth` cookie value must never appear in any response on `:7774` or
`:7775`, in any form, ever.** The proxy mints its own opaque token, `authcookie_<our own id>_vrczip`,
and that is the only credential a third-party app is ever given. Not a wrapper around the real one, not
an encrypted form of it — an unrelated identifier that maps to a grant in our DB.

This is stated as an invariant because **byte-faithful passthrough leaks it by default.** Copying
upstream status and headers is the correct behavior for every header except the ones carrying
credentials, and the places it goes wrong are not obvious:

| Leak path | Handling |
|---|---|
| `Set-Cookie` on any upstream response | **Stripped unconditionally** from every proxied response. If the grant needs a cookie set, we emit our own. Never pass through, never rewrite in place. |
| `GET /auth` (`verifyAuthToken`) returns `{ok, token}` | `token` is rewritten to the vrc.zip token. Returning the upstream body verbatim here hands over the real session. |
| Pipeline mirror `?authToken=` | The app supplies *its* token; the daemon opens the real socket with the real one. The real value is never echoed back in any frame, including error frames — VRChat's own `{"err":"authToken doesn't correspond with an active session","authToken":"...","ip":"..."}` **contains the token and must be sanitized before forwarding.** |
| Upstream error bodies | VRChat sometimes echoes request context into errors. Scan and redact before forwarding. |
| An app's inbound `Cookie` header | Never forwarded upstream. The daemon substitutes the real jar for the bound account; whatever the app sent is discarded. |
| Logs, audit rows, crash dumps | Tokens are redacted at the logger, not at the call site. |

Enforcement is mechanical, not a matter of remembering:

- **An egress filter runs on every proxy response.** It scans headers and body for `authcookie_` not
  followed by `_vrczip`, and for any live `twoFactorAuth` value. A hit is a **500 with an empty body
  and a loud error log** — fail closed. A credential leak must never be the quiet outcome.
- The filter is the last middleware in the chain, so it also covers responses from code written later
  by someone who hasn't read this section.
- **Tests assert it directly**: a fixture where upstream returns `Set-Cookie: auth=authcookie_<uuid>`,
  one where `GET /auth` returns a real token, and one where the pipeline emits VRChat's `authToken`
  error frame. All three must reach the client with no real credential present, and the `Set-Cookie`
  case must reach it with no `Set-Cookie` at all.

The `_vrczip` suffix earns its keep here: the egress filter can distinguish ours from theirs by shape
alone, a leaked token sent to `api.vrchat.cloud` is inert rather than a live session, and it is
greppable in a user's logs when they are debugging.

Same treatment for `twoFactorAuth`: the proxy issues its own `_vrczip`-suffixed value so device-trust
round-trips look normal to the client, and the real one stays in the encrypted store.


### Pending consent — the pairing-code flow

Consent and "log this account in first" are both asynchronous; the user may be AFK. The proxy answers
**now**, using VRChat's own 2FA mechanism as a device-pairing channel:

1. Login arrives with no existing grant → proxy replies `200 {"requiresTwoFactorAuth":["totp"]}` and
   sets a half-authenticated `auth` cookie, exactly as real VRChat does pre-2FA.
2. vrc.zip raises a consent sheet showing the app identity (from the UA), the requested scopes, the
   account, and **a 6-digit pairing code**.
3. The stock client, seeing `requiresTwoFactorAuth`, prompts its own user for a code — no modification,
   no vrc.zip-specific handling.
4. The user reads the code off the vrc.zip sheet and types it into the app. The app POSTs it to
   `/auth/twofactorauth/totp/verify` like any other 2FA code.
5. Correct code ⇒ `{"verified": true}` + the real grant cookie. **Typing the code is the consent
   gesture** — it proves the person operating the app is the person at the vrc.zip UI.

Wrong code returns `{"verified": false}`, byte-faithfully. Codes are single-use, expire in ~5 minutes,
and are rate-limited per app identity to stop brute force. If the account isn't in vrc.zip yet, the
sheet asks the user to add it first and the code doesn't appear until they have.

This is the Plex/Steam device-pairing pattern wearing VRChat's 2FA clothes. It costs nothing in
fidelity, needs no polling, no open socket, and no custom client code.

### Account selection

The username in the Basic auth is the account selector. A **reserved value** (empty string, or `*`)
means "let the user choose" — the consent sheet shows an account picker, and the app discovers which
account it actually got from the returned `CurrentUser`. An unrecognized non-reserved username is a
401 in VRChat's real invalid-credentials shape; there is deliberately no "default account" fallback,
because an app silently acting as the wrong account is the worst failure mode in this system.

### Scope escalation

An app that hits an endpoint outside its grant gets a **403 naming the missing scope** (in a vrc.zip
error body, since VRChat has no equivalent). To escalate it simply logs in again with the wider scope
list; that triggers a fresh consent sheet showing **only the delta**, and a new pairing code. The
existing grant keeps working throughout, so a background escalation never breaks a running app, and no
consent modal can appear unprompted while the user is doing something else.

### Enforcement

- **Scope enforcement** off the generated route table. `resource:verb` taxonomy (`friends:read`,
  `invite:send`, `moderation:write`, `groups:owner`, …), with high-risk scopes deny-by-default and never
  reachable via a wildcard grant: `account:credentials`, `account:destroy`, `moderation:*`,
  `files:delete`, `invite:send`, `groups:owner`, `favorites:group:clear`, `instances:close`, `economy:*`.
  `PUT /users/{id}/delete` and `DELETE /auth/twofactorauth` are **hard-denied regardless of scope**.
- **Scopes alone don't stop abuse**: per-grant rate budgets on `invite:send` / `friends:write` /
  `groups:invite`, an audit log of every mutating call attributed to the app, and a kill switch per
  grant and globally. A "Connected apps" page shows live request rate and rate-limit consumption per app.
- **The upstream User-Agent is always ours.** A downstream app's UA is used for *identity* and is never
  forwarded to VRChat — VRChat must see `vrc.zip/<version> (<user contact>)` so traffic is honestly
  attributed to the thing actually making it.
- **Pipeline mirror**: `wss://…:7774/?authToken=<proxy auth cookie>` speaking the exact VRChat pipeline
  protocol, filtered by the grant's scopes. Fed from the daemon's single real socket per account.

### Forward proxy — `:7776`

The mirror asks an app to change its base URL. **Plenty of apps cannot.** VRCX drives its HTTP
through Chromium, which takes `--proxy-server=` and nothing else; the same is true of most Electron
apps, and of anything that only reads `HTTP_PROXY`. For those, `:7776` is a real forward proxy: an
app is *configured* with it, and its VRChat calls arrive at the mirror without the app knowing the
mirror exists.

This is a delivery mechanism for `:7774`, not a second mirror. Every request it accepts is rewritten
onto `:7774` and answered there, so scopes, grants, consent, the audit log, and the egress filter all
apply exactly as they do to an app that changed its base URL.

- **`CONNECT api.vrchat.cloud:443` is the only shape that matters**, because VRChat is HTTPS. Serving
  it means being the TLS server for a hostname we do not own, so the daemon mints its own CA
  (`forward-proxy/ca.ts`, hand-rolled DER over `node:crypto` — nothing in Bun or Node can *issue* a
  certificate) and signs a leaf whose SANs are exactly the intercepted hosts. The user installs the
  CA once. **`ca.key` is the most dangerous file vrc.zip writes** — its blast radius is every site the
  user's browser trusts, not merely their VRChat accounts — so it lives at `0600` in
  `<state>/tls/`, is never transmitted, and the setup page says so in plain words.
- **Only hosts the mirror actually serves are decrypted.** Everything else is a blind byte pipe to
  the real server. vrc.zip is not in the business of reading a user's unrelated traffic, and a proxy
  that refused everything else would need a bypass list maintained by hand. The intercept set is a
  setting, not a constant, because the mirror does not serve all of it yet.
- **Three request shapes, three answers, and the third is a security boundary.** `CONNECT` is
  intercepted or tunnelled; absolute-form (`GET http://api.vrchat.cloud/...`) is rewritten onto the
  mirror, which is the one path needing no CA at all; and **origin-form (`GET /`) is never routed**,
  because origin-form is the only shape a web page can produce. It gets the setup page and the CA
  download and nothing else.
- **Bodies are forwarded verbatim, framing included.** The proxy segments the request stream so it
  can rewrite `Host` on *every* request of a kept-alive connection, and never decodes a body — so
  byte-fidelity here is structural rather than something to be careful about.

### Control API — `:7775`

Consent status polling, grant list/revoke, the **enriched event stream** (normalized events including
the log-derived `player-join` / `world-enter` / `portal-drop` the real pipeline has no equivalent for),
and **webhook registration** for apps that aren't long-running. Kept off `:7774` so the mirror stays a
pure mirror.

**Sessions are first-class here.** Every `gamelog.*` event on the stream and every webhook payload
carries `sessionId`, `accountId` (nullable), and `displayName`, plus there are `session.start` /
`session.end` events and a `GET /sessions` listing. A third-party app can therefore follow several
concurrently running game clients without re-deriving any of it from raw logs — which is the whole
reason this stream exists rather than telling people to tail the files themselves. A grant sees only
its bound account's sessions; unlinked sessions (a client signed into an account vrc.zip doesn't
manage) require an explicit scope, since they leak the existence of accounts the user never added.

---

## Phase 3 — Plugin system

Design pass complete. Headline correction to the original assumption:

> **A Bun Worker is an isolation primitive, not a security primitive.** It gets its own `globalThis`,
> `process`, `Bun`, `fetch`, and full `node:*` access. A `preload` prelude can scrub globals — worth
> doing — but it cannot disable the `import()` operator, so `await import("node:" + "fs")` reaches the
> whole filesystem, including the DB holding VRChat auth cookies. Bun also has no `resourceLimits`
> (commented out in `bun-types`), no `--no-addons`, and no permissions flag, so a worker cannot be
> memory-capped, and `terminate()` is not documented to preempt a synchronous spin loop.

### Isolation: child process, not Worker

`Bun.spawn` per plugin with `env: {}`, behind a `PluginTransport` interface so `Worker` stays available
for dev and first-party. A process buys real memory caps (Job Object on Windows, `RLIMIT_AS` on Linux),
a `kill(9)` that always wins, crash containment, and — the part that matters most — it is the only
granularity from which OS-level sandboxing (AppContainer, seccomp) is reachable later **without changing
the plugin API by one character**. Pool verified plugins into one shared process; one dedicated process
per unverified plugin.

**Spawn with `--smol`.** Plugin processes are overwhelmingly idle event handlers, so JSC's small-heap
configuration is the right trade: less resident memory, more frequent GC. That matters directly here —
the daemon's whole pitch against VRCX is a 50–80MB idle footprint, and N plugin processes are the most
likely way to lose it.

Two things to keep straight about it:

- **`--smol` is a hint, not a limit.** It does not cap anything. The RSS watchdog and the OS-level caps
  (Job Object on Windows, `RLIMIT_AS` on Linux) are still what actually stop a runaway plugin, and
  nothing about `--smol` lets us skip them.
- **A compute-heavy plugin will pay for it.** The manifest gets an opt-out
  (`"performance": "throughput"`) that spawns without the flag. It surfaces on the consent screen,
  because choosing it spends the *user's* memory — that's their call to make, not the author's to make
  silently.

This works because **vrc.zip ships its own `bun` binary** (see §Phase 5) rather than depending on one
being installed. `--smol` is therefore an ordinary spawn flag on a real runtime — no
`process.execPath` re-invocation trick, no build-time-only constraint, and the per-plugin opt-out above
is a plain matter of which argv we spawn with.

Supervisor: host-driven heartbeat (the echo lives in the prelude, not in plugin code, so a blocked event
loop stops answering no matter what the plugin does), RSS watchdog, activation and call deadlines,
exponential restart backoff, crash-loop auto-disable with a notification.

### Install-time compilation, not runtime resolution

At install: `Bun.build` with `target: "browser"` and `external: []` (node builtins become hard build
errors), then an AST deny-scan over the *bundled output* rejecting non-literal `import()`, literal
`node:`/`bun:` imports, `require`, `process.binding`, `new Function`, and `eval` of non-literals.
Content-address the artifact (`plugins/<id>/<sha256>.js`) and verify the hash on every load. Attacks
fail loudly at install with a message the user reads, instead of silently at 3 AM.

### RPC: hand-rolled envelope protocol, not Comlink

Comlink's value is making the boundary invisible; for a security boundary that is exactly wrong — you
can't enumerate the surface, schema-validate it, or attach per-call scope checks and deadlines without
fighting the proxy. ~250 lines of explicit protocol instead. Absolute epoch-ms deadlines on the wire,
enforced by the caller (a late reply to an aborted id is dropped). A single dispatcher does arg parsing
and the scope check — never the handlers.

Backpressure is load-bearing: log tailing bursts 40+ `player-join` events on instance transitions, and
pipeline `friend-location` fires for every friend move. Three host-side mechanisms: **declarative
filters** compiled to closures at subscribe time (one `===` per event, no wakeup for irrelevant ones);
**credit windows** with a per-subscription overflow policy — `coalesce` on `keyPath: "userId"` is exactly
right for friend-location, giving a slow plugin each friend's *current* location rather than a
900-event backlog; and **per-tick batching**. When the host sheds load it says so via a `dropped` frame
rather than letting the plugin believe it saw everything. `EventBus.emit()` must never await anything
plugin-related.

### UI: declarative schema rendered by host components

The host page holds the session token; plugin JS running in that page can read it and call the API with
*every* scope, not just its granted ones. So:

- **Same-origin dynamic import of a plugin ESM bundle — rejected.** Zero isolation. Independently
  fatal: externally-compiled Svelte 5 components must share `svelte/internal/client` with the host,
  permanently welding the whole plugin ecosystem to one Svelte version.
- **Web components — rejected as isolation.** Shadow DOM encapsulates styles and DOM queries, not JS.
- **A JSON `UINode` tree rendered by host shadcn components.** The plugin never touches a DOM node.

**There is no escape hatch, and that is a commitment, not a limitation.** An earlier draft kept an
iframe mode in reserve for charts and canvas work. Dropped, for two reasons that reinforce each other:
an escape hatch that exists gets reached for by default, and the design system erodes one plugin at a
time; and the security property only holds for plugins that didn't take the bypass, which makes it not
a property at all. Committing means we owe plugin authors a vocabulary rich enough that wanting one
never comes up — **including charts, which was the single genuine gap.**

What that buys, beyond isolation: plugin UI is automatically consistent with the design system, dark
mode, i18n and a11y; it works unchanged in any future remote or mobile client; the author writes twenty
lines instead of a build pipeline; and every improvement to the host's rendering lands in every plugin
at once.

#### Node catalog

Layout and structure
: `stack` (row/col, gap, align, wrap), `grid` (columns, responsive), `card` (title, description,
  footer), `tabs`, `accordion`, `separator`, `scroll` (max height, sticky header)

Content
: `text` (h1–h3, body, muted, code), `markdown` (sanitized, no raw HTML), `badge`, `avatar`, `icon`
  (from the host's icon set — no arbitrary URLs), `image` (allowlisted VRChat asset hosts or a
  plugin-bundled asset served by the daemon), `code` (with language), `kbd`, `empty`, `spinner`,
  `skeleton`, `progress`, `stat` (value, label, delta)

Domain refs — the pattern to lean on hardest
: `userRef`, `worldRef`, `groupRef`, `avatarRef`, `instanceRef`, `sessionRef`. The plugin passes an id;
  the host renders the avatar, name, trust colour, online state, and the standard context menu. A
  plugin does not need `friends:read` just to draw a face, and every reference in the app looks and
  behaves identically.

Input
: `input` (text/number/password/search), `textarea`, `select`, `combobox` (searchable, async options
  via intent), `switch`, `checkbox`, `radio`, `slider`, `datePicker`, `durationPicker`, `colorPicker`,
  `userPicker`, `worldPicker`, `form` (grouped submit with per-field validation messages)

Data display
: `table` (sortable, filterable, **virtualized** — friend lists get long), `list`, `tree`,
  `descriptionList`, `timeline`

Charts — first-class, because this was the reason people would have wanted an iframe
: `chart` with `line`, `area`, `bar`, `stackedBar`, `pie`, `donut`, `scatter`, `heatmap`, `sparkline`.
  Declarative data + encoding, host-rendered, host-themed, accessible by construction. A plugin
  charting "hours in world X per week" writes a data array and a spec, not a canvas.

Overlay and feedback
: `dialog` (modal, with actions), `sheet`, `popover`, `tooltip`, `dropdownMenu`, `contextMenu`,
  `alert` (info/success/warn/danger), `toast` (raised via intent, not a node)

#### Interaction model

Any node may carry handlers, not just buttons:

```ts
interface Interactive {
  onClick?: Intent;
  onDoubleClick?: Intent;
  onContextMenu?: Intent | UINode;   // an intent, or a menu tree to render
  onChange?: Intent;                 // inputs
  onSubmit?: Intent;                 // forms
  onSelect?: Intent;                 // table row / list item / tree node
  onVisible?: Intent;                // lazy load, infinite scroll
  keybinding?: string;               // scoped to the panel while focused
  confirm?: string;                  // host shows a confirmation before dispatching
  disabled?: boolean; busy?: boolean;
}

interface Intent { name: string; payload?: Record<string, string | number | boolean> }
```

The loop: host renders → user acts → host sends `ui.intent(panelId, intent, formState)` → plugin
updates its state → plugin calls `ui.setPanel(panelId, tree)` → host diffs and re-renders. Keyed
diffing on an optional `key` field keeps input focus and scroll position stable across updates.
`ui.patchPanel(panelId, path, node)` exists for the common case of updating one subtree without
resending the whole thing.

Plugins can also push without a user action: `ui.toast`, `ui.dialog`, `ui.notify` (the OS/VR
notification path), and `ui.setBadge(panelId, count)` for the sidebar.

**Latency:** intents round-trip to the plugin process, so anything that must feel instant is handled by
the host — input echo, focus, hover, tab switching, sort, table filtering, accordion open/close, and
optimistic `switch`/`checkbox` state. The plugin sees the result, not the keystroke. `debounceMs` on an
input's `onChange` is declarative.

#### Limits, kept deliberately

No raw HTML, no `<style>`, no inline handlers, no arbitrary image or font URLs (an `<img>` to a
plugin-controlled host is a beacon leaking "this user opened this panel"). Node-count and depth caps
(≈2,000 / 32) enforced on the host before render. Charts cap their series and point counts. These are
not friction to be negotiated away later — they are what make the vocabulary safe to render eagerly.

If a plugin author hits a genuine wall, **the answer is a new node type in the host**, contributed
upstream and available to everyone, not a hole in the boundary for one plugin.

### Manifest, lifecycle, storage

VS Code-flavored `vrcz-plugin.json` with `engines.pluginApi` (protocol major, not app version),
`permissions {scopes, capabilities, accounts, events, network}`, and `contributes {panels, settings,
commands, nodes}`. A **Zod schema is the single source of truth** — the published JSON Schema, the
consent UI, and the docs reference are all generated from it.

Consent shows plain-English scope descriptions from the shared registry, `dangerous` scopes in a
separate block behind a second toggle, an **account picker** (a plugin with `friends:read` must not
implicitly get it for all six of your accounts), event subscriptions in plain language, and the trust
tier — including a hold-to-confirm on *"Unsigned — this plugin can do anything your computer can do."*
Grants are stored immutably keyed by `(pluginId, version, grantHash)`, so an update that adds a scope
provably re-prompts and a downgrade can't silently reuse a broader grant.

**One SQLite file per plugin** in its own data dir. Uninstall is `rm -rf`; quota is a `stat`; a plugin
can't lock or corrupt the daemon's WAL. Exposed as a `StorageApi` capability (KV + append-only
`records` with a filter query), 50MB default quota. Raw SQL is a later opt-in capability.

Disable must be instant and always succeed — the kill path is not optional. Automation graphs
referencing a disabled plugin's node types are **paused and marked unavailable, never deleted**.

### Node type registration

One declarative `NodeDefinition` feeds three consumers — the Svelte Flow editor, the graph runtime, and
the type checker — so they cannot drift. A small closed port-type lattice with exactly two widening
rules (`friend <: user`, `X <: json`); every additional rule is an explanation you owe a user whose
edge just got refused.

Node bodies render from a **host-evaluated template**, not an RPC into the plugin — Svelte Flow
re-renders on every pan and zoom, and per-frame RPC at 60Hz is not viable. Plugin nodes get the standard
shadcn node chrome for free.

Triggers are inverted: a trigger node doesn't execute, it *arms*. The runtime tells the plugin an
instance is live with a given config; the plugin calls `fire()`. Type checking happens twice on purpose
— in the editor for instant red-edge feedback, and again in the daemon on save and at each execution
boundary, because the frontend is a client and clients lie. Node definitions are content-hashed into
saved graphs; an incompatible plugin update prompts for migration rather than silently rewiring.

### Corrections to the original plugin requirements

1. **`permissions.network` should not exist in v1.** Arbitrary HTTP collapses the sandbox to nothing —
   `friends:read` + network means your friends list is on someone's server. Replace it with two narrow,
   *host-executed* capabilities: `webhook` (POST to a URL the user typed into settings; the plugin
   supplies only the JSON body) and `fetch:allowlist` (host-declared domains shown individually at
   consent, no wildcards, response size capped). Both are logged and rate-limited because the host runs
   them.
2. **Plugins call a semantic `ctx.vrchat`, not the byte-faithful mirror.** The mirror exists for
   third-party apps that expect literal VRChat responses. Routing plugins through it would double
   rate-limit consumption for no benefit and hard-couple the plugin API to VRChat's response shapes
   forever.
3. **Rate budget is the sharpest edge.** A plugin polling `friends` every second, times six accounts,
   gets *the user* rate-limited or moderated — and the user will blame vrc.zip, not the plugin. Every
   plugin call goes through the shared limiter tagged with the plugin id, with a subordinate per-plugin
   budget and a UI naming who is eating it. `E_RATE_LIMIT` carries `retryAfterMs`, and the docs state
   plainly that retrying immediately is a bannable-behavior bug in *their* plugin.
4. **Outbound social actions need more than install-time consent.** `invite:send`, `moderation:write`,
   friend requests — these are visible to other people and are how a plugin gets a user banned or
   socially harmed. Dry-run by default for new plugins, a rolling per-hour cap absent an explicit user
   gesture, and an exportable audit log attributing every outbound action.
5. **Signing + trust tiers.** Ed25519 detached signature with a publisher key registered once. Without
   it, "install this plugin" is "run this exe."
6. **Don't call it a security sandbox until it is one.** Until process + OS sandboxing lands, the docs
   and the consent UI say "plugins run with your account's privileges; only install plugins you trust."
   Overclaiming here is how you get a supply-chain incident with your name on it.

### Docs (`@vrcz/plugin-api`)

Published on npm, versioned on the **protocol major**. `PortType`, `Scope`, `Envelope`, `UINode`, and
the manifest type live here and the daemon imports the same definitions — one source, no drift.
`create-vrcz-plugin` with `bun run dev` wired to `vrcz dev` (hot restart, relaxed deny-scan, streamed
logs) is the highest-leverage docs artifact, because most people never read prose. Generate: TypeDoc
reference, the scope table from the shared registry, the manifest reference from the Zod schema, the
event catalog from the typed bus registry, the port compatibility matrix from `assignable()`.
Hand-write: the mental model, five end-to-end guides, and a blunt security-model page.

### Plugin build order

`@vrcz/plugin-api` types → `ProcessTransport` + supervisor → dispatcher / scope gate / rate budget →
install pipeline → events bridge → storage → consent and management UI → declarative UI renderer →
nodes → scaffolder and docs. **Write a deliberately hostile plugin early** (spin loop, memory bomb,
`import("node:"+"fs")`, event flood); it is the regression suite for every claim above.

## Phase 4 — Node-graph automation

IFTTT-style event → condition → action graphs on Svelte Flow (`@xyflow/svelte`), executed in the daemon. Typed ports. Built-in action nodes include the push-out targets (Discord webhook, ntfy) and VR-overlay notifications (XSOverlay / OVR Toolkit / OSC). Plugins register additional node types. Runtime designed so it can grow toward general dataflow, but v1 ships triggers only.

**Storage is the shared store, not a new one.** Graph definitions, run history, and node state live in
the same SQLite DB behind the same query layer as everything else. Graph runs are `events` rows with a
`graph.*` kind, so they inherit the per-type retention config, the feed UI, and the enriched event
stream for free. Plugin-registered nodes keep their own state through the plugin `records` API — the
same engine, a per-plugin file. No separate graph database, no second migration system, no second
retention policy to forget about.

## Phase 5 — Packaging & polish

**vrc.zip ships its own `bun` binary.** It never uses a Bun the user may or may not have installed, and
never one on `PATH`. The bundled runtime executes both the daemon and every plugin process.

```
vrc.zip/
  bun.exe            # or `bun` — the pinned runtime, ours
  app/               # daemon + UI bundle
  plugins/
```

Why this and not `bun build --compile` into one self-contained executable:

- **Plugin processes need a real runtime with real flags.** `--smol` per plugin, and whatever comes
  later, are ordinary argv on a bundled binary. A compiled executable would have to re-invoke itself in
  a plugin-host mode and inherit whatever flags were baked in at build time — the same setting for the
  daemon and every plugin, which is exactly the knob we want per-process.
- **The plugin runtime is the Bun we tested against**, pinned and identical on every machine, rather
  than whatever the user happens to have. For a system that executes third-party code, "reproducible"
  is worth more than "small download."
- **`vrcz dev` works out of the box.** Plugin authors don't need their own Bun install.

Costs, accepted: the download grows by the size of the Bun binary (tens of MB), and updates ship a new
one when we bump the pin.

**Integrity matters more than usual here.** The bundled `bun` is the thing that executes the daemon and
every plugin; anyone who can replace it owns everything, including the VRChat cookies. So: the
installer writes it to a location the user's normal account can't modify where the platform allows it,
the updater verifies a signature before swapping it, and the launcher checks its hash at startup and
refuses to run on mismatch rather than warning. This is the same reasoning as the plugin-signing tier —
executing code you didn't verify is the whole risk surface.

Rest of Phase 5: Windows installer; `.desktop` entry and a systemd user unit on Linux (the tray is
unreliable there — StatusNotifierItem support is inconsistent and GNOME needs an extension, so autostart
replaces it). Update checker. Optional Windows webview shell (webview-bun / Buntralino) that
**destroys** the window on close rather than hiding it, so the 150–250MB webview cost isn't permanent.

---

## Risk register

| Risk | Mitigation |
|---|---|
| VRChat changes log line formats | Golden-file parser tests; tolerate both known `OnPlayerJoined` shapes; parser failures degrade to "unknown event," never crash the tail loop |
| VRChat changes/breaks API endpoints | Pin the spec; codegen is a deliberate step, not automatic; version the proxy's advertised spec version |
| Session limit exhaustion | Reuse cookies, never logout on exit, one session per account regardless of how many third-party apps are connected — this is the proxy's whole point |
| 429 / moderation action | Mandatory backoff, jittered non-clock-aligned polling, honest UA, audit log, kill switch |
| Bun Worker is not a security boundary (`import()` cannot be disabled) | Resolved: child process per plugin + install-time bundling with an AST deny-scan; OS sandboxing reachable later without an API change |
| Plugin UI code stealing the session token | Resolved: declarative `UINode` schema rendered by host components; the plugin never gets a DOM node, and there is **no escape hatch** — a bypass would mean the property only holds for plugins that declined to use it |
| Declarative UI too limited, authors feel boxed in | The vocabulary is deliberately broad (charts, virtualized tables, dialogs, context menus, forms — see §Phase 3 UI). A genuine wall is answered with a new host node type contributed upstream, not a hole for one plugin. Watch for this in early plugin feedback |
| Linux path detection misses a setup | Every detected path is shown and overridable; never fail silently |
| libsecret absent | File-backed key at `0600` with a loud UI warning, not a crash |
