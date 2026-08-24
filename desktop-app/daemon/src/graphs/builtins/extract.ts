/**
 * Pulling several values out of one object, on ports the author chooses.
 *
 * `Read field` answers "what is at this path", one path per node. That is the right node for one
 * value and the wrong one for six: a graph that wants a name, a status, a trust rank and a list of
 * tags off the same user ends up with four cards wired to the same port, each holding a string
 * nobody can check for typos. These nodes are that shape said once — a list of paths, and one output
 * port per path.
 *
 * Pure, like everything in `shaping.ts` and for the same reason. **The input is an object that is
 * already in hand**, not an id: `Look up a user` costs a request and already exists, and its
 * `Everything` port is what these are wired to. An extractor that fetched would be a second way to
 * spend the rate budget with no way to see it on the card.
 *
 * ## Why the ports are slots
 *
 * A node's outputs are its identity — hashed into `defHash`, referenced by every saved edge, checked
 * on every wire — so they cannot be computed from an instance's config. The way out is the one
 * `Compose text` already takes with its twenty-six inputs: **declare every port, always, and let the
 * config decide which are drawn.** See `variadicOutputs` in `@vrcz/plugin-api`.
 *
 * Two banks, because a port has one type and a field can hold one thing or several. Ten `json`
 * slots and five `list<json>` slots means `tags` arrives on a port a `For each` will accept, rather
 * than as JSON somebody converts by hand with an `As list` node.
 *
 * And a row **stores the slot it claims** rather than taking the next one by position. Rows are
 * added and removed in the middle; a positional rule would silently re-point every wire below a
 * deleted row at a different value, which is a graph doing something else after an edit nobody
 * thought was an edit.
 *
 * ## A path that finds nothing produces nothing, per port
 *
 * Same rule as `Read field`, applied one slot at a time: the missing field's own edges are dead and
 * its branch skips, while every other slot flows. The alternative — `null` on the port — is a graph
 * carrying on and sending a message addressed to nobody, and the alternative to *that* — gating the
 * whole node — would make one absent `statusDescription` stop a run that only wanted the name.
 */

import { FIELD_CATALOGUES } from "@vrcz/api/fields";
import type {
  NodeConfigValues,
  NodeDefinition,
  PortDefinition,
  PortValues,
} from "@vrcz/plugin-api/nodes";
import { parseSlotRows } from "@vrcz/plugin-api/nodes";
import { readPath } from "./shaping.ts";
import type { BuiltinNode } from "./types.ts";

/**
 * How many of each slot, and the ceiling is `MAX_NODE_PORTS` (16) minus room to breathe.
 *
 * Ten and five, which is fifteen declared ports. Raising either later would restamp the `defHash` of
 * every saved extractor and mark those graphs stale, so the headroom is deliberate rather than spare.
 */
const JSON_SLOTS = 10;
const LIST_SLOTS = 5;

/** The config field every extractor's rows live in. Named once: `variadicOutputs` points at it. */
const ROWS_FIELD = "fields";

/**
 * The slots, in the order the editor draws them when every one is claimed.
 *
 * Labels are placeholders — an instance's ports wear the label from the row that claimed them, and a
 * slot with no row is not drawn at all. They exist because a `PortDefinition` requires one, and
 * because an unclaimed slot that somehow *is* drawn (an edge into it, an imported document) should
 * still say something rather than nothing.
 */
const SLOTS: readonly PortDefinition[] = [
  ...Array.from({ length: JSON_SLOTS }, (_, index) => ({
    id: `o${String(index + 1)}`,
    label: `Value ${String(index + 1)}`,
    type: "json" as const,
  })),
  ...Array.from({ length: LIST_SLOTS }, (_, index) => ({
    id: `l${String(index + 1)}`,
    label: `List ${String(index + 1)}`,
    type: "list<json>" as const,
  })),
];

const SLOT_TYPES = new Map(SLOTS.map((slot) => [slot.id, slot.type]));

/** One default row, as the stored value: a fresh node is never a card with no ports at all. */
function defaultRow(path: string, label: string): string {
  return JSON.stringify([{ slot: "o1", path, label, list: false }]);
}

/* -------------------------------------------------------------------------------------------- */
/* The definitions                                                                                */
/* -------------------------------------------------------------------------------------------- */

const RAW: NodeDefinition = {
  id: "extract-raw",
  kind: "action",
  title: "Extract raw values",
  description: "Pulls several values out of any object, one output port per path you name.",
  category: "Data",
  inputs: [{ id: "value", label: "From", type: "json", required: true }],
  outputs: SLOTS,
  variadicOutputs: ROWS_FIELD,
  config: [
    {
      kind: "paths",
      id: ROWS_FIELD,
      label: "Values",
      placeholder: "user.displayName",
      description:
        "One row per value. Dotted or bracketed: user.tags[0] and $.user.tags.0 both work. Tick 'several' for a path that lands on a list, which puts it on a port a For each will take. A path that finds nothing leaves its own port empty and skips whatever it was wired to.",
      max: SLOTS.length,
    },
  ],
};

/**
 * A typed extractor, built from the generated catalogue.
 *
 * The options travel **inside the definition** rather than being looked up by the editor, which is
 * what keeps the UI free of any catalogue of its own: whoever registers a node declares what its
 * picker offers, and a plugin's extractor over its own schema works the same way. Options are not
 * hashed — a definition is pinned by its config field *kinds* — so a spec bump that adds a field
 * does not mark every saved graph stale.
 */
function typedExtractor(
  model: string,
  title: string,
  description: string,
  fallback: { path: string; label: string },
): NodeDefinition {
  const catalogue = FIELD_CATALOGUES[model] ?? [];
  return {
    id: `extract-${model}`,
    kind: "action",
    title,
    description,
    category: "Data",
    inputs: [{ id: "value", label: "From", type: "json", required: true }],
    outputs: SLOTS,
    variadicOutputs: ROWS_FIELD,
    config: [
      {
        kind: "fields",
        id: ROWS_FIELD,
        label: "Values",
        description:
          "One row per value. A field that holds several of something lands on a port a For each will take; one that is not there at all leaves its own port empty and skips whatever it was wired to.",
        options: catalogue.map((field) => ({
          value: field.path,
          label: field.path,
          list: field.list,
        })),
        max: SLOTS.length,
        default: defaultRow(fallback.path, fallback.label),
      },
    ],
  };
}

/**
 * The five, and what each one starts with.
 *
 * The default row is a name in every case, because that is the field somebody wants nine times out
 * of ten and because a freshly dropped card with no ports teaches nothing about what the node is
 * for. The label beside it is the friendly one — the picker writes the catalogue's own path in as the
 * label when a field is chosen, and this is the one place a better word is worth spelling out.
 */
const TYPED: readonly {
  model: string;
  title: string;
  description: string;
  fallback: { path: string; label: string };
}[] = [
  {
    model: "user",
    title: "Extract user values",
    description: "Pulls several fields out of a user, one output port per field.",
    fallback: { path: "displayName", label: "Name" },
  },
  {
    model: "world",
    title: "Extract world values",
    description: "Pulls several fields out of a world, one output port per field.",
    fallback: { path: "name", label: "Name" },
  },
  {
    model: "group",
    title: "Extract group values",
    description: "Pulls several fields out of a group, one output port per field.",
    fallback: { path: "name", label: "Name" },
  },
  {
    model: "avatar",
    title: "Extract avatar values",
    description: "Pulls several fields out of an avatar, one output port per field.",
    fallback: { path: "name", label: "Name" },
  },
  {
    model: "instance",
    title: "Extract instance values",
    description: "Pulls several fields out of an instance, one output port per field.",
    fallback: { path: "name", label: "Name" },
  },
];

/* -------------------------------------------------------------------------------------------- */
/* Execution                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * Every claimed slot that found something.
 *
 * Three ways a row produces nothing, and all three are the same sentence at the port: the slot is
 * not one this node has, another row claimed it first, or the path found nothing. A list row whose
 * value is not a list is the fourth — the author said this field holds several of something, and
 * handing a `For each` a single object because VRChat answered with one would be the node deciding
 * it knew better.
 */
export function extractValues(inputs: PortValues, config: NodeConfigValues): PortValues {
  const out: Record<string, unknown> = {};
  const claimed = new Set<string>();
  for (const row of parseSlotRows(config[ROWS_FIELD])) {
    const type = SLOT_TYPES.get(row.slot);
    if (type === undefined || claimed.has(row.slot)) continue;
    claimed.add(row.slot);
    const found = readPath(inputs.value, row.path);
    if (found === undefined) continue;
    if (type === "list<json>") {
      if (!Array.isArray(found)) continue;
      out[row.slot] = found;
      continue;
    }
    out[row.slot] = found;
  }
  return out;
}

/* -------------------------------------------------------------------------------------------- */
/* The set                                                                                        */
/* -------------------------------------------------------------------------------------------- */

export function extractNodes(): BuiltinNode[] {
  return [
    { definition: RAW, execute: extractValues },
    ...TYPED.map((entry) => ({
      definition: typedExtractor(entry.model, entry.title, entry.description, entry.fallback),
      execute: extractValues,
    })),
  ];
}
