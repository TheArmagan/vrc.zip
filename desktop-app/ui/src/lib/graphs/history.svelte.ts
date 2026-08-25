/**
 * Undo and redo for one open canvas.
 *
 * A stack of whole snapshots rather than a log of inverse operations, and that is a deliberate
 * trade. The canvas already replaces its `nodes` and `edges` arrays wholesale on every change — it
 * has to, they are `$state.raw` bound into Svelte Flow — so a snapshot is a copy of two arrays that
 * were about to be rebuilt anyway. An operation log would need an inverse written for each of the
 * dozen places that mutate the document, and a missing one is an undo that silently corrupts the
 * graph rather than one that fails loudly.
 *
 * Three things this does that a plain stack does not:
 *
 * **It knows which entry is on disk.** `markSaved()` is called by the editor's save, and `atSaved`
 * is what the Unsaved badge reads. Undoing back to the saved state clears the badge and redoing
 * away from it puts it back, which is the honest answer to "does this differ from the file".
 *
 * **It coalesces by key.** Everything typed into one config field while it holds focus is one undo
 * step: a push carrying the same key as the entry on top *replaces* it instead of stacking. So
 * Ctrl+Z takes back the whole name you just typed, not its last letter. `seal()` ends the run when
 * focus leaves the field, so coming back to it later starts a new step.
 *
 * **It clones on the way in and on the way out.** Svelte Flow is free to mutate a node object it
 * was handed, so an entry that shared one would rot in the stack. Both directions copy the node,
 * its position and its config; everything below that is either primitive or an array this codebase
 * only ever replaces.
 *
 * A save does **not** clear the stack. Undoing past a save is a normal thing to want, and the badge
 * tells the truth about it either way.
 */

/** The little a snapshot needs to know about a node to be cloned and diffed. */
export interface HistoryNode {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly data: Record<string, unknown>;
}

export interface Snapshot<N extends HistoryNode, E extends { readonly id: string }> {
  readonly nodes: readonly N[];
  readonly edges: readonly E[];
}

interface Entry<N extends HistoryNode, E extends { readonly id: string }> {
  readonly snapshot: Snapshot<N, E>;
  /** What this entry may still absorb, or null once it is closed to further edits. */
  key: string | null;
}

/**
 * How far back Ctrl+Z reaches.
 *
 * Bounded because an entry is a copy of the whole document and a long session on a large graph
 * would otherwise hold every version of it at once. A hundred steps is more than anybody walks back
 * through in one sitting, and the oldest going first is the right thing to lose.
 */
export const HISTORY_LIMIT = 100;

export class GraphHistory<N extends HistoryNode, E extends { readonly id: string }> {
  #entries = $state.raw<Entry<N, E>[]>([]);
  #index = $state(-1);
  /** The index whose snapshot is what the daemon has, or -1 when nothing here has been saved. */
  #saved = $state(-1);

  /** Starts over from a freshly loaded document. The load itself is not an undoable step. */
  reset(snapshot: Snapshot<N, E>): void {
    this.#entries = [{ snapshot: clone(snapshot), key: null }];
    this.#index = 0;
    this.#saved = 0;
  }

  /**
   * Records the state the document is in *after* a change.
   *
   * `key` is the coalescing key: two pushes in a row carrying the same non-null key are one step.
   * A null key always makes a new entry and closes whatever run was open, which is why every
   * structural change passes nothing.
   */
  push(snapshot: Snapshot<N, E>, key: string | null = null): void {
    const top = this.#entries[this.#index];
    if (key !== null && top !== undefined && top.key === key) {
      const amended = this.#entries.slice(0, this.#index);
      amended.push({ snapshot: clone(snapshot), key });
      this.#entries = amended;
      return;
    }
    // Anything pushed after an undo throws away the redo tail: the branch that was in front of you
    // is not reachable any more, and keeping it would make Ctrl+Y replay a document that never was.
    const kept = this.#entries.slice(0, this.#index + 1);
    if (top !== undefined) top.key = null;
    kept.push({ snapshot: clone(snapshot), key });
    while (kept.length > HISTORY_LIMIT) {
      kept.shift();
      if (this.#saved >= 0) this.#saved -= 1;
    }
    this.#entries = kept;
    this.#index = kept.length - 1;
  }

  /** Closes the entry on top to further coalescing. Called when focus leaves a config field. */
  seal(): void {
    const top = this.#entries[this.#index];
    if (top !== undefined) top.key = null;
  }

  /** Marks the current state as the one on disk. */
  markSaved(): void {
    this.seal();
    this.#saved = this.#index;
  }

  get canUndo(): boolean {
    return this.#index > 0;
  }

  get canRedo(): boolean {
    return this.#index < this.#entries.length - 1;
  }

  /** Whether what is on the canvas is what was last written. */
  get atSaved(): boolean {
    return this.#index === this.#saved;
  }

  undo(): Snapshot<N, E> | null {
    if (!this.canUndo) return null;
    this.seal();
    this.#index -= 1;
    return this.#current();
  }

  redo(): Snapshot<N, E> | null {
    if (!this.canRedo) return null;
    this.seal();
    this.#index += 1;
    return this.#current();
  }

  #current(): Snapshot<N, E> | null {
    const entry = this.#entries[this.#index];
    return entry === undefined ? null : clone(entry.snapshot);
  }
}

function clone<N extends HistoryNode, E extends { readonly id: string }>(
  snapshot: Snapshot<N, E>,
): Snapshot<N, E> {
  return {
    nodes: snapshot.nodes.map(cloneNode),
    // Edges are flat records of ids and are replaced rather than edited, so the array copy is the
    // whole of it.
    edges: [...snapshot.edges],
  };
}

function cloneNode<N extends HistoryNode>(node: N): N {
  const config = node.data["config"];
  return {
    ...node,
    position: { ...node.position },
    data: {
      ...node.data,
      ...(isRecord(config) ? { config: { ...config } } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Which nodes a jump between two states actually changed.
 *
 * This is what an undo selects, and the reason it selects anything: a step that restored three
 * nodes two screens away is otherwise indistinguishable from one that did nothing. Position, config
 * and breakpoint are compared because those are the three things a step can change about a node
 * that stays put; anything present in one state and absent from the other counts by existing.
 */
export function touchedBetween<N extends HistoryNode>(
  before: readonly N[],
  after: readonly N[],
): Set<string> {
  const previous = new Map(before.map((node) => [node.id, node]));
  const touched = new Set<string>();
  for (const node of after) {
    const was = previous.get(node.id);
    if (was === undefined || differs(was, node)) touched.add(node.id);
  }
  return touched;
}

function differs<N extends HistoryNode>(a: N, b: N): boolean {
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return true;
  if (a.data["breakpoint"] !== b.data["breakpoint"]) return true;
  const one = a.data["config"];
  const two = b.data["config"];
  if (!isRecord(one) || !isRecord(two)) return one !== two;
  const keys = new Set([...Object.keys(one), ...Object.keys(two)]);
  for (const key of keys) {
    if (one[key] !== two[key]) return true;
  }
  return false;
}
