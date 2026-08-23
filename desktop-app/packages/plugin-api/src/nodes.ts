/**
 * Node type registration: what a plugin declares so its node can appear in the graph editor.
 *
 * PLAN.md §Phase 3 "Node type registration": one declarative `NodeDefinition` feeds three consumers
 * — the Svelte Flow editor, the graph runtime in the daemon, and the type checker that runs in both
 * — so they cannot drift. Everything below is data. The only functions a plugin supplies are the
 * handlers in {@link NodeRegistration}, and they are never part of what the editor reads.
 *
 * Type checking happens twice on purpose: in the editor for instant red-edge feedback, and again in
 * the daemon on save and at each execution boundary, because the frontend is a client and clients
 * lie. Both calls land on {@link assignable}, which is why it is a pure function over two strings
 * with no host context at all.
 *
 * This file deliberately imports neither the manifest nor the RPC protocol. A `NodeDefinition`
 * travels inside a manifest's `contributes.nodes` and its handlers are invoked over the envelope
 * protocol, but the definition itself must be checkable — and unit-testable — with no transport and
 * no plugin loaded. The dependency runs one way: those modules may import this one.
 */

/* -------------------------------------------------------------------------------------------- */
/* The port-type lattice                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * The scalar port types.
 *
 * Small on purpose. Every member is something the graph runtime can actually carry between nodes and
 * the editor can label on an edge; nothing here is a shape a plugin invented. Domain types are ids
 * with host-known meaning (`user` is a user id, not a user object), which is what lets a node accept
 * a `user` from any producer without the producers agreeing on a payload shape.
 *
 * Still not present, and each absence is a decision: no `timestamp` distinct from `number`
 * (timestamps are integer unix-ms everywhere in this project, so a separate type would refuse an
 * edge the user is right to expect), and no `any` (that is what `json` is, with the direction
 * stated).
 */
export const BASE_PORT_TYPES = [
  "friend",
  "user",
  "world",
  "instance",
  "group",
  "avatar",
  "string",
  "number",
  "boolean",
  "json",
] as const;

export type BasePortType = (typeof BASE_PORT_TYPES)[number];

/**
 * A list of one scalar type. `list<friend>`, `list<string>`, and so on.
 *
 * **This entry used to say lists were deliberately absent**, on the grounds that an elementwise rule
 * would double the lattice for a v1 that ships triggers only. Decision 206 reversed it, and the
 * reason is that `foreach` and the list nodes need *some* answer: the alternatives were a flat
 * enumeration (`friendList`, `userList`, …) that grows every time a scalar is added, or "a list is
 * `json`", which hands back exactly the property the lattice exists to hold. One parameterised type
 * with one covariance rule buys several nodes and stays explicable in a sentence.
 *
 * Not nested: `list<list<user>>` is not a port type. A graph that needs one is a graph that wants a
 * different node, and the depth would have to be drawn on an edge label somebody reads at a glance.
 */
export type ListPortType = `list<${BasePortType}>`;

export type PortType = BasePortType | ListPortType;

export const LIST_PORT_TYPES: readonly ListPortType[] = BASE_PORT_TYPES.map(
  (type) => `list<${type}>` as const,
);

/** Every port type, scalars first. Iterated by the docs generator and by the editor's palette. */
export const PORT_TYPES: readonly PortType[] = [...BASE_PORT_TYPES, ...LIST_PORT_TYPES];

/** The element type of a list port, or null for a scalar. */
export function listElement(type: PortType): BasePortType | null {
  if (!type.startsWith("list<") || !type.endsWith(">")) return null;
  const inner = type.slice(5, -1);
  return (BASE_PORT_TYPES as readonly string[]).includes(inner) ? (inner as BasePortType) : null;
}

export function isPortType(value: unknown): value is PortType {
  return typeof value === "string" && (PORT_TYPES as readonly string[]).includes(value);
}

/**
 * Can a value of `from` flow into a port of `to`?
 *
 * **Three widening rules**, plus identity:
 *
 * 1. `friend <: user` — a friend is a user you also have a relationship with, so anything that takes
 *    a user takes a friend. Not the reverse: a node that needs friendship (unfriend, favourite) must
 *    be able to refuse a stranger at edit time rather than at 3 AM.
 * 2. `X <: json` — every type erases to JSON, lists included. Not the reverse: `json` into a typed
 *    port is the unchecked cast that makes a type system decorative, and the graph editor's whole
 *    value is telling the user *before* they save.
 * 3. `list<A> <: list<B>` when `A <: B` — lists widen exactly as their elements do, and no further.
 *    A list is never a scalar and a scalar is never a list, in either direction: "it is one thing or
 *    several" is the distinction the type exists to draw.
 *
 * PLAN.md is emphatic about why the list stops there: **every additional rule is an explanation you
 * owe a user whose edge just got refused.** Three rules still fit in a sentence, and the third is
 * the one people already expect from every other type system they have used.
 *
 * The port compatibility matrix in the docs is generated from this function, so it is the single
 * source of truth and cannot describe a rule that isn't implemented.
 */
export function assignable(from: PortType, to: PortType): boolean {
  if (from === to) return true;
  if (to === "json") return true;
  const fromElement = listElement(from);
  const toElement = listElement(to);
  // One side a list and the other not: refused before the scalar rules get a look, so
  // `list<friend>` cannot slip into a `user` port on the strength of rule 1.
  if (fromElement === null || toElement === null) {
    if (fromElement !== null || toElement !== null) return false;
    return from === "friend" && to === "user";
  }
  return assignable(fromElement, toElement);
}

/* -------------------------------------------------------------------------------------------- */
/* Ports                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export interface PortDefinition {
  /** Stable across versions. This is what a saved edge references, not the label. */
  readonly id: string;
  /** Shown on the node body and in the editor's edge tooltip. */
  readonly label: string;
  readonly type: PortType;
  /** An input with no incoming edge and no default fails the check at save time. */
  readonly required?: boolean;
  readonly description?: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Config                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * A config field is not a `UINode`.
 *
 * A UI tree is a rendering; the inspector needs a *schema* — something that produces a typed value
 * keyed by field id, can be validated on save, is content-hashed into the graph, and can be
 * migrated. Reusing `UINode` here would mean reading values back out of a rendering, which is how
 * you end up with a form that means something different after a redesign. The host draws these with
 * the same components the UI vocabulary uses, so they still look identical.
 */
export type NodeConfigField =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly placeholder?: string;
      readonly default?: string;
      readonly required?: boolean;
    }
  | {
      readonly kind: "number";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly min?: number;
      readonly max?: number;
      readonly default?: number;
      readonly required?: boolean;
    }
  | {
      readonly kind: "boolean";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly default?: boolean;
    }
  | {
      readonly kind: "select";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly default?: string;
      readonly required?: boolean;
    }
  | {
      readonly kind: "duration";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly default?: number;
      readonly required?: boolean;
    }
  | {
      readonly kind: "user";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly required?: boolean;
    }
  | {
      readonly kind: "world";
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly required?: boolean;
    };

/** A configured instance's values, keyed by field id. Integer unix-ms for `duration` fields. */
export type NodeConfigValues = Readonly<Record<string, string | number | boolean>>;

/* -------------------------------------------------------------------------------------------- */
/* Body template                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * The node's body text, as data the host evaluates locally.
 *
 * **Not an RPC into the plugin.** Svelte Flow re-renders on every pan and zoom; per-frame RPC at
 * 60Hz across a process boundary is not viable, and a plugin that is busy, restarting, or disabled
 * would leave blank nodes on the canvas. Evaluating a template means a saved graph draws correctly
 * with every plugin process dead.
 *
 * Segments are concatenated. `config` substitutes the instance's value for a field; `port`
 * substitutes the port's label, falling back to its id when no port matches. Everything renders as
 * text — same rule as the UI vocabulary, no markup anywhere.
 *
 * This once said `port` renders the label "with its type chip". It does not: `evaluateNodeBody`
 * returns a string and has no way to express a chip. Whether the editor draws one beside the body
 * is the editor's business, not this template's.
 */
export type NodeBodySegment =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "config"; readonly field: string; readonly fallback?: string }
  | { readonly kind: "port"; readonly port: string };

export type NodeBodyTemplate = readonly NodeBodySegment[];

/**
 * Evaluate a body template against an instance's config. Pure, synchronous, no host context — the
 * editor calls this per frame, so it must stay that way.
 */
export function evaluateNodeBody(
  template: NodeBodyTemplate,
  config: NodeConfigValues,
  ports?: readonly PortDefinition[],
): string {
  let out = "";
  for (const segment of template) {
    switch (segment.kind) {
      case "literal":
        out += segment.text;
        break;
      case "config": {
        const value = config[segment.field];
        out += value === undefined ? (segment.fallback ?? "") : String(value);
        break;
      }
      case "port": {
        const port = ports?.find((p) => p.id === segment.port);
        out += port?.label ?? segment.port;
        break;
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------------------------- */
/* Node definitions                                                                               */
/* -------------------------------------------------------------------------------------------- */

interface NodeDefinitionBase {
  /**
   * Unique within the plugin. The graph stores `<pluginId>/<id>`, so this may not change across a
   * plugin update without a migration — see {@link nodeDefinitionHash}.
   */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** Groups the node in the editor's palette. Free text; the host buckets unknown ones. */
  readonly category?: string;
  readonly icon?: string;
  readonly config?: readonly NodeConfigField[];
  readonly body?: NodeBodyTemplate;
  readonly outputs: readonly PortDefinition[];
}

/**
 * A trigger **arms, it does not execute** — this is the shape that makes that unrepresentable.
 *
 * A trigger has no inputs, because nothing upstream can hand it a value: it is where a graph starts.
 * And it has no `execute` handler anywhere in its registration ({@link TriggerRegistration}), so an
 * author cannot declare one that runs on demand even by mistake. The runtime tells the plugin an
 * instance is live with a given config; the plugin holds whatever subscription it needs and calls
 * `fire()` when the world does something. The inversion matters because the alternative — the
 * runtime polling a plugin to ask "did it happen yet?" — is both wrong for events and a rate-limit
 * hazard multiplied by every graph the user has saved.
 */
export interface TriggerNodeDefinition extends NodeDefinitionBase {
  readonly kind: "trigger";
  /**
   * How many times this trigger may fire per minute before the host coalesces. A trigger wired to
   * `friend-location` is not a rare event, and a graph that runs 900 times on an instance transition
   * is the user's rate budget, not the plugin's.
   */
  readonly maxFiresPerMinute?: number;
}

/**
 * Everything that runs when the graph reaches it. Conditions gate; actions do something. Both are
 * invoked with resolved inputs and return outputs, so both have inputs — the one structural
 * difference from a trigger.
 */
export interface ExecutableNodeDefinition extends NodeDefinitionBase {
  readonly kind: "action" | "condition";
  readonly inputs: readonly PortDefinition[];
}

export type NodeDefinition = TriggerNodeDefinition | ExecutableNodeDefinition;

/** Values on the wire between nodes. Domain types carry the id; `json` carries anything. */
export type PortValues = Readonly<Record<string, unknown>>;

/** Handed to the plugin when the runtime arms a trigger instance. */
export interface TriggerArmContext {
  /** Identifies this armed instance for the life of the arming; `fire()` is scoped to it. */
  readonly instanceId: string;
  readonly graphId: string;
  readonly config: NodeConfigValues;
  /** Starts one run of the graph downstream of this node. */
  fire(outputs: PortValues): void;
  /** Called when the graph is edited, paused, or the plugin is disabled. Tear down here. */
  onDisarm(handler: () => void): void;
}

export interface TriggerRegistration {
  readonly definition: TriggerNodeDefinition;
  /** Note the absence of `execute`. That absence is the invariant, not a gap. */
  arm(ctx: TriggerArmContext): void | Promise<void>;
}

export interface ExecutableRegistration {
  readonly definition: ExecutableNodeDefinition;
  execute(inputs: PortValues, config: NodeConfigValues): PortValues | Promise<PortValues>;
}

export type NodeRegistration = TriggerRegistration | ExecutableRegistration;

/** Narrowing helper for consumers that switch on the kind. */
export function isTriggerDefinition(def: NodeDefinition): def is TriggerNodeDefinition {
  return def.kind === "trigger";
}

/* -------------------------------------------------------------------------------------------- */
/* Content hashing                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * The canonical form that {@link nodeDefinitionHash} digests. Exported because a mismatch is a thing
 * a user has to be shown ("this node's ports changed"), and diffing two canonical forms says what
 * changed far better than comparing two hashes.
 *
 * **Covered — anything that can break a saved graph:**
 * - `id` and `kind` (a trigger that became an action is a different node)
 * - every port: `id`, `type`, `required`, and which side it is on — sorted by id, because argument
 *   order in a source file is not semantics
 * - every config field: `id` and `kind` — a text field that became a select invalidates stored values
 *
 * **Not covered — anything cosmetic:** `title`, `description`, `category`, `icon`, port `label` and
 * `description`, config `label`/`description`/`options`/`default`, and the body template. Fixing a
 * typo in a label must not prompt every user with a saved graph to migrate; a migration prompt that
 * fires for nothing is a migration prompt people click through.
 *
 * Key order in the source object is irrelevant by construction: this builds the string in a fixed
 * order rather than serializing whatever `Object.keys` happened to return.
 */
export function canonicalNodeDefinition(def: NodeDefinition): string {
  const ports = (side: string, list: readonly PortDefinition[]): string =>
    [...list]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => `${side}:${p.id}:${p.type}:${p.required === true ? "1" : "0"}`)
      .join(",");

  const inputs = isTriggerDefinition(def) ? "" : ports("in", def.inputs);
  const outputs = ports("out", def.outputs);
  const config = [...(def.config ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((f) => `${f.id}:${f.kind}`)
    .join(",");

  return [
    `id=${def.id}`,
    `kind=${def.kind}`,
    `in=${inputs}`,
    `out=${outputs}`,
    `cfg=${config}`,
  ].join("\n");
}

/**
 * SHA-256 of the canonical form, hex.
 *
 * Written into every saved graph that uses the node. On load, a definition whose hash differs is
 * **not** silently rewired — the user is prompted to migrate, and until they do the graph is paused
 * and marked unavailable rather than deleted (PLAN.md §Phase 3). Silently rewiring is how an
 * automation that sends invites starts sending them to the wrong person after an update.
 *
 * Async because `crypto.subtle` is the one digest available in all three places this runs: the
 * daemon, a plugin process, and the browser. A synchronous non-cryptographic hash was the
 * alternative and was passed over — a collision here means accepting an incompatible definition as
 * compatible, which is exactly the failure the hash exists to prevent.
 */
export async function nodeDefinitionHash(def: NodeDefinition): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalNodeDefinition(def));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* -------------------------------------------------------------------------------------------- */
/* Validation                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** Caps, for the same reason the UI vocabulary has them: this arrives from another process. */
export const MAX_NODE_PORTS = 16;
export const MAX_NODE_CONFIG_FIELDS = 24;
export const MAX_NODE_STRING = 200;

export interface NodeIssue {
  readonly path: string;
  readonly message: string;
}

export type NodeValidation =
  | { readonly ok: true; readonly definition: NodeDefinition }
  | { readonly ok: false; readonly issues: readonly NodeIssue[] };

const CONFIG_KINDS = ["text", "number", "boolean", "select", "duration", "user", "world"] as const;

/** `publisher.name`-ish: an identifier a graph can store and a person can read in an error. */
const NODE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkString(
  issues: NodeIssue[],
  path: string,
  value: unknown,
  { required }: { required: boolean },
): void {
  if (value === undefined) {
    if (required) issues.push({ path, message: "is required" });
    return;
  }
  if (typeof value !== "string" || value === "") {
    issues.push({ path, message: "must be a non-empty string" });
    return;
  }
  if (value.length > MAX_NODE_STRING) {
    issues.push({ path, message: `must be at most ${MAX_NODE_STRING} characters` });
  }
}

function checkPorts(issues: NodeIssue[], path: string, value: unknown): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array of ports" });
    return;
  }
  if (value.length > MAX_NODE_PORTS) {
    issues.push({ path, message: `must have at most ${MAX_NODE_PORTS} ports` });
    return;
  }
  const seen = new Set<string>();
  value.forEach((port, index) => {
    const at = `${path}[${String(index)}]`;
    if (!isRecord(port)) {
      issues.push({ path: at, message: "must be an object" });
      return;
    }
    checkString(issues, `${at}.id`, port.id, { required: true });
    checkString(issues, `${at}.label`, port.label, { required: true });
    if (typeof port.id === "string") {
      // Duplicate port ids are the failure that silently loses an edge: a saved graph references a
      // port by id, and two ports answering to one id means the wrong one may resolve.
      if (seen.has(port.id)) issues.push({ path: at, message: `duplicates port id "${port.id}"` });
      seen.add(port.id);
    }
    if (!isPortType(port.type)) {
      issues.push({
        path: `${at}.type`,
        message: `must be one of: ${PORT_TYPES.join(", ")}`,
      });
    }
  });
}

/**
 * Validates a node definition that arrived from a plugin.
 *
 * The same contract as `validateUINode`: a result rather than a throw, and the caller decides what
 * a rejection means. Every message names a path, because the author is the only person who can fix
 * it and "invalid node definition" tells them nothing.
 *
 * Note what is *not* checked here: whether the id appears in the plugin's `contributes.nodes`. This
 * module may not read a manifest — the one-way dependency that keeps the call path away from what
 * an author *requested* — so the host checks that where it has both.
 */
export function validateNodeDefinition(value: unknown): NodeValidation {
  const issues: NodeIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path: "$", message: "must be an object" }] };
  }

  checkString(issues, "id", value.id, { required: true });
  if (typeof value.id === "string" && !NODE_ID_PATTERN.test(value.id)) {
    issues.push({
      path: "id",
      message: 'must look like "friend-online" or "notes.added": lowercase, starting with a letter',
    });
  }
  checkString(issues, "title", value.title, { required: true });
  checkString(issues, "description", value.description, { required: false });
  checkString(issues, "category", value.category, { required: false });
  checkString(issues, "icon", value.icon, { required: false });

  const kind = value.kind;
  if (kind !== "trigger" && kind !== "action" && kind !== "condition") {
    issues.push({ path: "kind", message: 'must be "trigger", "action" or "condition"' });
  }

  checkPorts(issues, "outputs", value.outputs);
  if (kind === "trigger") {
    // A trigger with inputs is the shape the whole inversion exists to prevent: nothing upstream
    // can hand a value to the thing a graph *starts* with.
    if (value.inputs !== undefined) {
      issues.push({
        path: "inputs",
        message: "a trigger has no inputs — it arms, it does not run",
      });
    }
  } else if (kind === "action" || kind === "condition") {
    checkPorts(issues, "inputs", value.inputs);
  }

  if (value.config !== undefined) {
    if (!Array.isArray(value.config)) {
      issues.push({ path: "config", message: "must be an array of fields" });
    } else if (value.config.length > MAX_NODE_CONFIG_FIELDS) {
      issues.push({
        path: "config",
        message: `must have at most ${MAX_NODE_CONFIG_FIELDS} fields`,
      });
    } else {
      value.config.forEach((field, index) => {
        const at = `config[${String(index)}]`;
        if (!isRecord(field)) {
          issues.push({ path: at, message: "must be an object" });
          return;
        }
        if (!(CONFIG_KINDS as readonly unknown[]).includes(field.kind)) {
          issues.push({
            path: `${at}.kind`,
            message: `must be one of: ${CONFIG_KINDS.join(", ")}`,
          });
        }
        checkString(issues, `${at}.id`, field.id, { required: true });
        checkString(issues, `${at}.label`, field.label, { required: true });
        if (field.kind === "select" && !Array.isArray(field.options)) {
          issues.push({ path: `${at}.options`, message: "a select needs options" });
        }
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, definition: value as unknown as NodeDefinition };
}
