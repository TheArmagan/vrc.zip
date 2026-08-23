# vrc.zip

<img src="docs/icon.png" alt="" width="96">

A VRChat companion that runs on your own machine. It signs into more than one account at once, keeps
their presence live, records a feed you can search later, reads VRChat's game logs, and can hand that
same access to other apps you already use.

It opens in your browser, but nothing leaves your computer. Every port it binds is `127.0.0.1`.

> **UNOFFICIAL.** Not affiliated with, endorsed by, or operated by VRChat Inc. You sign in with your
> own VRChat credentials, and vrc.zip talks to VRChat as you.

![vrc.zip](docs/collage.jpg)

## Get it

Download `vrc.zip.exe` from [Releases](https://github.com/TheArmagan/vrc.zip/releases). One file,
nothing to install, nothing to put next to it. Windows x64 only for now.

Run it and it prints a link, then opens your browser on it:

```
  UI       http://127.0.0.1:7773  (the app)
  proxy    http://127.0.0.1:7774  (VRChat API mirror)
  control  http://127.0.0.1:7775  (consent, tokens, event stream)
  forward  http://127.0.0.1:7776  (configure an app with this)

  Open: http://127.0.0.1:7773/?token=...
```

The console window is not decoration. It carries that link, and closing it is how you stop the
daemon. The link has your session token in it, so treat it like a password.

## First run

1. **Settings, contact address.** VRChat requires every API client to put a working contact address
   in its User-Agent. Until you set an email or a profile URL there, sign-in fails with
   `setup_required`. vrc.zip sends nothing to VRChat other than the requests you cause.
2. **Accounts, Add account.** Username, password, then whichever second factor your account uses.
   All three work: authenticator app, email code, and the older `otp` path.
3. Add a second account if you have one. That is the normal case here, not an edge case.

Signing an account in does not launch VRChat, and quitting VRChat does not sign it out. Passwords are
never stored; the session cookie is, encrypted, and reused so VRChat is asked for a new session as
rarely as possible.

![Accounts](docs/screenshots/accounts.jpg)

## What you get

### Live sessions

Every VRChat client running on this machine, read out of its log file: who it is signed in as, the
world, the instance, and who has walked in and out since vrc.zip started watching.

Two clients on two accounts show up as two sessions. A client signed into an account vrc.zip does not
manage still shows up, just without a name attached.

![Live sessions](docs/screenshots/live-sessions.jpg)

### Friends

All accounts in one list, grouped by status, with the world and instance each person is in. Presence
comes off VRChat's own websocket, so a friend moving worlds lands in front of you rather than on the
next poll.

From a row you can invite them to where one of your clients already is, ask them for an invite, boop
them, or open the profile and keep a private note on it. Where VRChat allows a join, there is a join
button, and it self-invites instead of deep-linking when a client is already running on that account.

![Friends](docs/screenshots/friends.jpg)

### Feed

One searchable history across every account: friends coming online, moving worlds, notifications,
game log lines, group activity. Filter by kind, by account, or by text.

Rows link to the thing they mention. Profiles, worlds, groups and avatars open in the same panel with
a back stack, so following a name three levels deep still has a way back.

![Feed](docs/screenshots/feed.jpg)

### Game log and notifications

The game log is the raw thing, parsed: joins, leaves, world changes, instance changes, per client.
Notifications are friend requests, invites, group announcements and events, from every account, in
one inbox. Marking one seen clears the count here and leaves VRChat's own inbox untouched.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/game-log.jpg" alt="Game log"></td>
<td width="50%"><img src="docs/screenshots/notifications.jpg" alt="Notifications"></td>
</tr>
</table>

### Everything by keyboard

`Ctrl+Shift+P` opens the command palette. Every action in the app is in it, including the ones
plugins add, grouped by where they came from.

`Ctrl+Shift+V` takes whatever id or link is on your clipboard and opens it. A `usr_` out of a bug
report, a `wrld_` from Discord, a `vrchat://` copied out of the game. If the clipboard holds
something that is not an id, it says so instead of guessing.

### History you control

Every kind of event has its own retention window, and you can see how many rows each one is holding
before you change it. Expiring events are folded into daily counts first, so the shape of your
history survives even when the individual rows do not. Notes, friend history, the avatar log and the
user cache are never deleted.

![History settings](docs/screenshots/history.jpg)

## Let your other apps use it

vrc.zip can stand in front of VRChat for other local apps, VRCX included. The app logs in the way it
always does, except the credentials it ends up holding are vrc.zip's, not VRChat's, and you decide
what it may do with them.

Point a proxy-aware app at `http://127.0.0.1:7776` and open that URL in a browser for the setup
steps, including the certificate it needs to trust.

![Forward proxy setup](docs/screenshots/forward-proxy.jpg)

When the app logs in, vrc.zip shows you who is asking and what it wants. You approve by typing the
six-digit code into the app itself. There is no Allow button, on purpose.

Afterwards, **Connected apps** is the whole picture: which account it acts as, every permission it
holds with the risky ones marked, hourly limits you can tighten, what it has actually called
recently, and one button that cuts it off. One more button cuts off all of them.

![Connected apps](docs/screenshots/connected-apps.jpg)

An app that wants to be told rather than to ask can register a webhook and get the same events
pushed to it. Your real VRChat session cookie never reaches any of them. It cannot leave the daemon.

## Plugins

A plugin is a folder on your computer. There is no registry and no store. Install one and vrc.zip
compiles it, scans it, and shows you what it is asking for before anything runs.

![Installing a plugin](docs/screenshots/plugin-consent.jpg)

Read that warning and believe it: **a plugin runs with your account's privileges and can do anything
you can do on this computer.** Nothing sandboxes it, nothing checks who wrote it. The permission list
covers what it can ask vrc.zip for. It does not cover what it can do to your machine. Install
plugins you trust.

A plugin runs in its own process, on the same permissions you approved, and can draw a panel in the
app, add commands to the palette, and subscribe to the event stream. Enable, disable and remove are
all on one page.

![Plugins](docs/screenshots/plugins.jpg)

Writing one:

```
vrc.zip create-plugin my-plugin
cd my-plugin && bun install
vrc.zip dev .
```

`dev` reinstalls it every time you save.

## Where your things live

Everything is under `%LOCALAPPDATA%\vrc.zip`: the encrypted credential store, the SQLite database,
settings, and the proxy's certificate. Nothing is uploaded anywhere.

The key that encrypts the credential store is held by Windows Credential Manager, so the file is not
readable on its own.

One optional setting is the exception to "only VRChat". VRChat tells you what an avatar looks like
but never which avatar it is, so an avatar row has a picture and nothing to open. Turn on the avtr.zip
lookup and one image file id is sent there to get an avatar id back: no account, no cookie, no user
id, no display name. Leave it off and those rows stay unresolved.

## What it does not do

- **No packaged build outside Windows yet.** It runs from source anywhere Bun runs, and it knows
  where the logs live on Linux, Proton, Flatpak and Steam Deck, but the release is a Windows binary.
- **No node graph editor yet.** Plugins can already contribute node types. The canvas that wires them
  together is planned and not built.
- **No mobile, no remote access.** It binds to localhost only, and that is deliberate.
- **No monetization end-runs.** Favorite counts, invite slots and group limits are whatever your real
  VRC+ entitlements say. vrc.zip will not pretend otherwise.

It is version 0.1.0. Expect rough edges, and expect the database schema to move.

## Running from source

```bash
cd desktop-app
bun install
cd ui && bun run build && cd ..
bun run daemon
```

Bun 1.4.0. `desktop-app/PLAN.md` is the architecture and `desktop-app/PROGRESS.md` is the log of what
is built and what was decided along the way.

`backend/` in this repository is a separate project and is not part of the app.

## License

GPL-3.0. See [LICENSE](LICENSE).
