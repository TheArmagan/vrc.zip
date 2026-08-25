# Node model

> [!IMPORTANT]
> **Node types are real now.** A plugin registers one with `ctx.nodes.register`, the host holds it in
> the same registry its own built-in nodes live in, and Phase 4's graph runtime arms triggers and
> executes actions and conditions against it. What does not exist yet is the **canvas**: there is no
> visual editor to drag your node into, so a graph is built through the control API rather than by
> hand. That is step 4.5.
>
> Read [status.md](./status.md) for the line-by-line breakdown of what is real.

This page covers the `nodes` module of `@vrcz/plugin-api`: `PORT_TYPES`, `assignable`,
`PortDefinition`, `NodeConfigField`, the body template, `NodeDefinition` and its two shapes, and
`nodeDefinitionHash`. All of that is real and tested today.

Registering a node type **is** built: declare its id in `contributes.nodes`, call
`ctx.nodes.register` when your plugin activates, and the graph runtime can arm and execute it. The
palette that would let a user drag it onto a canvas is Phase 4's remaining step.

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
const BASE_PORT_TYPES = [
  "friend", "user", "world", "instance", "group", "avatar",
  "string", "number", "boolean", "json",
] as const;

// Each scalar also has a list form. `PORT_TYPES` is both halves, twenty in total.
type ListPortType = `list<${BasePortType}>`;   // list<friend>, list<string>, …
```

Ten scalars, closed, plus a `list<>` of each. Every one is something the runtime can actually carry
between nodes and the editor can label on an edge. **Domain types are ids with host-known meaning** —
`user` is a user id, not a user object — which is what lets your node accept a `user` from any
producer without the two of you agreeing on a payload shape.

Each absence is a decision, not an oversight:

- **No nesting.** `list<list<user>>` is not a port type. A graph that needs one wants a different
  node, and the depth would have to be legible on an edge label at a glance.
- **No `timestamp` distinct from `number`.** Timestamps are integer unix-ms everywhere in this
  project, so a separate type would refuse an edge the user is right to expect.
- **No `any`.** That is what `json` is, with the direction stated.

`isPortType(value)` is the runtime guard; `listElement(type)` gives a list's element type or null.

`portTypeLabel(type)` gives the name to **show a person**: `user` reads as `user id`, `list<user>`
as `list of user ids`. Use it anywhere a type reaches a human, and never parse it back — the wire
name is what `isPortType` takes, and only the display name is allowed to change. The editor shows it
in a port's hover title and in the node details panel, because a port labelled `User` with a bare
`user` badge beside it reads as a user *record*, and it has only ever been a `usr_…`.

## `category` groups your nodes in the palette

The editor groups the palette by category, not by owner — vrc.zip ships hundreds of built-in nodes
and one group called "Built in" would be useless. Your nodes group under **your plugin**, and under
your own categories within it: two nodes with `category: "Reading"` and two with
`category: "Writing"` appear as `acme.notes — Reading` and `acme.notes — Writing`.

Leave it unset and your nodes land in one group named after your plugin. The plugin id stays in the
group name whatever you call the category, for the same reason your panels sit under a `Plugins`
heading in the sidebar: a group called "Reading" with no owner attached would read as a feature of
vrc.zip, and your plugin is not vrc.zip.

The built-in categories, for reference, are `Triggers`, `Logic`, `Data`, `Lists`, `Values`,
`Send`, `Pipeline`, `VRChat`, `Me`, and one `API: <tag>` group per VRChat spec tag. **`VRChat` and
`Me` split on who the node acts on**: `VRChat` is everything aimed at somebody else — look a user
up, invite them, boop them — and `Me` is everything aimed at the user's own account: their status,
their friends list, their favourites, the group badge on their profile. It is a distinction worth
copying if your plugin does both, because it is the one a person checks before arming a graph.

## The lattice: exactly four widening rules

`assignable(from, to)` answers "can a value of `from` flow into a port of `to`?" It is identity, plus:

1. **`friend <: user`** — a friend is a user you also have a relationship with, so anything that takes
   a user takes a friend. Not the reverse: a node that needs friendship (unfriend, favourite) must be
   able to refuse a stranger **at edit time** rather than at 3 AM.
2. **`X <: json`** — every type erases to JSON, lists included. Not the reverse: `json` into a typed
   port is the unchecked cast that makes a type system decorative, and the graph editor's whole value
   is telling the user *before* they save.
3. **`list<A> <: list<B>` when `A <: B`** — lists widen exactly as their elements do, and no further.
   A list is never a scalar and a scalar is never a list, in either direction.
4. **`user <: string`, and the same for every other id type** — `user` is a user *id*, not a user
   object, and an id is a string. Not the reverse: a `string` cannot become a `user`, so "this port
   needs a person" still refuses a world id at edit time. The `A user` node is how you say a string
   really is one.

That is the whole list, and it stops there deliberately. **Every additional rule is an explanation you
owe a user whose edge just got refused.** Four rules still fit in a sentence each, and the last two are
the ones people already expect: lists widen as their elements do, and an id is text.

> This section said **two** rules until Phase 4. The third arrived with `foreach` and the list nodes,
> which needed *some* answer: the alternatives were a flat enumeration of `friendList` / `userList`
> that grows every time a scalar is added, or "a list is `json`", which hands back exactly the
> property the lattice exists to hold.
>
> The fourth arrived with the generated `(API)` nodes. Their path parameters used to be typed
> (`userId` was a `user`), which refused every id a graph had actually computed — a raw endpoint is
> where you end up holding a `string`. The parameters are plain `string` ports now, and this rule is
> what keeps a typed producer flowing into one.

### Compatibility matrix

Generated from `assignable`, which is the single source of truth — this table cannot describe a rule
that isn't implemented.

| from \ to | friend | user | world | instance | group | avatar | string | number | boolean | json |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **friend** | yes | yes | — | — | — | — | yes | — | — | yes |
| **user** | — | yes | — | — | — | — | yes | — | — | yes |
| **world** | — | — | yes | — | — | — | yes | — | — | yes |
| **instance** | — | — | — | yes | — | — | yes | — | — | yes |
| **group** | — | — | — | — | yes | — | yes | — | — | yes |
| **avatar** | — | — | — | — | — | yes | yes | — | — | yes |
| **string** | — | — | — | — | — | — | yes | — | — | yes |
| **number** | — | — | — | — | — | — | — | yes | — | yes |
| **boolean** | — | — | — | — | — | — | — | — | yes | yes |
| **json** | — | — | — | — | — | — | — | — | — | yes |

The list half is not drawn: read `list<A> -> list<B>` as `A -> B` in the table above, since rule 3 is
exactly that. `docs/generated/ports.md` is the generated copy, and it says the same in one line
rather than as a twenty-by-twenty grid.

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

Thirteen kinds:

| `kind` | Extra props | Notes |
| --- | --- | --- |
| `text` | `placeholder?`, `default?: string`, `required?` | |
| `number` | `min?`, `max?`, `default?: number`, `required?` | |
| `slider` | `min`, `max` **both required**, `step?`, `default?: number` | A number whose bounds are the interesting part. Use `number` when the value has a unit and no natural ceiling. |
| `boolean` | `default?: boolean` | No `required` — a boolean is always set. |
| `select` | `options` **required** `{ value, label }[]`, `default?: string`, `required?` | |
| `secret` | `placeholder?`, `required?` | Stored outside the graph. See below. |
| `duration` | `default?: number`, `required?` | **Integer unix-ms**, like every duration and timestamp in this project. |
| `user` | `required?` | Host renders its own user picker. |
| `world` | `required?` | Host renders its own world picker. |
| `account` | `required?` | Which of the user's accounts the node acts as. Host renders a picker over the signed-in accounts. |
| `buttons` | `max?`, `actions?: { value, label, argumentLabel?, placeholder?, reportsPress? }[]`, `default?: string` | A list of buttons, a row at a time. The value is JSON in a string. See below. |
| `fields` | `options` **required** `{ value, label, list? }[]`, `max?`, `default?: string` | A list of fields to pull out of a value, picked from a catalogue you declare. Each row claims an output slot. See below. |
| `paths` | `placeholder?`, `max?`, `default?: string` | The same rows with the path typed by hand, for a value nothing has a schema for. |
| `keys` | `placeholder?`, `max?`, `default?: string` | A list of keys, each claiming an **input** slot. The mirror of `paths`. See below. |
| `options` | `choices` **required** `{ value, label, argumentLabel?, placeholder?, group? }[]`, `max?`, `default?: string` | A list of options picked from a catalogue, each with a value where it takes one. Claims no ports. See below. |

Every kind also carries `id`, `label` (both required) and `description?`.

**Five kinds are repeatable — `buttons`, `fields`, `paths`, `keys`, `options` — and all five store a
JSON array in a string.** That is deliberate rather than a shortcut: a config value is `string | number | boolean` in
four places at once (the wire type, the definition hash, the secret substitution, the validator), and
widening it for one field would touch all four. The same trade `duration` makes by storing
milliseconds in a `number`.

For `buttons`, the host draws a row per button — a label, a select over the `actions` you declared,
and an argument box that appears only for an action whose entry names one.

Read it with `parseButtonRows(config.buttons)`, which answers `ButtonRow[]` and returns an empty list
for anything malformed. Never assume the string is well-formed: it is round-tripped through export,
hand-editing and import like every other config value.

**It keeps rows a running notification would not.** A row with a blank label, and a second row with
an id that is already taken, both come back from the parser — the host draws a text box for each of
those, and a row that vanished mid-keystroke would be unusable. Enforce what makes a *usable* button
in your handler: drop the unlabelled ones, and keep the first of any two sharing an id. A row's `id`
is what a press reports back, so it is the field a graph filters on; `reportsPress: false` on an
action tells the host not to ask for one, which is right for an action the platform handles without
waking you.

What the actions *mean* is yours. The host renders the labels and stores the choice; your handler
decides what each one does.

**`fields` and `paths` are the rows that decide what a node gives.** Each one names a path into an
incoming value and claims one output slot, which is the mechanism described under
[ports the author chooses](#ports-the-author-chooses). Read them with `parseSlotRows(config.fields)`:

```ts
interface SlotRow {
  readonly slot: string;   // the output port this row produces on
  readonly path: string;
  readonly label: string;  // blank means derive it
  readonly list: boolean;
}
```

The difference between the two kinds is only the control the host draws. `fields` renders a picker
over the `options` you declared, so it is the kind for a value with a schema behind it — a `list: true`
option tells the host the field holds several of something and the row belongs on a list slot.
`paths` renders a text box and a "several" checkbox, for a value nothing has a schema for.

`options` is **not hashed** (a definition is pinned by its config field *kinds*), so a catalogue that
grows does not mark every saved graph stale. `slotRowLabel(row)` gives a port's name: the author's
override, then the path's last segment, then the slot id.

**`keys` is the same row pointed the other way, and it decides what a node *takes*.** Each row is a
key and claims one input slot, which the host draws wearing that key — see
[`variadicInputSlots`](#ports-the-author-chooses). Read them with the same `parseSlotRows`, where
`row.path` is the key rather than a path, and name the port with `keyRowLabel(row)`: the author's
override, then the key **whole**, then the slot id. Whole, unlike `slotRowLabel`, because a key of
`user.name` means a field called exactly that rather than a route to a nested one. A row's `list` is
unused here.

**`options` is for a vocabulary somebody else defined**, where a checkbox per entry would be thirty
config fields and a text box would mean looking the spelling up every time. Each row picks from
`choices` and carries a value where the choice declares an `argumentLabel`; a choice without one is a
flag. `group` draws the picker under headings, which is what a catalogue assembled from two documents
wants. Read the rows with `parseOptionRows(config.options)`:

```ts
interface OptionRow {
  readonly option: string;  // the `value` of the choice, or something a newer build wrote
  readonly value: string;   // blank for a flag, or for a row nobody has filled in yet
}
```

It claims no ports, which is what separates it from `keys`: `MAX_NODE_PORTS` is sixteen and a
catalogue is usually longer, and most entries are flags with nothing for a wire to carry. **A row
naming an option this build has never heard of is kept**, because `choices` is not hashed — a graph
authored against a newer release names newer options, and dropping them silently would change what
the author asked for. Decide what to do with an unknown one where you read the rows.

In your handler, key the outputs by `row.slot` and read the **slot's declared type**, not the row's
`list` flag — the slot is what an edge is wired to and what the type check ran against, and a
round-tripped document can disagree with itself. A path that finds nothing should produce nothing on
that one port: the edges out of it are then dead and its branch skips, while every other slot flows.

**`account` stores an account id, and blank means "the graph's account".** That is the convention
every built-in follows and the reason the field is never `required`: a graph already has an account,
and a node that names one is the exception rather than the rule. The picker is a picker and not a
grant — the host re-checks the stored id against the accounts it actually manages when the node
runs, so a graph naming an account that has since been removed fails with a sentence rather than
quietly acting as somebody else.

**`secret` is the one whose value does not live in the graph.** A webhook URL, a topic, a token: the
host keeps it in the encrypted credential store, keyed by (graph, node, field), and substitutes it
into the config on its way to your handler. Your node reads `config.token` like any other field and
cannot tell the difference. What changes is everything around it — an exported or shared graph
cannot carry the value, there is no route that reads one back, and the substitution **overwrites**,
so a client that writes something into that key is ignored rather than trusted.

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
  readonly variadicInputs?: string;       // a config field saying how many inputs are in use
  readonly variadicInputsBase?: number;   // how many come before the variadic run
  readonly variadicInputsStride?: number; // how many ports one unit of the field claims
  readonly variadicInputSlots?: string;   // a `keys` field whose rows claim inputs by name
  readonly variadicInputSlotsBase?: number;
  readonly variadicOutputs?: string;      // a `fields` or `paths` field whose rows claim outputs
  readonly variadicOutputsBase?: number;
}

interface ExecutableRegistration {
  readonly definition: ExecutableNodeDefinition;
  execute(inputs: PortValues, config: NodeConfigValues): PortValues | Promise<PortValues>;
}
```

`PortValues` is `Readonly<Record<string, unknown>>` — domain types carry the id, `json` carries
anything.

`isTriggerDefinition(def)` narrows a `NodeDefinition` for consumers that switch on the kind.

### Ports the author chooses

**Every port a node will ever have is declared, always.** A node's ports are its identity: they are
hashed into `nodeDefinitionHash`, a saved edge references one by id, and the host checks every wire
against them. So a definition whose ports depend on an instance's config is a definition that is not
one thing, and there is no API for producing one. What the `variadic*` fields change is only
**which of the declared ports the editor draws**, and what they are called.

`variadicInputs` names a numeric (or `buttons`) config field saying how many inputs are in use,
counting from the first; `variadicInputsBase` is how many fixed inputs come before that run. This is
what lets a "compose text" node declare twenty-six slots and show three. `visibleInputCount(def,
config, wired)` and `visibleInputs(def, config, wired)` give the answer — and `wired` is a floor, so
**a port with an edge in it is never hidden**.

`variadicInputsStride` is how many declared ports one unit of that field claims, and it defaults to
one. A `buttons` field counts buttons rather than ports, and the desktop notification node gives each
of its buttons two: a label and an argument. Declare them interleaved (`button1`, `button1arg`,
`button2`, …), because the run is positional.

`variadicOutputs` names a `fields` or `paths` config field whose rows each **claim one output slot**
by id:

```ts
const EXTRACT: ExecutableNodeDefinition = {
  kind: "action",
  id: "extract",
  title: "Extract values",
  inputs: [{ id: "value", label: "From", type: "json", required: true }],
  // Two banks. A port has one type; a field holds one thing or several.
  outputs: [
    { id: "o1", label: "Value 1", type: "json" },
    { id: "o2", label: "Value 2", type: "json" },
    { id: "l1", label: "List 1", type: "list<json>" },
  ],
  variadicOutputs: "fields",
  config: [{ kind: "paths", id: "fields", label: "Values" }],
};

visibleOutputs(EXTRACT, { fields: '[{"slot":"l1","path":"tags","label":"Tags"}]' });
// -> [{ id: "l1", label: "Tags", type: "list<json>" }]
```

Claiming a **named** slot rather than counting from the first is not a style choice. Rows are added
and removed in the middle of the list; with a positional rule, deleting the first of six rows would
silently re-point the five wires below it at a different value — a graph that does something else
after an edit nobody thought was an edit.

Declare the slots in banks by type. Ten `json` and five `list<json>` is what the host's own
extractors use, and the list bank is what makes a field holding several of something arrive on a port
a `For each` will accept.

`variadicInputSlots` is the same mechanism on the other side: a `keys` field whose rows each claim one
**input** slot, drawn wearing the key. Use it where the ports are the author's own vocabulary rather
than a count — the host's `Compose JSON` is one port per key of the object it builds:

```ts
const COMPOSE: ExecutableNodeDefinition = {
  kind: "action",
  id: "compose-json",
  title: "Compose JSON",
  // One bank, all `json`: the object being built has no schema for a type check to be against.
  inputs: [
    { id: "v1", label: "Value 1", type: "json" },
    { id: "v2", label: "Value 2", type: "json" },
  ],
  outputs: [{ id: "value", label: "Object", type: "json" }],
  variadicInputSlots: "keys",
  config: [{ kind: "keys", id: "keys", label: "Keys" }],
};

visibleInputs(COMPOSE, { keys: '[{"slot":"v2","path":"displayName"}]' });
// -> [{ id: "v2", label: "displayName", type: "json" }]
```

`wired` here is the list of port **ids** with an edge rather than a count — position means nothing
when a row claims a slot by name — and it is the same floor: a port with a wire in it is drawn
whatever the rows say. A definition setting both input mechanisms is not a supported shape; this one
wins.

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
node *is*. Checking that the two lists agree is the install pipeline's job and **the pipeline does not
do it yet**, so today a node declared in the manifest and never registered is simply a node that
never appears. See [manifest.md](./manifest.md).

## See also

- [ui.md](./ui.md) — the panel vocabulary, and why config fields are not `UINode`s.
- [manifest.md](./manifest.md) — declaring your node ids.
- [status.md](./status.md) — what is built and what is not.
