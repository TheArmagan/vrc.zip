/**
 * Building an object, on ports the author names.
 *
 * The mirror of `extract.ts`, and the reason it exists is the node it supersedes. `Make an object`
 * has three ports called A, B and C and three text boxes saying what each one is called: six controls
 * for three keys, a cap of three nobody chose, and a card where nothing says which wire is the title
 * and which is the body. This is that shape said properly — a list of keys, and one input port per
 * key, wearing the key's own name.
 *
 * Pure, like everything else in the Data and Collections families. It reads its inputs and answers
 * with an object; nothing leaves the process.
 *
 * ## Why the ports are slots
 *
 * A node's ports are its identity — hashed into `defHash`, referenced by every saved edge, checked on
 * every wire — so they cannot be computed from an instance's config. Every slot is declared, always,
 * and the config decides which are drawn and what they are called. See `variadicInputSlots` in
 * `@vrcz/plugin-api`, which is the input half of the mechanism the extractors use.
 *
 * And a row **stores the slot it claims** rather than taking the next one by position. Rows are added
 * and removed in the middle; a positional rule would silently re-point every wire below a deleted row
 * at a different key, which is a graph quietly sending the world name as the user's name.
 *
 * ## Keys are literal, and nesting is composition
 *
 * `user.name` is a key with a dot in it, not a route to a nested field. The alternative — treating a
 * dot as structure, the way `readPath` does in the other direction — would mean a graph could not
 * produce a key that has one, and VRChat's own payloads are full of dotted names. A nested object is
 * a second `Compose JSON` wired into the first, which is the same answer said in the canvas.
 *
 * ## A key with nothing in it is a key the object does not have
 *
 * An unwired slot, or one whose branch produced nothing, leaves its key **out** rather than setting
 * it to null. The two are different things to whatever reads the object afterwards — an absent
 * `status` field and a `status` of null mean different things to VRChat's API and to a webhook — and
 * a node that invented nulls would be deciding which one the author meant. A deliberate null is a
 * `JSON value` node holding `null`, wired in.
 */

import type {
  NodeConfigValues,
  NodeDefinition,
  PortDefinition,
  PortValues,
} from "@vrcz/plugin-api/nodes";
import { parseSlotRows } from "@vrcz/plugin-api/nodes";
import type { BuiltinNode } from "./types.ts";

/**
 * How many keys one node can hold, and the ceiling is `MAX_NODE_PORTS` (16) minus room to breathe.
 *
 * Twelve, with the same reasoning the extractors' fifteen has: raising it later would restamp the
 * `defHash` of every saved node and mark those graphs stale, so the headroom is deliberate. Twelve
 * is also past the point where one object is still readable on a card — beyond it, composing two
 * objects and merging them is the clearer graph anyway.
 */
const KEY_SLOTS = 12;

/** The config field the rows live in. Named once: `variadicInputSlots` points at it. */
const ROWS_FIELD = "keys";

/**
 * The slots, in the order the editor draws them when every one is claimed.
 *
 * The labels are placeholders — an instance's ports wear the key from the row that claimed them, and
 * a slot with no row is not drawn at all. They exist because a `PortDefinition` requires one, and so
 * that a slot which somehow *is* drawn (an edge into it, an imported document) still says something.
 *
 * All `json`, because a key holds whatever it is given. A bank of typed slots would buy a type check
 * at the cost of the author choosing a bank per key, and the object being built has no schema for
 * that check to be against.
 */
const SLOTS: readonly PortDefinition[] = Array.from({ length: KEY_SLOTS }, (_, index) => ({
  id: `v${String(index + 1)}`,
  label: `Value ${String(index + 1)}`,
  type: "json" as const,
}));

const SLOT_IDS = new Set(SLOTS.map((slot) => slot.id));

/** One row, as the stored value: a fresh card is never one with no ports at all. */
const DEFAULT_ROWS = JSON.stringify([{ slot: "v1", path: "name", label: "", list: false }]);

const COMPOSE_JSON: NodeDefinition = {
  id: "compose-json",
  kind: "action",
  title: "Compose JSON",
  description: "Builds an object from a list of keys, one input port per key.",
  category: "Collections",
  inputs: SLOTS,
  variadicInputSlots: ROWS_FIELD,
  outputs: [{ id: "value", label: "Object", type: "json" }],
  config: [
    {
      kind: "keys",
      id: ROWS_FIELD,
      label: "Keys",
      placeholder: "displayName",
      description:
        "One row per key, and each one adds an input port named after it. A key is used exactly as typed, so a dot is part of the name rather than a nested field: wire a second Compose JSON in for that. A port with nothing wired to it leaves its key out of the object entirely.",
      max: KEY_SLOTS,
      default: DEFAULT_ROWS,
    },
  ],
  body: [{ kind: "literal", text: "an object" }],
};

/**
 * The object, built from the rows that claimed a slot and found a value.
 *
 * Four ways a row contributes nothing, and all four are the same thing at the output: the slot is not
 * one this node has, another row claimed it first, the key is blank, or nothing was wired in. The
 * first two are shapes only a round-tripped document produces; the last is ordinary.
 *
 * Built through `Object.fromEntries` rather than by assigning into a literal, and that is a safety
 * property rather than a style: `out[key] = value` with a key of `__proto__` walks into the setter on
 * `Object.prototype` and changes the object's prototype instead of adding a field. The keys here are
 * typed by a person into a document that is exported and imported again, which is exactly the path
 * that eventually carries one. `fromEntries` defines the property instead, so `__proto__` is a field
 * called `__proto__`.
 */
export function composeJson(inputs: PortValues, config: NodeConfigValues): PortValues {
  const entries: [string, unknown][] = [];
  const claimedSlots = new Set<string>();
  const claimedKeys = new Set<string>();

  for (const row of parseSlotRows(config[ROWS_FIELD])) {
    if (!SLOT_IDS.has(row.slot) || claimedSlots.has(row.slot)) continue;
    claimedSlots.add(row.slot);
    const key = row.path.trim();
    // The first row wins a repeated key, the same rule two buttons with one name follow: the editor
    // has to be typeable through a state where two rows match, so the drop belongs here.
    if (key === "" || claimedKeys.has(key)) continue;
    const value = inputs[row.slot];
    if (value === undefined) continue;
    claimedKeys.add(key);
    entries.push([key, value]);
  }
  return { value: Object.fromEntries(entries) };
}

export function composeNodes(): BuiltinNode[] {
  return [{ definition: COMPOSE_JSON, execute: composeJson }];
}
