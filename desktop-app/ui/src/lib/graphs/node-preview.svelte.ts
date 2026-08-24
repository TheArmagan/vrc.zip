/**
 * The timing behind "stop on a row and it tells you what the node is".
 *
 * Shared by the palette in the sidebar and the picker a dropped wire opens, because the two lists
 * are the same list and the interesting part is not the markup — it is the four rules that keep a
 * detail card from flickering:
 *
 * 1. **The first one waits.** Running the pointer down a list of four hundred rows on the way to
 *    somewhere else should show nothing at all.
 * 2. **The next one does not.** Once a card is open, moving to the row below swaps it immediately.
 *    Re-arming the delay per row is what makes a hover card feel like it is lagging behind you.
 * 3. **The keyboard never waits.** Arrowing to a row is a deliberate act, not a pointer passing over.
 * 4. **Scrolling closes it.** The card is anchored to a rectangle measured when it opened, and a
 *    list that scrolls under it leaves it pointing at the wrong row. Closing is honest; the next
 *    `enter` re-measures.
 */

import type { NodeDefinition } from "@vrcz/plugin-api/nodes";
import type { Box } from "./details.ts";

/** What the card draws, and the rectangle it hangs off. */
export interface NodePreviewTarget {
  readonly qualifiedId: string;
  readonly definition: NodeDefinition;
  readonly owner: string;
  readonly anchor: Box;
}

/** How long a pointer has to rest on a row before the first card appears. */
const DELAY_MS = 240;

export class NodePreview {
  #current = $state.raw<NodePreviewTarget | null>(null);
  #timer: ReturnType<typeof setTimeout> | null = null;

  get current(): NodePreviewTarget | null {
    return this.#current;
  }

  /**
   * A pointer came to rest on a row.
   *
   * `element` rather than a `DOMRect`, so the measurement happens at the moment the card is about
   * to be drawn instead of at the moment the pointer arrived — a list that moved in between (a
   * group opening, a search narrowing) would otherwise anchor the card to where the row used to be.
   */
  hover(element: Element | null, target: Omit<NodePreviewTarget, "anchor">): void {
    if (element === null) return;
    this.#clearTimer();
    if (this.#current !== null) {
      this.#current = { ...target, anchor: element.getBoundingClientRect() };
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#current = { ...target, anchor: element.getBoundingClientRect() };
    }, DELAY_MS);
  }

  /** The keyboard moved to a row. No delay: this was asked for rather than passed over. */
  focus(element: Element | null, target: Omit<NodePreviewTarget, "anchor">): void {
    if (element === null) return;
    this.#clearTimer();
    this.#current = { ...target, anchor: element.getBoundingClientRect() };
  }

  hide(): void {
    this.#clearTimer();
    this.#current = null;
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
