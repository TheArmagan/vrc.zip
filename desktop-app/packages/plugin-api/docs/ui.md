# UI vocabulary

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

Everything on this page lives in `@vrcz/plugin-api`'s `ui` module: the `UINode` union, the `Intent`
shape, the caps, and `validateUINode`. Those types and that validator are real and tested today.
**The host-side renderer that turns a `UINode` into pixels is not built** — it is step 3.9 in
`PROGRESS.md`. You can write and validate a tree now; nothing will draw it yet.

## The model

A plugin runs in its own process. It never touches a DOM node. It builds a tree of plain JSON — a
`UINode` — and hands it to the host, which renders it with the app's own shadcn-svelte components.

Two more obvious designs were considered and rejected, and the reason matters to you because it is
what closes the door on the escape hatch you will eventually want:

- **Same-origin dynamic import of a plugin bundle.** Zero isolation. The host page holds the session
  token, so plugin JS running in that page can read it and call the control API with *every* scope,
  not just the ones the user granted you. Independently fatal: externally-compiled Svelte 5
  components must share `svelte/internal/client` with the host, which would weld every plugin in
  the ecosystem to one Svelte version forever.
- **Web components.** Shadow DOM encapsulates styles and DOM queries. It does not encapsulate JS, so
  it fixes nothing about the paragraph above.

So: a JSON tree, rendered by the host.

### There is no escape hatch

No iframe mode, no raw HTML node, no `style` field, no arbitrary image or font URL. This is a
commitment rather than a v1 limitation. An escape hatch that exists gets reached for by default, and
a security property that only holds for the plugins which declined to take the bypass is not a
property.

The price is ours, not yours: committing to no escape hatch means the vocabulary owes you enough
that wanting one never comes up. When you hit a genuine wall, **the answer is a new node type in the
host**, contributed upstream and available to every plugin — not a hole in the boundary for yours.

### The loop

```
host renders  →  user acts  →  host sends the plugin a UiIntentDispatch
              →  plugin updates its own state  →  plugin pushes a new tree  →  host diffs and re-renders
```

The host owns everything that must feel instant, because an intent round-trips to another process:
input echo, focus, hover, tab switching, table sort and filter, and optimistic `switch` state. You
see the result, not the keystroke.

The `ui` module deliberately does not import the RPC module. It describes the *shape* of a dispatch;
the envelope, request name, deadlines and correlation ids belong to
[protocol.md](./protocol.md). The dependency runs one way, so the vocabulary can be validated and
unit-tested with no transport at all.

## Handlers are ids, not functions

The tree crosses a process boundary as JSON, so a handler cannot be a closure. Every handler is an
`Intent`:

```ts
interface Intent {
  readonly name: string;                                        // your own id, echoed back verbatim
  readonly payload?: Readonly<Record<string, string | number | boolean>>;
}
```

The payload is flat scalars only, and that is on purpose: an intent exists to disambiguate *which*
thing was clicked, not to ship state. State lives in your plugin; the host is a renderer with no
memory of its own beyond transient form input.

What comes back:

```ts
interface UiIntentDispatch {
  readonly panelId: string;
  readonly intent: Intent;
  readonly formState: Readonly<Record<string, string | number | boolean>>;
}
```

`formState` carries the current value of every **named** control inside the nearest enclosing `form`,
so a submit does not need a round trip per keystroke. Handlers outside a form get `{}`.

`validateUINode` rejects a handler that is not an intent object, and rejects an intent with no
non-empty `name`. Writing `onClick: () => {}` fails with the message *"handler must be an intent
object carrying an intent id, not a value or function"* — usually a sign someone read these docs as
if this were a component library.

## Text is never markup

Every string in the tree — `text.value`, labels, headers, cell values, tooltips, `confirm` — renders
as a DOM **text node**. There is no node type whose content is interpreted as HTML, no `style`, no
raw URL for an image or a font. (An `<img>` pointing at a plugin-controlled host is a beacon leaking
"this user opened this panel.") Icons name an entry in the host's icon set; images are not in this
cut at all. A renderer that reaches for `innerHTML` on any field here is a bug in the host.

`markdown` is absent for the same reason: sanitizing untrusted markup is its own project.

## Common props

Any node may carry these — this is not a button-only privilege. A table row, a list item, a card, or
a piece of text can all be interactive.

| Prop | Type | Notes |
| --- | --- | --- |
| `key` | `string` | Diff key. Keyed diffing is what keeps input focus, scroll position and open dialogs stable when you replace the tree; without it a re-render steals the cursor mid-word. |
| `tooltip` | `string` | Plain text. |
| `disabled` | `boolean` | |
| `busy` | `boolean` | |
| `confirm` | `string` | Host shows this text in a confirmation before dispatching. |
| `keybinding` | `string` | Scoped to the panel while it holds focus, so a plugin cannot capture a global chord. |
| `onClick` | `Intent` | |
| `onDoubleClick` | `Intent` | |
| `onContextMenu` | `Intent \| MenuNode` | A menu rendered in place, or an intent. **Any other node type is rejected** — the validator says "a context menu node must be of type `menu`". |
| `onChange` | `Intent` | Inputs. |
| `onSubmit` | `Intent` | Forms. |
| `onSelect` | `Intent` | Table row, list item. |
| `onVisible` | `Intent` | Fires when the node scrolls into view — lazy load and infinite scroll, declaratively. |

## Node reference

The union is **closed**: 28 types, listed in `UI_NODE_TYPES`. An unknown `type` is rejected, never
rendered as a passthrough — a host that guessed would be an escape hatch by accident. Unknown
*properties* on a known node are ignored, so a plugin built against a newer protocol minor still
renders on an older host.

Required props are marked **required**; everything else is optional.

### Layout and structure

| Node | Props |
| --- | --- |
| `stack` | `children` **required** `UINode[]`; `direction` `"row" \| "col"`; `gap` number; `align` `"start" \| "center" \| "end" \| "stretch"`; `justify` `"start" \| "center" \| "end" \| "between"`; `wrap` boolean |
| `grid` | `children` **required** `UINode[]`; `columns` number (column count at the widest breakpoint — the host collapses it responsively); `gap` number |
| `card` | `children` **required** `UINode[]`; `title` string; `description` string; `footer` `UINode[]` |
| `scroll` | `children` **required** `UINode[]`; `maxHeight` number |
| `tabs` | `items` **required** `TabItem[]`; `value` string (the selected tab id) |
| `separator` | `orientation` `"horizontal" \| "vertical"` |

`TabItem` is `{ id: string; label: string; icon?: string; content: UINode }`. `id`, `label` and
`content` are all checked; `content` is a full node and counts toward depth.

```ts
const layout: UINode = {
  type: "card",
  title: "Recent instances",
  description: "Last 24 hours, across the accounts you granted.",
  children: [
    {
      type: "stack",
      direction: "row",
      gap: 2,
      align: "center",
      justify: "between",
      children: [
        { type: "text", value: "12 instances", variant: "muted" },
        { type: "button", label: "Refresh", variant: "ghost", onClick: { name: "list.refresh" } },
      ],
    },
    { type: "separator" },
    { type: "scroll", maxHeight: 320, children: [] },
  ],
};
```

### Content

| Node | Props |
| --- | --- |
| `text` | `value` **required** string; `variant` `"h1" \| "h2" \| "h3" \| "body" \| "muted" \| "code"`; `selectable` boolean |
| `badge` | `label` **required** string; `tone` |
| `icon` | `name` **required** string; `size` number |
| `alert` | `tone`; `title` string; `description` string |
| `empty` | `title` **required** string; `description` string; `icon` string |
| `skeleton` | `lines` number |

`tone` is `"neutral" | "info" | "success" | "warn" | "danger"` — semantic, resolved to theme tokens
by the host. There is no plugin-supplied colour anywhere in this vocabulary, which is what makes
plugin UI follow the app's light and dark themes for free.

`icon.name` names an entry in the host's icon set. An **unknown name renders a placeholder rather
than failing the tree**: the icon set moves with the app, and a plugin built against a newer host
should degrade, not break.

`empty` exists so every plugin's "nothing here yet" state looks like the app's.

```ts
const states: UINode = {
  type: "stack",
  direction: "col",
  gap: 3,
  children: [
    { type: "text", value: "Instance watcher", variant: "h2" },
    { type: "alert", tone: "warn", title: "Not signed in", description: "Sign in to resume watching." },
    { type: "badge", label: "3 new", tone: "info" },
    { type: "icon", name: "user-check", size: 16 },
    { type: "empty", title: "Nobody seen yet", description: "Join a world and come back.", icon: "users" },
    { type: "skeleton", lines: 3 },
  ],
};
```

### Domain references

**The pattern to lean on hardest.** You pass an id; the host renders the face, name, trust colour,
online state, and the standard context menu.

| Node | Props |
| --- | --- |
| `userRef` | `id` **required** string; `fallbackLabel` string; `size` `"sm" \| "md" \| "lg"` |
| `worldRef` | same |
| `groupRef` | same |
| `avatarRef` | same |
| `instanceRef` | same |

This is a privacy win as much as a consistency one: **you do not need `friends:read` just to draw a
face**, because you never see the fields. You name an id, and the host — which already has them —
does the drawing. `fallbackLabel` is shown while the host resolves the real name.

```ts
const who: UINode = {
  type: "userRef",
  id: "usr_8b5a...",
  fallbackLabel: "Loading…",
  size: "md",
  onClick: { name: "user.open", payload: { id: "usr_8b5a..." } },
};
```

### Form

| Node | Props |
| --- | --- |
| `form` | `children` **required** `UINode[]`; `submitLabel` string; `resetLabel` string |
| `field` | `label` **required** string; `control` **required** `UINode`; `description` string; `error` string; `required` boolean |
| `input` | `name` string; `variant` `"text" \| "number" \| "password" \| "search"`; `value` string; `placeholder` string; `maxLength` number; `debounceMs` number |
| `textarea` | `name` string; `value` string; `placeholder` string; `rows` number; `maxLength` number; `debounceMs` number |
| `select` | `options` **required** `SelectOption[]`; `name` string; `value` string; `placeholder` string |
| `switch` | `name` string; `checked` boolean; `label` string |
| `button` | `label` **required** string; `variant` `"default" \| "secondary" \| "outline" \| "ghost" \| "destructive"`; `icon` string; `submit` boolean |

`SelectOption` is `{ value: string; label: string; disabled?: boolean }`.

Four things worth knowing:

- **`name` is what puts a control into `formState`.** An anonymous input is legal, but invisible to a
  submit.
- **`input.variant`, not `input.type`** — `type` is the union discriminant, so the HTML input type had
  to be spelled differently. The host maps it.
- **`field.error` is set by you** after you validate a submit. The host does not invent one.
- **`debounceMs` is a declarative debounce on `onChange`**, so a keystroke is not a process round trip.
- `button.submit` submits the enclosing form, dispatching its `onSubmit` with the whole `formState`.

Note the input types PLAN.md's catalog lists that are **not in this cut**: `slider`, `checkbox`,
`radio`, `datePicker`, `colorPicker`, `combobox`, `userPicker`, `worldPicker`. A vocabulary member
the host cannot draw is a promise we have not kept, so the union tracks what is actually vendored
under `ui/src/lib/components/ui/`.

### Data display

| Node | Props |
| --- | --- |
| `table` | `columns` **required** `TableColumn[]`; `rows` **required** `TableRow[]`; `rowKey` **required** string; `sortBy` string; `sortDir` `"asc" \| "desc"`; `filterable` boolean; `empty` string |
| `list` | `items` **required** `ListItem[]`; `empty` string |

`TableColumn` is `{ id, header, cell?, width?, align?, sortable? }` — `id` keys into each row object,
`align` is `"left" | "right" | "center"`, and `cell` is one of:

`text`, `number`, `timestamp`, `boolean`, `badge`, `userRef`, `worldRef`, `groupRef`, `avatarRef`,
`instanceRef`.

The first five format a scalar; the `*Ref` kinds take an id out of the row and get the full
domain-reference treatment above.

`TableRow` is `Readonly<Record<string, JsonValue>>`, but the validator is stricter than that name
suggests:
**cell values must be string, number, boolean, or null.** Nested structure in a row would need a
nested renderer, which is what columns are for.

`rowKey` names the column whose value identifies a row — it is the diff key, and what `onSelect`
reports.

`ListItem` is `{ key, title, subtitle?, badge?, icon?, onSelect? }`; `key` and `title` are checked as
strings.

#### Why table rows are data, not nodes

This is the single most load-bearing shape decision in the vocabulary. Cells are described **once per
column** instead of once per cell, so:

- a ten-thousand-row table costs **one node** against the 2000-node budget;
- the host can virtualize it and render only the visible window;
- friend lists, which get long, are expressible at all.

Rows are still validated, and still capped (`MAX_TABLE_ROWS`) — they are just not charged to the node
budget.

```ts
const seen: UINode = {
  type: "table",
  rowKey: "id",
  filterable: true,
  sortBy: "seen",
  sortDir: "desc",
  empty: "Nobody seen yet.",
  columns: [
    { id: "id", header: "User", cell: "userRef", sortable: true },
    { id: "seen", header: "Last seen", cell: "timestamp", align: "right", sortable: true },
    { id: "count", header: "Visits", cell: "number", align: "right" },
  ],
  rows: [
    { id: "usr_1", seen: 1_700_000_000_000, count: 3 },
    { id: "usr_2", seen: 1_700_000_100_000, count: 1 },
  ],
  onSelect: { name: "row.open" },
};
```

### Overlay

| Node | Props |
| --- | --- |
| `dialog` | `open` **required** boolean; `title` **required** string; `description` string; `children` `UINode[]`; `actions` `UINode[]`; `onClose` `Intent` |
| `menu` | `items` **required** `MenuItem[]`; `trigger` `UINode` |

**You own the dialog's openness.** The host reports a dismissal via `onClose` and changes nothing on
its own — so a dialog stays open until your next tree says otherwise.

`MenuItem` is `{ label, icon?, intent?, disabled?, danger?, separatorBefore?, items? }`. Menu items
are **not nodes**: a menu is a flat, closed shape, and letting arbitrary nodes inside one buys
nothing but a second layout engine. `items` nests for submenus. `separatorBefore` draws a rule above
the item.

`trigger` is what opens the menu when it is used as a dropdown; omit it when the menu is the value of
an `onContextMenu`.

```ts
const rowMenu: MenuNode = {
  type: "menu",
  items: [
    { label: "Open profile", icon: "user", intent: { name: "row.open" } },
    { label: "Forget", danger: true, separatorBefore: true, intent: { name: "row.forget" } },
  ],
};
```

## Caps

A tree that exceeds any cap is **rejected whole**. Truncating would render a panel you never wrote,
which is worse than an error you can read.

| Cap | Value | Why it exists |
| --- | --- | --- |
| `MAX_UI_DEPTH` | `32` | The host walks and renders this tree eagerly and synchronously on its own main thread; unbounded depth is a stack, and a cheap denial of service. |
| `MAX_UI_NODES` | `2000` | Total nodes — the render cost ceiling. **Menu items, select options, list items and table columns each count**, because building one costs the host what building a node costs. Table *rows* do not. |
| `MAX_UI_STRING` | `4096` | Any single string, including intent names and payload strings. Long enough for prose, short enough that 2000 of them are not a heap. |
| `MAX_TABLE_ROWS` | `10_000` | Rows are data, not nodes, so they escape the node cap and need a ceiling of their own. Set well above it because friend lists get long. |
| `MAX_UI_ISSUES` | `50` | Validation stops collecting past this point. A malformed tree can produce thousands of issues, and an error list nobody can read is not an error message. |

These are not friction to be negotiated away later. They are the only thing standing between a
hostile or merely buggy plugin and a host-side denial of service.

## Validating

```ts
import { validateUINode, type UiValidation } from "@vrcz/plugin-api";

const result: UiValidation = validateUINode(tree);
if (!result.ok) {
  for (const issue of result.issues) console.error(issue.path, issue.message);
}
```

`validateUINode` returns a **result, never a throw** — the tree arrives from an untrusted process
over a wire, so a malformed one is an expected input on a normal code path. A throw would be a bug in
the validator.

Issue paths are dotted from the root and deep enough to find the offending node:
`$.children[1].options[0].value`.

Run it in your own tests. The host will run it on everything you send regardless, but finding the
issue in your test suite is cheaper than finding it in a log line naming your plugin.

## Charts are deliberately out of this cut

PLAN.md's catalog lists `chart` as first-class, and PROGRESS.md decision 110 holds it back on
purpose. Charts were the one legitimate argument for the iframe escape hatch that was cut, so
shipping them badly reopens a decision that is otherwise closed.

**The first plugin genuinely blocked on a chart is the signal to build them properly.** If that is
you, open an issue — that is the intended path, not a workaround. Nothing in this vocabulary is
shaped to make charts easier to bolt on later; a chart is declarative data plus an encoding spec, and
it will arrive as its own node type like every other addition.

## A complete settings panel

This validates. Every prop below is real.

```ts
import type { UINode } from "@vrcz/plugin-api";

const panel: UINode = {
  type: "stack",
  direction: "col",
  gap: 4,
  children: [
    { type: "text", value: "Friend notes", variant: "h2" },
    {
      type: "alert",
      tone: "info",
      title: "Notes are local",
      description: "Nothing here leaves your machine.",
    },
    {
      type: "card",
      title: "Settings",
      description: "Applies to the accounts you granted at install.",
      children: [
        {
          type: "form",
          submitLabel: "Save",
          resetLabel: "Revert",
          onSubmit: { name: "settings.save" },
          children: [
            {
              type: "field",
              label: "Note prefix",
              description: "Prepended to every note this plugin writes.",
              required: true,
              control: {
                type: "input",
                name: "prefix",
                variant: "text",
                value: "",
                placeholder: "met at",
                maxLength: 64,
                debounceMs: 200,
                onChange: { name: "settings.touch", payload: { field: "prefix" } },
              },
            },
            {
              type: "field",
              label: "Write a note when",
              control: {
                type: "select",
                name: "trigger",
                value: "first-meet",
                placeholder: "Pick an event",
                options: [
                  { value: "first-meet", label: "I meet someone for the first time" },
                  { value: "every-join", label: "Anyone joins my instance" },
                  { value: "never", label: "Never — I write them myself", disabled: false },
                ],
              },
            },
            {
              type: "field",
              label: "Enabled",
              control: { type: "switch", name: "enabled", checked: true, label: "Watch instances" },
            },
            {
              type: "stack",
              direction: "row",
              gap: 2,
              justify: "end",
              children: [
                { type: "button", label: "Save", variant: "default", submit: true },
                {
                  type: "button",
                  label: "Delete all notes",
                  variant: "destructive",
                  confirm: "Delete every note? This cannot be undone.",
                  onClick: { name: "notes.clear" },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "card",
      title: "Notes",
      children: [
        {
          type: "table",
          rowKey: "id",
          filterable: true,
          sortBy: "updated",
          sortDir: "desc",
          empty: "No notes yet.",
          columns: [
            { id: "id", header: "User", cell: "userRef", sortable: true },
            { id: "note", header: "Note", cell: "text", width: 320 },
            { id: "updated", header: "Updated", cell: "timestamp", align: "right", sortable: true },
            { id: "pinned", header: "Pinned", cell: "boolean", align: "center" },
          ],
          rows: [
            { id: "usr_1", note: "met at Just B Club", updated: 1_700_000_000_000, pinned: true },
            { id: "usr_2", note: "avatar creator", updated: 1_700_000_100_000, pinned: false },
            { id: "usr_3", note: null, updated: 1_700_000_200_000, pinned: false },
          ],
          onSelect: { name: "note.open" },
          onContextMenu: {
            type: "menu",
            items: [
              { label: "Open profile", icon: "user", intent: { name: "note.openProfile" } },
              { label: "Pin", icon: "pin", intent: { name: "note.pin" } },
              {
                label: "Delete",
                danger: true,
                separatorBefore: true,
                intent: { name: "note.delete" },
              },
            ],
          },
        },
      ],
      footer: [{ type: "text", value: "Stored in this plugin's own database.", variant: "muted" }],
    },
    {
      type: "dialog",
      key: "confirm-delete",
      open: false,
      title: "Delete this note?",
      description: "The note is removed from this plugin's storage.",
      children: [{ type: "text", value: "This cannot be undone.", variant: "muted" }],
      actions: [
        { type: "button", label: "Cancel", variant: "outline", onClick: { name: "dialog.close" } },
        { type: "button", label: "Delete", variant: "destructive", onClick: { name: "note.delete" } },
      ],
      onClose: { name: "dialog.close" },
    },
  ],
};
```

## See also

- [nodes.md](./nodes.md) — the node model for graph automation, which uses a typed config schema
  rather than a `UINode` tree, and why.
- [protocol.md](./protocol.md) — how a tree and an intent actually cross the process boundary.
- [status.md](./status.md) — what is built and what is not.
