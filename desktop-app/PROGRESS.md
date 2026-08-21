# vrc.zip — Progress & Handoff

Working log for anyone (human or agent) picking this up. **Read [`PLAN.md`](./PLAN.md) first** — it is
the architecture and the reasoning. This file tracks only *state*: what exists, what's next, and what
was decided along the way.

**Last updated:** 2026-08-21
**Current phase:** Phase 1 — Foundation (closing) → Phase 2 — Proxy + control plane
**Status:** Phase 1 complete on the automatable side — daemon + UI both run, 501 tests green, and
the five verification gaps from the 1.10 audit are closed. What remains of 1.10 needs a human with
real VRChat accounts and a real game client. Phase 2 (proxy + control plane) starts next.

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
- [x] **1.10 Verification** — the automatable half is done. See `PLAN.md` §1.10.
      **Covered:** cookie jar; rate limiter + backoff; the three malformed pipeline content types;
      log-parser golden files; retention rollup; fixture-server login, 401 re-auth and 429 backoff;
      feed rows carrying the right `account_id`; one session per log file; unmanaged accounts staying
      unlinked; pre-auth events attributed retroactively; **two independent pipeline sockets, each on
      its own account's token**; **all three 2FA verifiers** (`totp`, `emailOtp`, `otp`) through to a
      `CurrentUser`; **one client crashing while the other session stays live**; **a foreign `Origin`
      rejected on a live port**; **a pipeline frame end to end — socket → decode → bus → SQLite —
      with two accounts online and neither seeing the other's rows**.
      **Not automatable — needs the user:** two *real* accounts signed in at once (only a live run
      proves VRChat's session cap and the pipeline's IP binding); launching VRChat to confirm
      world-join and player-join/leave rows; the Linux/Proton repeat; a real abrupt kill; idle RSS at
      1h and at 24h.
      **Also unverified:** `ui/` has no test runner and no tests at all — which is exactly where the
      four silent bugs in §Gotchas escaped from.

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
41. **The pipeline endpoint is injectable, and there is a fixture socket behind it.**
    `startDaemon({ pipelineUrl })` joins `baseUrl` as a test seam, and
    `daemon/src/testing/pipeline-fixture.ts` is a real `Bun.serve` WebSocket rather than an injected
    `createSocket`. Same reasoning as the REST fixture: what goes wrong on this path is
    handshake-level — the `?authToken=` query value and the mandatory UA on the upgrade — and a
    stub that hands the client a socket object proves neither. It is also the only way the Phase-1
    definition-of-done clause "two independent pipeline sockets" is testable at all; before this,
    nothing in the suite ever constructed two `PipelineClient`s.

---

## Gotchas

Empirical notes. Add to this as you hit things — especially where the plan turns out to be wrong.

Found by running code. Each of these contradicted an assumption, and most were silent failures.

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
- **The per-user roster fallback spends real rate budget.** A room of eighty strangers nobody has
  looked at is up to eighty `GET /users/{id}` on first sight of it, sequentially through the
  limiter. The daemon's `user_cache` absorbs the repeat cost and the UI holds an answer for 15s, so
  a room you sit in settles quickly — but a user hopping public instances is a genuinely heavier
  traffic pattern than before, and it is worth measuring against the 20/s per-account ceiling before
  deciding whether it needs its own budget.
- **The group modal is a card, not a group screen.** `GET /api/groups/:id` and `GroupModal` landed:
  a represented badge and a row in a user's Groups tab both open it, and it shows the description,
  the rules, the links, both member counts with the age of the live one, the owner, the join state
  and this account's membership status. What it still does not have is **members, posts, galleries
  and instances** — each needs its own endpoint and its own paging, and the footer links to
  vrchat.com in the meantime rather than letting the card pass for the whole group.
- **`mutualGroup` is on the wire and unused.** `LimitedUserGroups` carries it, so the "Mutual" badge
  dropped from the Groups tab as uncomputable can be restored for free.
- **The profile image/banner context-menu action is not built.** `UserDetail.iconUrlFull` now exists
  on the daemon (the non-thumbnail original, null rather than falling back to a thumbnail), but
  `ui/src/lib/api.ts` does not carry it yet and no menu item opens it.
- **The JS bundle is ~550 kB**, past Vite's 500 kB warning. It builds fine; worth splitting.
- **No endpoints for invite-request / boop.** Both are registered in the command palette as stubs
  that name the missing route when run. *Self-invite is now real* — `POST
  /api/accounts/:id/invite-self` — because `vrchat://launch` starts a *second* game client instead
  of moving the running one.
- **`favicon.ico` 404s** on every page load. Cosmetic, but it is a console error on first
  impression.
- **`rateLimit.remaining` and `queued` are approximations, and the snapshot is now also
  incomplete.** The limiter does not expose live token counts, and `StatusSnapshot.rateLimit` still
  describes a single ceiling when there are three (per-account 20/s, per-IP 100/s, files 300/s).
  `ratePerSecond` / `globalRatePerSecond` / `fileRatePerSecond` are all readable off the limiter
  now, so the settings screen can show three honest numbers — but `remaining` and `queued` should
  either become real or stop being drawn as a gauge that implies precision.
- **No CI workflow.** It belongs at the repo root in `.github/`, which is shared ground with
  `backend/` — a separate project. Needs a decision before it is added.
- Nothing else open. (Retention → per-type, decided. Node-graph storage → shared store, decided.)
