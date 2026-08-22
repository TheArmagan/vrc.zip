# `vrcz-plugin.json` reference

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

The manifest is the one file a plugin must have. It is what the consent screen renders, what the
grant is keyed on, and — once the installer exists — what the install pipeline reads before it will
touch your code.

Everything below is read out of `packages/plugin-api/src/manifest.ts`, which is the contract: a Zod
schema, with the TypeScript types *inferred* from it rather than declared beside it. The schema is
already published and already runs — `parseManifest()` is real code you can call today, and every
rejection message quoted on this page is the literal string it produces.

## Two rules that explain most of the rest

**Every object is strict.** Unknown keys are rejected, at every level, with the parse failing rather
than the key being ignored. That is not tidiness — a manifest that says `"permisions"` would
otherwise parse into a plugin running with *no* permissions declared, and a manifest that says
`"capabilties": ["storage"]` would install cleanly and then fail at runtime in a way that looks like
a host bug. A typo is an error you see at install, not a mystery you debug at 3am.

**Errors are written for the person at the install screen**, not for you with a stack trace. They
name the field, say what was wrong, and where possible say what to write instead. If you are adding
a refinement, that is the bar.

## Top level

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `$schema` | string | no | — | ≤ 2048 chars. Accepted and otherwise ignored |
| `id` | string | **yes** | — | 3–128 chars, `publisher.plugin-name` (see below) |
| `name` | string | **yes** | — | 1–64 chars |
| `version` | string | **yes** | — | semver |
| `description` | string | no | — | ≤ 300 chars |
| `publisher` | string | **yes** | — | 1–64 chars |
| `homepage` | string | no | — | a full URL |
| `repository` | string | no | — | a full URL |
| `license` | string | no | — | ≤ 64 chars (free text; not validated against SPDX) |
| `keywords` | string[] | no | `[]` | ≤ 10 entries, each 1–32 chars |
| `icon` | string | no | — | a relative path inside the plugin folder |
| `main` | string | **yes** | — | a relative path inside the plugin folder |
| `engines` | object | **yes** | — | see [engines](#engines) |
| `permissions` | object | no | see below | see [permissions](#permissions) |
| `contributes` | object | no | see below | see [contributes](#contributes) |
| `performance` | `"smol"` \| `"throughput"` | no | `"smol"` | see [performance](#performance) |
| `signing` | object | no | — | see [signing](#signing) |

`permissions` and `contributes` are optional objects that default to a fully-populated empty shape,
so a manifest that omits both still parses into `permissions.scopes: []`, `permissions.accounts.mode:
"none"`, `contributes.panels: []`, and so on. You never have to write an empty object to opt out of
something.

### `id`

Pattern: `^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$` — lowercase letters, digits and hyphens,
in dot-separated segments, at least one dot. VS Code's `publisher.name` convention.

It is restricted this hard because it is the primary key for three different things: your grants,
your data directory on disk, and the content-addressed artifact path. No uppercase, because two ids
differing only in case would collide on a case-insensitive filesystem and *not* collide in the grant
table. No dot-only segments, and nothing that could be read as `..`.

```
id must look like "publisher.plugin-name" — lowercase letters, digits and hyphens, at least one dot.
This id is the key for your grants and your data directory, so it cannot be changed later without
the user re-approving the plugin.
```

### `version`

Semver, by the official regex reduced to what a manifest may declare (pre-release and build metadata
allowed; a leading `v` is not). Grants are keyed by version, so an unparseable version means vrc.zip
cannot tell an update from a downgrade.

```
version must be a semantic version like "1.4.0". Grants are keyed by version, so an unparseable
version means vrc.zip cannot tell an update from a downgrade.
```

### `main` and `icon`

Both are relative POSIX paths inside the plugin folder, 1–255 characters, matching
`^(?!\/)(?!\.\.?(?:\/|$))(?:[\w.-]+\/)*[\w.-]+$`. Absolute paths, backslashes and any `..` segment
are refused — the install pipeline reads these paths off disk, and a manifest is untrusted input.

Both `main: "../../etc/passwd"` and `main: "C:\\evil.ts"` produce:

```
main must be a path inside the plugin folder, written with forward slashes — for example
"src/index.ts". Absolute paths, backslashes, and ".." are refused.
```

`icon` is a path, never a remote URL, and that is deliberate: a remote icon is a beacon that tells a
server every time someone opens the plugin list.

## `engines`

One field, and it is the one that will bite you first.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `pluginApi` | integer | **yes** | must equal this build's protocol major |

**`engines.pluginApi` is a bare integer — the plugin API protocol major — and a range string is
rejected.** In this build the value is **`0`** (`PLUGIN_API_PROTOCOL_MAJOR` in `@vrcz/shared`).

```json
"engines": { "pluginApi": 0 }
```

A range invites `"pluginApi": "^1.2.0"`, which reads as a statement about the *app's* version and is
not one. The protocol and the app version move independently; conflating them would force a
plugin-ecosystem break on every app release. One integer has exactly one meaning.

Writing a range gets you:

```
engines.pluginApi must be a whole number: the plugin API protocol major. Write 0, not a version
range and not the vrc.zip version — the two are versioned separately.
```

A major that is too high and one that is too low get different messages, because they are different
problems with different fixes:

```
engines.pluginApi is 1, but this build of vrc.zip only speaks plugin API 0. The plugin is newer than
the app — update vrc.zip.
```

```
engines.pluginApi is -1, but this build of vrc.zip only speaks plugin API 0. The plugin was written
for an older protocol that no longer exists — its author needs to update it.
```

## `permissions`

| Field | Type | Default | Constraints |
|---|---|---|---|
| `scopes` | string[] | `[]` | ≤ 64, each from the scope registry, no duplicates |
| `accounts` | object | `{ mode: "none", optional: false }` | see below |
| `events` | string[] | `[]` | ≤ 64, each an event pattern, no duplicates |
| `capabilities` | string[] | `[]` | ≤ 16, each a known capability, no duplicates |
| `fetch` | object | `{ domains: [] }` | see below |

### `permissions.scopes`

Validated against the shared scope registry (`packages/shared/src/scopes.ts`) — 48 scopes, 13 of
them `dangerous`. Dangerous scopes are **legal to request**: they are shown in their own block behind
a second toggle at consent, which is where that decision belongs. A manifest that could not ask for
them would only push authors into asking users to do something by hand, which is worse.

An unknown scope is quoted back at you:

```
permissions.scopes[0] "friends:reed" is not a permission vrc.zip recognises. Scopes look like
"friends:read" — see the scope reference for the full list of 48.
```

The `native` column marks the three scopes that gate vrc.zip's own data rather than a VRChat
operation — they are the exception to the account rule below.

| Scope | Dangerous | Native | Description shown at consent |
|---|---|---|---|
| `account:read` | no |  | Read your account profile, email status, and login state. |
| `account:write` | no |  | Change your account settings and confirm your email address. |
| `account:credentials` | **yes** |  | Manage your two-factor authentication, including recovery codes. |
| `account:destroy` | **yes** |  | Delete your VRChat account, or register new ones. |
| `avatars:read` | no |  | Search and read avatars. |
| `avatars:write` | no |  | Upload, change, and delete your avatars, and switch which one you wear. |
| `calendar:read` | no |  | Read group calendar events. |
| `calendar:write` | no |  | Create, edit, delete, and follow group calendar events. |
| `economy:read` | **yes** |  | Read your balance, purchases, subscriptions, and payout details. |
| `economy:write` | **yes** |  | Spend money: buy listings, and create or change things you sell. |
| `favorites:read` | no |  | Read your favorites and favorite groups. |
| `favorites:write` | no |  | Add and remove individual favorites, and rename favorite groups. |
| `favorites:group:clear` | **yes** |  | Empty an entire favorite group at once. This cannot be undone. |
| `files:read` | no |  | Read and download your uploaded files. |
| `files:write` | no |  | Upload files, images, and icons. |
| `files:delete` | **yes** |  | Permanently delete your uploaded files and their versions. |
| `friends:read` | no |  | Read your friends list and their online status. |
| `friends:write` | no |  | Send and cancel friend requests, unfriend people, and boop them. |
| `groups:read` | no |  | Read groups you can see, and their members. |
| `groups:write` | no |  | Join and leave groups, and post to ones you belong to. |
| `groups:invite` | **yes** |  | Invite people to your groups. They will see this as coming from you. |
| `groups:owner` | **yes** |  | Administer groups you run: kick, ban, assign roles, edit settings, read audit logs, and transfer ownership. |
| `instances:read` | no |  | Read instance details and recent locations. |
| `instances:write` | no |  | Create instances. |
| `instances:close` | **yes** |  | Close a running instance, removing everyone in it. |
| `inventory:read` | no |  | Read your inventory and drops. |
| `inventory:write` | no |  | Use, equip, share, and delete your inventory items. |
| `invite:read` | no |  | Read your saved invite messages. |
| `invite:write` | no |  | Edit and reset your invite message slots. |
| `invite:send` | **yes** |  | Send invites and invite requests to other people, as you. |
| `jams:read` | no |  | Read jams and their submissions. |
| `jams:write` | no |  | Submit content to jams, and withdraw it. |
| `moderation:read` | **yes** |  | Read who you have blocked or muted, and your moderation reports. |
| `moderation:write` | **yes** |  | Block, mute, and report other people, as you. |
| `notifications:read` | no |  | Read your notifications and invites. |
| `notifications:write` | no |  | Accept, decline, reply to, and clear your notifications. |
| `prints:read` | no |  | Read prints. |
| `prints:write` | no |  | Upload, edit, and delete your prints. |
| `props:read` | no |  | Read props. |
| `props:write` | no |  | Create, edit, publish, and delete your props. |
| `sessions:read` | no | native | See when your VRChat clients start and stop, and where they are. |
| `sessions:unlinked` | **yes** | native | See VRChat clients signed into accounts you have not added to vrc.zip, including their display names. |
| `webhooks:write` | no | native | Register web addresses that vrc.zip will send your events to as they happen. |
| `system:read` | no |  | Read VRChat's public configuration, health, and online-user count. |
| `users:read` | no |  | Look up users, their profiles, groups, and your notes about them. |
| `users:write` | no |  | Edit your own profile and notes, and delete your world save data. |
| `worlds:read` | no |  | Search and read worlds. |
| `worlds:write` | no |  | Create, edit, publish, and delete your worlds. |

### `permissions.accounts`

| Field | Type | Default | Constraints |
|---|---|---|---|
| `mode` | `"none"` \| `"one"` \| `"many"` | `"none"` | no `"all"` |
| `optional` | boolean | `false` | — |
| `reason` | string | — | ≤ 200 chars, shown beside the account picker |

This is a *request*, and the binding itself is chosen by the user at consent. **There is deliberately
no way to spell "all accounts"**: the widest a manifest can ask for is `"many"`, which renders an
account picker, and the picker's answer is what the grant records. A plugin with `friends:read` must
not implicitly get it for all six of the user's accounts.

```
permissions.accounts.mode must be "none" (the plugin never touches a VRChat account), "one" (you
pick a single account for it), or "many" (you pick any number). There is no "all" — which accounts a
plugin gets is your choice at install time, not the author's.
```

`optional: true` says the plugin still functions with nothing bound, which lets the picker be left
empty.

**Cross-check: a non-native scope with `mode: "none"` is rejected.** A VRChat scope with nothing to
apply it to is a permission the user grants for no effect.

```
permissions.accounts.mode is "none", but the plugin asks for "friends:read", which only means
anything against a VRChat account. Set it to "one" or "many" so you can choose which of your
accounts the plugin sees.
```

The three native scopes (`sessions:read`, `sessions:unlinked`, `webhooks:write`) are exempt: they
gate data vrc.zip derived itself from local log files, not anything belonging to one account. A
manifest asking only for `sessions:read` parses fine with `mode: "none"`.

### `permissions.events`

Bus subscriptions. Three shapes are accepted:

- `"*"` — everything
- `"<family>.*"` — a whole family
- an exact kind, e.g. `"friend.online"`

Families, in the order the host offers them: `friend`, `notification`, `gamelog`, `session`, `user`,
`group`, `instance`, `account`, `pipeline`, `economy`, `content`, `consent`, `other`. The kind
vocabulary is `packages/shared/src/events.ts`.

**An unknown kind is rejected**, which is the opposite of how the *consumer* side of the event system
behaves — a feed row with an unrecognised kind still renders. The asymmetry is deliberate: an
unrecognised kind in a feed is just news from a newer daemon, but a mistyped kind in a manifest is a
subscription that silently never fires, and you find out from a bug report months later.

If you genuinely want kinds this build has not heard of, write `family.*`, which is stable across
daemon versions by construction.

```
permissions.events[0] "friend.onlin" is not an event this build of vrc.zip publishes. Write one
exact kind (for example "friend.online"), a whole family with "friend.*", or "*" for everything.
Families: friend, notification, gamelog, session, user, group, instance, account, pipeline, economy,
content, consent, other.
```

### `permissions.capabilities`

Host powers, at most 16, no duplicates.

| Capability | Dangerous | What the user is told |
|---|---|---|
| `storage` | no | Keep its own settings and records in a private database on this computer. |
| `storage:sql` | **yes** | Run raw SQL against its own private database. Only its own — it cannot reach vrc.zip's. |
| `webhook` | no | Send messages to a web address that you type into its settings. The plugin chooses what to say, never where it goes. |
| `fetch:allowlist` | **yes** | Ask vrc.zip to fetch pages from the specific websites listed below, and read the replies. |
| `notify` | no | Show you desktop and in-headset notifications. |

That is the complete list. An unknown capability is rejected:

```
permissions.capabilities[0] "sqlite" is not a capability vrc.zip offers. The full list is: storage,
storage:sql, webhook, fetch:allowlist, notify.
```

#### There is no `network` permission, and no way to spell one

`permissions.network` does not exist. Neither does a `network` capability. Both spellings are
rejected, and both rejections point at the same two replacements.

Arbitrary HTTP collapses the sandbox to nothing: `friends:read` plus network access means your
friends list is on someone's server. The two replacements are narrow *because the host executes
them*, which is also what makes them loggable and rate-limitable.

Writing `permissions.network` — a strict-mode unknown key that gets its own translated message:

```
permissions.network There is no "network" permission in vrc.zip, on purpose: a plugin that can read
your friends list and also call any server can put your friends list on that server. Use "webhook"
(you supply a JSON body; the user types the destination into settings) or "fetch:allowlist" with the
exact domains listed under permissions.fetch.domains.
```

Writing it as a capability instead gets the same answer:

```
permissions.capabilities[0] "network" is not a capability, on purpose. Use "webhook" (you supply a
JSON body; the user types the destination into settings) or "fetch:allowlist" with the exact domains
listed under permissions.fetch.domains.
```

### `permissions.fetch`

| Field | Type | Default | Constraints |
|---|---|---|---|
| `domains` | string[] | `[]` | ≤ 20, each ≤ 253 chars, bare public lowercase hostnames, no duplicates |
| `reason` | string | — | ≤ 200 chars, shown next to the domain list |

The cap is 20 and it is low on purpose: a consent screen with forty domains on it is a consent screen
nobody reads.

**The capability and the domain list are checked in both directions.** Declaring one without the
other is a manifest where two places disagree, and one of them is a lie the user might read.

```
permissions.fetch.domains is empty, but the plugin asks for the "fetch:allowlist" capability. List
the exact domains it needs, or drop the capability.
```

```
permissions.capabilities does not include "fetch:allowlist", but permissions.fetch.domains lists
domains. Add the capability so the domains appear on the consent screen, or remove them.
```

Each domain must be a bare hostname: lowercase, at least one dot, no scheme, no path, no port. Four
specific mistakes get four specific messages.

**No wildcards.** This is the mistake authors actually make, so it is checked before the shape rule
and gets its own explanation:

```
permissions.fetch.domains[0] "*.example.com" contains a wildcard, and wildcards are not allowed
here. A consent screen has to name every site vrc.zip may talk to on the plugin's behalf, and
"*.example.com" names an unbounded set. List each domain in full instead.
```

An author who needs three subdomains lists three subdomains, and the user reads three lines. That is
the trade: a wildcard is one line meaning "any of an unbounded set of hosts, including ones that do
not exist yet", and nobody can meaningfully agree to it.

```
permissions.fetch.domains[0] "https://api.example.com/v1" is a URL, not a domain. Write just the
host, like "api.example.com" — the scheme is always https and the path is chosen at call time.
```

```
permissions.fetch.domains[0] "API.example.com" must be written in lowercase, so that two spellings
cannot mean two entries.
```

```
permissions.fetch.domains[0] "localhost" points at this computer. vrc.zip makes these requests
itself, so a local address would let the plugin reach services on your own machine that it cannot
reach directly.
```

That last one covers `localhost`, anything ending in `.localhost`, and any bare IPv4 literal. The
host performs these fetches, so a loopback entry would aim the host's own network position at the
machine it is protecting — including vrc.zip's own control API on `127.0.0.1`.

### Duplicates

`scopes`, `events`, `capabilities` and `fetch.domains` each reject a repeated entry, naming the
value rather than counting:

```
permissions.scopes lists "users:read" twice. Remove the duplicate — a repeated entry usually means
two edits landed on the same list.
```

```
permissions.fetch.domains lists "api.example.com" twice. Remove the duplicate — each domain gets one
line on the consent screen.
```

## `contributes`

Surface, not authority. Four lists, each defaulting to `[]`.

| Field | Type | Default | Max |
|---|---|---|---|
| `panels` | Panel[] | `[]` | 32 |
| `settings` | Setting[] | `[]` | 64 |
| `commands` | Command[] | `[]` | 64 |
| `nodes` | NodeContribution[] | `[]` | 64 |

Every contribution id (and every setting `key`) is a lowercase identifier in your own namespace,
1–64 chars, matching `^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$` — for example `friend-notes` or
`notes.export`. Ids must be unique **within their own list**:

```
contributes.panels declares "notes" twice. Every contribution needs its own id, because that is what
the host addresses it by.
```

### Panel

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `id` | string | **yes** | — | contribution id |
| `title` | string | **yes** | — | 1–64 chars |
| `description` | string | no | — | ≤ 200 chars |
| `icon` | string | no | — | ≤ 64 chars, a name from the host's icon set — never a URL |
| `placement` | `"sidebar"` \| `"main"` \| `"settings"` | no | `"sidebar"` | — |

### Setting

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `key` | string | **yes** | — | contribution id |
| `type` | `"string"` \| `"number"` \| `"boolean"` \| `"select"` \| `"url"` \| `"secret"` | **yes** | — | — |
| `label` | string | **yes** | — | 1–64 chars |
| `description` | string | no | — | ≤ 200 chars |
| `default` | string \| number \| boolean | no | — | — |
| `options` | `{ value, label }[]` | only for `select` | — | ≤ 64, each field 1–64 chars |
| `required` | boolean | no | `false` | — |

`url` exists as its own type because it is the destination half of the `webhook` capability: the
user types the URL here, and the plugin only ever supplies a body. `secret` is stored in the OS
credential store rather than in the plugin's database.

`options` is required for `select` and refused for everything else:

```
contributes.settings[0].options is missing: the setting "tone" is a dropdown, so it needs at least
one option to choose from.
```

```
contributes.settings[0].options only applies to a setting of type "select", but "name" is a
"string".
```

### Command

| Field | Type | Required | Constraints |
|---|---|---|---|
| `id` | string | **yes** | contribution id |
| `title` | string | **yes** | 1–64 chars |
| `description` | string | no | ≤ 200 chars |
| `icon` | string | no | ≤ 64 chars |

### Node contribution

| Field | Type | Required | Constraints |
|---|---|---|---|
| `id` | string | **yes** | contribution id |
| `title` | string | **yes** | 1–64 chars |
| `category` | string | no | ≤ 64 chars |
| `description` | string | no | ≤ 200 chars |

**This is the declaration only.** The full `NodeDefinition` — ports, the port-type lattice, the
host-evaluated body template — lives in `nodes.ts` and is registered at runtime; see
[nodes.md](./nodes.md). The seam is deliberate. The manifest says *which* node type ids exist, so
grants, uninstall and "paused and marked unavailable" have something stable to key on; `nodes.ts`
says what each one *is*. Putting the definitions here would mean the consent screen also carried the
graph type system, and that a plugin could not add a node type without a manifest change the user has
to re-approve. Checking that the two lists agree is the install pipeline's job — and the install
pipeline does not exist yet.

## `performance`

`"smol"` (default) or `"throughput"`.

The plugin process is spawned with `--smol` unless you opt out. `--smol` selects JSC's small-heap
configuration: less resident memory, more frequent GC, which is the right trade for a process that is
overwhelmingly an idle event handler. The daemon's whole pitch is a 50–80MB idle footprint, and N
plugin processes are the most likely way to lose it.

`"throughput"` is an **opt-out, not a tuning knob**. It spends the *user's* memory, so it surfaces on
the consent screen and it is part of the grant hash — that is their call to make, not yours to make
silently. Choose it when your plugin genuinely computes, not because more sounded better.

```
performance must be "smol" (the default — the plugin runs in a small-heap process) or "throughput"
(more memory, for a plugin that genuinely computes).
```

Worth knowing: `--smol` is a hint, not a limit. It caps nothing. The RSS watchdog and the OS-level
caps are what actually stop a runaway plugin.

## `signing`

| Field | Type | Required | Constraints |
|---|---|---|---|
| `algorithm` | `"ed25519"` | **yes** | the only accepted value |
| `publisherKey` | string | **yes** | base64 Ed25519 public key: 32 bytes, 44 chars, matching `^[A-Za-z0-9+/]{43}=$` |
| `keyId` | string | no | ≤ 64 chars |

The detached signature itself is **not** in here, and that is what "detached" means — a signature
stored inside the document it signs cannot cover itself. The manifest names the publisher key the
signature must verify against; the signature ships beside the bundle and is checked against the
content-addressed artifact.

Note what is absent: **there is no trust-tier field.** A plugin does not get to declare itself
trusted. The tier is derived by the host from whether a valid signature exists and whether the user
has seen this publisher key before, which is why the unsigned case gets a hold-to-confirm rather than
a checkbox.

> **Not implemented.** `manifest.ts` parses this block and nothing verifies it — signature checking
> belongs to the install pipeline (step 3.5), which does not exist. The `plugins` table already has
> `trust` and `publisher_key` columns waiting for it.

## `grantHash`

Grants are stored immutably keyed by `(pluginId, version, grantHash)`. The hash is a SHA-256 over
exactly the fields a user is agreeing to, so an update that adds a scope provably re-prompts, and a
downgrade cannot silently reuse a grant that was broader than what the older version asked for.

`GRANT_HASH_VERSION` is currently `1`, and it is folded into the hashed payload. Bumping it
invalidates every stored grant, which is correct: if the definition of "consent-relevant" changed,
the old grants were made against a different question.

**Hashed:**

| Field | Why |
|---|---|
| `permissions.scopes` | The authority itself. |
| `permissions.accounts.mode` | How many accounts the plugin may be pointed at. |
| `permissions.accounts.optional` | Whether the picker may be left empty. |
| `permissions.events` | What it gets told about, unprompted. |
| `permissions.capabilities` | Host powers, including storage and the two network replacements. |
| `permissions.fetch.domains` | Where the host will send requests on its behalf. |
| `performance` | Spends the user's memory. |

Lists are sorted and de-duplicated before hashing, so re-ordering a JSON array is not a re-prompt,
and neither is reformatting the file or changing the key order.

**Not hashed:**

| Field | Why not |
|---|---|
| `id`, `version` | They are the other two components of the grant key. Hashing them would change the hash on every release even when nothing new was asked for, destroying the one thing it is for. |
| `name`, `description`, `publisher`, `homepage`, `repository`, `license`, `keywords`, `icon`, every `reason` string | Presentation. None of them can widen what the plugin may do, and re-prompting on a typo fix trains people to click through prompts. Identity is pinned by `id` and by `signing`, not by a display name. |
| `contributes` | A new panel, command, setting or node type adds *surface*, not *authority*. All of them still run inside the granted scopes, events and capabilities. |
| `main` | The entry path does not describe what the plugin may do, and the code behind it is pinned separately and more strongly: the artifact is content-addressed as `plugins/<id>/<sha256>.js` and its hash is verified on every load. |
| `engines.pluginApi` | The schema pins it to the one major this build serves, so it is a constant for any manifest that reached a consent screen. A constant contributes nothing. |
| `signing` | Trust tier is evaluated at install against the signature, and it is not something the user grants. Folding it in would make a routine key rotation read as a permission change. |

### What this means for you

Ship a patch release that fixes a typo in your description, adds a panel, renames yourself, and
rotates your signing key: same hash, no re-prompt, the user's existing grant still applies at the new
version (subject to the version component of the key — see [lifecycle.md](./lifecycle.md)). Add one
scope, one event pattern, one capability, one fetch domain, or flip `performance` to `"throughput"`:
new hash, and the consent sheet is unavoidable.

## `parseManifest`

```ts
import { parseManifest, formatManifestIssues, grantHash } from "@vrcz/plugin-api";

const result = parseManifest(JSON.parse(await Bun.file("vrcz-plugin.json").text()));
if (!result.ok) {
  console.error(result.message); // already formatted for a human
  process.exit(1);
}
console.log(result.manifest.id, grantHash(result.manifest));
```

It returns a result rather than throwing, because every caller — the installer, the consent screen,
`vrcz dev`, the docs tooling — wants the list of problems to *show*. A rejected manifest is a normal
outcome, not an exceptional one.

```ts
type ManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; issues: readonly ManifestIssue[]; message: string };

interface ManifestIssue {
  path: string;    // dotted, with array indices: "permissions.fetch.domains[1]". Empty for the root.
  message: string; // one sentence, written for whoever is staring at a failed install
}
```

`message` is `issues` joined with newlines, each line being `path` + space + `message` (or just the
message for a root-level issue) — every quoted rejection on this page is one such line.

`PluginManifest` is `z.infer` of the schema (defaults applied); `PluginManifestInput` is `z.input`
(what you actually write, defaults still optional).

## `$schema` and tooling

`$schema` is accepted and otherwise ignored, so that an editor which adds it automatically does not
break your first save.

> **Not published yet.** PLAN.md says the JSON Schema is generated from the Zod schema, and there is
> no generator in `tools/` yet — nothing serves a schema at any URL today. Until there is, `$schema`
> buys you nothing but forward compatibility. Run `parseManifest` in a test instead; it is the same
> code the installer will run.

## See also

- [getting-started.md](./getting-started.md) — a complete working manifest in context
- [status.md](./status.md) — what is built and what is not
- [security-model.md](./security-model.md) — why the boundary is shaped this way
- [lifecycle.md](./lifecycle.md) — install, activate, update, disable, uninstall
- [nodes.md](./nodes.md) — the `NodeDefinition` behind a `contributes.nodes` entry
