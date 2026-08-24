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
 * `foreach` and the type check on save both landed after this header was written, and it said they
 * had not for long enough to be worth correcting here rather than quietly: a header that lists what
 * is missing has to be maintained like anything else, or it becomes the first thing a reader is
 * wrong about. The Phase 4 checklist is where the outstanding work actually lives.
 */

import { randomUUID } from "node:crypto";
import type { NodeConfigValues, NodeDefinition, PortValues } from "@vrcz/plugin-api/nodes";
import {
  foreachBodies,
  type GraphDocument,
  type GraphEdge,
  type GraphEventKind,
  type GraphNode,
  innermostLoop,
  reachableFrom,
  validateGraphDocument,
} from "@vrcz/shared";
import type { EventBus } from "../bus/event-bus.ts";
import type { Store } from "../store/index.ts";
import type { GraphRow, GraphRunRow } from "../store/types.ts";
import {
  BRANCH_TYPE,
  COLLECT_TYPE,
  DEFAULT_WAIT_MS,
  ERROR_PORT,
  FOREACH_TYPE,
  INTRINSIC_DEFINITIONS,
  MISSED_RESUME_GRACE_MS,
  STOP_WHEN_TYPE,
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
  /**
   * How the engine pauses between a loop's items. Injected for the same reason `now` is: a test
   * asserting that a delay happened must not be a test that takes as long as the delay.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Resume sweep interval. `0` leaves the sweep manual, which is how the tests run it. */
  readonly sweepMs?: number;
  /** Where a failure that belongs to no run goes. Default: `console.error`. */
  readonly onError?: (message: string, error: unknown) => void;
  /**
   * Resolves a `secret` config field on its way to a node handler.
   *
   * Absent means every secret field arrives empty, which is the correct behaviour for a daemon with
   * no credential store: a node that needs a token fails saying it has none, rather than sending a
   * request without one.
   */
  readonly secrets?: GraphSecretResolver | undefined;
}

/** `(graph, node, field) -> value`, or undefined when nothing is stored. */
export type GraphSecretResolver = (
  graphId: string,
  nodeId: string,
  fieldId: string,
) => string | undefined;

/** Why a fire was not honoured. Carried on `graph.run.dropped`, because silence is the failure. */
type DropReason = "fire_rate" | "busy" | "queue_full" | "unavailable";

const DEFAULT_SWEEP_MS = 5_000;

export class GraphEngine {
  readonly #store: Store;
  readonly #bus: EventBus;
  readonly #provider: NodeProvider;
  readonly #limits: GraphLimits;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #sweepMs: number;
  readonly #onError: (message: string, error: unknown) => void;
  readonly #secrets: GraphSecretResolver | undefined;
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
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          // Unref'd: a loop mid-pause must never be the reason the daemon refuses to exit.
          setTimeout(resolve, ms).unref?.();
        }));
    this.#sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;
    this.#secrets = options.secrets;
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
    this.#reclaimOrphanRuns();
    for (const graph of this.#store.listEnabledGraphs()) await this.#arm(graph);
    await this.resumeDue();
    // Queued fires outlive a crash too, and nothing else would ever pump them: `#pumpQueue` is only
    // reached from the end of a run, and after a restart there is no run to end.
    for (const graphId of new Set(
      this.#store.listGraphRunsByStatus("queued").map((run) => run.graph_id),
    )) {
      await this.#pumpQueue(graphId);
    }
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

  /**
   * Gives up the runs a previous process was walking when it died.
   *
   * A `running` row means "some process has this run in hand", and after a restart no process has.
   * Nothing was clearing them: `start` resumes `waiting` rows only, while `countLiveGraphRuns`
   * counts `running` too — so one kill at the wrong moment left a `drop`-mode graph with a row that
   * said a run was in flight **forever**, and every fire from then on was refused with "a run is
   * already in flight". The graph never ran again and the canvas stayed dimmed, with nothing
   * anywhere saying why.
   *
   * Deleted rather than resumed, and that is the conservative half. The state is persisted at node
   * boundaries, so a run killed *during* a node has no record that the node ran: picking it up
   * again would re-execute it, and the node most likely to be interrupted is the slow one, which is
   * the one that sends something. Re-sending an invite is a worse failure than losing a run.
   */
  #reclaimOrphanRuns(): void {
    for (const run of this.#store.listGraphRunsByStatus("running")) {
      this.#store.deleteGraphRun(run.id);
      const graph = this.#store.getGraph(run.graph_id);
      if (graph === null) continue;
      this.#emit("graph.run.failed", graph, {
        runId: run.id,
        triggerNode: run.trigger_node,
        dryRun: run.dry_run === 1,
        durationMs: this.#now() - run.started_at,
        node: null,
        message: "vrc.zip stopped while this run was in flight, so it was given up.",
      });
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
    const before: string[] = [];
    for (const key of [...this.#armed.keys()]) {
      if (!key.startsWith(`${graphId}:`)) continue;
      before.push(key);
      // Kept, not forgotten: see below.
      await this.#disarmKey(key, false);
    }
    const graph = this.#store.getGraph(graphId);
    if (graph !== null && graph.enabled === 1 && this.#started) await this.#arm(graph);
    /*
     * The fire-rate window survives a reload, and it has to.
     *
     * Disarming used to forget it unconditionally, and every save, enable and disable comes through
     * here — so a trigger that was being held back by `maxFiresPerMinute` was released from it by
     * the author pressing Save, and could exceed the ceiling inside the same minute by doing so
     * repeatedly. A trigger that is armed again under the same key is the *same* trigger, whatever
     * new instance id it got, so its window carries over. Only a key that did not come back is
     * forgotten, which is what stops the map growing for the life of the process as graphs are
     * edited and deleted.
     */
    for (const key of before) {
      if (!this.#armed.has(key)) this.#counters.fires.forget(key);
    }
    // The graph is gone, so its runs-per-hour window is nobody's. Same leak, one level up.
    if (graph === null) this.#counters.runs.forget(graphId);
  }

  /**
   * One node type's definition, intrinsics included.
   *
   * Public because the control API has to answer the same question the engine answers internally —
   * "is this node a trigger?" — and the two must not disagree. Asking the provider directly would
   * miss the intrinsics, which is how a `For each` ends up classified as an unknown type.
   */
  definitionOf(type: string): NodeDefinition | null {
    return this.#definition(type);
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

    /*
     * The concurrency questions come **before** the runs-per-hour window, and the order is the
     * whole point: that window counts *runs*, and a fire dropped for `busy` or `queue_full` never
     * becomes one. Counting it anyway meant a `drop`-mode graph with a chatty trigger could be
     * force-disabled for "running more than 200 times in an hour" while it was executing one run
     * and refusing the other two hundred — the ceiling firing at exactly the graph that was
     * obeying it.
     */
    const live = this.#store.countLiveGraphRuns(graphId);
    if (graph.concurrency === "drop" && live > 0) {
      this.#drop(graph, nodeId, "busy", "a run is already in flight");
      return;
    }
    if (graph.concurrency === "parallel" && live >= this.#limits.maxParallelRuns) {
      this.#drop(graph, nodeId, "busy", `already running ${String(live)} times`);
      return;
    }
    const queueing = graph.concurrency === "queue" && live > 0;
    if (queueing) {
      const queued = this.#store.countGraphRunsByStatus(graphId, "queued");
      if (queued >= this.#limits.maxQueuedRuns) {
        this.#drop(graph, nodeId, "queue_full", `${String(queued)} fires already waiting`);
        return;
      }
    }

    // A queued fire is counted here rather than when it is pumped: it is a run that will happen,
    // and waiting would let a queue absorb the whole hour's worth and release it uncounted.
    const runsThisHour = this.#counters.runs.hit(graphId, now);
    if (runsThisHour > this.#limits.maxRunsPerHour) {
      // The one ceiling whose answer is to switch the graph off. A graph running two hundred times
      // an hour is not going to recover on the next fire, and dropping quietly for the rest of the
      // evening would be indistinguishable from being broken.
      const reason = `Ran more than ${String(this.#limits.maxRunsPerHour)} times in an hour.`;
      this.#store.setGraphEnabled(graphId, false, reason, now);
      // Forgotten here, so the hour's evidence dies with the disable. It has done its job; leaving
      // it behind meant the user could fix the loop, press Enable, and be switched off again by the
      // same two hundred timestamps before the graph had run once.
      this.#counters.runs.forget(graphId);
      this.#emit("graph.disabled", graph, { reason, node: nodeId });
      await this.reload(graphId);
      return;
    }

    if (queueing) {
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

  /**
   * Takes one trigger instance down.
   *
   * `forget` is whether its fire-rate window goes with it. A reload says no — the same trigger is
   * about to be armed again under the same key and its recent fires still happened — while a stop
   * or a delete says yes, because nothing will ever ask about that key again.
   */
  async #disarmKey(key: string, forget = true): Promise<void> {
    const armed = this.#armed.get(key);
    if (armed === undefined) return;
    this.#armed.delete(key);
    if (forget) this.#counters.fires.forget(key);
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
    // Remembered outside the `try` so the failure path can still pump the queue. See its comment.
    let graphId: string | null = null;
    try {
      const run = this.#store.getGraphRun(runId);
      if (run === null) return;
      graphId = run.graph_id;
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
      // And the queue is pumped here as well as on the normal path. In `queue` mode nothing else
      // ever starts the next fire — a later `fire` sees `live > 0` and only enqueues — so an engine
      // defect on one run used to strand every fire behind it until the daemon restarted.
      if (graphId !== null) {
        this.#walking.delete(runId);
        await this.#pumpQueue(graphId);
      }
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
    const bodies = foreachBodies(
      document,
      document.nodes.filter((node) => node.type === FOREACH_TYPE).map((node) => node.id),
    );
    const inBody = new Set([...bodies.values()].flatMap((body) => [...body]));
    const scope: Scope = {
      graph,
      document,
      run,
      nodes: new Map(document.nodes.map((node) => [node.id, node])),
      incoming: incomingEdges(document),
      outgoing: outgoingEdges(document),
      bodies,
      // Resolved once per run rather than per `Collect`, because the answer cannot change while a
      // run is in flight: it is a property of the document, and the document is read once.
      owner: new Map(
        [...inBody].flatMap((id) => {
          const loop = innermostLoop(bodies, id);
          return loop === null ? [] : [[id, loop] as const];
        }),
      ),
      iterations: new Map(),
    };
    // The outer scope is everything the trigger reaches **except** the bodies of any `foreach`.
    // A body node belongs to its loop and is walked once per item by `#runForeach`; leaving it in
    // the outer scope would run it a second time, with whatever the last iteration left behind.
    const outer = new Set(
      [...reachableFrom(document, run.trigger_node)].filter((id) => !inBody.has(id)),
    );
    return await this.#walkScope(scope, state, this.#withSources(scope, outer), false);
  }

  /**
   * Adds the **source** nodes that feed a scope: the ones with nothing wired into them.
   *
   * A value literal, "now", a random number, the friend list — none of them has an incoming edge, so
   * none of them is reachable from a trigger, so without this they would never run and everything
   * downstream of one would skip. Reachability is the right rule for a node that is waiting on
   * something; a node waiting on nothing belongs to whatever consumes it.
   *
   * **"Nothing wired in", not "no inputs declared".** The five id literals took no inputs until they
   * grew an optional `Id` port (see `values.ts`), and a rule counting declared ports would have
   * stopped every saved graph using one dead. The question the engine actually cares about is
   * whether this node has anything to wait for, and an unwired optional port is not something to
   * wait for. A **required** input left unwired is a different thing — the graph check refuses to
   * save that — and it stays out rather than running against a value that was never supplied.
   *
   * **Only when something in the scope actually consumes it.** A source wired into a branch that
   * this run never reaches stays out — which matters because one of these performs a VRChat read,
   * and doing it for a branch nobody took would spend the user's rate budget on nothing.
   *
   * An unfired **trigger** is never a source, however few inputs it has: a graph with two trigger
   * roots must not run the other one's branch.
   *
   * **A chain of them counts, not just the last link.** This used to look at one node at a time and
   * ask whether it fed the scope *directly*, which quietly excluded every source more than one hop
   * away: `Text value → Compose text → Discord`, with only `Discord` reachable from the trigger,
   * left `Compose text` out (it has an incoming edge, so it is not a source) and `Text value` out
   * (it feeds a node that was itself not in the scope). `Discord`'s input never settled and the run
   * reported finished having executed nothing. So the answer is a closure rather than a filter: walk
   * *backwards* from what the scope consumes, then admit a node once everything feeding it is in.
   *
   * `consumers` is what has to be fed, which is the scope itself except inside a nested loop —
   * see `#runForeach`, where an inner body's sources belong to the inner body.
   */
  #withSources(
    scope: Scope,
    allowed: ReadonlySet<string>,
    consumers: ReadonlySet<string> = allowed,
  ): Set<string> {
    const out = new Set(allowed);

    // Everything upstream of what the scope consumes, gathered backwards. A node not in here feeds
    // nothing anybody is waiting for, so whether it *could* run is not a question worth asking.
    const upstream = new Set<string>();
    const queue = [...consumers];
    for (;;) {
      const id = queue.pop();
      if (id === undefined) break;
      for (const edge of scope.incoming.get(id) ?? []) {
        const from = edge.from.node;
        if (out.has(from) || upstream.has(from)) continue;
        upstream.add(from);
        queue.push(from);
      }
    }

    // Then forwards to a fixpoint: a node joins once every one of its own inputs is settled by
    // something already in. A chain rooted at an unfired trigger never satisfies this, which is
    // what keeps the other trigger's branch out.
    for (let grew = true; grew; ) {
      grew = false;
      for (const id of upstream) {
        if (out.has(id)) continue;
        const node = scope.nodes.get(id);
        if (node === undefined) continue;
        const definition = this.#definition(node.type);
        if (definition === null || definition.kind === "trigger") continue;
        const edges = scope.incoming.get(id) ?? [];
        if (!edges.every((edge) => out.has(edge.from.node))) continue;
        // A **required** input left unwired is a different thing — the graph check refuses to save
        // that — and the node stays out rather than running against a value never supplied.
        const wired = new Set(edges.map((edge) => edge.to.port));
        if (definition.inputs.some((input) => input.required === true && !wired.has(input.id))) {
          continue;
        }
        out.add(id);
        grew = true;
      }
    }
    return out;
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
      if (nodeId === null) {
        /*
         * Nothing is ready. That is usually the end of the scope, but not always: a node can be
         * waiting on a source that is **not in this scope at all** — the other trigger of a
         * two-trigger graph, most often — and no amount of walking will settle it. `#pickNext`
         * requires every input to be settled before it will even look at the dead-edge rule, so
         * such a node was neither run nor skipped and the run reported `finished` having stopped
         * halfway. Blocking on something that can never arrive **is** a dead edge, so it is settled
         * the way every other dead edge is: the node skips, and the walk carries on to whatever
         * that unblocks. When there is nothing left to unblock, the scope really has drained.
         */
        const stuck = this.#stuckNodes(document, allowed, state, incoming);
        if (stuck.length === 0) return { kind: "finished" };
        state.skipped.push(...stuck);
        this.#persist(run.id, state);
        continue;
      }
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

      if (node.type === COLLECT_TYPE || node.type === STOP_WHEN_TYPE) {
        const loop = scope.owner.get(nodeId);
        const iteration = loop === undefined ? undefined : scope.iterations.get(loop);
        if (iteration === undefined) {
          // Drawn outside every loop, or in a body this run never entered. Failing says so; the
          // alternative is a Collect that appends to nothing and a Stop that stops nothing, which
          // is a graph that looks right and quietly is not.
          return {
            kind: "failed",
            node: nodeId,
            message: `${node.type === COLLECT_TYPE ? "Collect" : "Stop when"} has to be inside a For each.`,
          };
        }
        if (node.type === COLLECT_TYPE) {
          iteration.collected.push(inputs.value ?? null);
          state.outputs[nodeId] = { out: inputs.value ?? null };
        } else {
          const stop = inputs.when === true;
          if (stop) iteration.stopped = true;
          state.outputs[nodeId] = { out: stop };
        }
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
        const config = this.#withSecrets(graph.id, node, definition);
        const produced = await this.#provider.execute(node.type, inputs, config, {
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
    const delayMs = foreachDelay(scope.nodes.get(nodeId));
    // Checked against the whole loop rather than one item: see `GraphLimits.maxForeachDelayMs`. The
    // last item is not followed by a pause, which is why this counts the gaps and not the items.
    const totalDelay = delayMs * Math.max(0, list.length - 1);
    if (totalDelay > this.#limits.maxForeachDelayMs) {
      return {
        kind: "failed",
        node: nodeId,
        message: `A For each may wait ${String(Math.round(this.#limits.maxForeachDelayMs / 60_000))} minutes in total between items. This one would wait ${String(Math.round(totalDelay / 60_000))}.`,
      };
    }

    const body = scope.bodies.get(nodeId) ?? new Set<string>();

    /*
     * A nested loop's body is part of this one's, so its nodes are walked here too — once, by the
     * inner `#runForeach`. They are deliberately **not** counted as consumers when the sources are
     * resolved: a source feeding only an inner-body node belongs to the inner body, which asks for
     * it again on every inner item. Promoting it here as well ran it once per *outer* item on top
     * of that, and `clearScope` threw the result away unread. For a source that performs a VRChat
     * read, that is rate budget spent on nothing.
     */
    const nested = new Set<string>();
    for (const [loop, inner] of scope.bodies) {
      if (loop === nodeId || !body.has(loop)) continue;
      for (const id of inner) nested.add(id);
    }
    const consumers = new Set([...body].filter((id) => !nested.has(id)));

    // Sources are resolved per body, not per run: a `now` or a random number inside a loop is asked
    // again for each item, which is what an author drawing it there means.
    const scoped = this.#withSources(scope, body, consumers);

    // What this loop is accumulating and whether it has been told to stop. Keyed by the loop's node
    // id so a `Collect` two loops deep reaches its own, and removed in `finally` so a failed run
    // cannot leave a stale iteration for a later pass to append to.
    const iteration: Iteration = { collected: [], stopped: false };
    scope.iterations.set(nodeId, iteration);

    let ran = 0;
    try {
      for (const [index, item] of list.entries()) {
        state.outputs[nodeId] = { item: item ?? null, index };
        clearScope(state, scoped);
        // The live position, for the editor's readout. Written into the run row rather than emitted:
        // a message per iteration would be on the bus whether or not anybody had the canvas open.
        state.loops = { ...state.loops, [nodeId]: { at: index + 1, of: list.length } };
        // Written before the body rather than after it, because the question the readout asks is
        // "which item is it on now" and the answer is only useful while the item is still running.
        this.#persist(scope.run.id, state);
        const outcome = await this.#walkScope(scope, state, scoped, true);
        if (outcome.kind !== "finished") return outcome;
        ran = index + 1;
        // Checked after the body drains rather than where `Stop when` executed: the item finishes
        // as drawn, and only the *next* one is called off. See `STOP_WHEN_DEFINITION`.
        if (iteration.stopped) break;
        // Between items, not after the last one: a pause at the end delays everything downstream of
        // the loop for no reason anybody drawing it intended.
        if (delayMs > 0 && index < list.length - 1) await this.#sleep(delayMs);
      }
    } finally {
      scope.iterations.delete(nodeId);
      const { [nodeId]: _gone, ...rest } = state.loops ?? {};
      state.loops = rest;
    }

    /*
     * The loop is over, so `done` and `results` start being produced. The body's own outputs are
     * deliberately left in place, so a node downstream of *both* the loop and the body reads the
     * last iteration rather than nothing.
     *
     * **`item` and `index` are kept for the same reason**, which they were not until now. A node
     * wired from both `item` and `done` is subtracted out of the body by `foreachBodies` on purpose
     * — it runs once, after the loop, in the outer scope — and replacing the loop's outputs with
     * `{done, results}` alone made its `item` edge dead, so the node that the subtraction exists to
     * support was silently skipped instead. They carry the **last** iteration, which is the only
     * honest reading of "item" once the loop has stopped, and they are absent when nothing ran:
     * there is no last item for an empty list, and inventing one would be worse than a dead edge.
     *
     * `done` counts the items that actually ran, which is the same as the list's length unless a
     * `Stop when` cut it short — and if it said `list.length` there, the count would be a lie in the
     * one case somebody is counting.
     */
    state.outputs[nodeId] =
      ran === 0
        ? { done: ran, results: iteration.collected }
        : { done: ran, results: iteration.collected, item: list[ran - 1] ?? null, index: ran - 1 };
    return { kind: "finished" };
  }

  /**
   * The nodes in this scope that will never become ready, because something outside it feeds them.
   *
   * Only the ones blocked *directly* by an outsider: whatever they were blocking becomes ready (or
   * becomes stuck in its own right) on the next pass, so one pass per layer settles the lot without
   * this having to reason about the chain.
   */
  #stuckNodes(
    document: GraphDocument,
    allowed: ReadonlySet<string>,
    state: RunState,
    incoming: ReadonlyMap<string, GraphEdge[]>,
  ): string[] {
    const stuck: string[] = [];
    for (const node of document.nodes) {
      if (!allowed.has(node.id) || settled(node.id, state)) continue;
      const edges = incoming.get(node.id) ?? [];
      if (edges.some((edge) => !allowed.has(edge.from.node) && !settled(edge.from.node, state))) {
        stuck.push(node.id);
      }
    }
    return stuck;
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
    /*
     * A graph the user switched off does not come back to life six hours later.
     *
     * `fire` refuses a disabled graph and the triggers are disarmed, so this was the one door left
     * open: a run parked on a `Wait` is a row in `graph_runs`, the sweep picks it up on its time
     * regardless, and the rest of the run — the invite, the webhook — went out on a graph the user
     * had already turned off, or that the runs-per-hour ceiling had turned off for them. Dropped
     * rather than left parked: "off" has to mean the pending work stops, and a row that resumes
     * whenever somebody re-enables the graph is a delayed action nobody remembers arming.
     */
    if (graph.enabled !== 1) {
      this.#store.deleteGraphRun(run.id);
      this.#drop(
        graph,
        run.trigger_node,
        "unavailable",
        "the graph was switched off while it waited",
      );
      await this.#pumpQueue(graph.id);
      return;
    }

    const waitNode = document.nodes.find((node) => node.id === run.wait_node);
    /*
     * The document was edited while this run was parked and the `Wait` it is standing on is gone.
     *
     * Resuming would walk a state keyed by node ids that no longer exist, and — worse — it would
     * silently ignore an `onMissed: "skip"` the author had set on the very node being resumed,
     * because the policy is read off a node that cannot be found. There is no honest way to finish
     * a run whose middle has been deleted, so it is given up and said out loud.
     */
    if (run.wait_node !== null && waitNode === undefined) {
      this.#store.deleteGraphRun(run.id);
      this.#emit("graph.run.failed", graph, {
        runId: run.id,
        triggerNode: run.trigger_node,
        dryRun: run.dry_run === 1,
        durationMs: now - run.started_at,
        node: run.wait_node,
        message:
          "The Wait this run was parked on no longer exists. The graph was edited while it waited.",
      });
      await this.#pumpQueue(graph.id);
      return;
    }
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

  /**
   * The node's config with every `secret` field filled in from the credential store.
   *
   * The substitution **overwrites** rather than filling a gap. A graph document has no business
   * carrying a secret, so whatever a client wrote into that key is discarded here: the property
   * "the document cannot leak a token" then holds at execution time regardless of what was saved,
   * rather than depending on every writer having stripped it.
   */
  #withSecrets(graphId: string, node: GraphNode, definition: NodeDefinition): NodeConfigValues {
    const fields = (definition.config ?? []).filter((field) => field.kind === "secret");
    if (fields.length === 0) return node.config;
    const config: Record<string, string | number | boolean> = { ...node.config };
    for (const field of fields) {
      config[field.id] = this.#secrets?.(graphId, node.id, field.id) ?? "";
    }
    return config;
  }

  #definition(type: string): NodeDefinition | null {
    return INTRINSIC_DEFINITIONS.get(type) ?? this.#provider.definition(type);
  }

  #firesPerMinute(graph: GraphRow, nodeId: string): number {
    const document = readDocument(graph);
    const node = document?.nodes.find((entry) => entry.id === nodeId);
    const definition = node === undefined ? null : this.#definition(node.type);
    // `?? `, not a truthiness test. A definition declaring `0` means "never on its own" — a trigger
    // that only fires when something asks it to — and reading that as "unset" handed it the default
    // of 120 a minute, which is the opposite of what it said.
    const declared = definition?.kind === "trigger" ? definition.maxFiresPerMinute : undefined;
    return typeof declared === "number" && Number.isFinite(declared) && declared >= 0
      ? declared
      : this.#limits.defaultFiresPerMinute;
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
  /** The body of each `foreach` in the document, by node id. From `@vrcz/shared`. */
  readonly bodies: ReadonlyMap<string, Set<string>>;
  /** Which loop a body node belongs to: the innermost one containing it. */
  readonly owner: ReadonlyMap<string, string>;
  /** The loops currently iterating, outermost first by construction. Mutated as the walk runs. */
  readonly iterations: Map<string, Iteration>;
}

/**
 * One loop mid-flight: what its `Collect`s have appended, and whether a `Stop when` fired.
 *
 * Deliberately **not** in `RunState`. A run parked on a `wait` is reloaded from JSON by whichever
 * process picks it up, and a `wait` inside a `foreach` is already refused for exactly this reason —
 * so this lives for the length of one `#runForeach` call and never has to survive a restart.
 */
interface Iteration {
  readonly collected: unknown[];
  stopped: boolean;
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
      ...(parsed.loops === undefined ? {} : { loops: parsed.loops }),
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

/**
 * How long this `Wait` waits.
 *
 * The fallback is the definition's own default rather than `0`, because the daemon never applies a
 * config default — that is the editor's job, done once when the node is created — so a document that
 * arrived by import, by hand, or from an older build reaches here with no `durationMs` at all. Zero
 * parked the run with `resumeAt` in the past and continued it on the very next sweep, which is a
 * `Wait` that does not wait. An explicit `0` is still honoured: that is somebody saying "park and
 * continue", which is a real thing to ask for and the reason this checks the *type* rather than the
 * value.
 */
function waitDuration(node: GraphNode): number {
  const raw = node.config.durationMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_WAIT_MS;
}

/** How long to pause between a loop's items. Absent, negative and NaN all mean "do not pause". */
function foreachDelay(node: GraphNode | undefined): number {
  const raw = node?.config.delayMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function onMissed(node: GraphNode): string {
  const raw = node.config.onMissed;
  return typeof raw === "string" ? raw : "resume";
}

/** Exported for the tests, which assert the walk's rules directly rather than through an engine. */
export const __walkRules = { isDead, settled, gate, gatherInputs };
