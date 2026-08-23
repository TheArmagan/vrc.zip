/**
 * The two nodes that remember something between runs.
 *
 * Everything else in the built-in set is pure: same inputs, same outputs, no trace afterwards. These
 * two are not, and the reason is that the automations people actually want are not either. "Tell me
 * when Ada comes online" becomes "tell me *once*, not the four times she reconnects while her
 * headset settles", and there is no way to say that without remembering the last time.
 *
 * ## The cooldown is the safety one
 *
 * A counter is a convenience. A cooldown is what makes a graph safe to arm: a run that fires on
 * `player_join` in a busy public instance can message somebody forty times in a minute, and the node
 * that stops it has to be reachable by an author who has not thought about rate limits yet.
 *
 * ## Keyed by whatever the author wires in
 *
 * `key` is usually a user id, which makes the cooldown per person rather than per graph — the
 * difference between "quiet for an hour about Ada" and "quiet for an hour about everybody". Nothing
 * wired means one shared key, which is the right default for a graph about the world rather than
 * about people.
 *
 * State lives in `graph_state`, keyed by (graph, node, key), and dies with the graph.
 */

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import type { ExecuteContext } from "../types.ts";
import type { BuiltinNode } from "./types.ts";

/**
 * What a stateful node needs from the store.
 *
 * Four methods rather than a `Store`, for the same reason every other seam here is narrow: the
 * graph runtime has no business with SQLite, and a fake for a test is three lines.
 */
export interface GraphStateStore {
  get(graphId: string, nodeId: string, key: string): { value: string; updatedAt: number } | null;
  put(graphId: string, nodeId: string, key: string, value: string, now: number): void;
}

const COOLDOWN: NodeDefinition = {
  id: "cooldown",
  kind: "action",
  title: "Not too often",
  description: "Stops the run if it has already been through here recently.",
  category: "Logic",
  inputs: [
    {
      id: "key",
      label: "Per",
      type: "json",
      description: "A user, a world, anything. Leave it unwired for one shared cooldown.",
    },
    { id: "payload", label: "Carry", type: "json" },
  ],
  outputs: [{ id: "out", label: "Then", type: "json" }],
  config: [
    {
      kind: "number",
      id: "windowMs",
      label: "Quiet for (ms)",
      min: 0,
      default: 3_600_000,
      required: true,
    },
  ],
  body: [
    { kind: "literal", text: "at most once per " },
    { kind: "config", field: "windowMs", fallback: "hour" },
    { kind: "literal", text: "ms" },
  ],
};

const COUNTER: NodeDefinition = {
  id: "counter",
  kind: "action",
  title: "Running total",
  description: "Adds one each time the run passes through, and reports the running total.",
  category: "Data",
  inputs: [
    { id: "key", label: "Per", type: "json" },
    { id: "by", label: "Add", type: "number", description: "Defaults to one." },
  ],
  outputs: [{ id: "count", label: "Count", type: "number" }],
  config: [
    {
      kind: "number",
      id: "resetAfterMs",
      label: "Start over after (ms)",
      min: 0,
      default: 0,
      description: "Zero means never. 86400000 is a day, which makes it a daily count.",
    },
  ],
  body: [{ kind: "literal", text: "count" }],
};

/** The dimension a stateful node is keyed by. Empty is a real key: "no dimension". */
function keyOf(inputs: PortValues): string {
  const raw = inputs.key;
  if (raw === undefined || raw === null) return "";
  const key = typeof raw === "string" ? raw : JSON.stringify(raw);
  // Bounded, because this is a primary key column and the value came off the wire. A user id is 41
  // characters; anything past this is somebody wiring a whole event payload in by mistake.
  return (key ?? "").slice(0, 200);
}

function configNumber(config: NodeConfigValues, key: string, fallback: number): number {
  const raw = config[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function statefulNodes(state: GraphStateStore, now: () => number): BuiltinNode[] {
  return [
    {
      definition: COOLDOWN,
      execute: (inputs, config, context: ExecuteContext): PortValues => {
        const key = keyOf(inputs);
        const window = configNumber(config, "windowMs", 3_600_000);
        const at = now();
        const last = state.get(context.graphId, context.nodeId, key);

        if (last !== null && at - last.updatedAt < window) {
          // Nothing, which stops the run here. The graph did what it was told: not too often.
          return {};
        }
        // Written *before* letting the run through, so two fires landing in the same millisecond
        // cannot both pass: the second reads the row the first wrote.
        state.put(context.graphId, context.nodeId, key, String(at), at);
        return { out: inputs.payload ?? true };
      },
    },
    {
      definition: COUNTER,
      execute: (inputs, config, context: ExecuteContext): PortValues => {
        const key = keyOf(inputs);
        const at = now();
        const reset = configNumber(config, "resetAfterMs", 0);
        const previous = state.get(context.graphId, context.nodeId, key);
        const expired = previous !== null && reset > 0 && at - previous.updatedAt >= reset;
        const base = previous === null || expired ? 0 : Number(previous.value);
        const by = typeof inputs.by === "number" && Number.isFinite(inputs.by) ? inputs.by : 1;
        const count = (Number.isFinite(base) ? base : 0) + by;
        state.put(context.graphId, context.nodeId, key, String(count), at);
        return { count };
      },
    },
  ];
}
