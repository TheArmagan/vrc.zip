/**
 * Signals: one graph saying something, and any graph hearing it.
 *
 * ## Why a graph needs to talk to another graph
 *
 * Graphs are separate documents on purpose — a graph is a thing you enable, arm and disable on its
 * own. That is right up to the moment two of them are about the same subject: one watches joins and
 * decides somebody is worth greeting, another owns *how* greeting is done, and without a way to say
 * so the second one has to be copied into the first. Copies drift.
 *
 * A signal is the smallest thing that fixes it: a **name**, a **value**, and a scope.
 *
 * ## Local and global, and why they are different event kinds
 *
 *   local   only this graph hears it. Sequencing a graph with itself — finish this branch, then
 *           start that one — without an edge between them.
 *   global  every graph hears it, and it lands in the feed as `graph.signal`.
 *
 * The split is enforced in two places and they are not redundant. The trigger filters by the
 * emitting graph, which is what makes local *local*; and the two use different bus kinds, which is
 * what keeps the local hop out of the feed — `graph.signal.local` is in the feed writer's
 * `EPHEMERAL` set. A single kind with a `scope` field in the payload would have made the feed writer
 * read payloads to decide what to persist, which nothing else in the daemon does.
 *
 * ## A rehearsal does not signal
 *
 * A dry run must not emit. A global signal can start a run in *another* graph, and that graph's
 * armed state is its own — so a rehearsal that signalled could reach through an armed neighbour and
 * send a real invite. That is the one thing dry-run exists to prevent, so an unarmed graph logs what
 * it would have said and says nothing.
 */

import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import type { BusEvent, EventBus } from "../../bus/event-bus.ts";
import type { ExecuteContext } from "../types.ts";
import type { GraphStateStore } from "./stateful.ts";
import type { BuiltinArmRequest, BuiltinNode } from "./types.ts";

export interface SignalDeps {
  readonly bus: EventBus;
  readonly now?: () => number;
  /**
   * Where `only the first time` remembers that it has already fired.
   *
   * Optional, and the fallback is deliberate rather than a degradation: with no store the node still
   * fires once per *process*, held in memory. A "once" that silently became "every time" because a
   * daemon was built without a store would be the worst of the three outcomes.
   */
  readonly state?: GraphStateStore | undefined;
}

export const SIGNAL_KIND = "graph.signal";
export const LOCAL_SIGNAL_KIND = "graph.signal.local";

/** What rides in a signal's payload. Both the emitter and the trigger read this shape. */
export interface SignalPayload {
  readonly name: string;
  readonly graphId: string;
  readonly value: unknown;
}

const NAME_FIELD = {
  kind: "text",
  id: "name",
  label: "Called",
  placeholder: "greet",
  description: "The name a listening graph waits for. Anything you like; match it exactly.",
  required: true,
} as const;

/* -------------------------------------------------------------------------------------------- */
/* Emitting                                                                                       */
/* -------------------------------------------------------------------------------------------- */

const EMIT: NodeDefinition = {
  id: "emit-signal",
  kind: "action",
  title: "Send a signal",
  description: "Says something by name, for this graph or every graph to hear.",
  category: "Send",
  inputs: [
    {
      id: "value",
      label: "With",
      type: "json",
      description: "Whatever the listener should receive. Optional.",
    },
  ],
  outputs: [{ id: "sent", label: "Sent", type: "boolean" }],
  config: [
    NAME_FIELD,
    {
      kind: "select",
      id: "scope",
      label: "Heard by",
      options: [
        { value: "local", label: "this graph only" },
        { value: "global", label: "every graph, and the feed" },
      ],
      default: "local",
    },
  ],
  body: [
    { kind: "literal", text: "signal " },
    { kind: "config", field: "name", fallback: "…" },
  ],
};

/* -------------------------------------------------------------------------------------------- */
/* Hearing                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const ON_SIGNAL: NodeDefinition = {
  id: "on-signal",
  kind: "trigger",
  title: "When a signal arrives",
  description: "Fires when a graph sends a signal by this name.",
  category: "Triggers",
  outputs: [
    { id: "value", label: "With", type: "json" },
    { id: "name", label: "Called", type: "string" },
    { id: "graph", label: "From graph", type: "string", description: "The id of the sender." },
    { id: "at", label: "At", type: "number" },
  ],
  config: [
    NAME_FIELD,
    {
      kind: "select",
      id: "scope",
      label: "Listen to",
      options: [
        { value: "any", label: "this graph and every other" },
        { value: "local", label: "this graph only" },
        { value: "global", label: "other graphs only" },
      ],
      default: "any",
    },
    {
      kind: "boolean",
      id: "once",
      label: "Only the first time",
      default: false,
      description: "Fires once and then never again. Select this node to forget that it did.",
    },
  ],
  maxFiresPerMinute: 240,
  body: [
    { kind: "literal", text: "on " },
    { kind: "config", field: "name", fallback: "…" },
  ],
};

/** The state key `only the first time` writes under. One row per node; the dimension is unused. */
export const ONCE_KEY = "once";

function signalOf(event: BusEvent): SignalPayload | null {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const name = record.name;
  const graphId = record.graphId;
  if (typeof name !== "string" || typeof graphId !== "string") return null;
  return { name, graphId, value: record.value ?? null };
}

function configText(config: NodeConfigValues, id: string): string {
  const raw = config[id];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Which bus kinds a listener subscribes to.
 *
 * `local` still subscribes only to the local kind and `global` only to the global one, so the bus
 * does the coarse filtering with a map lookup and the callback only has to answer the question the
 * bus cannot: *which graph* sent it.
 */
export function signalKinds(scope: string): readonly string[] {
  if (scope === "local") return [LOCAL_SIGNAL_KIND];
  if (scope === "global") return [SIGNAL_KIND];
  return [LOCAL_SIGNAL_KIND, SIGNAL_KIND];
}

export function signalNodes(deps: SignalDeps): BuiltinNode[] {
  const now = deps.now ?? Date.now;
  const state = deps.state;
  /** The in-memory fallback for `once` when there is no store. Per process, by graph and node. */
  const fired = new Set<string>();

  return [
    {
      definition: EMIT,
      execute: (inputs, config, context: ExecuteContext): PortValues => {
        const name = configText(config, "name");
        if (name === "") return { sent: false };
        const global = config.scope === "global";
        if (context.dryRun) {
          // Nothing on the bus. See the note at the top: an armed neighbour would act on it.
          // The same `graph.note` shape every other rehearsing action writes, so the feed renders
          // one kind of "would have" line rather than two.
          deps.bus.emit({
            kind: "graph.note",
            accountId: context.accountId,
            ts: now(),
            subjectId: context.graphId,
            payload: {
              graphId: context.graphId,
              node: context.nodeId,
              dryRun: true,
              note: `Signal ${name}, heard by ${global ? "every graph" : "this graph"}`,
            },
          });
          return { sent: false };
        }
        const payload: SignalPayload = {
          name,
          graphId: context.graphId,
          value: inputs.value ?? null,
        };
        deps.bus.emit({
          kind: global ? SIGNAL_KIND : LOCAL_SIGNAL_KIND,
          // A signal belongs to a graph, not to a VRChat account: several graphs can act as
          // different accounts and a listener filters by graph, never by account.
          accountId: null,
          ts: now(),
          // The signal's name, so the feed can group by it and a webhook filter can match on it
          // without opening the payload.
          subjectId: name,
          payload: { ...payload },
        });
        return { sent: true };
      },
    },
    {
      definition: ON_SIGNAL,
      arm: (request: BuiltinArmRequest) => {
        const wanted = configText(request.config, "name");
        if (wanted === "") return;
        const scope = configText(request.config, "scope") || "any";
        const once = request.config.once === true;

        const subscription = deps.bus.subscribe(
          (event) => {
            const signal = signalOf(event);
            if (signal === null || signal.name !== wanted) return;
            // The bus filtered by kind; this is the part it cannot do — *which graph* sent it.
            const mine = signal.graphId === request.graphId;
            // A local signal never leaves its graph, whatever the listener asked to hear. This is
            // the invariant, and it is checked before the listener's own preference precisely so a
            // listener set to "anything" cannot widen somebody else's `local` into a global one.
            if (event.kind === LOCAL_SIGNAL_KIND && !mine) return;
            // Then the listener's preference. `global` meaning "other graphs only" is what makes
            // "everybody react to this except me" expressible at all.
            if (scope === "local" && !mine) return;
            if (scope === "global" && mine) return;
            if (once && !claimFirst(state, fired, request, now)) return;
            request.fire({
              value: signal.value,
              name: signal.name,
              graph: signal.graphId,
              at: event.ts,
            });
          },
          { kinds: signalKinds(scope) },
        );
        return () => {
          subscription.unsubscribe();
        };
      },
    },
  ];
}

/**
 * Takes the one fire `only the first time` is allowed, or refuses.
 *
 * Written before the fire rather than after it, so two signals arriving in the same tick cannot both
 * pass — the second reads what the first wrote. The same ordering the cooldown node uses, and for
 * the same reason.
 */
function claimFirst(
  state: GraphStateStore | undefined,
  fired: Set<string>,
  request: BuiltinArmRequest,
  now: () => number,
): boolean {
  if (state === undefined) {
    // Keyed by the graph and the node, not by the instance id: an instance id is minted afresh on
    // every arm, so a saved graph or a daemon reload re-armed the node under a name the set had
    // never seen and `only the first time` fired again. The store half is keyed this way already,
    // and the fallback promises the same thing for a process rather than for an arming.
    const key = `${request.graphId} ${request.nodeId}`;
    if (fired.has(key)) return false;
    fired.add(key);
    return true;
  }
  if (state.get(request.graphId, request.nodeId, ONCE_KEY) !== null) return false;
  state.put(request.graphId, request.nodeId, ONCE_KEY, "1", now());
  return true;
}
