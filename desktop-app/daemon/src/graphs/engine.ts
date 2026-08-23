/**
 * The graph runtime: arms triggers, walks runs, parks them on a `wait`, and enforces the ceilings.
 *
 * PLAN.md §Phase 4 is the spec and PROGRESS.md decision 206 is why it is shaped this way. The two
 * ideas everything else follows from:
 *
 * 1. **A missing key is the only gating mechanism.** A node records what it produced; a port with no
 *    entry is dead, and any node with a dead input is skipped. A condition that answered false
 *    records nothing, a branch records one side, a node that failed onto its error port records only
 *    `error` — three features, one rule in the walk, and nothing that needs a second kind of edge.
 * 2. **A run is durable.** It exists in `graph_runs` from the moment it starts, is rewritten at
 *    every node boundary, and is deleted when it ends. That is what lets a `wait` outlive the
 *    process, and it is why the ceilings can be answered with a `COUNT(*)` that a restart cannot
 *    disagree with.
 *
 * What is not here yet: `foreach` (the other half of the iteration answer), and the type check on
 * save. Both are named in the Phase 4 checklist.
 */

import { randomUUID } from "node:crypto";
import type { NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import {
  type GraphDocument,
  type GraphEdge,
  type GraphEventKind,
  type GraphNode,
  reachableFrom,
  validateGraphDocument,
} from "@vrcz/shared";
import type { EventBus } from "../bus/event-bus.ts";
import type { Store } from "../store/index.ts";
import type { GraphRow, GraphRunRow } from "../store/types.ts";
import {
  BRANCH_TYPE,
  ERROR_PORT,
  FOREACH_TYPE,
  INTRINSIC_DEFINITIONS,
  MISSED_RESUME_GRACE_MS,
  WAIT_TYPE,
} from "./intrinsics.ts";
import { DEFAULT_GRAPH_LIMITS, GraphCounters, type GraphLimits } from "./limits.ts";
import type { NodeProvider, RunOutcome, RunState } from "./types.ts";

export interface GraphEngineOptions {
  readonly store: Store;
  readonly bus: EventBus;
  readonly provider: NodeProvider;
  readonly limits?: Partial<GraphLimits>;
  /** Injected so a test can drive the clock without waiting for one. */
  readonly now?: () => number;
  /** Resume sweep interval. `0` leaves the sweep manual, which is how the tests run it. */
  readonly sweepMs?: number;
  /** Where a failure that belongs to no run goes. Default: `console.error`. */
  readonly onError?: (message: string, error: unknown) => void;
}

/** Why a fire was not honoured. Carried on `graph.run.dropped`, because silence is the failure. */
type DropReason = "fire_rate" | "busy" | "queue_full" | "unavailable";

const DEFAULT_SWEEP_MS = 5_000;

export class GraphEngine {
  readonly #store: Store;
  readonly #bus: EventBus;
  readonly #provider: NodeProvider;
  readonly #limits: GraphLimits;
  readonly #now: () => number;
  readonly #sweepMs: number;
  readonly #onError: (message: string, error: unknown) => void;
  readonly #counters = new GraphCounters();

  /** Armed trigger instances, keyed `<graphId>:<nodeId>`, so a reload can disarm precisely. */
  readonly #armed = new Map<string, { readonly type: string; readonly instanceId: string }>();

  /**
   * Runs currently being walked, so a resume sweep landing on top of a live run cannot start a
   * second walk of it. The database says a run is `running`; this says *this process* is on it.
   */
  readonly #walking = new Set<string>();

  #sweep: ReturnType<typeof setInterval> | undefined;
  #started = false;

  constructor(options: GraphEngineOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#provider = options.provider;
    this.#limits = { ...DEFAULT_GRAPH_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
    this.#sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;
    this.#onError =
      options.onError ??
      ((message, error) => {
        console.error(`[vrc.zip] ${message}`, error);
      });
  }

  /** How many trigger instances are armed. The cheapest honest answer to "is this thing on". */
  get armedCount(): number {
    return this.#armed.size;
  }

  /**
   * Arms every enabled graph and picks up runs left parked by a previous process.
   *
   * The order matters: parked runs are resumed **before** the sweep timer starts, so a machine that
   * was off past a resume time settles its backlog once rather than racing the first tick.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    for (const graph of this.#store.listEnabledGraphs()) await this.#arm(graph);
    await this.resumeDue();
    if (this.#sweepMs > 0) {
      this.#sweep = setInterval(() => {
        void this.resumeDue().catch((error: unknown) => {
          this.#onError("graph resume sweep failed", error);
        });
      }, this.#sweepMs);
      // The sweep must never be the reason a daemon refuses to exit.
      this.#sweep.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#sweep !== undefined) clearInterval(this.#sweep);
    this.#sweep = undefined;
    for (const key of [...this.#armed.keys()]) await this.#disarmKey(key);
    this.#counters.clear();
  }

  /**
   * Re-reads one graph and arms or disarms it to match.
   *
   * Called after a save, an enable, a disable and a delete — all four are the same question, which
   * is why they are one method. A graph whose document changed is disarmed and armed again rather
   * than diffed: a trigger's config may have moved, and re-arming is cheap next to being subtly
   * wrong about which subscription is live.
   */
  async reload(graphId: string): Promise<void> {
    for (const key of [...this.#armed.keys()]) {
      if (key.startsWith(`${graphId}:`)) await this.#disarmKey(key);
    }
    const graph = this.#store.getGraph(graphId);
    if (graph === null || graph.enabled !== 1 || !this.#started) return;
    await this.#arm(graph);
  }

  /** Resumes every parked run whose time has come, and applies the missed policy to the rest. */
  async resumeDue(): Promise<void> {
    const now = this.#now();
    for (const run of this.#store.listDueGraphRuns(now)) {
      if (this.#walking.has(run.id)) continue;
      await this.#resume(run, now);
    }
  }

  /**
   * Starts a run, subject to every ceiling. Public because the manual "run now" trigger (4.3) and
   * the tests both need the same door a plugin trigger comes through.
   */
  async fire(graphId: string, nodeId: string, outputs: PortValues): Promise<void> {
    const now = this.#now();
    const graph = this.#store.getGraph(graphId);
    // Not an error: a fire can arrive from a plugin between a disable and its disarm landing.
    if (graph === null || graph.enabled !== 1) return;

    const fires = this.#counters.fires.hit(`${graphId}:${nodeId}`, now);
    const ceiling = this.#firesPerMinute(graph, nodeId);
    if (fires > ceiling) {
      this.#drop(graph, nodeId, "fire_rate", `over ${String(ceiling)} fires per minute`);
      return;
    }

    const runsThisHour = this.#counters.runs.hit(graphId, now);
    if (runsThisHour > this.#limits.maxRunsPerHour) {
      // The one ceiling whose answer is to switch the graph off. A graph running two hundred times
      // an hour is not going to recover on the next fire, and dropping quietly for the rest of the
      // evening would be indistinguishable from being broken.
      const reason = `Ran more than ${String(this.#limits.maxRunsPerHour)} times in an hour.`;
      this.#store.setGraphEnabled(graphId, false, reason, now);
      this.#emit("graph.disabled", graph, { reason, node: nodeId });
      await this.reload(graphId);
      return;
    }

    const live = this.#store.countLiveGraphRuns(graphId);
    if (graph.concurrency === "drop" && live > 0) {
      this.#drop(graph, nodeId, "busy", "a run is already in flight");
      return;
    }
    if (graph.concurrency === "parallel" && live >= this.#limits.maxParallelRuns) {
      this.#drop(graph, nodeId, "busy", `already running ${String(live)} times`);
      return;
    }
    if (graph.concurrency === "queue" && live > 0) {
      const queued = this.#store.countGraphRunsByStatus(graphId, "queued");
      if (queued >= this.#limits.maxQueuedRuns) {
        this.#drop(graph, nodeId, "queue_full", `${String(queued)} fires already waiting`);
        return;
      }
      this.#insertRun(graph, nodeId, outputs, "queued", now);
      return;
    }

    const runId = this.#insertRun(graph, nodeId, outputs, "running", now);
    await this.#advance(runId);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Arming                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  async #arm(graph: GraphRow): Promise<void> {
    const document = readDocument(graph);
    if (document === null) {
      this.#onError(`graph ${graph.id} has an unreadable document and was not armed`, null);
      return;
    }
    const targets = new Set(document.edges.map((edge) => edge.to.node));
    for (const node of document.nodes) {
      // A trigger is a root: nothing upstream can hand it a value, so anything with an incoming
      // edge is not one, whatever its definition says.
      if (targets.has(node.id)) continue;
      const definition = this.#definition(node.type);
      if (definition === null || definition.kind !== "trigger") continue;

      const key = `${graph.id}:${node.id}`;
      const instanceId = randomUUID();
      this.#armed.set(key, { type: node.type, instanceId });
      try {
        await this.#provider.arm(node.type, {
          instanceId,
          graphId: graph.id,
          nodeId: node.id,
          config: node.config,
          fire: (outputs) => {
            // `fire` is sync by contract (a plugin calls it from a socket handler), so the run is
            // started detached. A rejection here belongs to nobody, which is why it is logged.
            void this.fire(graph.id, node.id, outputs).catch((error: unknown) => {
              this.#onError(`graph ${graph.id} failed to start a run`, error);
            });
          },
        });
      } catch (error) {
        this.#armed.delete(key);
        this.#onError(`graph ${graph.id} could not arm ${node.type}`, error);
      }
    }
  }

  async #disarmKey(key: string): Promise<void> {
    const armed = this.#armed.get(key);
    if (armed === undefined) return;
    this.#armed.delete(key);
    this.#counters.fires.forget(key);
    try {
      await this.#provider.disarm(armed.type, armed.instanceId);
    } catch (error) {
      // A disarm that throws still counts as disarmed here: the alternative is an entry that can
      // never be cleared and a trigger the engine believes is live forever.
      this.#onError(`could not disarm ${armed.type}`, error);
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Running                                                                                    */
  /* ---------------------------------------------------------------------------------------- */

  #insertRun(
    graph: GraphRow,
    triggerNode: string,
    outputs: PortValues,
    status: "running" | "queued",
    now: number,
  ): string {
    const id = randomUUID();
    const state: RunState = { outputs: { [triggerNode]: outputs }, skipped: [], executed: [] };
    this.#store.insertGraphRun({
      id,
      graph_id: graph.id,
      trigger_node: triggerNode,
      status,
      // Captured here, not read from the graph when an action runs: arming a graph must not promote
      // a rehearsal that is already in flight into the real thing.
      dry_run: graph.armed === 1 ? 0 : 1,
      state: JSON.stringify(state),
      started_at: now,
      updated_at: now,
    });
    return id;
  }

  async #advance(runId: string): Promise<void> {
    if (this.#walking.has(runId)) return;
    this.#walking.add(runId);
    try {
      const run = this.#store.getGraphRun(runId);
      if (run === null) return;
      const graph = this.#store.getGraph(run.graph_id);
      const document = graph === null ? null : readDocument(graph);
      if (graph === null || document === null) {
        this.#store.deleteGraphRun(runId);
        return;
      }
      const state = readState(run);
      const outcome = await this.#walk(graph, document, run, state);
      this.#settle(graph, run, outcome);
      // Awaited rather than detached, so "the next queued run starts when this one ends" is a fact
      // a caller can observe rather than a race a test has to sleep through.
      if (outcome.kind !== "waiting") {
        this.#walking.delete(run.id);
        await this.#pumpQueue(run.graph_id);
      }
    } catch (error) {
      // A throw out of the walk itself is a defect in the engine, not in a node. The run is not
      // left `running` forever regardless: an orphan row would occupy a concurrency slot for good.
      this.#store.deleteGraphRun(runId);
      this.#onError(`graph run ${runId} died`, error);
    } finally {
      this.#walking.delete(runId);
    }
  }

  async #walk(
    graph: GraphRow,
    document: GraphDocument,
    run: GraphRunRow,
    state: RunState,
  ): Promise<RunOutcome> {
    const bodies = foreachBodies(document);
    const inBody = new Set([...bodies.values()].flatMap((body) => [...body]));
    const scope: Scope = {
      graph,
      document,
      run,
      nodes: new Map(document.nodes.map((node) => [node.id, node])),
      incoming: incomingEdges(document),
      outgoing: outgoingEdges(document),
      bodies,
    };
    // The outer scope is everything the trigger reaches **except** the bodies of any `foreach`.
    // A body node belongs to its loop and is walked once per item by `#runForeach`; leaving it in
    // the outer scope would run it a second time, with whatever the last iteration left behind.
    const outer = new Set(
      [...reachableFrom(document, run.trigger_node)].filter((id) => !inBody.has(id)),
    );
    return await this.#walkScope(scope, state, outer, false);
  }

  /**
   * Walks one scope until nothing in it is ready.
   *
   * The outer scope draining means the run finished; a `foreach` body draining means one iteration
   * finished. They are the same loop because they are the same question — which is what keeps a
   * loop body from needing a second set of rules about skipping, errors and ceilings.
   */
  async #walkScope(
    scope: Scope,
    state: RunState,
    allowed: ReadonlySet<string>,
    insideForeach: boolean,
  ): Promise<RunOutcome> {
    const { graph, document, run, nodes, incoming, outgoing } = scope;
    for (;;) {
      const nodeId = this.#pickNext(document, allowed, state, incoming);
      if (nodeId === null) return { kind: "finished" };
      const node = nodes.get(nodeId);
      if (node === undefined) return { kind: "finished" };

      const edges = incoming.get(nodeId) ?? [];
      if (edges.some((edge) => isDead(edge, state))) {
        state.skipped.push(nodeId);
        this.#persist(run.id, state);
        continue;
      }

      if (state.executed.length >= this.#limits.maxNodesPerRun) {
        return {
          kind: "failed",
          node: nodeId,
          message: `Ran more than ${String(this.#limits.maxNodesPerRun)} nodes in one run.`,
        };
      }

      const inputs = gatherInputs(edges, state);
      state.executed.push(nodeId);

      if (node.type === WAIT_TYPE) {
        if (insideForeach) {
          // A limit, stated rather than discovered. Parking mid-iteration would mean persisting
          // which item the loop was on and everything it had accumulated, and a resume would have
          // to reconstruct a scope rather than a node. `graph_runs.wait_node` names one node
          // because that is all a run needs to say when the loop is not part of the answer.
          return {
            kind: "failed",
            node: nodeId,
            message: "A Wait cannot be used inside a For each.",
          };
        }
        const resumeAt = this.#now() + waitDuration(node);
        this.#store.parkGraphRun(run.id, nodeId, resumeAt, JSON.stringify(state), this.#now());
        return { kind: "waiting", resumeAt };
      }

      if (node.type === FOREACH_TYPE) {
        const outcome = await this.#runForeach(scope, state, nodeId, inputs);
        if (outcome.kind !== "finished") return outcome;
        this.#persist(run.id, state);
        continue;
      }

      if (node.type === BRANCH_TYPE) {
        // The intrinsic in one line, and it needs no special case downstream: only the side taken
        // is recorded, so the other side's edges are dead and everything under it skips.
        const taken = inputs.value === true ? "true" : "false";
        state.outputs[nodeId] = { [taken]: inputs.payload ?? true };
        this.#persist(run.id, state);
        continue;
      }

      const definition = this.#definition(node.type);
      if (definition === null) {
        return {
          kind: "failed",
          node: nodeId,
          message: `The node type ${node.type} is not available. Its plugin may be stopped.`,
        };
      }

      try {
        const produced = await this.#provider.execute(node.type, inputs, node.config, {
          graphId: graph.id,
          runId: run.id,
          nodeId,
          dryRun: run.dry_run === 1,
          accountId: actingAccount(node, graph),
        });
        state.outputs[nodeId] = gate(definition, produced);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const routed = (outgoing.get(nodeId) ?? []).some(
          (edge) => edge.from.port === ERROR_PORT && !state.skipped.includes(edge.to.node),
        );
        if (!routed) return { kind: "failed", node: nodeId, message };
        // The author wired the failure onward, so it is data now rather than the end of the run.
        // Only `error` is produced, which leaves every other branch of this node dead.
        state.outputs[nodeId] = { [ERROR_PORT]: message };
      }
      this.#persist(run.id, state);
    }
  }

  /**
   * Runs a `foreach` body once per element, in order.
   *
   * Sequential rather than concurrent, and that is the answer for a v1: the body can send invites
   * and hit webhooks, and forty of those at once is the shape the ceilings exist to prevent. Each
   * iteration starts from a clean body — the previous iteration's outputs are cleared — so a node
   * cannot silently read the last item instead of this one.
   *
   * `executed` is **not** cleared, which is what makes the run-size ceiling bound the loop: a
   * thousand iterations of a three-node body is three thousand nodes, and it is refused as such.
   */
  async #runForeach(
    scope: Scope,
    state: RunState,
    nodeId: string,
    inputs: PortValues,
  ): Promise<RunOutcome> {
    const list = Array.isArray(inputs.list) ? (inputs.list as unknown[]) : [];
    if (list.length > this.#limits.maxForeachItems) {
      return {
        kind: "failed",
        node: nodeId,
        message: `A For each may run over ${String(this.#limits.maxForeachItems)} items.`,
      };
    }
    const body = scope.bodies.get(nodeId) ?? new Set<string>();

    for (const [index, item] of list.entries()) {
      state.outputs[nodeId] = { item: item ?? null, index };
      clearScope(state, body);
      const outcome = await this.#walkScope(scope, state, body, true);
      if (outcome.kind !== "finished") return outcome;
    }

    // The loop is over, so `item` and `index` stop being produced and `done` starts: every edge out
    // of the body side is dead from here, and the after-the-loop branch is the only live one.
    // The body's own outputs are deliberately left in place, so a node downstream of *both* the loop
    // and the body reads the last iteration rather than nothing.
    state.outputs[nodeId] = { done: list.length };
    return { kind: "finished" };
  }

  /** The next node whose every incoming edge has settled. Document order, so a run is repeatable. */
  #pickNext(
    document: GraphDocument,
    reachable: ReadonlySet<string>,
    state: RunState,
    incoming: ReadonlyMap<string, GraphEdge[]>,
  ): string | null {
    for (const node of document.nodes) {
      if (!reachable.has(node.id)) continue;
      if (settled(node.id, state)) continue;
      const edges = incoming.get(node.id) ?? [];
      if (edges.every((edge) => settled(edge.from.node, state))) return node.id;
    }
    return null;
  }

  #settle(graph: GraphRow, run: GraphRunRow, outcome: RunOutcome): void {
    if (outcome.kind === "waiting") return;
    this.#store.deleteGraphRun(run.id);
    const base = {
      runId: run.id,
      triggerNode: run.trigger_node,
      dryRun: run.dry_run === 1,
      durationMs: this.#now() - run.started_at,
    };
    if (outcome.kind === "finished") {
      this.#emit("graph.run.finished", graph, base);
    } else {
      this.#emit("graph.run.failed", graph, {
        ...base,
        node: outcome.node,
        message: outcome.message,
      });
    }
  }

  /** Starts the oldest queued fire, if the graph is in `queue` mode and nothing else is running. */
  async #pumpQueue(graphId: string): Promise<void> {
    try {
      if (this.#store.countLiveGraphRuns(graphId) === 0) return;
      const next = this.#store.nextQueuedGraphRun(graphId);
      if (next === null) return;
      if (this.#store.countGraphRunsByStatus(graphId, "running") > 0) return;
      this.#store.updateGraphRunState(next.id, "running", next.state, this.#now());
      await this.#advance(next.id);
    } catch (error) {
      this.#onError(`graph ${graphId} could not start its next queued run`, error);
    }
  }

  async #resume(run: GraphRunRow, now: number): Promise<void> {
    const graph = this.#store.getGraph(run.graph_id);
    const document = graph === null ? null : readDocument(graph);
    if (graph === null || document === null) {
      this.#store.deleteGraphRun(run.id);
      return;
    }
    const waitNode = document.nodes.find((node) => node.id === run.wait_node);
    const missed = run.resume_at !== null && now - run.resume_at > MISSED_RESUME_GRACE_MS;
    if (missed && waitNode !== undefined && onMissed(waitNode) === "skip") {
      // The author's answer to "the app was closed past this time", and the reason it is a per-node
      // choice: a machine asleep for a week must not wake up and act on a world the user has left.
      this.#store.deleteGraphRun(run.id);
      this.#emit("graph.run.expired", graph, {
        runId: run.id,
        triggerNode: run.trigger_node,
        node: run.wait_node,
        lateBy: run.resume_at === null ? null : now - run.resume_at,
      });
      await this.#pumpQueue(graph.id);
      return;
    }

    const state = readState(run);
    if (run.wait_node !== null) {
      const edges = incomingEdges(document).get(run.wait_node) ?? [];
      state.outputs[run.wait_node] = { out: gatherInputs(edges, state).in ?? null };
    }
    this.#store.updateGraphRunState(run.id, "running", JSON.stringify(state), now);
    await this.#advance(run.id);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Small helpers                                                                              */
  /* ---------------------------------------------------------------------------------------- */

  #definition(type: string): NodeDefinition | null {
    return INTRINSIC_DEFINITIONS.get(type) ?? this.#provider.definition(type);
  }

  #firesPerMinute(graph: GraphRow, nodeId: string): number {
    const document = readDocument(graph);
    const node = document?.nodes.find((entry) => entry.id === nodeId);
    const definition = node === undefined ? null : this.#definition(node.type);
    if (definition !== null && definition.kind === "trigger" && definition.maxFiresPerMinute) {
      return definition.maxFiresPerMinute;
    }
    return this.#limits.defaultFiresPerMinute;
  }

  #persist(runId: string, state: RunState): void {
    this.#store.updateGraphRunState(runId, "running", JSON.stringify(state), this.#now());
  }

  #drop(graph: GraphRow, nodeId: string, reason: DropReason, detail: string): void {
    this.#emit("graph.run.dropped", graph, { triggerNode: nodeId, reason, detail });
  }

  #emit(kind: GraphEventKind, graph: GraphRow, payload: Record<string, unknown>): void {
    this.#bus.emit({
      kind,
      accountId: graph.account_id,
      ts: this.#now(),
      subjectId: graph.id,
      payload: { graphId: graph.id, graphName: graph.name, ...payload },
    });
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Pure helpers — the walk's rules, testable without an engine                                    */
/* -------------------------------------------------------------------------------------------- */

/** Everything a walk needs that does not change while it runs. Built once per `#advance`. */
interface Scope {
  readonly graph: GraphRow;
  readonly document: GraphDocument;
  readonly run: GraphRunRow;
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly incoming: ReadonlyMap<string, GraphEdge[]>;
  readonly outgoing: ReadonlyMap<string, GraphEdge[]>;
  /** The body of each `foreach` in the document, by node id. */
  readonly bodies: ReadonlyMap<string, Set<string>>;
}

/**
 * Which nodes belong to each `foreach`'s body.
 *
 * The body is what the loop's `item` and `index` reach, minus what its `done` reaches. That
 * subtraction is what lets one node sit after the loop *and* read the body — it is excluded from
 * the body, runs once in the outer scope, and sees the last iteration. Anything else would need a
 * second kind of edge to say "this one is after the loop", which is a concept the canvas does not
 * have and would have to explain.
 */
function foreachBodies(document: GraphDocument): Map<string, Set<string>> {
  const bodies = new Map<string, Set<string>>();
  for (const node of document.nodes) {
    if (node.type !== FOREACH_TYPE) continue;
    const after = reachableFromPorts(document, node.id, new Set(["done"]));
    const body = reachableFromPorts(document, node.id, new Set(["item", "index"]));
    for (const id of after) body.delete(id);
    body.delete(node.id);
    bodies.set(node.id, body);
  }
  return bodies;
}

/** Everything downstream of one node's named output ports, excluding the node itself. */
function reachableFromPorts(
  document: GraphDocument,
  nodeId: string,
  ports: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const edge of document.edges) {
    if (edge.from.node !== nodeId || !ports.has(edge.from.port)) continue;
    for (const id of reachableFrom(document, edge.to.node)) out.add(id);
  }
  out.delete(nodeId);
  return out;
}

/** Un-settles a set of nodes, so the next iteration starts from nothing rather than from before. */
function clearScope(state: RunState, scope: ReadonlySet<string>): void {
  for (const id of scope) delete state.outputs[id];
  const kept = state.skipped.filter((id) => !scope.has(id));
  state.skipped.length = 0;
  state.skipped.push(...kept);
}

function readDocument(graph: GraphRow): GraphDocument | null {
  try {
    const parsed: unknown = JSON.parse(graph.definition);
    return validateGraphDocument(parsed).ok ? (parsed as GraphDocument) : null;
  } catch {
    return null;
  }
}

function readState(run: GraphRunRow): RunState {
  try {
    const parsed = JSON.parse(run.state) as Partial<RunState>;
    return {
      outputs: parsed.outputs ?? {},
      skipped: parsed.skipped ?? [],
      executed: parsed.executed ?? [],
    };
  } catch {
    return { outputs: {}, skipped: [], executed: [] };
  }
}

function incomingEdges(document: GraphDocument): Map<string, GraphEdge[]> {
  const map = new Map<string, GraphEdge[]>();
  for (const edge of document.edges) {
    const list = map.get(edge.to.node);
    if (list === undefined) map.set(edge.to.node, [edge]);
    else list.push(edge);
  }
  return map;
}

function outgoingEdges(document: GraphDocument): Map<string, GraphEdge[]> {
  const map = new Map<string, GraphEdge[]>();
  for (const edge of document.edges) {
    const list = map.get(edge.from.node);
    if (list === undefined) map.set(edge.from.node, [edge]);
    else list.push(edge);
  }
  return map;
}

/** Executed or skipped. Absent means "not reached yet", which is what the walk waits on. */
function settled(nodeId: string, state: RunState): boolean {
  return state.outputs[nodeId] !== undefined || state.skipped.includes(nodeId);
}

/**
 * The one rule. An edge is dead when its source was skipped, or when the source produced nothing
 * for that port — which is how a false condition, an untaken branch and an unfailed error port all
 * stop the run without any of them being a special case here.
 */
function isDead(edge: GraphEdge, state: RunState): boolean {
  if (state.skipped.includes(edge.from.node)) return true;
  const produced = state.outputs[edge.from.node];
  return produced === undefined || !(edge.from.port in produced);
}

function gatherInputs(edges: readonly GraphEdge[], state: RunState): PortValues {
  const inputs: Record<string, unknown> = {};
  for (const edge of edges) {
    inputs[edge.to.port] = state.outputs[edge.from.node]?.[edge.from.port];
  }
  return inputs;
}

/**
 * A condition that answered false produces nothing, which gates everything downstream of it.
 *
 * The first declared output is the answer, by convention rather than by a field: a condition with
 * several outputs is a branch, and that is a different node.
 */
function gate(definition: NodeDefinition, produced: PortValues): PortValues {
  if (definition.kind !== "condition") return produced;
  const first = definition.outputs[0]?.id;
  if (first === undefined) return produced;
  return produced[first] === false ? {} : produced;
}

/** The node's own account, then the graph's. Neither is an error; the action decides what to do. */
function actingAccount(node: GraphNode, graph: GraphRow): string | null {
  const own = node.config.accountId;
  if (typeof own === "string" && own !== "") return own;
  return graph.account_id;
}

function waitDuration(node: GraphNode): number {
  const raw = node.config.durationMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function onMissed(node: GraphNode): string {
  const raw = node.config.onMissed;
  return typeof raw === "string" ? raw : "resume";
}

/** Exported for the tests, which assert the walk's rules directly rather than through an engine. */
export const __walkRules = { isDead, settled, gate, gatherInputs };
