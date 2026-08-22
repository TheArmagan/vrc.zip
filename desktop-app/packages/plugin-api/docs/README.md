# vrc.zip plugin documentation

> [!IMPORTANT]
> **You cannot install or run a plugin from the app yet**, and a good deal more is built than that
> sentence suggests. The install pipeline compiles, deny-scans and content-addresses a bundle; the
> daemon spawns, memory-caps and supervises a plugin process; a dispatcher answers scope-checked and
> account-checked read calls against VRChat. None of it is constructed by the daemon's composition
> root, and there is no consent screen, so nothing can be installed, granted anything, or started
> from the app. Lifecycle dispatch to your exported functions, storage, events, outbound actions and
> the UI renderer are not built at all.
>
> These pages document what is **real today** and mark clearly what is not. Read
> [status.md](./status.md) for the line-by-line breakdown before you build anything you are relying
> on.

## Start here

1. **[status.md](./status.md)** — what is built, what is not, step by step. Read this first; the
   other pages describe a contract, and this one tells you how much of it runs.
2. **[security-model.md](./security-model.md)** — what a plugin can do to the person who installs it,
   stated without flattery. Read this before you publish anything, and before you install anything.
3. **[getting-started.md](./getting-started.md)** — the actual steps: project layout, a manifest that
   parses, and what happens to your code.

## Reference

| Page | What is in it |
|---|---|
| [manifest.md](./manifest.md) | Every `vrcz-plugin.json` field, its constraints, and what `grantHash` covers |
| [lifecycle.md](./lifecycle.md) | Spawn to death: the prelude, the handshake, heartbeats, deadlines, restarts, disable |
| [protocol.md](./protocol.md) | The wire: frames, directions, deadlines, errors, backpressure |
| [ui.md](./ui.md) | The `UINode` vocabulary the host renders on your behalf |
| [nodes.md](./nodes.md) | Graph nodes: the port lattice, config, trigger inversion, definition hashing |
| [cheatsheet.md](./cheatsheet.md) | Every scope, capability, frame, error code and limit, in tables |

## The mental model in one page

A plugin is a **separate process**. It never shares memory with the daemon, never touches the DOM,
and never holds a VRChat credential. It talks to the host over a small, explicit, newline-delimited
JSON protocol, and everything it is allowed to do is a scope a human approved by name.

Four consequences follow from that, and they explain most of the design:

**You describe UI, you do not render it.** A plugin sends a JSON `UINode` tree and the host draws it
with its own components. This is not a stylistic preference: the host page holds the session token,
so plugin JavaScript running in that page could call the API with *every* scope rather than the ones
it was granted. There is no escape hatch, which is a commitment rather than a limitation — it means
the vocabulary owes you enough that you never want one.

**You call a semantic API, not the byte-faithful mirror.** The mirror on `:7774` exists for
third-party apps that expect literal VRChat responses. Routing plugins through it would double rate
limit consumption for no benefit and weld the plugin API to VRChat's response shapes forever.

**The host is what runs anything expensive or dangerous.** Arbitrary network access does not exist as
a permission. What exists instead are two narrow host-executed capabilities: a webhook to a URL *the
user typed*, and a fetch allowlist of host-declared domains with no wildcards. Both are logged and
rate-limited, because the host is the one making the call. Both are validated in the manifest today
and neither is implemented.

**Anything other people can see is treated as more dangerous than anything they cannot.** Invites,
friend requests and moderation are visible to strangers and are how a plugin gets its user banned, so
they are dry-run by default and lifted only by an explicit, per-scope gesture.

## Where things live on disk

| Path | What |
|---|---|
| `<state>/plugins/<id>/<sha256>.js` | The installed artifact, named by its own hash and verified on load. Written by the install pipeline |
| `<state>/plugin-data/<id>/` | The plugin's own directory, its working directory, and on Windows its `TEMP`. Uninstall is `rm -rf`; the quota is a `stat` |
| `<state>/plugin-data/<id>/plugin.sqlite` | Its own database, so it cannot lock or corrupt the daemon's. **Storage is step 3.7 and this file does not exist yet** |
| `<state>/runtime/bun-<version>/bun[.exe]` | The pinned runtime plugin processes are spawned with. The fetcher exists; its hash pins ship empty, so today this resolves only from a source checkout |

`<state>` is the platform state directory, overridable in full with `VRCZIP_STATE_DIR`.

## A note on these docs

They are hand-written against the source rather than generated, which means they can drift. When a
page and the code disagree, the code is right and the page is a bug — `packages/plugin-api/src` is
the contract. Step 3.11 replaces the reference half of these pages with generated output for exactly
that reason.
