# Node model

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

This page covers the `nodes` module of `@vrcz/plugin-api`: `PORT_TYPES`, `assignable`,
`PortDefinition`, `NodeConfigField`, the body template, `NodeDefinition` and its two shapes, and
`nodeDefinitionHash`. All of that is real and tested today.

**Registering a node type with the host is not built** — it is step 3.10 in `PROGRESS.md`. You can
write a `NodeDefinition`, evaluate its body template and hash it right now; nothing will put it in
the graph editor's palette yet.

## What a node is for

vrc.zip's automation is a node graph — a Svelte Flow editor in the UI, a graph runtime in the daemon.
A plugin contributes node types to that graph: triggers that start a run, conditions that gate one,
and actions that do something.

One declarative `NodeDefinition` feeds **three** consumers — the editor, the runtime, and the type
checker that runs in both — so they cannot drift. Everything in a definition is data. The only
functions you supply are the handlers in `NodeRegistration`, and the editor never reads those.

Type checking happens twice on purpose: in the editor for instant red-edge feedback, and again in the
daemon on save and at each execution boundary, **because the frontend is a client and clients lie**.
Both calls land on the same `assignable`, which is why it is a pure function over two strings with no
host context at all.

## Port types

```ts
const PORT_TYPES = [
  "friend", "user", "world", "instance", "group", "avatar",
  "string", "number", "boolean", "json",
] as const;
```

Ten members, closed. Every one is something the runtime can actually carry between nodes and the
editor can label on an edge. **Domain types are ids with host-known meaning** — `user` is a user id,
not a user object — which is what lets your node accept a `user` from any producer without the two of
you agreeing on a payload shape.

Each absence is a decision, not an oversight:

- **No array or list types.** An `X[] <: json` rule plus an elementwise rule would double the lattice
  for a v1 that ships triggers only.
- **No `timestamp` distinct from `number`.** Timestamps are integer unix-ms everywhere in this
  project, so a separate type would refuse an edge the user is right to expect.
- **No `any`.** That is what `json` is, with the direction stated.

`isPortType(value)` is the runtime guard.

## The lattice: exactly two widening rules

`assignable(from, to)` answers "can a value of `from` flow into a port of `to`?" It is identity, plus:

1. **`friend <: user`** — a friend is a user you also have a relationship with, so anything that takes
   a user takes a friend. Not the reverse: a node that needs friendship (unfriend, favourite) must be
   able to refuse a stranger **at edit time** rather than at 3 AM.
2. **`X <: json`** — every type erases to JSON. Not the reverse: `json` into a typed port is the
   unchecked cast that makes a type system decorative, and the graph editor's whole value is telling
   the user *before* they save.

That is the whole list, and it stops there deliberately. **Every additional rule is an explanation you
owe a user whose edge just got refused.** A user who learns two rules can predict the entire matrix; a
user facing eight rules learns none of them and tries edges until one sticks.

### Compatibility matrix

Generated from `assignable`, which is the single source of truth — this table cannot describe a rule
that isn't implemented.

| from \ to | friend | user | world | instance | group | avatar | string | number | boolean | json |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **friend** | yes | yes | — | — | — | — | — | — | — | yes |
| **user** | — | yes | — | — | — | — | — | — | — | yes |
| **world** | — | — | yes | — | — | — | — | — | — | yes |
| **instance** | — | — | — | yes | — | — | — | — | — | yes |
| **group** | — | — | — | — | yes | — | — | — | — | yes |
| **avatar** | — | — | — | — | — | yes | — | — | — | yes |
| **string** | — | — | — | — | — | — | yes | — | — | yes |
| **number** | — | — | — | — | — | — | — | yes | — | yes |
| **boolean** | — | — | — | — | — | — | — | — | yes | yes |
| **json** | — | — | — | — | — | — | — | — | — | yes |

Note what the matrix says about your own design: `number` does not flow into `string`, and `string`
does not flow into `number`. If you want that, it is a conversion node, not a lattice rule.

## Ports

```ts
interface PortDefinition {
  readonly id: string;          // stable across versions — a saved edge references this, not the label
  readonly label: string;       // shown on the node body and the editor's edge tooltip
  readonly type: PortType;
  readonly required?: boolean;  // an input with no incoming edge and no default fails at save time
  readonly description?: string;
}
```

The `id`/`label` split is the whole point: rename a label freely, and every saved graph keeps working
(see [the hash](#nodedefinitionhash) below). Change an `id` and you have made a different port.

## Config

An inspector field is **not a `UINode`**. This is deliberate, and worth understanding before you go
looking for the `UINode` escape hatch:

A UI tree is a *rendering*. An inspector needs a *schema* — something that produces a typed value
keyed by field id, can be validated on save, is content-hashed into the graph, and can be migrated.
Reusing `UINode` here would mean reading values back out of a rendering, which is how you end up with
a form that means something different after a redesign. The host draws config fields with the same
components the [UI vocabulary](./ui.md) uses, so they look identical to a user regardless.

Seven kinds:

| `kind` | Extra props | Notes |
| --- | --- | --- |
| `text` | `placeholder?`, `default?: string`, `required?` | |
| `number` | `min?`, `max?`, `default?: number`, `required?` | |
| `boolean` | `default?: boolean` | No `required` — a boolean is always set. |
| `select` | `options` **required** `{ value, label }[]`, `default?: string`, `required?` | |
| `duration` | `default?: number`, `required?` | **Integer unix-ms**, like every duration and timestamp in this project. |
| `user` | `required?` | Host renders its own user picker. |
| `world` | `required?` | Host renders its own world picker. |

Every kind also carries `id`, `label` (both required) and `description?`.

A configured instance's values are `NodeConfigValues` — `Readonly<Record<string, string | number | boolean>>`,
keyed by field id.

```ts
const config: readonly NodeConfigField[] = [
  { kind: "user", id: "who", label: "Only this friend" },
  { kind: "duration", id: "debounce", label: "Ignore repeats within", default: 60_000 },
  {
    kind: "select",
    id: "transition",
    label: "Fire on",
    options: [
      { value: "online", label: "Coming online" },
      { value: "offline", label: "Going offline" },
    ],
    default: "online",
    required: true,
  },
];
```

## The body template

A node's body text is **data the host evaluates locally**, not an RPC into your plugin.

```ts
type NodeBodySegment =
  | { kind: "literal"; text: string }
  | { kind: "config"; field: string; fallback?: string }
  | { kind: "port"; port: string };
```

Segments are concatenated. `config` substitutes the instance's value for a field (or `fallback`, or
`""`, when unset); `port` renders the port's label, falling back to the port id when the port is not
found. Everything renders as text — same rule as the UI vocabulary, no markup anywhere.

**Why host-evaluated:** Svelte Flow re-renders on every pan and zoom. Per-frame RPC at 60Hz across a
process boundary is not viable, and a plugin that is busy, restarting, or disabled would leave blank
nodes scattered across the canvas. Evaluating a template means a saved graph draws correctly with
every plugin process dead.

`evaluateNodeBody(template, config, ports?)` is exported and is pure, synchronous, and takes no host
context — the editor calls it per frame, so it must stay that way. You can call it in your own tests:

```ts
const body: NodeBodyTemplate = [
  { kind: "literal", text: "when " },
  { kind: "config", field: "who", fallback: "any friend" },
  { kind: "literal", text: " comes online" },
];

evaluateNodeBody(body, { who: "usr_123" }); // "when usr_123 comes online"
evaluateNodeBody(body, {});                 // "when any friend comes online"
```

## Node definitions

Every definition carries `id`, `title`, `outputs`, and optionally `description`, `category`, `icon`,
`config`, `body`.

- `id` is unique **within your plugin**. The graph stores `<pluginId>/<id>`, so it may not change
  across an update without a migration.
- `category` groups the node in the editor's palette. Free text; the host buckets unknown ones.
- `icon` names an entry in the host's icon set — never a URL.

Beyond that there are exactly two shapes.

### Trigger inversion

**A trigger arms, it does not execute.** And the type shape makes an executing trigger
*unrepresentable* rather than merely discouraged.

`NodeDefinitionBase` in the two snippets below is internal and **not exported**, so these are the
shape rather than something to paste. It supplies the common fields listed above: `id`, `title`,
`description?`, `category?`, `icon?`, `config?`, `body?` and `outputs`.

```ts
interface TriggerNodeDefinition extends NodeDefinitionBase {
  readonly kind: "trigger";
  readonly maxFiresPerMinute?: number;
}

interface TriggerRegistration {
  readonly definition: TriggerNodeDefinition;
  arm(ctx: TriggerArmContext): void | Promise<void>;
  // Note the absence of `execute`. That absence is the invariant, not a gap.
}
```

Two structural facts follow from that:

- **A trigger has no `inputs`.** Nothing upstream can hand it a value; it is where a graph starts.
  `TriggerNodeDefinition` simply has no `inputs` member to fill in.
- **A trigger has no `execute` anywhere in its registration.** You cannot declare one that runs on
  demand, even by mistake.

The runtime tells you an instance is live with a given config; you hold whatever subscription you
need and call `fire()` when the world does something:

```ts
interface TriggerArmContext {
  readonly instanceId: string;   // identifies this armed instance for the life of the arming
  readonly graphId: string;
  readonly config: NodeConfigValues;
  fire(outputs: PortValues): void;      // starts one run of the graph downstream of this node
  onDisarm(handler: () => void): void;  // graph edited, paused, or plugin disabled — tear down here
}
```

The inversion matters because the alternative — the runtime polling your plugin to ask "did it happen
yet?" — is both wrong for events and a rate-limit hazard multiplied by every graph the user has
saved.

`maxFiresPerMinute` is how many times this trigger may fire before the host coalesces. A trigger
wired to `friend-location` is not a rare event, and a graph that runs 900 times on an instance
transition is spending **the user's** rate budget, not yours.

### Actions and conditions

Everything that runs when the graph reaches it. Conditions gate; actions do something. Both are
invoked with resolved inputs and return outputs, so **both have inputs** — the one structural
difference from a trigger.

```ts
interface ExecutableNodeDefinition extends NodeDefinitionBase {
  readonly kind: "action" | "condition";
  readonly inputs: readonly PortDefinition[];
}

interface ExecutableRegistration {
  readonly definition: ExecutableNodeDefinition;
  execute(inputs: PortValues, config: NodeConfigValues): PortValues | Promise<PortValues>;
}
```

`PortValues` is `Readonly<Record<string, unknown>>` — domain types carry the id, `json` carries
anything.

`isTriggerDefinition(def)` narrows a `NodeDefinition` for consumers that switch on the kind.

### A worked pair

```ts
import type { NodeDefinition } from "@vrcz/plugin-api";

const friendOnline: NodeDefinition = {
  kind: "trigger",
  id: "friend-online",
  title: "Friend comes online",
  description: "Fires when a friend's status goes from offline to online.",
  category: "Friends",
  icon: "user-check",
  maxFiresPerMinute: 60,
  config: [{ kind: "user", id: "who", label: "Only this friend" }],
  body: [
    { kind: "literal", text: "when " },
    { kind: "config", field: "who", fallback: "any friend" },
    { kind: "literal", text: " comes online" },
  ],
  outputs: [
    { id: "friend", label: "Friend", type: "friend", description: "who it was" },
    { id: "at", label: "Time", type: "number", description: "unix-ms" },
  ],
};

const writeNote: NodeDefinition = {
  kind: "action",
  id: "write-note",
  title: "Write a note",
  category: "Notes",
  config: [
    { kind: "text", id: "prefix", label: "Prefix", default: "seen", required: true },
    { kind: "boolean", id: "pin", label: "Pin the note", default: false },
  ],
  body: [
    { kind: "literal", text: "note on " },
    { kind: "port", port: "subject" },
  ],
  inputs: [
    { id: "subject", label: "User", type: "user", required: true },
    { id: "text", label: "Text", type: "string" },
  ],
  outputs: [{ id: "noteId", label: "Note", type: "string" }],
};
```

`friendOnline`'s `friend` output wires into `writeNote`'s `subject` input because `friend <: user`.
It would not wire the other way.

## `nodeDefinitionHash`

```ts
const hash = await nodeDefinitionHash(friendOnline); // 64 hex chars, SHA-256
```

The hash of a canonical form is written into every saved graph that uses your node. On load, a
definition whose hash differs is **not silently rewired** — the user is prompted to migrate, and until
they do the graph is paused and marked unavailable rather than deleted. Silently rewiring is how an
automation that sends invites starts sending them to the wrong person after an update.

### What it covers, and what it does not

| Covered — anything that can break a saved graph | Not covered — anything cosmetic |
| --- | --- |
| `id` | `title` |
| `kind` (a trigger that became an action is a different node) | `description` |
| every port's `id`, `type`, `required`, and which side it is on | `category`, `icon` |
| every config field's `id` and `kind` | port `label` and `description` |
| | config `label`, `description`, `options`, `default` |
| | the body template |

**Why the split matters to you:** fixing a typo in a label must not prompt every user with a saved
graph to migrate. A migration prompt that fires for nothing is a migration prompt people click
through — and then click through the one that mattered.

Three more properties, all tested:

- **Port order is not semantics.** Ports are sorted by id before hashing, so reordering arguments in
  your source file does not move the hash.
- **Key order in the source object is irrelevant by construction.** The canonical form is built in a
  fixed order rather than serializing whatever `Object.keys` returned.
- An input and an output sharing an id are **not** interchangeable — the side is part of the digest.

`canonicalNodeDefinition(def)` is exported too, and returns the string that gets digested. Use it when
you need to *show* what changed: diffing two canonical forms says "this node's ports changed" far
better than comparing two hashes.

The hash is async because `crypto.subtle` is the one digest available in all three places this runs:
the daemon, a plugin process, and the browser. A synchronous non-cryptographic hash was the
alternative and was passed over — a collision here means accepting an incompatible definition as
compatible, which is exactly the failure the hash exists to prevent.

## The manifest half

A `NodeDefinition` lives in your code, not in `vrcz-plugin.json`. The manifest's `contributes.nodes`
carries only `id`, `title`, and optional `category` and `description` — enough for grants, uninstall,
and "paused and marked unavailable" to have something stable to key on. `nodes.ts` says what each
node *is*; the install pipeline checks that the two lists match. See [manifest.md](./manifest.md).

## See also

- [ui.md](./ui.md) — the panel vocabulary, and why config fields are not `UINode`s.
- [manifest.md](./manifest.md) — declaring your node ids.
- [status.md](./status.md) — what is built and what is not.
