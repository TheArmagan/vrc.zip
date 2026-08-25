/**
 * Copy and paste for the canvas, as a graph fragment.
 *
 * The payload **is a `GraphDocument`** in a small envelope, which is the whole design. A fragment
 * of a graph and a graph are the same shape, so pasting is the load path with new ids: the editor's
 * `toFlowNode`/`toFlowEdge` take these straight, and a payload on the system clipboard is a
 * readable, pasteable, diffable piece of JSON rather than a private encoding.
 *
 * **Two clipboards, and the in-memory one wins.** A copy writes both here and to the system
 * clipboard; a paste prefers whatever `text/plain` carries *if it parses as one of ours*, and falls
 * back to this buffer otherwise. That gets both halves right: copying in one window and pasting in
 * another works, and a paste with somebody's shopping list on the clipboard still pastes the nodes
 * you copied rather than doing nothing.
 *
 * **A secret never travels.** A node's secret fields live in the credential store keyed by node id,
 * they are never readable from here, and a pasted node is a new id — so it starts with none, and
 * the inspector says so. Copying credentials by copying a card would be a way to move a secret
 * somewhere its owner did not put it.
 */

import type { GraphDocument, GraphEdge, GraphNode } from "@vrcz/shared";

/** The envelope's marker. Anything else on the clipboard is somebody else's text. */
export const CLIPBOARD_KIND = "vrc.zip/graph-fragment";

interface Envelope {
  readonly kind: typeof CLIPBOARD_KIND;
  readonly version: 1;
  readonly document: GraphDocument;
}

/** How far a paste with nowhere to be lands from the nodes it came from. */
export const PASTE_OFFSET = 32;

export function serializeFragment(document: GraphDocument): string {
  const envelope: Envelope = { kind: CLIPBOARD_KIND, version: 1, document };
  return JSON.stringify(envelope, null, 2);
}

/**
 * A clipboard's text as a fragment, or null if it is not one.
 *
 * Deliberately forgiving about everything except the marker and the shape it needs: a fragment
 * written by a newer build with fields this one has never heard of still pastes, and the daemon
 * refuses the save if what came through is not a graph it can run. Being strict here would only
 * turn a recoverable paste into nothing happening.
 */
export function parseFragment(text: string): GraphDocument | null {
  if (text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["kind"] !== CLIPBOARD_KIND) return null;
  const document = parsed["document"];
  if (!isRecord(document)) return null;
  const nodes = document["nodes"];
  const edges = document["edges"];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return null;
  const clean = nodes.filter(isFragmentNode);
  if (clean.length === 0) return null;
  const ids = new Set(clean.map((node) => node.id));
  return {
    nodes: clean,
    // A wire with one end outside the fragment has nothing to attach to. Dropped here rather than
    // at paste time so the invariant holds for every reader of a payload, not just this editor.
    edges: edges
      .filter(isFragmentEdge)
      .filter((edge) => ids.has(edge.from.node) && ids.has(edge.to.node)),
  };
}

/**
 * Places a fragment: new ids throughout, and moved to where the paste happened.
 *
 * `at` is the flow position the group's top-left corner should land on — under the pointer, when
 * the pointer is over the canvas. Relative positions inside the group are preserved, so a pasted
 * cluster keeps the shape it was arranged in; with no `at`, the whole group steps down and right by
 * `PASTE_OFFSET` from where it was copied, which is what makes a duplicate visible on top of its
 * original.
 *
 * `newId` is passed in rather than generated here so the editor keeps one id sequence for
 * everything it creates.
 */
export function placeFragment(
  document: GraphDocument,
  at: { readonly x: number; readonly y: number } | null,
  newId: (kind: "node" | "edge") => string,
): GraphDocument {
  const left = Math.min(...document.nodes.map((node) => node.position.x));
  const top = Math.min(...document.nodes.map((node) => node.position.y));
  const shift =
    at === null ? { x: PASTE_OFFSET, y: PASTE_OFFSET } : { x: at.x - left, y: at.y - top };
  const remap = new Map(document.nodes.map((node) => [node.id, newId("node")]));
  return {
    nodes: document.nodes.map((node) => ({
      ...node,
      id: remap.get(node.id) ?? node.id,
      position: { x: node.position.x + shift.x, y: node.position.y + shift.y },
      // Rebuilt rather than spread through: a fragment carries whatever the copied node's config
      // held, and nothing else about it should survive by accident.
      config: { ...node.config },
    })),
    edges: document.edges.map((edge) => ({
      id: newId("edge"),
      from: { node: remap.get(edge.from.node) ?? edge.from.node, port: edge.from.port },
      to: { node: remap.get(edge.to.node) ?? edge.to.node, port: edge.to.port },
    })),
  };
}

/**
 * The buffer behind "the in-memory one wins".
 *
 * Module scope rather than component state on purpose: copying on one graph and pasting on another
 * is the case this exists for, and the editor is remounted between the two.
 */
let buffer: GraphDocument | null = null;

export function setBuffer(document: GraphDocument): void {
  buffer = document;
}

export function getBuffer(): GraphDocument | null {
  return buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFragmentNode(value: unknown): value is GraphNode {
  if (!isRecord(value)) return false;
  if (typeof value["id"] !== "string" || typeof value["type"] !== "string") return false;
  const position = value["position"];
  if (
    !isRecord(position) ||
    typeof position["x"] !== "number" ||
    typeof position["y"] !== "number"
  ) {
    return false;
  }
  return isRecord(value["config"]);
}

function isFragmentEdge(value: unknown): value is GraphEdge {
  if (!isRecord(value)) return false;
  return isEnd(value["from"]) && isEnd(value["to"]);
}

function isEnd(value: unknown): boolean {
  return isRecord(value) && typeof value["node"] === "string" && typeof value["port"] === "string";
}
