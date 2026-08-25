/**
 * The debugger's ear on the event stream: which graphs are being watched, and what to say about it.
 *
 * ## Why this is not just a `toast()` call in the editor
 *
 * A toast has to survive the thing that raised it. The interesting failures happen while you are
 * looking at a *different* screen — that is most of what makes a big graph hard to debug — so the
 * subscription belongs to the app rather than to a mounted canvas. `app.svelte.ts` routes every
 * `graph.*` frame here and this decides whether anybody asked to hear about it.
 *
 * ## What decides that
 *
 * The graph's own `debug` flag, read from the list `graphs.svelte.ts` already holds. Not a
 * preference in this browser, and not "is the editor open": the daemon is the one that knows which
 * graph somebody sat down to debug, it is the same bit that turns tracing and breakpoints on, and
 * one switch with three effects is a thing a person can hold in their head. A second, client-side
 * switch would be a way for the toasts and the traces to disagree about what is being debugged.
 *
 * ## What it says, and what it deliberately does not
 *
 * Three kinds, and each one is something that has no other way to reach you:
 *
 *  - **`graph.node.error`** — a node threw and its `on error` wire swallowed it. This is the one
 *    the whole feature is for. Nothing else in the app surfaces it, because from the outside the
 *    run finished normally.
 *  - **`graph.run.failed`** — the run ended on a node. It reaches the feed, which is no use at all
 *    while you are staring at the canvas it happened on.
 *  - **`graph.note`** — a rehearsal saying what it *would* have done. A dry run's whole output.
 *
 * `graph.run.finished` is **not** here on purpose. A graph that fires every minute would turn a
 * debugging session into a wall of "it worked", and the run log in the editor already says so
 * without interrupting anything.
 */

import { isEventFrame, type StreamFrame } from "@vrcz/shared";
import { toast } from "svelte-sonner";
import { hrefFor } from "$lib/router.ts";
import { graphs } from "./graphs.svelte.ts";

/**
 * How many toasts one graph may raise in a burst before the rest are folded into a count.
 *
 * A `For each` over forty friends with a broken node inside it fails forty times in a second, and
 * forty stacked toasts is a screen you cannot use and cannot read. The fold keeps the first few,
 * which are the ones that say what went wrong, and replaces the rest with one line saying how many
 * more there were — which is the other thing worth knowing.
 */
const BURST_LIMIT = 3;

/** How long a burst is. Long enough to cover a loop, short enough that the next fire is its own. */
const BURST_MS = 4_000;

/** One toast per node per burst, so a loop's fortieth identical failure is not a fortieth toast. */
interface Burst {
  at: number;
  shown: number;
  folded: number;
  /** The sonner id of the "and N more" line, so it updates in place rather than stacking. */
  foldId: string | number | null;
}

class GraphDebugState {
  readonly #bursts = new Map<string, Burst>();

  /** Injected so a test can drive the clock, and so `Date.now` is not read in a hot path. */
  #now: () => number = () => Date.now();

  /** Test seam. Nothing in the app calls this. */
  setClock(now: () => number): void {
    this.#now = now;
  }

  /**
   * Forgets every burst in progress. A test seam too, and it exists because of a real hazard.
   *
   * This is a module singleton, so its burst map outlives any one test — and a test that rewinds
   * the injected clock leaves an entry whose `at` is in the *future*, which reads as "the burst is
   * still going" forever. The app never rewinds a clock, so there is nothing to guard against in
   * production; a test that shares this object with the last one is the whole risk.
   */
  reset(): void {
    this.#bursts.clear();
  }

  /**
   * Whether toasts are on for a graph.
   *
   * A graph the list has not loaded yet answers **false**, and that is the right way round: the
   * cost of a missed toast is one event you can still find in the run log, and the cost of the
   * other choice is every graph on the machine shouting at somebody who opened the app.
   */
  watching(graphId: string | null): boolean {
    if (graphId === null) return false;
    return graphs.graphs.find((graph) => graph.id === graphId)?.debug === true;
  }

  /**
   * What to call a graph in a toast.
   *
   * Resolved from the list rather than read off the payload, and the payload is why: the engine's
   * own `#emit` attaches `graphName`, but `graph.note` is emitted straight to the bus by the action
   * that rehearsed, and carries only the id. Every note therefore arrived titled "A graph" — which
   * is precisely useless on a machine with eleven of them. The list is already loaded, because
   * `watching` just consulted it.
   */
  #nameOf(graphId: string, fallback: unknown): string {
    const known = graphs.graphs.find((graph) => graph.id === graphId)?.name;
    if (known !== undefined && known !== "") return known;
    return typeof fallback === "string" && fallback !== "" ? fallback : "A graph";
  }

  /** One frame off the stream. Called for every `graph.*` frame, and drops most of them. */
  apply(frame: StreamFrame): void {
    if (!isEventFrame(frame)) return;
    const data = frame.payload.data as Record<string, unknown> | null;
    const graphId = typeof data?.graphId === "string" ? data.graphId : null;
    /*
     * The catalogue is loaded on demand, here, and this is the only place that can.
     *
     * `graphs.load()` is otherwise called by the Graphs screen, so before this the debugger was
     * silent for anybody who had not been there this session — which is precisely the person it
     * exists for, because the whole point is hearing about a graph while you are somewhere else. A
     * `graph.*` frame is proof there is a list worth having. The frame that triggers the load is
     * lost, and that is the honest trade: one event, once, against never toasting at all.
     */
    if (graphId !== null && !graphs.loaded && !graphs.loading) void graphs.load();
    if (!this.watching(graphId) || graphId === null) return;

    const graphName = this.#nameOf(graphId, data?.graphName);
    const node = typeof data?.node === "string" ? data.node : null;

    switch (frame.type) {
      case "graph.node.error":
        this.#raise(graphId, node, "error", `${graphName}: a node failed`, {
          description: `${describe(data?.message)} The run carried on, because the error is wired onward.`,
          graphId,
        });
        break;
      case "graph.run.failed":
        this.#raise(graphId, node, "error", `${graphName}: the run stopped`, {
          description: describe(data?.message),
          graphId,
        });
        break;
      case "graph.run.paused":
        this.#raise(graphId, node, "info", `${graphName}: paused`, {
          description: "Stopped at a breakpoint. Continue it from the run log.",
          graphId,
        });
        break;
      case "graph.note":
        // A rehearsal note is not a problem, so it is the quiet variant. Its whole job is to let
        // somebody watch a dry run do its thing without opening the feed.
        this.#raise(graphId, node, "message", `${graphName}`, {
          description: describe(data?.note),
          graphId,
        });
        break;
      default:
        break;
    }
  }

  /**
   * Raises one toast, or folds it into the burst that is already on screen.
   *
   * Keyed by graph **and node**, so two different nodes failing in the same second are two toasts —
   * which is the case where the second one is the news — while one node failing forty times inside
   * a loop is one toast and a count.
   */
  #raise(
    graphId: string,
    nodeId: string | null,
    kind: "error" | "info" | "message",
    title: string,
    options: { description: string; graphId: string },
  ): void {
    const key = `${graphId}:${nodeId ?? ""}:${kind}`;
    const now = this.#now();
    const burst = this.#bursts.get(key);
    if (burst === undefined || now - burst.at > BURST_MS) {
      this.#bursts.set(key, { at: now, shown: 1, folded: 0, foldId: null });
    } else if (burst.shown >= BURST_LIMIT) {
      burst.folded += 1;
      const message = `${title} — ${String(burst.folded)} more`;
      // Sonner replaces a toast raised with an existing id, so the count ticks in place instead of
      // becoming the very stack this exists to prevent.
      burst.foldId =
        burst.foldId === null
          ? toast.message(message)
          : toast.message(message, { id: burst.foldId });
      return;
    } else {
      burst.shown += 1;
    }

    const action = {
      label: "Open",
      onClick: () => {
        window.location.hash = hrefFor("graphs", options.graphId);
      },
    };
    if (kind === "error") toast.error(title, { description: options.description, action });
    else if (kind === "info") toast.info(title, { description: options.description, action });
    else toast.message(title, { description: options.description, action });
  }
}

/** A message from an event payload, or a sentence saying there was not one. */
function describe(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : "No message.";
}

export const graphDebug = new GraphDebugState();
