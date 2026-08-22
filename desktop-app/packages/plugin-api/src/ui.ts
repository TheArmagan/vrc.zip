/**
 * The declarative UI vocabulary: a JSON `UINode` tree that host shadcn components render.
 *
 * PLAN.md §Phase 3 "UI: declarative schema rendered by host components" rejected the two obvious
 * alternatives and this file is what is left. Same-origin dynamic import of a plugin bundle has zero
 * isolation — the host page holds the session token, so plugin JS in that page can call the control
 * API with *every* scope — and it would weld the whole plugin ecosystem to one Svelte version
 * forever, because externally-compiled Svelte 5 components must share `svelte/internal/client` with
 * the host. Web components fix neither: shadow DOM encapsulates styles and DOM queries, not JS.
 *
 * So the plugin never touches a DOM node. It sends a tree of plain JSON and the host renders it.
 *
 * **There is no escape hatch, and that is a commitment, not a limitation** (PLAN.md §Phase 3). An
 * escape hatch that exists gets reached for by default, and the security property would only hold
 * for the plugins that declined to take it — which makes it not a property. The price is that we owe
 * plugin authors a vocabulary rich enough that wanting one never comes up. When an author hits a
 * genuine wall the answer is a new node type here, contributed upstream and available to everyone.
 *
 * ## Scope of this cut
 *
 * Forms, virtualized tables, dialogs, context menus, and per-node click handlers — PROGRESS.md
 * decision 110. That covers what a settings-and-list plugin needs, which is most of them.
 *
 * **Charts are deliberately not in this cut.** They were the one legitimate argument for the iframe
 * escape hatch that was cut, so shipping them badly reopens a decision that is otherwise closed. A
 * `chart` node lands when the first plugin is genuinely blocked on one; that plugin is the signal.
 * Nothing here should be shaped to make charts easier to bolt on later — a chart is declarative data
 * plus an encoding spec, and it will arrive as its own node type like every other addition.
 *
 * Also absent on purpose: `markdown` (sanitizing untrusted markup is its own project, and this cut
 * has no node that renders anything as markup at all — see below), and the input types with no
 * vendored host component behind them yet (`slider`, `checkbox`, `radio`, `datePicker`,
 * `colorPicker`). A vocabulary member the host cannot draw is a promise to plugin authors we have
 * not kept, so the union tracks `ui/src/lib/components/ui/`.
 *
 * ## Text is never markup
 *
 * Every string in this tree — `text.value`, labels, headers, cell values, tooltips — is rendered as
 * a DOM **text node**, never as HTML. There is no node type whose content is interpreted as markup,
 * no `style`, no raw URL for an image or a font (an `<img>` at a plugin-controlled host is a beacon
 * leaking "this user opened this panel"). Icons name an entry in the host's icon set; images are not
 * in this cut at all. A renderer that reaches for `innerHTML` for any field here is a bug.
 *
 * ## Handlers are ids, not functions
 *
 * The tree crosses a process boundary, so a handler cannot be a closure. Every handler is an
 * {@link Intent}: a `name` the plugin chose, plus a small flat payload. The host renders, the user
 * acts, the host sends the plugin a {@link UiIntentDispatch}, the plugin updates its own state and
 * pushes a new tree. This file describes the *shape* of that dispatch and deliberately does not
 * import the RPC module that carries it — the envelope, request name, deadlines, and correlation ids
 * belong to `protocol.ts`, which may import this file. The dependency runs one way only, so that the
 * UI vocabulary can be validated and unit-tested without a transport.
 */

import type { JsonValue } from "@vrcz/shared";

/* -------------------------------------------------------------------------------------------- */
/* Intents                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** A payload value. Flat scalars only: an intent is a signal, not a data channel. */
export type IntentPayloadValue = string | number | boolean;

/**
 * What a handler is. `name` is the plugin's own identifier for the action, echoed back verbatim.
 *
 * The payload is flat and scalar because it exists to disambiguate *which* thing was clicked, not to
 * ship state. State lives in the plugin; the host is a renderer with no memory of its own beyond
 * transient form input.
 */
export interface Intent {
  readonly name: string;
  readonly payload?: Readonly<Record<string, IntentPayloadValue>>;
}

/**
 * The message the host sends the plugin when a handler fires — the seam to `protocol.ts`.
 *
 * `formState` carries the *current* value of every named control inside the nearest enclosing
 * `form`, so a submit does not need a round trip per keystroke. Handlers outside a form get `{}`.
 * The host, not the plugin, owns input echo, focus, hover, tab switching, table sort and filter, and
 * optimistic `switch` state: those must feel instant and an intent round-trips to another process.
 */
export interface UiIntentDispatch {
  readonly panelId: string;
  readonly intent: Intent;
  readonly formState: Readonly<Record<string, IntentPayloadValue>>;
}

/* -------------------------------------------------------------------------------------------- */
/* Limits                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * The caps. These are not friction to be negotiated away later — they are the only thing standing
 * between a hostile or merely buggy plugin and a host-side denial of service, because the host
 * renders this tree eagerly and synchronously on its own main thread.
 *
 * A tree that exceeds any cap is rejected whole. Truncating would render a panel the author never
 * wrote, which is worse than an error the author can read.
 */
export const MAX_UI_DEPTH = 32;
/** Total nodes, counting menu items — a menu is as expensive to build as a node. */
export const MAX_UI_NODES = 2000;
/** Any single string. Long enough for prose, short enough that 2000 of them are not a heap. */
export const MAX_UI_STRING = 4096;
/**
 * Table rows are data, not nodes (see {@link TableNode}), so they need their own ceiling. Friend
 * lists get long, hence a limit well above the node cap.
 */
export const MAX_TABLE_ROWS = 10_000;
/** Stop collecting issues past this point; a malformed tree can produce thousands. */
export const MAX_UI_ISSUES = 50;

/* -------------------------------------------------------------------------------------------- */
/* Common props                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Handlers and state that any node may carry — PLAN.md is explicit that this is not a button-only
 * privilege. A table row, a list item, a card, or a piece of text can all be interactive.
 */
export interface UiCommon {
  /**
   * Diff key. Keyed diffing is what keeps input focus, scroll position, and open dialogs stable
   * when the plugin replaces the tree; without it a re-render steals the cursor mid-word.
   */
  readonly key?: string;
  readonly tooltip?: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  /** Host shows this text in a confirmation before dispatching. Plain text, never markup. */
  readonly confirm?: string;
  /** Scoped to the panel while it holds focus, so a plugin cannot capture a global chord. */
  readonly keybinding?: string;

  readonly onClick?: Intent;
  readonly onDoubleClick?: Intent;
  /** An intent, or a menu to render in place. Any other node type is rejected. */
  readonly onContextMenu?: Intent | MenuNode;
  readonly onChange?: Intent;
  readonly onSubmit?: Intent;
  readonly onSelect?: Intent;
  /** Fires when the node scrolls into view — lazy load and infinite scroll, declaratively. */
  readonly onVisible?: Intent;
}

/* -------------------------------------------------------------------------------------------- */
/* The union                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * Every node type, as a value, so the spec table below is exhaustive by construction: a member added
 * here with no entry in `NODE_FIELDS` is a compile error rather than a runtime surprise.
 */
export const UI_NODE_TYPES = [
  // Layout and structure
  "stack",
  "grid",
  "card",
  "scroll",
  "tabs",
  "separator",
  // Content
  "text",
  "badge",
  "icon",
  "alert",
  "empty",
  "skeleton",
  // Domain references — the pattern to lean on hardest
  "userRef",
  "worldRef",
  "groupRef",
  "avatarRef",
  "instanceRef",
  // Input
  "form",
  "field",
  "input",
  "textarea",
  "select",
  "switch",
  "button",
  // Data display
  "table",
  "list",
  // Overlay
  "dialog",
  "menu",
] as const;

export type UINodeType = (typeof UI_NODE_TYPES)[number];

/** Row or column direction with the usual box knobs. */
export interface StackNode extends UiCommon {
  readonly type: "stack";
  readonly direction?: "row" | "col";
  readonly gap?: number;
  readonly align?: "start" | "center" | "end" | "stretch";
  readonly justify?: "start" | "center" | "end" | "between";
  readonly wrap?: boolean;
  readonly children: readonly UINode[];
}

export interface GridNode extends UiCommon {
  readonly type: "grid";
  /** Column count at the widest breakpoint; the host collapses it responsively. */
  readonly columns?: number;
  readonly gap?: number;
  readonly children: readonly UINode[];
}

export interface CardNode extends UiCommon {
  readonly type: "card";
  readonly title?: string;
  readonly description?: string;
  readonly children: readonly UINode[];
  readonly footer?: readonly UINode[];
}

export interface ScrollNode extends UiCommon {
  readonly type: "scroll";
  readonly maxHeight?: number;
  readonly children: readonly UINode[];
}

export interface TabsNode extends UiCommon {
  readonly type: "tabs";
  readonly value?: string;
  readonly items: readonly TabItem[];
}

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly content: UINode;
}

export interface SeparatorNode extends UiCommon {
  readonly type: "separator";
  readonly orientation?: "horizontal" | "vertical";
}

export interface TextNode extends UiCommon {
  readonly type: "text";
  /** Rendered as a text node. Never parsed, never markup. */
  readonly value: string;
  readonly variant?: "h1" | "h2" | "h3" | "body" | "muted" | "code";
  readonly selectable?: boolean;
}

export interface BadgeNode extends UiCommon {
  readonly type: "badge";
  readonly label: string;
  readonly tone?: Tone;
}

/** Semantic tone, resolved to theme tokens by the host — never a plugin-supplied colour. */
export type Tone = "neutral" | "info" | "success" | "warn" | "danger";

export interface IconNode extends UiCommon {
  readonly type: "icon";
  /**
   * A name in the host's icon set. Unknown names render a placeholder rather than failing the tree:
   * the set moves with the app, and a plugin built against a newer host should degrade, not break.
   */
  readonly name: string;
  readonly size?: number;
}

export interface AlertNode extends UiCommon {
  readonly type: "alert";
  readonly tone?: Tone;
  readonly title?: string;
  readonly description?: string;
}

/** The "nothing here yet" state, so every plugin's empty list looks like the app's. */
export interface EmptyNode extends UiCommon {
  readonly type: "empty";
  readonly title: string;
  readonly description?: string;
  readonly icon?: string;
}

export interface SkeletonNode extends UiCommon {
  readonly type: "skeleton";
  readonly lines?: number;
}

/**
 * Domain references. The plugin passes an id; the host renders the face, name, trust colour, online
 * state, and the standard context menu.
 *
 * This is the pattern to lean on hardest, and it is a privacy win as much as a consistency one: a
 * plugin does not need `friends:read` just to draw a face, because it never sees the fields — it
 * names an id and the host, which already has them, does the drawing.
 */
export interface RefNodeBase extends UiCommon {
  readonly id: string;
  /** Falls back to the id while the host resolves the real name. */
  readonly fallbackLabel?: string;
  readonly size?: "sm" | "md" | "lg";
}
export interface UserRefNode extends RefNodeBase {
  readonly type: "userRef";
}
export interface WorldRefNode extends RefNodeBase {
  readonly type: "worldRef";
}
export interface GroupRefNode extends RefNodeBase {
  readonly type: "groupRef";
}
export interface AvatarRefNode extends RefNodeBase {
  readonly type: "avatarRef";
}
export interface InstanceRefNode extends RefNodeBase {
  readonly type: "instanceRef";
}

export interface FormNode extends UiCommon {
  readonly type: "form";
  readonly children: readonly UINode[];
  readonly submitLabel?: string;
  readonly resetLabel?: string;
}

/** Label + control + description + validation message, laid out the way the rest of the app does. */
export interface FieldNode extends UiCommon {
  readonly type: "field";
  readonly label: string;
  readonly description?: string;
  /** Set by the plugin after it validates a submit; the host does not invent one. */
  readonly error?: string;
  readonly required?: boolean;
  readonly control: UINode;
}

export interface InputNode extends UiCommon {
  readonly type: "input";
  /** Name in `formState`. Anonymous inputs are legal but invisible to submit. */
  readonly name?: string;
  /**
   * Named `variant`, not `type`, because `type` is the union discriminant. The host maps it to the
   * HTML input type.
   */
  readonly variant?: "text" | "number" | "password" | "search";
  readonly value?: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
  /** Declarative debounce on `onChange`, so a keystroke is not a process round trip. */
  readonly debounceMs?: number;
}

export interface TextareaNode extends UiCommon {
  readonly type: "textarea";
  readonly name?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly maxLength?: number;
  readonly debounceMs?: number;
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectNode extends UiCommon {
  readonly type: "select";
  readonly name?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly options: readonly SelectOption[];
}

export interface SwitchNode extends UiCommon {
  readonly type: "switch";
  readonly name?: string;
  readonly checked?: boolean;
  readonly label?: string;
}

export interface ButtonNode extends UiCommon {
  readonly type: "button";
  readonly label: string;
  readonly variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  readonly icon?: string;
  /** Submits the enclosing form, dispatching its `onSubmit` with the whole `formState`. */
  readonly submit?: boolean;
}

/**
 * How a cell is drawn. `text`/`number`/`timestamp`/`boolean`/`badge` format a scalar; the `*Ref`
 * kinds take an id and get the full domain-reference treatment above.
 */
export type TableCellKind =
  | "text"
  | "number"
  | "timestamp"
  | "boolean"
  | "badge"
  | "userRef"
  | "worldRef"
  | "groupRef"
  | "avatarRef"
  | "instanceRef";

export interface TableColumn {
  /** Key into each row object. */
  readonly id: string;
  readonly header: string;
  readonly cell?: TableCellKind;
  readonly width?: number;
  readonly align?: "left" | "right" | "center";
  readonly sortable?: boolean;
}

/**
 * Rows are **data, not nodes**, and that is the whole reason a table can be virtualized and can hold
 * ten thousand friends inside a 2000-node budget. Cells are described once per column instead of
 * once per cell, so the tree stays small and the host renders only the visible window.
 */
export type TableRow = Readonly<Record<string, JsonValue>>;

export interface TableNode extends UiCommon {
  readonly type: "table";
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  /** Column id whose value identifies a row — the diff key, and what `onSelect` reports. */
  readonly rowKey: string;
  readonly sortBy?: string;
  readonly sortDir?: "asc" | "desc";
  /** Host-side filtering: instant, no round trip. */
  readonly filterable?: boolean;
  readonly empty?: string;
}

export interface ListItem {
  readonly key: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly badge?: string;
  readonly icon?: string;
  readonly onSelect?: Intent;
}

export interface ListNode extends UiCommon {
  readonly type: "list";
  readonly items: readonly ListItem[];
  readonly empty?: string;
}

export interface DialogNode extends UiCommon {
  readonly type: "dialog";
  /** The plugin owns openness. The host reports a dismissal via `onClose` and changes nothing. */
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly children?: readonly UINode[];
  readonly actions?: readonly UINode[];
  readonly onClose?: Intent;
}

/**
 * Menu items are not nodes — a menu is a flat, closed shape, and letting arbitrary nodes inside one
 * buys nothing but a second layout engine. Items still count against the node budget, because
 * building one costs the host the same as building a node.
 */
export interface MenuItem {
  readonly label: string;
  readonly icon?: string;
  readonly intent?: Intent;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  /** A rule above this item. */
  readonly separatorBefore?: boolean;
  readonly items?: readonly MenuItem[];
}

export interface MenuNode extends UiCommon {
  readonly type: "menu";
  readonly items: readonly MenuItem[];
  /** What opens the menu when it is used as a dropdown. Omitted when used as a context menu. */
  readonly trigger?: UINode;
}

/** The closed union. Adding a member means adding a host renderer — there is no fallback node. */
export type UINode =
  | StackNode
  | GridNode
  | CardNode
  | ScrollNode
  | TabsNode
  | SeparatorNode
  | TextNode
  | BadgeNode
  | IconNode
  | AlertNode
  | EmptyNode
  | SkeletonNode
  | UserRefNode
  | WorldRefNode
  | GroupRefNode
  | AvatarRefNode
  | InstanceRefNode
  | FormNode
  | FieldNode
  | InputNode
  | TextareaNode
  | SelectNode
  | SwitchNode
  | ButtonNode
  | TableNode
  | ListNode
  | DialogNode
  | MenuNode;

/* -------------------------------------------------------------------------------------------- */
/* Validation                                                                                     */
/* -------------------------------------------------------------------------------------------- */

export interface UiIssue {
  /** Dotted path from the root, e.g. `children[2].control.options[0].value`. */
  readonly path: string;
  readonly message: string;
}

/**
 * A result, never a throw. The tree arrives from an untrusted process over a wire, so a malformed
 * one is an expected input on a normal code path — the host answers it with a rendered error and a
 * log line naming the plugin, not with an exception unwinding a render.
 */
export type UiValidation =
  | { readonly ok: true; readonly node: UINode }
  | {
      readonly ok: false;
      readonly issues: readonly UiIssue[];
    };

/**
 * Field specs. The union above is the contract for plugin authors written in TypeScript; this table
 * is the same contract enforced at runtime for everyone else. `Record<UINodeType, …>` keeps them
 * from drifting in one direction (a missing node type is a compile error); a test walks a realistic
 * tree to catch drift in the other.
 */
type FieldSpec =
  | { readonly kind: "string"; readonly required?: boolean; readonly oneOf?: readonly string[] }
  | { readonly kind: "number"; readonly required?: boolean }
  | { readonly kind: "boolean"; readonly required?: boolean }
  | { readonly kind: "node"; readonly required?: boolean }
  | { readonly kind: "nodes"; readonly required?: boolean }
  | { readonly kind: "intent" }
  | { readonly kind: "menuOrIntent" }
  | { readonly kind: "menuItems"; readonly required?: boolean }
  | { readonly kind: "tabs"; readonly required?: boolean }
  | { readonly kind: "options"; readonly required?: boolean }
  | { readonly kind: "listItems"; readonly required?: boolean }
  | { readonly kind: "columns"; readonly required?: boolean }
  | { readonly kind: "rows"; readonly required?: boolean };

const COMMON_FIELDS: Readonly<Record<string, FieldSpec>> = {
  key: { kind: "string" },
  tooltip: { kind: "string" },
  disabled: { kind: "boolean" },
  busy: { kind: "boolean" },
  confirm: { kind: "string" },
  keybinding: { kind: "string" },
  onClick: { kind: "intent" },
  onDoubleClick: { kind: "intent" },
  onContextMenu: { kind: "menuOrIntent" },
  onChange: { kind: "intent" },
  onSubmit: { kind: "intent" },
  onSelect: { kind: "intent" },
  onVisible: { kind: "intent" },
};

const TONES: readonly string[] = ["neutral", "info", "success", "warn", "danger"];

const TABLE_CELL_KINDS: readonly string[] = [
  "text",
  "number",
  "timestamp",
  "boolean",
  "badge",
  "userRef",
  "worldRef",
  "groupRef",
  "avatarRef",
  "instanceRef",
];

const REF_FIELDS: Readonly<Record<string, FieldSpec>> = {
  id: { kind: "string", required: true },
  fallbackLabel: { kind: "string" },
  size: { kind: "string", oneOf: ["sm", "md", "lg"] },
};

const NODE_FIELDS: Readonly<Record<UINodeType, Readonly<Record<string, FieldSpec>>>> = {
  stack: {
    direction: { kind: "string", oneOf: ["row", "col"] },
    gap: { kind: "number" },
    align: { kind: "string", oneOf: ["start", "center", "end", "stretch"] },
    justify: { kind: "string", oneOf: ["start", "center", "end", "between"] },
    wrap: { kind: "boolean" },
    children: { kind: "nodes", required: true },
  },
  grid: {
    columns: { kind: "number" },
    gap: { kind: "number" },
    children: { kind: "nodes", required: true },
  },
  card: {
    title: { kind: "string" },
    description: { kind: "string" },
    children: { kind: "nodes", required: true },
    footer: { kind: "nodes" },
  },
  scroll: { maxHeight: { kind: "number" }, children: { kind: "nodes", required: true } },
  tabs: { value: { kind: "string" }, items: { kind: "tabs", required: true } },
  separator: { orientation: { kind: "string", oneOf: ["horizontal", "vertical"] } },
  text: {
    value: { kind: "string", required: true },
    variant: { kind: "string", oneOf: ["h1", "h2", "h3", "body", "muted", "code"] },
    selectable: { kind: "boolean" },
  },
  badge: { label: { kind: "string", required: true }, tone: { kind: "string", oneOf: TONES } },
  icon: { name: { kind: "string", required: true }, size: { kind: "number" } },
  alert: {
    tone: { kind: "string", oneOf: TONES },
    title: { kind: "string" },
    description: { kind: "string" },
  },
  empty: {
    title: { kind: "string", required: true },
    description: { kind: "string" },
    icon: { kind: "string" },
  },
  skeleton: { lines: { kind: "number" } },
  userRef: REF_FIELDS,
  worldRef: REF_FIELDS,
  groupRef: REF_FIELDS,
  avatarRef: REF_FIELDS,
  instanceRef: REF_FIELDS,
  form: {
    children: { kind: "nodes", required: true },
    submitLabel: { kind: "string" },
    resetLabel: { kind: "string" },
  },
  field: {
    label: { kind: "string", required: true },
    description: { kind: "string" },
    error: { kind: "string" },
    required: { kind: "boolean" },
    control: { kind: "node", required: true },
  },
  input: {
    name: { kind: "string" },
    variant: { kind: "string", oneOf: ["text", "number", "password", "search"] },
    value: { kind: "string" },
    placeholder: { kind: "string" },
    maxLength: { kind: "number" },
    debounceMs: { kind: "number" },
  },
  textarea: {
    name: { kind: "string" },
    value: { kind: "string" },
    placeholder: { kind: "string" },
    rows: { kind: "number" },
    maxLength: { kind: "number" },
    debounceMs: { kind: "number" },
  },
  select: {
    name: { kind: "string" },
    value: { kind: "string" },
    placeholder: { kind: "string" },
    options: { kind: "options", required: true },
  },
  switch: { name: { kind: "string" }, checked: { kind: "boolean" }, label: { kind: "string" } },
  button: {
    label: { kind: "string", required: true },
    variant: {
      kind: "string",
      oneOf: ["default", "secondary", "outline", "ghost", "destructive"],
    },
    icon: { kind: "string" },
    submit: { kind: "boolean" },
  },
  table: {
    columns: { kind: "columns", required: true },
    rows: { kind: "rows", required: true },
    rowKey: { kind: "string", required: true },
    sortBy: { kind: "string" },
    sortDir: { kind: "string", oneOf: ["asc", "desc"] },
    filterable: { kind: "boolean" },
    empty: { kind: "string" },
  },
  list: { items: { kind: "listItems", required: true }, empty: { kind: "string" } },
  dialog: {
    open: { kind: "boolean", required: true },
    title: { kind: "string", required: true },
    description: { kind: "string" },
    children: { kind: "nodes" },
    actions: { kind: "nodes" },
    onClose: { kind: "intent" },
  },
  menu: { items: { kind: "menuItems", required: true }, trigger: { kind: "node" } },
};

const UI_NODE_TYPE_SET: ReadonlySet<string> = new Set(UI_NODE_TYPES);

class Walker {
  readonly issues: UiIssue[] = [];
  nodes = 0;
  /** Latched once a cap trips: past that point the tree is rejected and walking on wastes time. */
  aborted = false;

  add(path: string, message: string): void {
    if (this.issues.length < MAX_UI_ISSUES) this.issues.push({ path, message });
  }

  budget(path: string): boolean {
    this.nodes += 1;
    if (this.nodes > MAX_UI_NODES) {
      if (!this.aborted) this.add(path, `tree exceeds ${MAX_UI_NODES} nodes`);
      this.aborted = true;
      return false;
    }
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkString(w: Walker, path: string, value: unknown, spec: FieldSpec): void {
  if (typeof value !== "string") {
    w.add(path, "expected a string");
    return;
  }
  if (value.length > MAX_UI_STRING) w.add(path, `string exceeds ${MAX_UI_STRING} characters`);
  if (spec.kind === "string" && spec.oneOf && !spec.oneOf.includes(value)) {
    w.add(path, `expected one of ${spec.oneOf.join(", ")}`);
  }
}

function checkIntent(w: Walker, path: string, value: unknown): void {
  // The one rule that makes the boundary work: a handler is an id the plugin chose, not a function.
  // A function here means someone tried to send a closure across a process boundary — usually by
  // reading the docs as if this were a component library.
  if (!isRecord(value)) {
    w.add(path, "handler must be an intent object carrying an intent id, not a value or function");
    return;
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    w.add(`${path}.name`, "handler must be an intent id (a non-empty string)");
    return;
  }
  if (value.name.length > MAX_UI_STRING) w.add(`${path}.name`, "intent name too long");
  if (value.payload === undefined) return;
  if (!isRecord(value.payload)) {
    w.add(`${path}.payload`, "expected an object of scalars");
    return;
  }
  for (const [k, v] of Object.entries(value.payload)) {
    const t = typeof v;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      w.add(`${path}.payload.${k}`, "payload values must be string, number, or boolean");
    } else if (t === "string" && (v as string).length > MAX_UI_STRING) {
      w.add(`${path}.payload.${k}`, "string exceeds the length cap");
    }
  }
}

function checkMenuItems(w: Walker, path: string, value: unknown, depth: number): void {
  if (!Array.isArray(value)) {
    w.add(path, "expected an array of menu items");
    return;
  }
  if (depth > MAX_UI_DEPTH) {
    w.add(path, `tree exceeds depth ${MAX_UI_DEPTH}`);
    w.aborted = true;
    return;
  }
  for (const [i, raw] of value.entries()) {
    if (w.aborted) return;
    const p = `${path}[${i}]`;
    if (!w.budget(p)) return;
    if (!isRecord(raw)) {
      w.add(p, "expected a menu item object");
      continue;
    }
    if (typeof raw.label !== "string") w.add(`${p}.label`, "expected a string");
    if (raw.icon !== undefined && typeof raw.icon !== "string")
      w.add(`${p}.icon`, "expected string");
    if (raw.intent !== undefined) checkIntent(w, `${p}.intent`, raw.intent);
    for (const flag of ["disabled", "danger", "separatorBefore"] as const) {
      if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") {
        w.add(`${p}.${flag}`, "expected a boolean");
      }
    }
    if (raw.items !== undefined) checkMenuItems(w, `${p}.items`, raw.items, depth + 1);
  }
}

function checkJsonScalarRow(w: Walker, path: string, row: unknown): void {
  if (!isRecord(row)) {
    w.add(path, "expected a row object");
    return;
  }
  for (const [k, v] of Object.entries(row)) {
    if (v === null) continue;
    const t = typeof v;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      // Nested structure in a row would need a nested renderer, which is what columns are for.
      w.add(`${path}.${k}`, "cell values must be string, number, boolean, or null");
    } else if (t === "string" && (v as string).length > MAX_UI_STRING) {
      w.add(`${path}.${k}`, "string exceeds the length cap");
    }
  }
}

function checkField(w: Walker, path: string, value: unknown, spec: FieldSpec, depth: number): void {
  switch (spec.kind) {
    case "string":
      checkString(w, path, value, spec);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) w.add(path, "expected a number");
      return;
    case "boolean":
      if (typeof value !== "boolean") w.add(path, "expected a boolean");
      return;
    case "node":
      walk(w, path, value, depth + 1);
      return;
    case "nodes":
      if (!Array.isArray(value)) {
        w.add(path, "expected an array of nodes");
        return;
      }
      for (const [i, child] of value.entries()) {
        if (w.aborted) return;
        walk(w, `${path}[${i}]`, child, depth + 1);
      }
      return;
    case "intent":
      checkIntent(w, path, value);
      return;
    case "menuOrIntent":
      if (isRecord(value) && value.type !== undefined) {
        if (value.type !== "menu") {
          w.add(path, "a context menu node must be of type `menu`");
          return;
        }
        walk(w, path, value, depth + 1);
        return;
      }
      checkIntent(w, path, value);
      return;
    case "menuItems":
      checkMenuItems(w, path, value, depth + 1);
      return;
    case "tabs":
      if (!Array.isArray(value)) {
        w.add(path, "expected an array of tabs");
        return;
      }
      for (const [i, raw] of value.entries()) {
        if (w.aborted) return;
        const p = `${path}[${i}]`;
        if (!isRecord(raw)) {
          w.add(p, "expected a tab object");
          continue;
        }
        if (typeof raw.id !== "string") w.add(`${p}.id`, "expected a string");
        if (typeof raw.label !== "string") w.add(`${p}.label`, "expected a string");
        if (raw.icon !== undefined && typeof raw.icon !== "string") {
          w.add(`${p}.icon`, "expected a string");
        }
        walk(w, `${p}.content`, raw.content, depth + 1);
      }
      return;
    case "options":
      if (!Array.isArray(value)) {
        w.add(path, "expected an array of options");
        return;
      }
      for (const [i, raw] of value.entries()) {
        const p = `${path}[${i}]`;
        if (!w.budget(p)) return;
        if (!isRecord(raw)) {
          w.add(p, "expected an option object");
          continue;
        }
        if (typeof raw.value !== "string") w.add(`${p}.value`, "expected a string");
        if (typeof raw.label !== "string") w.add(`${p}.label`, "expected a string");
        if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") {
          w.add(`${p}.disabled`, "expected a boolean");
        }
      }
      return;
    case "listItems":
      if (!Array.isArray(value)) {
        w.add(path, "expected an array of list items");
        return;
      }
      for (const [i, raw] of value.entries()) {
        const p = `${path}[${i}]`;
        if (!w.budget(p)) return;
        if (!isRecord(raw)) {
          w.add(p, "expected a list item object");
          continue;
        }
        if (typeof raw.key !== "string") w.add(`${p}.key`, "expected a string");
        if (typeof raw.title !== "string") w.add(`${p}.title`, "expected a string");
        for (const opt of ["subtitle", "badge", "icon"] as const) {
          if (raw[opt] !== undefined && typeof raw[opt] !== "string") {
            w.add(`${p}.${opt}`, "expected a string");
          }
        }
        if (raw.onSelect !== undefined) checkIntent(w, `${p}.onSelect`, raw.onSelect);
      }
      return;
    case "columns":
      if (!Array.isArray(value)) {
        w.add(path, "expected an array of columns");
        return;
      }
      for (const [i, raw] of value.entries()) {
        const p = `${path}[${i}]`;
        if (!w.budget(p)) return;
        if (!isRecord(raw)) {
          w.add(p, "expected a column object");
          continue;
        }
        if (typeof raw.id !== "string") w.add(`${p}.id`, "expected a string");
        if (typeof raw.header !== "string") w.add(`${p}.header`, "expected a string");
        if (raw.cell !== undefined && !TABLE_CELL_KINDS.includes(raw.cell as string)) {
          w.add(`${p}.cell`, `expected one of ${TABLE_CELL_KINDS.join(", ")}`);
        }
      }
      return;
    case "rows": {
      if (!Array.isArray(value)) {
        w.add(path, "expected an array of rows");
        return;
      }
      if (value.length > MAX_TABLE_ROWS) {
        w.add(path, `table exceeds ${MAX_TABLE_ROWS} rows`);
        w.aborted = true;
        return;
      }
      // Rows are data, so they are checked but not charged to the node budget — the whole point of
      // the columns/rows split is that ten thousand rows cost one node.
      for (const [i, row] of value.entries()) checkJsonScalarRow(w, `${path}[${i}]`, row);
      return;
    }
  }
}

function walk(w: Walker, path: string, value: unknown, depth: number): void {
  if (w.aborted) return;
  if (depth > MAX_UI_DEPTH) {
    w.add(path, `tree exceeds depth ${MAX_UI_DEPTH}`);
    w.aborted = true;
    return;
  }
  if (!w.budget(path)) return;
  if (!isRecord(value)) {
    w.add(path, "expected a node object");
    return;
  }
  const type = value.type;
  if (typeof type !== "string" || !UI_NODE_TYPE_SET.has(type)) {
    // Closed union: an unknown type is rejected, never rendered as a passthrough. A host that
    // guessed here would be an escape hatch by accident.
    w.add(`${path}.type`, `unknown node type ${JSON.stringify(type)}`);
    return;
  }
  const fields = NODE_FIELDS[type as UINodeType];
  for (const [name, spec] of Object.entries(fields)) {
    const raw = value[name];
    if (raw === undefined) {
      if ("required" in spec && spec.required) w.add(`${path}.${name}`, "required");
      continue;
    }
    checkField(w, `${path}.${name}`, raw, spec, depth);
    if (w.aborted) return;
  }
  for (const [name, spec] of Object.entries(COMMON_FIELDS)) {
    const raw = value[name];
    if (raw === undefined) continue;
    checkField(w, `${path}.${name}`, raw, spec, depth);
    if (w.aborted) return;
  }
  // Unknown properties are ignored rather than rejected: a plugin built against a newer protocol
  // minor sending a field this host has not learned yet should still render.
}

/**
 * Validate a tree that arrived from a plugin process.
 *
 * Returns a result — the caller decides whether that means an error panel, a dropped patch, or a
 * disabled plugin. Never throws for malformed input; a throw here would be a bug in this file.
 */
export function validateUINode(value: unknown): UiValidation {
  const w = new Walker();
  walk(w, "$", value, 0);
  if (w.issues.length > 0) return { ok: false, issues: w.issues };
  return { ok: true, node: value as UINode };
}
