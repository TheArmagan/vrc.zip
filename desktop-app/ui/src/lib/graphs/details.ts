/**
 * What a palette row says when you stop on it, and how wide the palette is allowed to be.
 *
 * Two unrelated-looking things in one module because they are the same problem seen twice: the
 * sidebar is 224 pixels and a node's title, its full type id, its description and its ports do not
 * fit in 224 pixels. One answer widens the list; the other draws the rest of the node beside it.
 *
 * Everything here is pure and takes its geometry as arguments — no `window`, no element lookups —
 * so the clamping and the flip-to-the-other-side rule are testable without a DOM. The components
 * measure; this decides.
 */

import type { NodeDefinition, PortDefinition } from "@vrcz/plugin-api/nodes";
import { AFTER_PORT, ERROR_PORT } from "@vrcz/plugin-api/nodes";
import { FOREACH_AFTER_PORTS } from "@vrcz/shared";
import { FOREACH_TYPE } from "./loops.ts";

/* -------------------------------------------------------------------------------------------- */
/* The sidebar's width                                                                            */
/* -------------------------------------------------------------------------------------------- */

/** `w-56`, which is what the palette was before it could be dragged. Also the double-click reset. */
export const SIDEBAR_DEFAULT_WIDTH = 224;

/**
 * Narrow enough to be a strip of icons, wide enough that the group headers still read.
 *
 * Not zero. A sidebar that can be dragged shut is a sidebar somebody loses, and there is no button
 * to bring it back — the palette is the only way to add a node with the pointer.
 */
export const SIDEBAR_MIN_WIDTH = 168;

/** Past this the canvas is the smaller half, which is the wrong way round for an editor. */
export const SIDEBAR_MAX_WIDTH = 520;

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, px)));
}

/* -------------------------------------------------------------------------------------------- */
/* Where the detail card goes                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** Just enough that the card reads as beside the row rather than welded to it. */
const GAP = 8;
/** The card never touches a screen edge, so it always looks placed rather than clipped. */
const MARGIN = 8;

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface DetailPlacement {
  readonly left: number;
  readonly top: number;
  /** Which side of the row it landed on. The card points its little edge back at the anchor. */
  readonly side: "right" | "left";
}

/**
 * Beside the row, on whichever side it fits.
 *
 * Right first, because the palette is on the left of the canvas and that is the empty direction.
 * The wire-drop picker can open anywhere, though, including hard against the right edge of the
 * window — so the flip is not a nicety, it is the difference between a detail card and a sliver.
 *
 * When neither side fits (a narrow window, a wide card) the roomier side wins and the card is
 * pinned to the margin rather than pushed off screen. Overlapping the row is the lesser failure:
 * the row is still readable in the list behind it, and the card is the thing being asked for.
 *
 * Vertically it starts level with the row and slides up only as far as it must, so a card for a row
 * near the bottom of a long list stays visually attached to it.
 */
export function placeDetails(anchor: Box, card: Size, viewport: Size): DetailPlacement {
  const roomRight = viewport.width - anchor.right - GAP - MARGIN;
  const roomLeft = anchor.left - GAP - MARGIN;
  const side: "right" | "left" =
    card.width <= roomRight
      ? "right"
      : card.width <= roomLeft
        ? "left"
        : roomRight >= roomLeft
          ? "right"
          : "left";

  const wanted = side === "right" ? anchor.right + GAP : anchor.left - GAP - card.width;
  const left = Math.round(
    Math.min(Math.max(wanted, MARGIN), Math.max(MARGIN, viewport.width - card.width - MARGIN)),
  );
  const top = Math.round(
    Math.min(
      Math.max(anchor.top, MARGIN),
      Math.max(MARGIN, viewport.height - card.height - MARGIN),
    ),
  );
  return { left, top, side };
}

/* -------------------------------------------------------------------------------------------- */
/* What the card lists                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * One line in the card's port list.
 *
 * `role` is what decides how it is drawn, and the three values are the three kinds of thing a port
 * can be: a value that flows, a sequencing port that carries nothing, and the error port. The card
 * on the canvas draws the same three differently for the same reason.
 */
export interface PortRow {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly description?: string | undefined;
  /** Inputs only. An unwired required input fails the check at save time, which is worth saying. */
  readonly required?: boolean | undefined;
  readonly role: "value" | "sequence" | "error";
}

export interface PortRows {
  readonly inputs: readonly PortRow[];
  readonly outputs: readonly PortRow[];
}

function rowOf(port: PortDefinition): PortRow {
  return {
    id: port.id,
    label: port.label,
    type: port.type,
    description: port.description,
    required: port.required,
    role: "value",
  };
}

/**
 * Every port a node will have on the canvas, declared or not.
 *
 * **The implicit ones are included, and that is the point.** `run after` and `on error` are on every
 * executable card and appear in no `NodeDefinition`, so a preview built from the definition alone
 * would show a node with fewer ports than the thing it is previewing. Somebody reading this card to
 * decide whether a node can be sequenced would get the wrong answer.
 *
 * A trigger has neither: it starts a run rather than taking part in one, so there is nothing to
 * sequence it after and nowhere for its failure to go.
 */
export function detailPorts(qualifiedId: string, definition: NodeDefinition): PortRows {
  const executable = definition.kind !== "trigger";
  const after =
    qualifiedId === FOREACH_TYPE
      ? definition.outputs.filter((port) => FOREACH_AFTER_PORTS.includes(port.id))
      : [];

  return {
    inputs: [
      ...(executable
        ? [
            {
              id: AFTER_PORT,
              label: "run after",
              type: "",
              description: "Carries no value. An edge into it means: not until that one has run.",
              role: "sequence" as const,
            },
          ]
        : []),
      ...(executable ? definition.inputs.map(rowOf) : []),
    ],
    outputs: [
      ...definition.outputs.filter((port) => !after.includes(port)).map(rowOf),
      ...after.map((port) => ({ ...rowOf(port), role: "sequence" as const })),
      ...(executable
        ? [
            {
              id: ERROR_PORT,
              label: "on error",
              type: "string",
              description: "Produced only when this node throws. Unwired, a failure stops the run.",
              role: "error" as const,
            },
          ]
        : []),
    ],
  };
}
