/**
 * Literals, and the two other nodes that answer without being asked anything.
 *
 * ## Why a value node is a node at all
 *
 * Most graphs need a constant somewhere: the world you want to be told about, the number to compare
 * against, the text to send. Config fields cover the case where the constant belongs to *one* node,
 * but not the case where the same value feeds three of them, and not the case where a node's input
 * is a typed port with no config equivalent.
 *
 * ## One node per type, not one node with a type picker
 *
 * A `Text` node has a real `string` output and a `User` node has a real `user` output, so the
 * lattice checks the edge as it is drawn. A single node whose output type followed a config field
 * would have to change its own port type — which `nodeDefinitionHash` covers, so every switch would
 * mark saved graphs stale, and the editor would have to redraw ports on a config change. The cost of
 * the split is a longer palette, which is what the search box is for.
 *
 * ## They are **sources**
 *
 * None of these has an input, so none is reachable from a trigger. The engine has a rule for that
 * (`#withSources`): a node type with no inputs runs when something that *is* reachable consumes it.
 * That is what makes a literal usable without wiring a "run me" port into it.
 */

import type { NodeConfigValues, NodeDefinition, PortType } from "@vrcz/plugin-api/nodes";
import type { BuiltinNode } from "./types.ts";

/**
 * A literal of one port type.
 *
 * The id types (`user`, `world`, …) exist because a resolver takes an id and a `string` cannot flow
 * into a `user` port — which is the lattice working, not getting in the way. Typing an id into a
 * `User` node is the honest way to say "this specific person".
 */
function literal(
  type: PortType,
  id: string,
  title: string,
  placeholder: string,
  description: string,
): BuiltinNode {
  const numeric = type === "number";
  const boolean = type === "boolean";
  const definition: NodeDefinition = {
    id,
    kind: "action",
    title,
    description,
    category: "Values",
    inputs: [],
    outputs: [{ id: "value", label: "Value", type }],
    config: [
      numeric
        ? { kind: "number", id: "value", label: "Value", default: 0 }
        : boolean
          ? { kind: "boolean", id: "value", label: "Value", default: false }
          : { kind: "text", id: "value", label: "Value", placeholder },
    ],
    body: [{ kind: "config", field: "value", fallback: "…" }],
  };

  return {
    definition,
    execute: (_inputs, config) => ({ value: readValue(config, numeric, boolean) }),
  };
}

function readValue(
  config: NodeConfigValues,
  numeric: boolean,
  boolean: boolean,
): string | number | boolean {
  const raw = config.value;
  if (boolean) return raw === true || raw === "true";
  if (numeric) {
    const parsed = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return typeof raw === "string" ? raw : String(raw ?? "");
}

/**
 * A JSON literal, which is the one value node that can carry a shape the type system cannot check.
 *
 * Text that will not parse produces **nothing** rather than a string that looks like JSON. A node
 * whose whole job is to be an object should not silently become `"{ oops"` downstream, and gating is
 * how every other node in this app says "I could not do my job".
 */
const JSON_VALUE: NodeDefinition = {
  id: "json-value",
  kind: "action",
  title: "JSON value",
  description: "A literal object or list, typed in. Useful for a webhook body.",
  category: "Values",
  inputs: [],
  outputs: [{ id: "value", label: "Value", type: "json" }],
  config: [
    {
      kind: "text",
      id: "value",
      label: "JSON",
      placeholder: '{ "hello": "world" }',
      required: true,
    },
  ],
  body: [{ kind: "config", field: "value", fallback: "{}" }],
};

const NOW: NodeDefinition = {
  id: "now",
  kind: "action",
  title: "Now",
  description: "The current time, as this machine sees it.",
  category: "Values",
  inputs: [],
  outputs: [
    { id: "at", label: "At", type: "number", description: "Integer unix milliseconds." },
    { id: "iso", label: "ISO", type: "string" },
  ],
  body: [{ kind: "literal", text: "now" }],
};

const RANDOM_NUMBER: NodeDefinition = {
  id: "random-number",
  kind: "action",
  title: "Random number",
  description: "A whole number between two bounds, inclusive.",
  category: "Values",
  inputs: [],
  outputs: [{ id: "value", label: "Value", type: "number" }],
  config: [
    { kind: "number", id: "min", label: "From", default: 1 },
    { kind: "number", id: "max", label: "To", default: 100 },
  ],
  body: [
    { kind: "config", field: "min", fallback: "1" },
    { kind: "literal", text: " to " },
    { kind: "config", field: "max", fallback: "100" },
  ],
};

function bound(config: NodeConfigValues, key: string, fallback: number): number {
  const raw = config[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function valueNodes(now: () => number): BuiltinNode[] {
  return [
    literal("string", "text-value", "Text value", "hello", "A line of text."),
    literal("number", "number-value", "Number value", "0", "A number."),
    literal("boolean", "boolean-value", "Yes or no", "", "A fixed yes or no."),
    literal("user", "user-value", "A user", "usr_…", "One specific person, by id."),
    literal("world", "world-value", "A world", "wrld_…", "One specific world, by id."),
    literal(
      "instance",
      "instance-value",
      "An instance",
      "wrld_…:12345~region(eu)",
      "One specific instance, as VRChat writes it.",
    ),
    literal("avatar", "avatar-value", "An avatar", "avtr_…", "One specific avatar, by id."),
    literal("group", "group-value", "A group", "grp_…", "One specific group, by id."),
    {
      definition: JSON_VALUE,
      execute: (_inputs, config) => {
        try {
          return { value: JSON.parse(typeof config.value === "string" ? config.value : "") };
        } catch {
          // Nothing, not the raw text: a node whose job is to be an object must not become a
          // broken string downstream. See the note above.
          return {};
        }
      },
    },
    {
      definition: NOW,
      execute: () => {
        const at = now();
        return { at, iso: new Date(at).toISOString() };
      },
    },
    {
      definition: RANDOM_NUMBER,
      execute: (_inputs, config) => {
        const min = bound(config, "min", 1);
        const max = bound(config, "max", 100);
        const low = Math.ceil(Math.min(min, max));
        const high = Math.floor(Math.max(min, max));
        // Swapped bounds are read as a range rather than refused: somebody typing 100 and 1 meant a
        // range, and an error there would be pedantry rather than protection.
        return { value: low + Math.floor(Math.random() * (high - low + 1)) };
      },
    },
  ];
}
