/**
 * The middle of a graph: comparing, gating, reading a field, composing a string, and the list nodes.
 *
 * Every one of these is pure — same inputs, same outputs, no account, no network, nothing to dry-run.
 * That is why they are in their own file: the actions in `actions.ts` all have a side effect and a
 * dry-run branch, and mixing the two would make it easy to write a "shaping" node that quietly does
 * something.
 *
 * **Gating is the absence of a value, not a false one.** A node that decides the run should stop
 * returns `{}` — nothing produced, so every edge out of it is dead and everything downstream skips.
 * That is the same mechanism the engine uses for a false condition and an untaken branch, and it is
 * why `gate` needs no cooperation from the walk.
 */

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import type { BuiltinNode } from "./types.ts";

/* -------------------------------------------------------------------------------------------- */
/* Compare                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const COMPARE_OPS = [
  { value: "eq", label: "is" },
  { value: "ne", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "starts", label: "starts with" },
  { value: "matches", label: "matches (regex)" },
  { value: "gt", label: "is greater than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" },
] as const;

const COMPARE: NodeDefinition = {
  id: "compare",
  kind: "action",
  title: "Compare",
  description: "Answers a yes-or-no question about two values.",
  category: "Logic",
  inputs: [
    { id: "left", label: "This", type: "json", required: true },
    { id: "right", label: "That", type: "json" },
  ],
  outputs: [{ id: "result", label: "Result", type: "boolean" }],
  config: [
    { kind: "select", id: "op", label: "Test", options: [...COMPARE_OPS], default: "eq" },
    {
      kind: "text",
      id: "value",
      label: "Compared with",
      description: "Used when nothing is wired to That.",
    },
  ],
  body: [
    { kind: "port", port: "left" },
    { kind: "literal", text: " " },
    { kind: "config", field: "op", fallback: "is" },
    { kind: "literal", text: " " },
    { kind: "config", field: "value", fallback: "…" },
  ],
};

/**
 * `right` beats the config, and the config exists at all because most comparisons are against a
 * constant the author types. A node that could only compare two wires would need a "literal" node
 * beside every one of them.
 */
function rightOperand(inputs: PortValues, config: NodeConfigValues): unknown {
  return inputs.right === undefined ? (config.value ?? null) : inputs.right;
}

function compare(inputs: PortValues, config: NodeConfigValues): PortValues {
  const left = inputs.left;
  const right = rightOperand(inputs, config);
  const op = typeof config.op === "string" ? config.op : "eq";
  return { result: evaluateCompare(op, left, right) };
}

export function evaluateCompare(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case "eq":
      // Loose on purpose at the *string* level rather than with `==`: a number that arrived as text
      // from a config field must compare equal to the same number from a port, and `==` would also
      // make `0` equal `false`, which is not something a graph author asked for.
      return sameValue(left, right);
    case "ne":
      return !sameValue(left, right);
    case "contains":
      return asText(left).includes(asText(right));
    case "starts":
      return asText(left).startsWith(asText(right));
    case "matches":
      return matches(asText(left), asText(right));
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = asNumber(left);
      const b = asNumber(right);
      if (a === null || b === null) return false;
      if (op === "gt") return a > b;
      if (op === "gte") return a >= b;
      if (op === "lt") return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "boolean" || typeof right === "boolean") return false;
  if (left === null || right === null || left === undefined || right === undefined) return false;
  if (typeof left === "object" || typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return String(left) === String(right);
}

/**
 * A regex from a graph, run against untrusted text.
 *
 * Not compiled once and cached: the pattern is config, so it changes with the graph, and a bad one
 * must be an answer of `false` rather than a crash — the author is not standing there to read a
 * stack trace at 3 AM. Catastrophic backtracking is a real hazard and is bounded by nothing here;
 * the run-size ceiling does not help with a single slow call. Worth revisiting if a graph ever hangs.
 */
function matches(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value) ?? "";
  return String(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* -------------------------------------------------------------------------------------------- */
/* Logic and gating                                                                               */
/* -------------------------------------------------------------------------------------------- */

const LOGIC: NodeDefinition = {
  id: "logic",
  kind: "action",
  title: "And / Or",
  description: "Combines two yes-or-no answers.",
  category: "Logic",
  inputs: [
    { id: "a", label: "A", type: "boolean", required: true },
    { id: "b", label: "B", type: "boolean", required: true },
  ],
  outputs: [{ id: "result", label: "Result", type: "boolean" }],
  config: [
    {
      kind: "select",
      id: "op",
      label: "Combine with",
      options: [
        { value: "and", label: "and" },
        { value: "or", label: "or" },
      ],
      default: "and",
    },
  ],
  body: [
    { kind: "literal", text: "A " },
    { kind: "config", field: "op", fallback: "and" },
    { kind: "literal", text: " B" },
  ],
};

const NOT: NodeDefinition = {
  id: "not",
  kind: "action",
  title: "Not",
  description: "Turns yes into no.",
  category: "Logic",
  inputs: [{ id: "value", label: "Value", type: "boolean", required: true }],
  outputs: [{ id: "result", label: "Result", type: "boolean" }],
  body: [
    { kind: "literal", text: "not " },
    { kind: "port", port: "value" },
  ],
};

const GATE: NodeDefinition = {
  id: "gate",
  kind: "action",
  title: "Only if",
  description: "Stops the run unless the answer is yes.",
  category: "Logic",
  inputs: [
    { id: "value", label: "If", type: "boolean", required: true },
    { id: "payload", label: "Carry", type: "json" },
  ],
  outputs: [{ id: "out", label: "Then", type: "json" }],
  body: [
    { kind: "literal", text: "only if " },
    { kind: "port", port: "value" },
  ],
};

/* -------------------------------------------------------------------------------------------- */
/* Reading and composing                                                                          */
/* -------------------------------------------------------------------------------------------- */

const FIELD: NodeDefinition = {
  id: "field",
  kind: "action",
  title: "Read field",
  description: "Pulls one value out of an event's payload.",
  category: "Data",
  inputs: [{ id: "value", label: "From", type: "json", required: true }],
  outputs: [{ id: "out", label: "Value", type: "json" }],
  config: [
    {
      kind: "text",
      id: "path",
      label: "Path",
      placeholder: "user.displayName",
      description: "Dotted or bracketed: user.tags[0] and $.user.tags.0 both work.",
      required: true,
    },
  ],
  body: [
    { kind: "literal", text: "." },
    { kind: "config", field: "path", fallback: "?" },
  ],
};

/**
 * A path into JSON. A path that finds nothing produces **nothing**, which gates the run.
 *
 * That is deliberate and it is the more useful of the two options: a graph that reads
 * `user.displayName` off an event that has no user should not carry on with `null` and send a
 * message addressed to nobody.
 *
 * Dots and brackets both work — `tags.0`, `tags[0]`, and a leading `$` — because people write paths
 * the way they have seen them written, and refusing `$.user.tags[0]` over punctuation would be a
 * lesson nobody wanted. Everything normalises to dotted segments before the walk.
 */
export function readPath(value: unknown, path: string): unknown {
  const normalised = path
    .trim()
    .replace(/^\$\.?/, "")
    .replaceAll(/\[["']?(.*?)["']?\]/g, ".$1");
  let current = value;
  for (const segment of normalised.split(".")) {
    if (segment === "") continue;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** `a` through `z`, as twenty-six declared inputs. See `variadicInputs` for why all of them exist. */
const TEMPLATE_SLOTS = Array.from({ length: 26 }, (_, index) => {
  const letter = String.fromCharCode(97 + index);
  return { id: letter, label: letter.toUpperCase(), type: "json" as const };
});

/** How many slots a `Compose text` node starts with. Three, which is what it always had. */
const TEMPLATE_DEFAULT_SLOTS = 3;

const TEMPLATE: NodeDefinition = {
  id: "template",
  kind: "action",
  title: "Compose text",
  description: "Builds a line of text from the values wired into it.",
  category: "Data",
  inputs: TEMPLATE_SLOTS,
  variadicInputs: "slots",
  outputs: [{ id: "text", label: "Text", type: "string" }],
  config: [
    {
      kind: "text",
      id: "template",
      label: "Text",
      placeholder: "{a} joined {b}",
      description:
        "Write {a}, {b} and so on where the wired values should go. A number can be formatted: {a:2f} for two decimals, {a:,} to group thousands, {a:%} for a percentage, {a:+} to always show the sign. {a:str} quotes and escapes the value as JSON, for building a body by hand.",
      required: true,
    },
    {
      kind: "slider",
      id: "slots",
      label: "Slots",
      min: 1,
      max: TEMPLATE_SLOTS.length,
      step: 1,
      default: TEMPLATE_DEFAULT_SLOTS,
      description: "How many values this node takes. It cannot go below the ones already wired.",
    },
  ],
  body: [{ kind: "config", field: "template", fallback: "…" }],
};

/**
 * A format spec: `{a:2f}`, `{a:,}`, `{a:+1%}`.
 *
 * In order: an optional `+` to always show the sign, an optional `,` to group thousands, and
 * optionally a digit count followed by `f` for fixed decimals or `%` for a percentage. Every part is
 * optional but the spec as a whole must say *something*, which is what the check below enforces —
 * `{a:}` means nothing and is therefore a typo rather than a request.
 */
const FORMAT_SPEC = /^(\+?)(,?)(?:(\d*)([f%]))?$/;

/**
 * `{a:str}` — the value as a JSON literal, quotes and escaping included.
 *
 * The reason it exists is building JSON by hand, which is what `Compose text` gets used for the
 * moment somebody needs a request body this palette has no node for. `{"name": "{a}"}` looks right
 * and breaks the first time a display name contains a quote, a backslash or a newline — and it
 * breaks at the far end, in whatever service rejected the payload, which is the worst place to
 * find out. `{"name": {a:str}}` cannot: the quoting is the formatter's job.
 *
 * It is also the one spec that is useful on something that is not a string. An object arrives as its
 * JSON, a number as digits with no quotes, `null` as `null` — each of which is what a JSON document
 * wanted in that position anyway.
 */
const JSON_SPEC = "str";

/**
 * The locale is fixed, and that is a decision rather than an oversight.
 *
 * A graph is a document. The line it composes goes to a webhook, a feed row, a notification — and it
 * must not read differently because the machine running the daemon is set to German. If somebody
 * wants a decimal comma they can type one; what they cannot do is opt out of a machine setting they
 * did not know was in play.
 */
const FORMAT_LOCALE = "en-US";

/**
 * One value formatted by a spec, or null when the spec is not one.
 *
 * Null means "leave the slot exactly as the author typed it", which is the same thing an unknown
 * slot does — a typo in the spec has to be visible in the output, because the alternative is a graph
 * quietly ignoring half of what was asked of it. A *non-numeric value* is different and is handled
 * by the caller: the spec was right, the world just handed over a string, and printing the string is
 * more useful than printing `NaN`.
 */
function formatNumber(value: unknown, spec: string): string | null {
  const parts = FORMAT_SPEC.exec(spec);
  if (parts === null) return null;
  const [, sign, group, digits, style] = parts;
  if (sign === "" && group === "" && style === undefined) return null;

  const number = asNumber(value);
  if (number === null) return asText(value);

  const places = digits === undefined || digits === "" ? 0 : Number(digits);
  return new Intl.NumberFormat(FORMAT_LOCALE, {
    ...(style === "%" ? { style: "percent" as const } : {}),
    useGrouping: group === ",",
    // Without a style there is no rounding to do, so both ends open: the point of `{a:,}` on its own
    // is grouping, and silently truncating 1234.5678 to `1,235` would be a second thing happening.
    ...(style === undefined
      ? { maximumFractionDigits: 20 }
      : { minimumFractionDigits: places, maximumFractionDigits: places }),
    // `exceptZero` rather than `always`: `+0` reads as a bug in whatever produced it.
    ...(sign === "+" ? { signDisplay: "exceptZero" as const } : {}),
  }).format(number);
}

/**
 * `{a}` through `{z}`, `{{` for a literal brace, and an optional `:spec` for numbers.
 *
 * An unknown slot is left exactly as typed, and so is an unreadable spec. Both are the author's
 * text rather than the world's, and a template that silently drops the parts it did not understand
 * is one nobody can debug.
 */
export function fillTemplate(template: string, inputs: PortValues): string {
  return template.replace(
    /\{\{|\}\}|\{([a-z])(?::([^}]*))?\}/g,
    (match, slot: string | undefined, spec: string | undefined) => {
      if (match === "{{") return "{";
      if (match === "}}") return "}";
      if (slot === undefined || !(slot in inputs)) return match;
      if (spec === undefined) return asText(inputs[slot]);
      // `undefined` has no JSON form, and a wired port carrying nothing is a real state. `null` is
      // the JSON word for it and is what the surrounding document can actually parse.
      if (spec === JSON_SPEC) return JSON.stringify(inputs[slot] ?? null) ?? "null";
      return formatNumber(inputs[slot], spec) ?? match;
    },
  );
}

/* -------------------------------------------------------------------------------------------- */
/* Lists                                                                                          */
/* -------------------------------------------------------------------------------------------- */

const AS_LIST: NodeDefinition = {
  id: "as-list",
  kind: "action",
  title: "As list",
  description: "Treats a raw value as a list, so it can be looped over.",
  category: "Lists",
  inputs: [{ id: "value", label: "Value", type: "json", required: true }],
  outputs: [{ id: "list", label: "List", type: "list<json>" }],
  body: [{ kind: "literal", text: "as a list" }],
};

const LIST_FILTER: NodeDefinition = {
  id: "list-filter",
  kind: "action",
  title: "Filter list",
  description: "Keeps the items that pass a test.",
  category: "Lists",
  inputs: [{ id: "list", label: "List", type: "list<json>", required: true }],
  outputs: [{ id: "list", label: "Kept", type: "list<json>" }],
  config: [
    {
      kind: "text",
      id: "path",
      label: "Field",
      placeholder: "status",
      description: "Left blank, the item itself is tested.",
    },
    { kind: "select", id: "op", label: "Test", options: [...COMPARE_OPS], default: "eq" },
    { kind: "text", id: "value", label: "Compared with" },
  ],
  body: [
    { kind: "literal", text: "where " },
    { kind: "config", field: "path", fallback: "item" },
    { kind: "literal", text: " " },
    { kind: "config", field: "op", fallback: "is" },
    { kind: "literal", text: " " },
    { kind: "config", field: "value", fallback: "…" },
  ],
};

const LIST_COUNT: NodeDefinition = {
  id: "list-count",
  kind: "action",
  // "Count items", not "Count": the stateful `counter` node is also about counting, and two
  // palette entries reading "Count" is a palette nobody can choose from.
  title: "Count items",
  description: "How many items are in a list.",
  category: "Lists",
  inputs: [{ id: "list", label: "List", type: "list<json>", required: true }],
  outputs: [{ id: "count", label: "Count", type: "number" }],
  body: [
    { kind: "literal", text: "count of " },
    { kind: "port", port: "list" },
  ],
};

const LIST_FIRST: NodeDefinition = {
  id: "list-first",
  kind: "action",
  title: "First item",
  description: "The first item, or nothing when the list is empty.",
  category: "Lists",
  inputs: [{ id: "list", label: "List", type: "list<json>", required: true }],
  outputs: [{ id: "item", label: "Item", type: "json" }],
  body: [
    { kind: "literal", text: "first of " },
    { kind: "port", port: "list" },
  ],
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export function shapingNodes(): BuiltinNode[] {
  return [
    { definition: COMPARE, execute: compare },
    {
      definition: LOGIC,
      execute: (inputs, config) => ({
        result:
          config.op === "or"
            ? inputs.a === true || inputs.b === true
            : inputs.a === true && inputs.b === true,
      }),
    },
    { definition: NOT, execute: (inputs) => ({ result: inputs.value !== true }) },
    {
      definition: GATE,
      // Nothing, not `false`: an unproduced port is what stops the run, and returning `{out: false}`
      // would send a literal `false` down the graph instead.
      execute: (inputs) => (inputs.value === true ? { out: inputs.payload ?? true } : {}),
    },
    {
      definition: FIELD,
      execute: (inputs, config) => {
        const found = readPath(inputs.value, typeof config.path === "string" ? config.path : "");
        return found === undefined ? {} : { out: found };
      },
    },
    {
      definition: TEMPLATE,
      execute: (inputs, config) => ({
        text: fillTemplate(typeof config.template === "string" ? config.template : "", inputs),
      }),
    },
    { definition: AS_LIST, execute: (inputs) => ({ list: asArray(inputs.value) }) },
    {
      definition: LIST_FILTER,
      execute: (inputs, config) => {
        const path = typeof config.path === "string" ? config.path : "";
        const op = typeof config.op === "string" ? config.op : "eq";
        const right = config.value ?? null;
        return {
          list: asArray(inputs.list).filter((item) =>
            evaluateCompare(op, path === "" ? item : readPath(item, path), right),
          ),
        };
      },
    },
    { definition: LIST_COUNT, execute: (inputs) => ({ count: asArray(inputs.list).length }) },
    {
      definition: LIST_FIRST,
      execute: (inputs) => {
        const list = asArray(inputs.list);
        // Empty produces nothing, which gates. "The first friend in the instance, if there is one"
        // is the shape this node is for, and `null` would make the graph act on nobody.
        return list.length === 0 ? {} : { item: list[0] };
      },
    },
  ];
}
