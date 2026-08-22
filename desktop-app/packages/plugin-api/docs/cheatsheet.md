# Cheatsheet

> [!IMPORTANT]
> **You cannot install and run a plugin yet.** Phase 3 is partly built: the manifest, the wire
> protocol, the UI vocabulary and the node model are settled and published, and the daemon can
> spawn, supervise, restart and kill a plugin process. What is missing is everything between those
> two halves — the installer, the `ctx` API a plugin actually calls, lifecycle dispatch to your
> exported functions, storage, the consent screen, and the UI renderer.
>
> These pages document what is **real today** and mark clearly what is not. Read
> [status.md](./status.md) for the line-by-line breakdown before you build anything you are relying
> on.

Every value here is read from source. Protocol major is **0** (`PLUGIN_API_PROTOCOL_MAJOR`), which is
what `engines.pluginApi` must say.

## Frames

Direction from `FRAME_SENDERS`, and it is validated on arrival, not merely documented.

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

`LIFECYCLE_PHASES`: `activate`, `deactivate`, `shutdown`.
`DROP_REASONS`: `overflow`, `coalesced`, `shutdown`.
`OVERFLOW_POLICIES`: `drop-newest`, `drop-oldest`, `coalesce`, `disconnect`. No `block`, deliberately.

## Error codes

| Code | Retryable |
|---|---|
| `E_PROTOCOL` | no |
| `E_BAD_REQUEST` | no |
| `E_UNKNOWN_METHOD` | no |
| `E_SCOPE_DENIED` | no |
| `E_ACCOUNT_DENIED` | no |
| `E_RATE_LIMIT` | yes — **wait `retryAfterMs`; a hot retry is a bannable-behaviour bug** |
| `E_TIMEOUT` | yes |
| `E_CANCELLED` | no |
| `E_TOO_LARGE` | no |
| `E_QUOTA` | no |
| `E_DRY_RUN` | no |
| `E_UNAVAILABLE` | yes |
| `E_UPSTREAM` | yes |
| `E_INTERNAL` | yes |

## Protocol limits

| Constant | Value |
|---|---|
| `MAX_FRAME_BYTES` | 1048576 |
| `MAX_JSON_DEPTH` | 32 |
| `MAX_ID_LENGTH` | 64 |
| `MAX_METHOD_LENGTH` | 96 |
| `MAX_MESSAGE_LENGTH` | 1024 |
| `MAX_KIND_LENGTH` | 64 |
| `MAX_FILTER_KINDS` | 64 |
| `MAX_FILTER_VALUES` | 64 |
| `MAX_BATCH_EVENTS` | 256 |
| `MAX_CREDITS` | 4096 |
| `MAX_KEY_PATH_SEGMENTS` | 4 |
| `MAX_DEADLINE_HORIZON_MS` | 600000 |

## UI limits

| Constant | Value |
|---|---|
| `MAX_UI_NODES` | 2000 |
| `MAX_UI_DEPTH` | 32 |
| `MAX_UI_STRING` | 4096 |
| `MAX_TABLE_ROWS` | 10000 |
| `MAX_UI_ISSUES` | 50 |

## Host-side process limits

| Constant | Value | File |
|---|---|---|
| `MAX_LOG_LINE_BYTES` | 2048 | `process-transport.ts` |
| `LOG_BURST_LINES` | 200 | `process-transport.ts` |
| `LOG_REFILL_PER_SECOND` | 20 | `process-transport.ts` |
| `MAX_PRELUDE_SOURCE_BYTES` | 16384 | `prelude.ts` |
| `RLIMIT_SETUP_FAILED_EXIT` | 71 | `limits.ts` |

## Supervisor thresholds

Defaults in `supervisor.ts`; every one is overridable per supervisor.

| Option | Default | Effect |
|---|---|---|
| `heartbeatIntervalMs` | 10000 | One `ping` per interval, only while `running`. |
| `pingTimeoutMs` | 5000 | Half the interval, so at most one beat is outstanding. |
| `maxMissedBeats` | 3 | Then `kill()`. `heartbeat-lost`. |
| `rssLimitBytes` | 268435456 (256 MiB) | Checked on every beat. Over it is a kill, not a stop. |
| `helloTimeoutMs` | 10000 | `hello-timeout`. |
| `activateTimeoutMs` | 15000 | `activate-hung`. |
| `stopGraceMs` | 3000 | Graceful stop only. |
| `baseBackoffMs` | 1000 | Ladder start. |
| `maxBackoffMs` | 60000 | Ladder ceiling, jittered up to +20%. |
| `stableAfterMs` | 60000 | Continuously `running` resets the ladder and the crash window. |
| `crashWindowMs` | 300000 | Rolling window. |
| `crashLoopThreshold` | 5 | Crashes in the window before auto-disable. |

States: `idle`, `starting`, `activating`, `running`, `stopping`, `backoff`, `disabled`.
Failure kinds: `spawn-failed`, `hello-timeout`, `protocol-mismatch`, `activate-hung`,
`activate-failed`, `heartbeat-lost`, `rss-exceeded`, `crashed`.
Exit reasons: `shutdown`, `crashed`, `killed`, `spawn-failed`.
Disable reasons: `user` (sticky), `crash-loop` (sticky), `protocol-mismatch` (sticky),
`spawn-failed` (**not** sticky).

## Scopes

48 scopes, 13 of them dangerous. Dangerous scopes render in a separate block behind a second toggle at
consent and are never reachable through a wildcard grant. Native scopes gate vrc.zip's own data rather
than a VRChat endpoint, so they are the only ones that mean anything with `accounts.mode: "none"`.

| Scope | Flags | Description |
|---|---|---|
| `account:read` | - | Read your account profile, email status, and login state. |
| `account:write` | - | Change your account settings and confirm your email address. |
| `account:credentials` | dangerous | Manage your two-factor authentication, including recovery codes. |
| `account:destroy` | dangerous | Delete your VRChat account, or register new ones. |
| `avatars:read` | - | Search and read avatars. |
| `avatars:write` | - | Upload, change, and delete your avatars, and switch which one you wear. |
| `calendar:read` | - | Read group calendar events. |
| `calendar:write` | - | Create, edit, delete, and follow group calendar events. |
| `economy:read` | dangerous | Read your balance, purchases, subscriptions, and payout details. |
| `economy:write` | dangerous | Spend money: buy listings, and create or change things you sell. |
| `favorites:read` | - | Read your favorites and favorite groups. |
| `favorites:write` | - | Add and remove individual favorites, and rename favorite groups. |
| `favorites:group:clear` | dangerous | Empty an entire favorite group at once. This cannot be undone. |
| `files:read` | - | Read and download your uploaded files. |
| `files:write` | - | Upload files, images, and icons. |
| `files:delete` | dangerous | Permanently delete your uploaded files and their versions. |
| `friends:read` | - | Read your friends list and their online status. |
| `friends:write` | - | Send and cancel friend requests, unfriend people, and boop them. |
| `groups:read` | - | Read groups you can see, and their members. |
| `groups:write` | - | Join and leave groups, and post to ones you belong to. |
| `groups:invite` | dangerous | Invite people to your groups. They will see this as coming from you. |
| `groups:owner` | dangerous | Administer groups you run: kick, ban, assign roles, edit settings, read audit logs, and transfer ownership. |
| `instances:read` | - | Read instance details and recent locations. |
| `instances:write` | - | Create instances. |
| `instances:close` | dangerous | Close a running instance, removing everyone in it. |
| `inventory:read` | - | Read your inventory and drops. |
| `inventory:write` | - | Use, equip, share, and delete your inventory items. |
| `invite:read` | - | Read your saved invite messages. |
| `invite:write` | - | Edit and reset your invite message slots. |
| `invite:send` | dangerous | Send invites and invite requests to other people, as you. |
| `jams:read` | - | Read jams and their submissions. |
| `jams:write` | - | Submit content to jams, and withdraw it. |
| `moderation:read` | dangerous | Read who you have blocked or muted, and your moderation reports. |
| `moderation:write` | dangerous | Block, mute, and report other people, as you. |
| `notifications:read` | - | Read your notifications and invites. |
| `notifications:write` | - | Accept, decline, reply to, and clear your notifications. |
| `prints:read` | - | Read prints. |
| `prints:write` | - | Upload, edit, and delete your prints. |
| `props:read` | - | Read props. |
| `props:write` | - | Create, edit, publish, and delete your props. |
| `sessions:read` | native | See when your VRChat clients start and stop, and where they are. |
| `sessions:unlinked` | dangerous, native | See VRChat clients signed into accounts you have not added to vrc.zip, including their display names. |
| `webhooks:write` | native | Register web addresses that vrc.zip will send your events to as they happen. |
| `system:read` | - | Read VRChat's public configuration, health, and online-user count. |
| `users:read` | - | Look up users, their profiles, groups, and your notes about them. |
| `users:write` | - | Edit your own profile and notes, and delete your world save data. |
| `worlds:read` | - | Search and read worlds. |
| `worlds:write` | - | Create, edit, publish, and delete your worlds. |

## Capabilities

`permissions.capabilities`. **There is no `network` capability and no way to spell one** — arbitrary
HTTP collapses the boundary, since `friends:read` plus network means the user's friends list is on
someone's server. The two replacements are narrow because the host executes them, which is also what
makes them loggable and rate-limitable.

| Capability | Dangerous | Description |
|---|---|---|
| `storage` | no | Keep its own settings and records in a private database on this computer. |
| `storage:sql` | yes | Run raw SQL against its own private database. Only its own — it cannot reach vrc.zip's. |
| `webhook` | no | Send messages to a web address that you type into its settings. The plugin chooses what to say, never where it goes. |
| `fetch:allowlist` | yes | Ask vrc.zip to fetch pages from the specific websites listed below, and read the replies. |
| `notify` | no | Show you desktop and in-headset notifications. |

## Events

13 families, 52 known kinds. Families in filter-bar order:

`friend`, `notification`, `gamelog`, `session`, `user`, `group`, `instance`, `account`, `pipeline`,
`economy`, `content`, `consent`, `other`.

| Family | Kinds |
|---|---|
| `friend` | `online`, `offline`, `active`, `location`, `updated`, `added`, `removed`, `presence`, `list_refreshed` |
| `user` | `updated`, `location`, `badge_assigned`, `badge_unassigned` |
| `notification` | `received`, `received_v2`, `updated`, `deleted`, `responded`, `seen`, `hidden`, `cleared`, `synced` |
| `gamelog` | `player_join`, `player_leave`, `world_enter`, `location_join`, `portal_spawn`, `destination_set`, `left_room`, `join_failed`, `screenshot`, `app_quit`, `vr_mode`, `authenticated` |
| `session` | `start`, `update`, `end` |
| `account` | `state`, `ready`, `removed` |
| `pipeline` | `state` |
| `group` | `joined`, `left`, `member_updated`, `role_updated` |
| `instance` | `queue_joined`, `queue_ready` |
| `economy` | `update` |
| `content` | `refresh`, `image_updated` |
| `consent` | `pending`, `resolved` |

`other` is the bucket a consumer puts an unrecognised namespace in; nothing is emitted under it.

### Pattern syntax

Two places take patterns and they are **not** the same grammar:

| Where | Accepts | Unknown kinds |
|---|---|---|
| `permissions.events` in the manifest | `*`, `<family>.*`, or one exact `BusEventKind` | Rejected at install. Write `family.*` for forward compatibility. |
| `EventFilter.kinds` on a `subscribe` frame | Literal kind, or a dotted prefix ending `.*`, matching `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$` | Accepted — a newer daemon's kind still matches. |

Filter fields are ANDed; values within a field are ORed. Omitted means "all". An event with
`accountId: null` never matches an `accountIds` list.

## Port types

`PORT_TYPES`: `friend`, `user`, `world`, `instance`, `group`, `avatar`, `string`, `number`, `boolean`,
`json`.

`assignable(from, to)` is identity plus **exactly two widening rules**:

1. `friend <: user` — anything taking a user takes a friend. Not the reverse: a node needing
   friendship must be able to refuse a stranger at edit time.
2. `X <: json` — every type erases to JSON. Not the reverse: `json` into a typed port is the unchecked
   cast that makes a type system decorative.

No arrays, no `timestamp` distinct from `number` (timestamps are integer unix-ms everywhere), no
`any`. Every additional rule is an explanation owed to a user whose edge just got refused.

## UI node types

`UI_NODE_TYPES` — 28 types. See [ui.md](./ui.md) for fields, interaction and validation.

| Group | Types |
|---|---|
| Layout | `stack`, `grid`, `card`, `scroll`, `tabs`, `separator` |
| Content | `text`, `badge`, `icon`, `alert`, `empty`, `skeleton` |
| Domain refs | `userRef`, `worldRef`, `groupRef`, `avatarRef`, `instanceRef` |
| Input | `form`, `field`, `input`, `textarea`, `select`, `switch`, `button` |
| Data | `table`, `list` |
| Overlay | `dialog`, `menu` |

## On-disk paths

Root is `VRCZIP_STATE_DIR` when set; otherwise `%LOCALAPPDATA%\vrc.zip` on Windows,
`~/Library/Application Support/vrc.zip` on macOS, `$XDG_STATE_HOME/vrc.zip` or
`~/.local/state/vrc.zip` elsewhere.

| Path | Contents |
|---|---|
| `plugins/<id>/` | Installed artifacts for one plugin. |
| `plugins/<id>/<sha256>.js` | The content-addressed bundle. The name *is* the hash, verified on every load. |
| `plugin-data/<id>/` | The plugin's own data directory. Also its process working directory. |
| `plugin-data/<id>/plugin.sqlite` | The plugin's own database. It cannot lock or corrupt the daemon's WAL. |
| `runtime/bun-<version>/bun[.exe]` | The pinned plugin runtime. **The installer that fetches this does not exist yet.** |

Code and data are separate trees on purpose: uninstall is `rm -rf` on the code, so keeping data across
an uninstall-reinstall is a decision someone makes rather than an accident of layout, and the quota is
a `stat` on one directory.

## See also

[protocol.md](./protocol.md) · [lifecycle.md](./lifecycle.md) · [manifest.md](./manifest.md) ·
[ui.md](./ui.md) · [nodes.md](./nodes.md) · [security-model.md](./security-model.md) ·
[status.md](./status.md)
