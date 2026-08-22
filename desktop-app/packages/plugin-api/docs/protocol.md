# The wire protocol

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
> Not built: **lifecycle dispatch to your exported functions** (the host sends the frame; nothing
> routes it to your `activate`), the `ctx` object those docs describe, storage, outbound actions,
> the UI renderer, and nodes.
>
> These pages document what is **real today** and mark clearly what is not. Read
> [status.md](./status.md) for the line-by-line breakdown before you build anything you are relying
> on.

Everything between the daemon and your plugin process is newline-delimited JSON, one frame per line,
over the process's stdin and stdout. The complete vocabulary is twelve frame tags. There is nothing
else: if a tag is not in the table below, it does not cross the boundary.

Source of truth: `packages/plugin-api/src/protocol.ts`. Every constant, code and rule on this page is
read from that file.

## Why it is written down rather than proxied

The obvious design is a transparent proxy — Comlink, or something like it — where calling
`host.friends.list()` in your plugin just works and the boundary is invisible. Invisibility is
exactly the wrong property for a security boundary. A surface you cannot enumerate is a surface you
cannot schema-validate; a call you cannot name is a call you cannot attach a scope check to; and a
method that materialises out of a `Proxy` get-trap has nowhere to hang a deadline. Every one of those
three would have to be fought back in afterwards, and the fight is the tell.

So the surface is a list. `FRAME_TAGS` is the whole vocabulary, `parseEnvelope` is the one door, and
a frame that does not validate costs the sender its own call and nothing else. Nothing in
`protocol.ts` throws on bad input — every function returns a `ParseResult`, because the peer is
assumed hostile and a hostile peer must not be able to raise an exception inside the host.

Validation is hand-rolled rather than Zod, unlike the manifest. The manifest is read once at install
time and its schema also generates the JSON Schema, the consent screen and the docs. This code runs
on every frame of a burst — log tailing puts 40+ events on the bus during a single instance
transition — and what it enforces is byte budgets and depth caps, which a schema language does not
describe well. It also has to stay dependency-free enough to run inside the injected prelude.

## The envelope

Every frame is a JSON object with a `t` field naming its tag. Decoding is three steps, in this order:
the UTF-8 byte cap on the *text*, then `JSON.parse`, then `parseEnvelope`. The byte cap comes first
because parsing is where a hostile frame gets to allocate, and a 400MB frame rejected after parsing
has already cost what it was going to cost.

### Direction is validated, not documented

`FRAME_SENDERS` says which side may originate each tag, and `parseEnvelope` enforces it when given a
`from` role. This is a real check rather than a convention, because without it a plugin could send
*itself* an `event` frame's worth of forged bus data, or answer a `ping` it was never asked, and the
host would have no principled reason to object. The host decodes plugin output with
`decodeEnvelope(text, { from: "plugin" })`, so a host-only tag arriving on stdout is reported as a
protocol error and never reaches a handler.

| Tag | Sender | Fields |
|---|---|---|
| `req` | both | `id`, `method`, `deadline`, `params?` |
| `res` | both | `id`, `result?` |
| `err` | both | `id`, `error` |
| `subscribe` | plugin | `id`, `deadline`, `sub`, `filter`, `delivery` |
| `unsubscribe` | plugin | `id`, `deadline`, `sub` |
| `event` | host | `sub`, `seq`, `events[]` |
| `dropped` | host | `sub`, `count`, `reason`, `seq` |
| `credit` | plugin | `sub`, `credits` |
| `hello` | plugin | `protocol`, `pluginId` |
| `lifecycle` | host | `id`, `deadline`, `phase` |
| `ping` | host | `nonce`, `deadline` |
| `pong` | plugin | `nonce`, `rss?` |

"Both" is not laziness: the protocol is symmetric, and the host calls into the plugin (`ui.intent`, a
graph node body) exactly the way the plugin calls into the host.

### Frame by frame

**`req` / `res` / `err`** — a call and its two possible answers, correlated by `id`. `method` is a
dotted name resolved in the receiver's dispatch table, at most 96 characters. `params` and `result`
are optional and may be any JSON value, subject to the depth cap. An `err` carries an `ErrorPayload`:
`code` from the closed set below, a one-line `message` (≤1024 characters, for your log, never parsed),
an optional `retryAfterMs`, and an optional `data`.

**`subscribe` / `unsubscribe`** — plugin-initiated, answered with `res` or `err` on the same `id`,
like any other call. `sub` is a plugin-chosen subscription id that every subsequent `event` and
`dropped` frame carries. `filter` and `delivery` are described under [Backpressure](#backpressure).

**`event`** — one per-tick batch for one subscription. `seq` is the sequence number of the *first*
event in the batch and is monotonic per subscription, so together with `dropped.count` you can prove
whether you saw everything the host sent. A batch never exceeds `MAX_BATCH_EVENTS` (256), nor the
subscription's own `delivery.maxBatch`.

Each entry is a `PluginEvent`:

| Field | Type | Notes |
|---|---|---|
| `kind` | `string` | Dotted kind, ≤64 characters. Deliberately a bare string, not a narrow union. |
| `accountId` | `string \| null` | Required and nullable. `null` means the event is not attributable to a managed account. |
| `ts` | `number` | Integer unix-ms. Timestamps are integer unix-ms everywhere in vrc.zip. |
| `subjectId` | `string \| null` (optional) | The user, world or group the event is about. |
| `sessionId` | `number \| null` (optional) | The `sessions` row id on `gamelog.*` events. Sessions are not accounts. |
| `location` | `string \| null` (optional) | |
| `payload` | JSON (optional) | |

`kind` is a bare `string` on purpose, matching the producer/consumer split in
`@vrcz/shared/events.ts`. A plugin compiled against an older protocol must still receive, filter and
render a kind a newer daemon invented, rather than have the host drop it. Strictness belongs at the
point of emission.

**`dropped`** — the host saying it shed load, with `count`, a `reason` (`overflow`, `coalesced` or
`shutdown`) and the `seq` the next delivered event will carry, so the gap is locatable. The host says
this rather than letting you believe you saw everything, because a plugin silently missing events
writes wrong data and never finds out why.

**`credit`** — you returning credit for events you have finished processing. `credits` must be at
least 1 and at most `MAX_CREDITS` (4096).

**`hello`** — sent once, as the first frame after boot, **by the injected prelude and not by your
code**. It carries the protocol major the process speaks and the plugin id. A mismatch is a hard stop
at the supervisor, never a restart loop, since nothing about respawning the same bundle changes which
protocol it was compiled against.

**`lifecycle`** — `activate`, `deactivate` or `shutdown`, answered on its `id` like any other request.
See [lifecycle.md](./lifecycle.md), and note there that **dispatch to your exported functions is not
wired yet**.

**`ping` / `pong`** — the heartbeat. The echo lives in the prelude, so your code never sees a `ping`
and cannot forget to answer one. `pong.rss` is resident set size in bytes when the runtime can report
it. The prelude refuses to send a `pong` (or a `hello`) on your behalf through the `send` seam, since
a forgeable heartbeat would defeat the thing the heartbeat is for.

## Deadlines

**A deadline on the wire is an absolute unix-ms instant, never a duration.**

A duration would mean "you have 5000ms", which requires both sides to agree on when the clock started,
and they cannot. The frame sits in a pipe for an unknown time, the callee's event loop may be busy
when it arrives, and a duration silently restarts at whatever moment the callee happens to look at it.
An absolute instant is the same instant however long the frame spent in transit, which is what makes
the budget real.

The consequence is clock skew, and it is real. Two processes on one machine read the same OS clock,
so ordinary drift is not the problem; a wall-clock *step* is — an NTP correction, or a user setting
the system clock. Three rules follow:

- **The caller is the only enforcer.** The host times its own pending calls on its own clock and
  aborts the id locally when the deadline passes. A reply arriving afterwards is dropped rather than
  resolved, so a skewed callee can be late but can never resurrect a call the caller already finished
  with.
- **The callee treats the deadline as advisory.** It surfaces as a budget hint, and as an
  `AbortSignal` on `DispatchContext`. It must never be a reason to *refuse* a call: under a backwards
  clock step every deadline looks expired, and a callee that refused would answer nothing at all.
- **The horizon is capped** at `MAX_DEADLINE_HORIZON_MS` (600000, ten minutes). A frame whose
  deadline sits further out than that is rejected, which bounds what a forward clock step can do to a
  pending table.

**An expired deadline is not a parse error.** `parseDeadline` accepts an instant already in the past
and returns it. This is deliberate: under a backwards step *every* deadline looks expired, and
rejecting the frame would mean the peer never even learns its call timed out. Expiry is a decision the
caller makes with `isExpired()`, and the dispatcher's `authorizeCall` checks it before a handler runs
so that a call whose budget is already spent consumes no rate limiter and no storage on its way to
being discarded.

`deadlineIn(timeoutMs)` builds a wire-legal deadline from a duration, truncating and clamping to
`[0, MAX_DEADLINE_HORIZON_MS]`.

## Errors

The set is closed. A frame carrying a code outside it is rejected, which means you can `switch`
exhaustively and a new code is a protocol-major concern.

| Code | Retryable | Meaning |
|---|---|---|
| `E_PROTOCOL` | no | The frame was not a legal envelope: unknown tag, wrong direction, over a size cap. |
| `E_BAD_REQUEST` | no | The frame was legal; the method's own parameters failed to parse. |
| `E_UNKNOWN_METHOD` | no | No such method in this protocol major. |
| `E_SCOPE_DENIED` | no | The plugin does not hold the scope this method requires. Requesting it means re-consent. |
| `E_ACCOUNT_DENIED` | no | The scope is granted, but not for the account the call named. |
| `E_RATE_LIMIT` | yes | The plugin's hourly volume budget for that scope is spent, or it has too many calls in flight at once. Carries `retryAfterMs`. |
| `E_TIMEOUT` | yes | The caller's deadline passed before a reply arrived. Synthesised by the caller. |
| `E_CANCELLED` | no | The call was abandoned: subsystem shut down, plugin disabled, panel closed. |
| `E_TOO_LARGE` | no | A frame, parameter or result exceeded a size cap. |
| `E_QUOTA` | no | The per-plugin SQLite quota is full. Deleting records is the fix; waiting is not. |
| `E_DRY_RUN` | no | An outbound social action was accepted and *not performed*: this plugin is still in dry-run for that scope. |
| `E_UNAVAILABLE` | yes | The host could serve this in principle but not now: account offline, pipeline down. |
| `E_UPSTREAM` | yes | VRChat itself returned an error. `data` carries the upstream status where there was one. |
| `E_INTERNAL` | yes | A bug on whichever side produced it. Never carries the other side's internals. |

`retryable` is advisory. It says the same call unchanged *could* succeed later; it is not permission
to retry in a tight loop.

### `E_RATE_LIMIT`: read this one properly

**Wait for `retryAfterMs`. Retrying immediately is a bug in your plugin, and it is a
bannable-behaviour bug — not in vrc.zip's opinion, in VRChat's.**

Every call your plugin makes is a call against the *user's* account. A plugin that polls through a 429
gets the person running it rate-limited and potentially moderated, and they will blame vrc.zip rather
than you. The host tags every call with your plugin id, meters a subordinate per-plugin budget against
the shared limiter, and names the plugin eating it in the UI — so a hot retry loop is visible to the
user by design. PLAN.md §Phase 3 correction 3 is where this comes from.

**`retryAfterMs` is a real number, not a stock hour.** It is how long until the *oldest call in your
window ages out*, so waiting exactly that long is the correct response. The byte-faithful proxy
answers an exhausted third-party app with the whole window instead, which is fine for an HTTP client
that was going to poll anyway; a plugin is told in as many words that retrying early is a bug, and a
flat hour quoted against a real nine-second wait is how that instruction stops being believed.

Treat it as a floor rather than a promise: the window may refill later than that if your calls were
bunched. It will not refill *earlier*.

Two different things answer with this code, and only one of them is the hourly budget. Exceeding the
in-flight cap on concurrent calls also answers `E_RATE_LIMIT`, with a short `retryAfterMs` in the
hundreds of milliseconds, because it is the one error a well-behaved plugin already knows how to wait
on.

## Backpressure

Three mechanisms, and the first is the reason the other two rarely matter.
`EventBus.emit()` never awaits anything plugin-related, so a slow plugin can lose events but can never
slow the daemon down.

### 1. Filters are data, not predicates

An `EventFilter` is a JSON object, not a callback:

```json
{ "kinds": ["gamelog.*", "friend.online"], "accountIds": ["usr_…"], "subjectIds": ["usr_…"] }
```

Being data is what lets the host compile it to a closure once, at subscribe time (`compileFilter`),
and then spend one `Set.has` per event deciding whether your process is woken at all. A predicate
would have to cross the process boundary per event, which is precisely the cost the filter exists to
avoid.

Fields are ANDed; values within a field are ORed. An entry ending in `.*` matches any kind under that
dotted prefix; anything else is exact. An omitted field matches everything — and for `accountIds` the
host narrows to your grant regardless. An event with `accountId: null` (an unlinked game session) can
never match an id list, because the subscription asked for named accounts and this event belongs to
none of them.

There is deliberately no negation, no disjunction across fields, and no expression language. Every
operator is an equality or a dotted-prefix test, so the cost of a filter is bounded by construction.
Filter kinds must match `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$` — the character set is boring on
purpose, since matching is `===`.

### 2. Credit windows and overflow

A `DeliveryPolicy` is `{ credits, maxBatch, overflow, keyPath? }`. `credits` is how many events may be
outstanding before the queue is considered full; you return credit with a `credit` frame as you finish
processing.

`OVERFLOW_POLICIES` is what happens when the window is full. Take a burst of 900 `friend.location`
events into a window of 100:

| Policy | Result | Right when |
|---|---|---|
| `drop-newest` | You see the **first** 100; the 800 after are shed. | Events are individually meaningful and order matters — an audit log. Wrong for presence: it leaves you looking at a stale world forever. |
| `drop-oldest` | A ring buffer: you see the **last** 100. | Only recency matters and the events are not per-entity. |
| `coalesce` | With `keyPath: "userId"`, you see **each friend's current location**, one entry per friend, however many times they moved. | Anything presence-shaped. A slow plugin gets the truth, late, instead of 900 events describing a path it no longer cares about. |
| `disconnect` | The subscription closes and you are told. | Correctness genuinely depends on seeing every event: better a loud failure than silent gaps. |

**There is deliberately no `block` policy.** Blocking is the thing backpressure exists to prevent. A
plugin that cannot keep up loses events; it does not get to slow the daemon down.

Two details of `coalesce` worth knowing, both of them in `applyOverflow` as executable code rather
than prose:

- It supersedes whenever a key is already pending, not only when the queue is full. Replacement is the
  entire point, and delaying it until the window fills would hand you a backlog you explicitly asked
  not to have. A superseded event counts as dropped and is reported with reason `coalesced`.
- A coalesce subscription whose keys are all distinct has degenerated into an unbounded queue, so it
  falls back to ring-buffer behaviour rather than growing without bound.

`keyPath` is required with `coalesce` and refused without it — silently ignoring a stray `keyPath`
would let you believe you had asked for coalescing. The resolution rule: **a path whose first segment
is not a field of the event is resolved against `payload`.** So `"userId"` and `"payload.userId"` both
work, and `"subjectId"` addresses the event field. A path resolving to anything but a string, number
or boolean makes that event uncoalescable — it queues normally and is never replaced. At most
`MAX_KEY_PATH_SEGMENTS` (4) segments, none empty.

`coalesceByKey` preserves the position of each key's *first* appearance, so a chatty key cannot
repeatedly jump the queue and starve a quiet one.

### 3. Per-tick batching

`maxBatch` is the most events the host packs into one `event` frame. One frame of 40 join events costs
one wakeup and one parse; 40 frames cost 40 of each.

## Limits

Every one of these is the only thing standing between a hostile peer and an unbounded allocation, an
unbounded recursion, or an unbounded wait.

| Constant | Value | Why |
|---|---|---|
| `MAX_FRAME_BYTES` | 1048576 | One encoded frame, in UTF-8 bytes. Checked *before* `JSON.parse`, because parsing is where the allocation happens. |
| `MAX_JSON_DEPTH` | 32 | Deep nesting is the cheapest denial of service available: a few hundred bytes of `[[[[…]]]]` turns any recursive walk into a stack overflow. Same 32 that caps the UI tree. |
| `MAX_ID_LENGTH` | 64 | Correlation ids are counters. Nothing legitimate is long. |
| `MAX_METHOD_LENGTH` | 96 | `vrchat.friends.list` and the like. A dotted name, not a sentence. |
| `MAX_MESSAGE_LENGTH` | 1024 | Error messages are shown in a log, not parsed. |
| `MAX_KIND_LENGTH` | 64 | Event kinds are dotted paths from the shared vocabulary. |
| `MAX_FILTER_KINDS` | 64 | Kind patterns per subscription. A plugin wanting more wants no filter at all. |
| `MAX_FILTER_VALUES` | 64 | Values per id list in a filter. Six accounts is the realistic ceiling. |
| `MAX_BATCH_EVENTS` | 256 | Events in one `event` frame. |
| `MAX_CREDITS` | 4096 | The credit window ceiling. |
| `MAX_KEY_PATH_SEGMENTS` | 4 | A coalesce key path is `userId` or `payload.userId`, not a query language. |
| `MAX_DEADLINE_HORIZON_MS` | 600000 | How far ahead a deadline may sit. A peer setting `Number.MAX_VALUE` is asking the other side to hold a pending entry forever. |

Both sides check the frame cap. The sender checks too, rather than leaving it to the receiver: a host
that only discovers an oversized frame on the far side has already written it into a pipe, and a
plugin that only learns from an `E_TOO_LARGE` reply has lost the call it could have failed locally
with the payload still in hand. `exceedsFrameCap` settles almost every frame with two integer
comparisons and only encodes a borderline one.

A few smaller rules that are easy to trip over:

- `NaN` and `Infinity` are refused inside any JSON payload. They serialise to `null`, so a frame
  carrying one did not come from JSON and is evidence about the peer.
- `credits` and `maxBatch` must both be at least 1.
- `event.location` is allowed up to 512 characters, because locations (`wrld_…:12345~region(eu)`) are
  longer than ids; the frame cap is the real bound there.

## The dispatcher contract

Host-side, but worth understanding because it is what decides whether your call runs.

A method is declared with `defineMethod`, which binds four things together: the `scope` it requires
(or an explicit `null` for one that needs none), a `cost` charged against the plugin's subordinate
rate budget, a `parse` for its parameters, and a `handle` that receives *parsed* parameters. The shape
is the enforcement. A handler cannot check a scope because it is given nothing to check one with, and
it cannot forget to validate its arguments because it never sees the raw ones.

`authorizeCall` is the gate, and it is pure: it decides, it does not act. Method lookup, then
deadline, then scope, in that order.

**`authorizeCall` does not check the account**, which is worth knowing if you are reading
`protocol.ts` to work out where that happens. `ErasedMethod` carries `scope` and `cost` and nothing
else, so a method's account posture cannot ride on it and the membership check lives in the host's
scope gate beside it. There, naming an account outside the grant is `E_ACCOUNT_DENIED`; naming none
when the grant covers exactly one resolves to that one; naming none when it covers several is
`E_BAD_REQUEST` rather than a guess.

The full order the host runs, and every step is a refusal point:

```
grant → in-flight cap → method → deadline → scope → account → budget → charge → invoke
```

The charge lands **before** the work rather than after, as a reservation. Recording afterwards would
let a hundred simultaneous calls all read the same pre-spend count and all pass, which is the exact
shape a volume budget exists to stop.

The methods behind that mechanism are real now, and there are eight of them, all reads:
`vrchat.accounts.list`, `vrchat.friends.list`, `vrchat.users.get`, `vrchat.worlds.get`,
`vrchat.worlds.search`, `vrchat.instances.get`, `vrchat.groups.get` and `vrchat.groups.list`. See
[getting-started.md](./getting-started.md) for their scopes.

What the dispatcher sees of you is a `PluginGrant`: `pluginId`, the `scopes` and `accountIds` the user
actually approved, and any `dryRunScopes` still logging instead of acting. It is deliberately **not**
the manifest type. The manifest is what you *requested*; a grant is what the person at the consent
screen approved, which is narrower whenever they unticked something. Nothing on the call path may
consult a manifest, and `protocol.ts` has no way to reach one.

## See also

- [lifecycle.md](./lifecycle.md) — spawn, prelude, handshake, heartbeat, restart and death.
- [cheatsheet.md](./cheatsheet.md) — every value on this page in one table.
- [status.md](./status.md) — what exists today and what does not.
