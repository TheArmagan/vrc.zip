/**
 * The two decisions behind the palette's detail card, both of which are pure arithmetic and neither
 * of which is checkable by looking at the running app for more than one window size.
 */

import type { NodeDefinition } from "@vrcz/plugin-api/nodes";
import { describe, expect, test } from "vitest";
import {
  clampSidebarWidth,
  detailPorts,
  placeDetails,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./details.ts";

const VIEWPORT = { width: 1280, height: 800 };
const CARD = { width: 288, height: 240 };

function box(left: number, top: number, width = 200, height = 28) {
  return { left, top, right: left + width, bottom: top + height };
}

describe("the sidebar's width", () => {
  test("clamps to the ends rather than refusing", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(300)).toBe(300);
  });

  test("a dragged-shut sidebar is impossible", () => {
    // There is no button that brings the palette back, so zero has to be unreachable rather than
    // merely discouraged.
    expect(clampSidebarWidth(0)).toBeGreaterThan(0);
    expect(clampSidebarWidth(-500)).toBe(SIDEBAR_MIN_WIDTH);
  });

  test("garbage out of localStorage lands on the default", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  test("rounds, so the style attribute never carries a subpixel", () => {
    expect(clampSidebarWidth(287.6)).toBe(288);
  });
});

describe("where the detail card lands", () => {
  test("to the right of the row when there is room", () => {
    const placed = placeDetails(box(8, 200), CARD, VIEWPORT);
    expect(placed.side).toBe("right");
    expect(placed.left).toBe(216);
    expect(placed.top).toBe(200);
  });

  test("flips to the left when the row is against the right edge", () => {
    // The wire-drop picker opens wherever the pointer was, including two hundred pixels from the
    // right edge of the window. Without the flip the card would be a sliver.
    const placed = placeDetails(box(1040, 200), CARD, VIEWPORT);
    expect(placed.side).toBe("left");
    expect(placed.left).toBe(1040 - 8 - CARD.width);
  });

  test("with room on neither side it takes the roomier one and stays on screen", () => {
    const narrow = { width: 420, height: 800 };
    const placed = placeDetails(box(20, 100, 380), CARD, narrow);
    expect(placed.left).toBeGreaterThanOrEqual(8);
    expect(placed.left + CARD.width).toBeLessThanOrEqual(narrow.width - 8);
  });

  test("slides up only as far as it must, so it stays level with its row", () => {
    const high = placeDetails(box(8, 700), CARD, VIEWPORT);
    expect(high.top).toBe(800 - 240 - 8);

    const level = placeDetails(box(8, 300), CARD, VIEWPORT);
    expect(level.top).toBe(300);
  });

  test("a card taller than the window is pinned to the top rather than pushed off it", () => {
    const placed = placeDetails(box(8, 400), { width: 288, height: 900 }, VIEWPORT);
    expect(placed.top).toBe(8);
  });
});

describe("what the card lists", () => {
  const action: NodeDefinition = {
    id: "send",
    kind: "action",
    title: "Send",
    category: "Social",
    inputs: [{ id: "to", label: "To", type: "user", required: true }],
    outputs: [{ id: "sent", label: "Sent", type: "boolean" }],
  };

  const trigger: NodeDefinition = {
    id: "on-thing",
    kind: "trigger",
    title: "When a thing happens",
    category: "Triggers",
    outputs: [{ id: "at", label: "At", type: "number" }],
  };

  test("an executable node carries the two ports no definition declares", () => {
    // They are on every card on the canvas. A preview that omitted them would answer "can this be
    // sequenced" with a no.
    const ports = detailPorts("vrcz/send", action);
    expect(ports.inputs.map((port) => port.label)).toEqual(["run after", "To"]);
    expect(ports.outputs.map((port) => port.label)).toEqual(["Sent", "on error"]);
    expect(ports.inputs[1]?.required).toBe(true);
  });

  test("a trigger has neither, because it starts a run rather than joining one", () => {
    const ports = detailPorts("vrcz/on-thing", trigger);
    expect(ports.inputs).toEqual([]);
    expect(ports.outputs.map((port) => port.label)).toEqual(["At"]);
  });

  test("the loop's after-the-loop outputs sort below its per-item one", () => {
    const foreach: NodeDefinition = {
      id: "foreach",
      kind: "action",
      title: "For each",
      category: "Flow",
      inputs: [{ id: "items", label: "Items", type: "list<user>" }],
      outputs: [
        { id: "item", label: "Item", type: "user" },
        { id: "done", label: "Done", type: "boolean" },
        { id: "results", label: "Results", type: "list<json>" },
      ],
    };
    const ports = detailPorts("vrcz/foreach", foreach);
    expect(ports.outputs.map((port) => port.label)).toEqual([
      "Item",
      "Done",
      "Results",
      "on error",
    ]);
    // "Once per element" and "when the loop has finished" are different kinds of answer, and the
    // card draws the second kind differently. Same split the canvas card makes.
    expect(ports.outputs.map((port) => port.role)).toEqual([
      "value",
      "sequence",
      "sequence",
      "error",
    ]);
  });
});
